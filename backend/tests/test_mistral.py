"""Unit and integration tests for the Mistral AI provider in Bimo."""

import os
import types
from unittest.mock import MagicMock
import pytest
from openai import (
    APIConnectionError,
    APIStatusError,
    AuthenticationError,
    BadRequestError,
    RateLimitError,
)

from app import config, mistral_client, nvidia_client


def test_mistral_config_defaults(monkeypatch):
    """Verify default model and base URL settings."""
    monkeypatch.delenv("MISTRAL_MODEL", raising=False)
    monkeypatch.delenv("MISTRAL_BASE_URL", raising=False)
    monkeypatch.delenv("NVIDIA_STANZA_MODEL", raising=False)

    assert mistral_client.default_model() == "ministral-8b-2512"
    assert mistral_client.base_url() == "https://api.mistral.ai/v1"
    assert config.get_stanza_model() == "ministral-8b-2512"


def test_mistral_model_env_override(monkeypatch):
    """MISTRAL_MODEL env var overrides default model."""
    monkeypatch.setenv("MISTRAL_MODEL", "mistral-large-latest")
    assert mistral_client.default_model() == "mistral-large-latest"
    assert config.get_stanza_model() == "mistral-large-latest"


def test_is_mistral_model():
    """Verify identification of Mistral models."""
    assert mistral_client.is_mistral_model("ministral-8b-2512") is True
    assert mistral_client.is_mistral_model("codestral-2508") is True
    assert mistral_client.is_mistral_model("codestral-22b-instruct") is True
    assert mistral_client.is_mistral_model("mistral-small-2603") is True
    assert mistral_client.is_mistral_model("mistral-medium-latest") is True
    assert mistral_client.is_mistral_model("pixtral-12b-2409") is True
    assert mistral_client.is_mistral_model("deepseek-ai/deepseek-v4-flash") is False
    assert mistral_client.is_mistral_model("meta/llama-3.3-70b-instruct") is False


def test_clean_key_defensive():
    """Whitespace and quotes are stripped; internal whitespace raises."""
    assert mistral_client._clean_key('  "my-secret-key"  ') == "my-secret-key"
    assert mistral_client._clean_key("  'my-secret-key'  ") == "my-secret-key"
    with pytest.raises(RuntimeError, match="whitespace inside"):
        mistral_client._clean_key("key with spaces")


def test_api_key_fingerprint_never_leaks(monkeypatch):
    """Fingerprint masks key and never exposes raw value."""
    monkeypatch.setenv("MISTRAL_API_KEY", "mis-1234567890abcdef")
    fp = mistral_client.api_key_fingerprint()
    assert fp["configured"] is True
    assert "1234567890" not in fp["preview"]
    assert fp["preview"].startswith("mis-")
    assert fp["preview"].endswith("cdef")


def test_mistral_streaming_success(monkeypatch):
    """iter_response yields delta tokens and done content."""
    monkeypatch.setenv("MISTRAL_API_KEY", "test-mistral-key")

    def mock_stream():
        chunks = ["Hello", " world", " from", " Codestral!"]
        for c in chunks:
            delta = types.SimpleNamespace(content=c)
            choice = types.SimpleNamespace(delta=delta, finish_reason=None)
            yield types.SimpleNamespace(choices=[choice])
        choice_done = types.SimpleNamespace(delta=types.SimpleNamespace(content=None), finish_reason="stop")
        yield types.SimpleNamespace(choices=[choice_done])

    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = mock_stream()
    monkeypatch.setattr(mistral_client, "_client", lambda: mock_client)

    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"},
    ]

    events = list(mistral_client.iter_response(messages, model="codestral-2508"))

    deltas = [ev["data"] for ev in events if ev["type"] == "delta"]
    assert "".join(deltas) == "Hello world from Codestral!"

    done = next(ev for ev in events if ev["type"] == "done")
    assert done["content"] == "Hello world from Codestral!"

    # Verify messages passed to OpenAI client
    mock_client.chat.completions.create.assert_called_once()
    call_kwargs = mock_client.chat.completions.create.call_args.kwargs
    assert call_kwargs["model"] == "codestral-2508"
    assert call_kwargs["stream"] is True
    assert call_kwargs["messages"] == messages
    # Codestral defaults to 0.2 temperature for lower latency / precise code
    assert call_kwargs["temperature"] == 0.2


