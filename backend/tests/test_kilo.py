"""Unit tests for Kilo AI Gateway client and Nexus routing in BMO.

Verifies:
- Nexus (id "deep") routes to Kilo AI Gateway using Step 3.7 Flash (stepfun/step-3.7-flash:free)
- Paid models (kilo-auto/frontier, kilo-auto/efficient, etc.) are strictly excluded
- Rate limits (HTTP 429) are handled gracefully
- Streaming yields content tokens and reasoning tokens seamlessly
- No fallback to paid models
"""

import pytest
from unittest.mock import MagicMock, patch

from app import kilo_client, nvidia_client
from app.config import DEFAULT_KILO_BASE_URL, DEFAULT_KILO_MODEL, get_nexos_model, get_real_id_map


def test_kilo_defaults():
    """Verify default model is stepfun/step-3.7-flash:free and base URL is Kilo Gateway."""
    assert kilo_client.default_model() == "stepfun/step-3.7-flash:free"
    assert kilo_client.base_url() == DEFAULT_KILO_BASE_URL
    assert DEFAULT_KILO_MODEL == "stepfun/step-3.7-flash:free"
    assert get_nexos_model() == "stepfun/step-3.7-flash:free"
    assert get_real_id_map()["deep"] == "stepfun/step-3.7-flash:free"


def test_kilo_model_matching():
    """Verify is_kilo_model accurately recognizes Nexus identifiers."""
    assert kilo_client.is_kilo_model("deep") is True
    assert kilo_client.is_kilo_model("nexus") is True
    assert kilo_client.is_kilo_model("nexos") is True
    assert kilo_client.is_kilo_model("stepfun/step-3.7-flash:free") is True
    assert kilo_client.is_kilo_model("stepfun/step-3.7-flash") is True
    assert kilo_client.is_kilo_model("kilo/something") is True
    assert kilo_client.is_kilo_model("ministral-8b-2512") is False
    assert kilo_client.is_kilo_model("qwen/qwen3.8-27b") is False


def test_paid_model_strictly_excluded():
    """Verify paid Kilo models (kilo-auto/frontier, kilo-auto/efficient) are blocked and coerced to free."""
    assert kilo_client.validate_model("kilo-auto/frontier") == "stepfun/step-3.7-flash:free"
    assert kilo_client.validate_model("kilo-auto/efficient") == "stepfun/step-3.7-flash:free"
    assert kilo_client.validate_model("kilo-auto/some-other-paid") == "stepfun/step-3.7-flash:free"
    assert kilo_client.validate_model("deep") == "stepfun/step-3.7-flash:free"
    assert kilo_client.validate_model(None) == "stepfun/step-3.7-flash:free"


def test_kilo_rate_limit_graceful_handling(monkeypatch):
    """Verify HTTP 429 / RateLimitError is caught and yields a clean user-facing message."""
    monkeypatch.setenv("KILO_API_KEY", "test-kilo-key")

    mock_client = MagicMock()
    from openai import RateLimitError
    import httpx

    req = httpx.Request("POST", "https://api.kilo.ai/api/gateway/chat/completions")
    resp = httpx.Response(429, request=req)
    mock_client.chat.completions.create.side_effect = RateLimitError(
        message="Rate limit exceeded", response=resp, body=None
    )

    monkeypatch.setattr(kilo_client, "_client", lambda: mock_client)

    with pytest.raises(RuntimeError) as excinfo:
        list(kilo_client.iter_response([{"role": "user", "content": "hello"}]))

    assert "rate limit reached for Step 3.7 Flash" in str(excinfo.value)


def test_kilo_streaming_content_and_reasoning(monkeypatch):
    """Verify Kilo streaming properly separates and yields content and reasoning tokens."""
    monkeypatch.setenv("KILO_API_KEY", "test-kilo-key")

    # Mock chunk generator
    def make_chunk(content=None, reasoning=None, finish_reason=None):
        delta = MagicMock()
        delta.content = content
        delta.reasoning = reasoning
        delta.reasoning_content = None
        choice = MagicMock()
        choice.delta = delta
        choice.finish_reason = finish_reason
        chunk = MagicMock()
        chunk.choices = [choice]
        return chunk

    mock_stream = [
        make_chunk(reasoning="Analyzing the question..."),
        make_chunk(reasoning=" Step 2."),
        make_chunk(content="The answer is "),
        make_chunk(content="42.", finish_reason="stop"),
    ]

    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = mock_stream
    monkeypatch.setattr(kilo_client, "_client", lambda: mock_client)

    events = list(kilo_client.iter_response([{"role": "user", "content": "What is life?"}]))

    deltas = [e["data"] for e in events if e["type"] == "delta"]
    reasoning_deltas = [e["data"] for e in events if e["type"] == "reasoning_delta"]
    done_events = [e for e in events if e["type"] == "done"]

    assert "".join(reasoning_deltas) == "Analyzing the question... Step 2."
    assert "".join(deltas) == "The answer is 42."
    assert len(done_events) == 1
    assert done_events[0]["content"] == "The answer is 42."
    assert done_events[0]["reasoning"] == "Analyzing the question... Step 2."


def test_nexus_routes_to_kilo_dispatcher(monkeypatch):
    """Verify nvidia_client.iter_response delegates 'deep' model requests to kilo_client."""
    called = []

    def mock_kilo_iter_response(messages, **kwargs):
        called.append(kwargs.get("model"))
        yield {"type": "delta", "data": "Kilo response"}
        yield {"type": "done", "content": "Kilo response"}

    monkeypatch.setattr(kilo_client, "iter_response", mock_kilo_iter_response)

    events = list(nvidia_client.iter_response(
        [{"role": "user", "content": "Deep thought"}],
        model="stepfun/step-3.7-flash:free",
    ))

    assert len(called) == 1
    assert called[0] == "stepfun/step-3.7-flash:free"
    assert events[0]["data"] == "Kilo response"


def test_api_key_fingerprint_never_leaks(monkeypatch):
    """Ensure KILO_API_KEY is masked and never exposed in full."""
    monkeypatch.setenv("KILO_API_KEY", "kilo_secret_key_1234567890abcdef")
    fp = kilo_client.api_key_fingerprint()
    assert fp["configured"] is True
    assert "kilo_secret_key_1234567890abcdef" not in str(fp)
    assert fp["preview"] == "kilo…cdef"


def test_iter_response_with_fallback_routes_nexus_to_kilo(monkeypatch):
    """Verify iter_response_with_fallback directly delegates Nexus to Kilo without paid fallback."""
    called = []

    def mock_kilo_iter_response(messages, **kwargs):
        called.append(kwargs.get("model"))
        yield {"type": "delta", "data": "Direct Kilo"}
        yield {"type": "done", "content": "Direct Kilo"}

    monkeypatch.setattr(kilo_client, "iter_response", mock_kilo_iter_response)

    events = list(nvidia_client.iter_response_with_fallback(
        [{"role": "user", "content": "Hello"}],
        model="stepfun/step-3.7-flash:free",
    ))

    assert len(called) == 1
    assert called[0] == "stepfun/step-3.7-flash:free"
    assert events[0]["data"] == "Direct Kilo"

