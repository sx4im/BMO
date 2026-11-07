"""Unit and integration tests for the Groq AI provider in Bimo."""

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

from app import config, groq_client, mistral_client, nvidia_client


def test_groq_config_defaults(monkeypatch):
    """Verify default model and base URL settings."""
    monkeypatch.delenv("GROQ_AEON_MODEL", raising=False)
    monkeypatch.delenv("GROQ_MODEL", raising=False)
    monkeypatch.delenv("GROQ_BASE_URL", raising=False)

    assert groq_client.default_model() == "qwen/qwen3.8-27b"
    assert groq_client.base_url() == "https://api.groq.com/openai/v1"
    assert config.get_aeon_model() == "qwen/qwen3.8-27b"


def test_groq_model_env_override(monkeypatch):
    """GROQ_AEON_MODEL env var overrides default model."""
    monkeypatch.setenv("GROQ_AEON_MODEL", "qwen-2.5-32b")
    assert groq_client.default_model() == "qwen-2.5-32b"
    assert config.get_aeon_model() == "qwen-2.5-32b"


def test_is_groq_model():
    """Verify identification of Groq models."""
    assert groq_client.is_groq_model("aeon") is True
    assert groq_client.is_groq_model("qwen/qwen3.8-27b") is True
    assert groq_client.is_groq_model("qwen-2.5-32b") is True
    assert groq_client.is_groq_model("groq/compound") is True
    # Explicit NVIDIA prefixed models should not be routed to Groq
    assert groq_client.is_groq_model("nvidia/qwen3-next-80b-a3b-instruct") is False
    assert groq_client.is_groq_model("mistral-small-2603") is False
    assert groq_client.is_groq_model("openai/gpt-oss-120b") is False


def test_clean_key_defensive():
    """Whitespace and quotes are stripped; internal whitespace raises."""
    assert groq_client._clean_key('  "my-secret-key"  ') == "my-secret-key"
    assert groq_client._clean_key("  'my-secret-key'  ") == "my-secret-key"
    with pytest.raises(RuntimeError, match="whitespace inside"):
        groq_client._clean_key("key with spaces")


def test_api_key_fingerprint_never_leaks(monkeypatch):
    """Fingerprint masks key and never exposes raw value."""
    monkeypatch.setenv("GROQ_API_KEY", "gsk_1234567890abcdef")
    fp = groq_client.api_key_fingerprint()
    assert fp["configured"] is True
    assert "1234567890" not in fp["preview"]
    assert fp["preview"].startswith("gsk_")
    assert fp["preview"].endswith("cdef")


def test_groq_streaming_success(monkeypatch, provider_budget):
    """iter_response yields delta tokens and done content."""
    monkeypatch.setenv("GROQ_API_KEY", "test-groq-key")

    def mock_stream():
        chunks = ["Hello", " from", " Groq", " Aeon!"]
        for c in chunks:
            delta = types.SimpleNamespace(content=c)
            choice = types.SimpleNamespace(delta=delta, finish_reason=None)
            yield types.SimpleNamespace(choices=[choice])
        choice_done = types.SimpleNamespace(delta=types.SimpleNamespace(content=None), finish_reason="stop")
        yield types.SimpleNamespace(choices=[choice_done])

    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = mock_stream()
    monkeypatch.setattr(groq_client, "_client", lambda: mock_client)

    messages = [
        {"role": "system", "content": "You are Aeon."},
        {"role": "user", "content": "Hello!"},
    ]

    events = list(groq_client.iter_response(messages, model="qwen/qwen3.8-27b"))

    deltas = [ev["data"] for ev in events if ev["type"] == "delta"]
    assert "".join(deltas) == "Hello from Groq Aeon!"

    done = next(ev for ev in events if ev["type"] == "done")
    assert done["content"] == "Hello from Groq Aeon!"

    mock_client.chat.completions.create.assert_called_once()
    call_kwargs = mock_client.chat.completions.create.call_args.kwargs
    assert call_kwargs["model"] == "qwen/qwen3.8-27b"
    assert call_kwargs["stream"] is True
    assert call_kwargs["messages"] == messages


def test_nvidia_dispatcher_routes_groq_when_configured(monkeypatch):
    """nvidia_client.iter_response delegates Groq models to groq_client when configured."""
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test123")
    monkeypatch.setenv("GROQ_AEON_MODEL", "qwen/qwen3.8-27b")

    called = []
    def mock_groq_iter(messages, **kwargs):
        called.append(kwargs.get("model"))
        yield {"type": "delta", "data": "routed to groq"}
        yield {"type": "done", "content": "routed to groq"}

    monkeypatch.setattr(groq_client, "iter_response", mock_groq_iter)

    messages = [{"role": "user", "content": "hello"}]
    events = list(nvidia_client.iter_response(messages, model="qwen/qwen3.8-27b"))

    assert called == ["qwen/qwen3.8-27b"]
    assert any(ev.get("data") == "routed to groq" for ev in events)


def test_nvidia_dispatcher_fallback_to_stanza_when_groq_unconfigured(monkeypatch):
    """If GROQ_API_KEY is not set, nvidia_client falls back to Stanza (Mistral) instead of failing on NVIDIA."""
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    called = []
    def mock_mistral_iter(messages, **kwargs):
        called.append(kwargs.get("model"))
        yield {"type": "delta", "data": "fallback to stanza"}
        yield {"type": "done", "content": "fallback to stanza"}

    monkeypatch.setattr(mistral_client, "iter_response", mock_mistral_iter)

    messages = [{"role": "user", "content": "hello"}]
    events = list(nvidia_client.iter_response(messages, model="qwen/qwen3.8-27b"))

    assert called == [config.get_stanza_model()]
    assert any(ev.get("data") == "fallback to stanza" for ev in events)