def test_codestral_extended_thinking_injection(monkeypatch):
    """When reasoning_effort is high, injects deep analysis directive into system prompt."""
    monkeypatch.setenv("MISTRAL_API_KEY", "test-mistral-key")

    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = iter([])
    monkeypatch.setattr(mistral_client, "_client", lambda: mock_client)

    # 1. Extended thinking ON (high) with existing system message
    messages = [
        {"role": "system", "content": "You are Bmo."},
        {"role": "user", "content": "solve a hard algorithm"},
    ]
    list(mistral_client.iter_response(messages, model="codestral-2508", reasoning_effort="high"))
    sent_msgs = mock_client.chat.completions.create.call_args.kwargs["messages"]
    sys_content = sent_msgs[0]["content"]
    assert "EXTENDED THINKING ACTIVE" in sys_content
    assert "Deconstruct the user's requirements" in sys_content

    # 2. Extended thinking OFF (low)
    mock_client.reset_mock()
    messages_low = [
        {"role": "system", "content": "You are Bmo."},
        {"role": "user", "content": "write hello world"},
    ]
    list(mistral_client.iter_response(messages_low, model="codestral-2508", reasoning_effort="low"))
    sent_msgs_low = mock_client.chat.completions.create.call_args.kwargs["messages"]
    assert "EXTENDED THINKING ACTIVE" not in sent_msgs_low[0]["content"]

    # 3. Extended thinking ON when no initial system prompt
    mock_client.reset_mock()
    messages_no_sys = [
        {"role": "user", "content": "design architecture"},
    ]
    list(mistral_client.iter_response(messages_no_sys, model="codestral-2508", reasoning_effort="high"))
    sent_msgs_no_sys = mock_client.chat.completions.create.call_args.kwargs["messages"]
    assert sent_msgs_no_sys[0]["role"] == "system"
    assert "EXTENDED THINKING ACTIVE" in sent_msgs_no_sys[0]["content"]


def test_mistral_multi_turn_history(monkeypatch):
    """Multi-turn conversation history is preserved and sent cleanly."""
    monkeypatch.setenv("MISTRAL_API_KEY", "test-mistral-key")

    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = iter([])
    monkeypatch.setattr(mistral_client, "_client", lambda: mock_client)

    history = [
        {"role": "system", "content": "System directive"},
        {"role": "user", "content": "Turn 1 question"},
        {"role": "assistant", "content": "Turn 1 answer"},
        {"role": "user", "content": "Turn 2 question"},
    ]

    list(mistral_client.iter_response(history, reasoning_effort="low"))
    call_kwargs = mock_client.chat.completions.create.call_args.kwargs
    assert call_kwargs["messages"] == history


def test_mistral_error_handling(monkeypatch):
    """Test standard error conversions without leaking secrets."""
    monkeypatch.setenv("MISTRAL_API_KEY", "test-mistral-key")

    mock_client = MagicMock()
    monkeypatch.setattr(mistral_client, "_client", lambda: mock_client)

    messages = [{"role": "user", "content": "hi"}]

    # 401 Auth error
    mock_client.chat.completions.create.side_effect = AuthenticationError("Invalid key", response=MagicMock(status_code=401), body=None)
    with pytest.raises(RuntimeError, match="authentication failed \\(401\\)"):
        list(mistral_client.iter_response(messages))

    # 429 Rate limit error
    mock_client.chat.completions.create.side_effect = RateLimitError("Too Many Requests", response=MagicMock(status_code=429), body=None)
    with pytest.raises(RuntimeError, match="rate limit exceeded \\(429"):
        list(mistral_client.iter_response(messages))

    # 400 Bad Request error
    mock_client.chat.completions.create.side_effect = BadRequestError("Invalid parameter", response=MagicMock(status_code=400), body=None)
    with pytest.raises(RuntimeError, match="request rejected \\(400\\)"):
        list(mistral_client.iter_response(messages))

    # Network connection failure
    mock_client.chat.completions.create.side_effect = APIConnectionError(request=MagicMock())
    with pytest.raises(RuntimeError, match="Network error reaching Mistral"):
        list(mistral_client.iter_response(messages))


def test_nvidia_dispatcher_routes_mistral(monkeypatch):
    """nvidia_client.iter_response delegates mistral models to mistral_client with reasoning_effort."""
    monkeypatch.setenv("MISTRAL_MODEL", "codestral-2508")
    monkeypatch.setenv("MISTRAL_API_KEY", "test-key")

    captured = {}
    def mock_mistral_iter(messages, **kwargs):
        captured.update(kwargs)
        yield {"type": "delta", "data": "routed to mistral"}
        yield {"type": "done", "content": "routed to mistral"}

    monkeypatch.setattr(mistral_client, "iter_response", mock_mistral_iter)

    messages = [{"role": "user", "content": "hello"}]
    events = list(nvidia_client.iter_response(messages, model="codestral-2508", reasoning_effort="high"))

    assert captured.get("model") == "codestral-2508"
    assert captured.get("reasoning_effort") == "high"
    assert any(ev.get("data") == "routed to mistral" for ev in events)


def test_nvidia_dispatcher_preserves_nvidia_models(monkeypatch):
    """NVIDIA models continue to route through NVIDIA OpenAI client."""
    mock_openai_client = MagicMock()
    mock_choice = types.SimpleNamespace(
        delta=types.SimpleNamespace(content="from nvidia"),
        finish_reason="stop",
    )
    mock_openai_client.chat.completions.create.return_value = [
        types.SimpleNamespace(choices=[mock_choice])
    ]

    monkeypatch.setattr(nvidia_client, "_client", lambda model: mock_openai_client)
    monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-test-key")

    messages = [{"role": "user", "content": "hello"}]
    events = list(nvidia_client.iter_response(messages, model="openai/gpt-oss-120b"))

    assert any(ev.get("data") == "from nvidia" for ev in events)
    mock_openai_client.chat.completions.create.assert_called_once()
    assert mock_openai_client.chat.completions.create.call_args.kwargs["model"] == "openai/gpt-oss-120b"
