"""Provider diagnostics must report upstream evidence without changing streams."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from flask import Flask

from app import groq_client, mistral_client, nvidia_client
from app.routes.analytics_routes import analytics_bp


@pytest.fixture(params=[("groq", groq_client), ("mistral", mistral_client)])
def provider(request, monkeypatch):
    name, adapter = request.param
    client = MagicMock()
    monkeypatch.setattr(adapter, "_client", lambda *args: client)
    return name, adapter, client


def test_inference_reports_first_upstream_chunk_once_and_preserves_answer(provider):
    name, adapter, client = provider
    client.chat.completions.create.return_value = [
        SimpleNamespace(id="completion-123", model="reported-model", choices=[]),
        SimpleNamespace(id="completion-123", model="reported-model", choices=[
            SimpleNamespace(delta=SimpleNamespace(content="Answer"), finish_reason="stop"),
        ]),
    ]

    events = list(adapter.iter_response([], model="requested-model"))

    assert events[0] == {
        "type": "inference", "provider": name, "requested_model": "requested-model",
        "reported_model": "reported-model", "request_id": "completion-123",
    }
    assert len([event for event in events if event["type"] == "inference"]) == 1
    assert [event["data"] for event in events if event["type"] == "delta"] == ["Answer"]
    assert events[-1]["type"] == "done"
    assert events[-1]["content"] == "Answer"


def test_inference_never_substitutes_requested_model_for_missing_upstream_evidence(provider):
    name, adapter, client = provider
    client.chat.completions.create.return_value = [SimpleNamespace(choices=[
        SimpleNamespace(delta=SimpleNamespace(content="Answer"), finish_reason="stop"),
    ])]

    events = list(adapter.iter_response([], model="requested-model"))

    assert events[0] == {
        "type": "inference", "provider": name, "requested_model": "requested-model",
        "reported_model": None, "request_id": None,
    }
    assert events[-1]["content"] == "Answer"


def test_failure_before_upstream_chunk_does_not_claim_inference(provider):
    _, adapter, client = provider

    def fail():
        raise RuntimeError("upstream unavailable")
        yield

    client.chat.completions.create.return_value = fail()
    events = []
    with pytest.raises(RuntimeError, match="upstream unavailable"):
        events.extend(adapter.iter_response([], model="requested-model"))
    assert events == []


def test_inference_does_not_hide_error_after_partial_answer(provider):
    name, adapter, client = provider

    def fail_after_answer():
        yield SimpleNamespace(id="completion-123", model="reported-model", choices=[
            SimpleNamespace(delta=SimpleNamespace(content="Partial"), finish_reason=None),
        ])
        raise RuntimeError("connection lost")

    client.chat.completions.create.return_value = fail_after_answer()
    events = []
    with pytest.raises(RuntimeError, match="connection lost"):
        events.extend(adapter.iter_response([], model="requested-model"))
    assert events[0]["type"] == "inference"
    assert events[0]["provider"] == name
    assert events[-1] == {"type": "delta", "data": "Partial"}
    assert not any(event["type"] == "done" for event in events)


def test_metadata_does_not_prevent_fallback_on_error_before_first_token(monkeypatch):
    monkeypatch.setattr(nvidia_client, "get_nexos_model", lambda: "primary")
    monkeypatch.setattr(nvidia_client, "get_stanza_model", lambda: "fallback")

    def upstream(messages, *, model, **kwargs):
        yield {"type": "inference", "provider": "nvidia" if model == "primary" else "groq"}
        if model == "primary":
            raise RuntimeError("failed before content")
        yield {"type": "delta", "data": "Recovered"}
        yield {"type": "done", "content": "Recovered"}

    monkeypatch.setattr(nvidia_client, "iter_response", upstream)

    events = list(nvidia_client.iter_response_with_fallback([], model="primary"))

    assert [event["provider"] for event in events if event["type"] == "inference"] == ["nvidia", "groq"]
    assert events[-1] == {"type": "done", "content": "Recovered"}


def test_metadata_keeps_reasoning_separate_from_answer(monkeypatch):
    client = MagicMock()
    monkeypatch.setattr(groq_client, "_client", lambda: client)
    client.chat.completions.create.return_value = [SimpleNamespace(
        id="completion-456", model="reported-model", choices=[SimpleNamespace(
            delta=SimpleNamespace(content="Answer", reasoning="Reasoning"),
            finish_reason="stop",
        )],
    )]

    events = list(nvidia_client.iter_response([], model="openai/gpt-oss-120b", reasoning_effort="max"))

    request = client.chat.completions.create.call_args.kwargs
    assert request["reasoning_effort"] == "high"
    assert request["extra_body"] == {"include_reasoning": True}
    assert request["max_completion_tokens"] == 16384
    assert [event["type"] for event in events] == ["inference", "reasoning_delta", "delta", "done"]
    assert events[1]["data"] == "Reasoning"
    assert events[2]["data"] == "Answer"
    assert events[-1] == {"type": "done", "content": "Answer", "reasoning": "Reasoning",
                          "finish_reason": "stop", "usage": None, "complete": True}


def test_error_after_first_answer_never_appends_fallback_despite_metadata(monkeypatch):
    monkeypatch.setattr(nvidia_client, "get_nexos_model", lambda: "primary")
    monkeypatch.setattr(nvidia_client, "get_stanza_model", lambda: "fallback")

    def upstream(messages, *, model, **kwargs):
        assert model == "primary", "partial answers must never switch provider"
        yield {"type": "inference", "provider": "nvidia"}
        yield {"type": "delta", "data": "Partial"}
        raise RuntimeError("connection lost")

    monkeypatch.setattr(nvidia_client, "iter_response", upstream)
    events = []
    with pytest.raises(RuntimeError, match="connection lost"):
        events.extend(nvidia_client.iter_response_with_fallback([], model="primary"))
    assert events == [
        {"type": "inference", "provider": "nvidia"},
        {"type": "delta", "data": "Partial"},
    ]


def test_metadata_does_not_disable_first_token_timeout(monkeypatch):
    monkeypatch.setattr(nvidia_client, "get_nexos_model", lambda: "primary")
    monkeypatch.setattr(nvidia_client, "get_stanza_model", lambda: "fallback")
    monkeypatch.setattr(nvidia_client.threading, "Thread", lambda **kwargs: MagicMock())
    deadlines = []

    class PendingStream:
        def get(self, timeout=None):
            assert timeout is not None, "metadata must not disable the first-token deadline"
            deadlines.append(timeout)
            if len(deadlines) == 1:
                return "data", {"type": "inference", "provider": "nvidia"}
            raise nvidia_client.queue.Empty

    monkeypatch.setattr(nvidia_client.queue, "Queue", PendingStream)
    clock = iter([0.0, 10.0, 20.0])
    monkeypatch.setattr(nvidia_client.time, "monotonic", lambda: next(clock))

    def fallback(messages, *, model, **kwargs):
        assert model == "fallback"
        yield {"type": "delta", "data": "Recovered"}

    monkeypatch.setattr(nvidia_client, "iter_response", fallback)
    events = list(nvidia_client.iter_response_with_fallback([], model="primary"))
    assert events[-1] == {"type": "delta", "data": "Recovered"}
    assert 0 < deadlines[1] < deadlines[0] <= 50


def test_health_reports_only_render_commit_as_backend_revision(monkeypatch):
    app = Flask(__name__)
    app.register_blueprint(analytics_bp)
    monkeypatch.setenv("RENDER_GIT_COMMIT", "5e3d0bc21c6a8c173855b556778b828998ed0b6f")
    monkeypatch.setenv("UNRELATED_SECRET", "must-not-appear")
    with app.test_client() as client:
        response = client.get("/health")
    assert response.get_json()["backend_revision"] == "5e3d0bc21c6a8c173855b556778b828998ed0b6f"
    assert "must-not-appear" not in response.get_data(as_text=True)


def test_health_does_not_invent_a_revision_when_render_metadata_is_unavailable(monkeypatch):
    app = Flask(__name__)
    app.register_blueprint(analytics_bp)
    monkeypatch.delenv("RENDER_GIT_COMMIT", raising=False)
    with app.test_client() as client:
        assert client.get("/health").get_json()["backend_revision"] is None
