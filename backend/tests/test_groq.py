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
    assert groq_client.is_groq_model("openai/gpt-oss-120b") is True


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


def test_groq_streaming_success(monkeypatch):
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


def test_nvidia_dispatcher_requires_groq_key_without_mistral_fallback(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setenv("MISTRAL_API_KEY", "unused-test-key")
    fallback = MagicMock(return_value=iter([]))
    monkeypatch.setattr(mistral_client, "iter_response", fallback)
    with pytest.raises(RuntimeError, match="GROQ_API_KEY"):
        list(nvidia_client.iter_response([], model="qwen/qwen3.8-27b"))
    fallback.assert_not_called()


@pytest.mark.parametrize("overrides", [
    {}, {"GROQ_MODEL": "qwen-2.5-32b"},
    {"NVIDIA_AEON_MODEL": "qwen/qwen3-32b"},
    {"GROQ_AEON_MODEL": "qwen/qwen3.8-27b", "GROQ_MODEL": "qwen-2.5-32b"},
])
def test_stanza_uses_mistral_independently_of_aeon_overrides(monkeypatch, overrides):
    for key in ("GROQ_AEON_MODEL", "GROQ_MODEL", "NVIDIA_AEON_MODEL"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("MISTRAL_MODEL", "ministral-8b-2512")
    monkeypatch.setenv("NVIDIA_STANZA_MODEL", "nvidia/stale-stanza")
    for key, value in overrides.items():
        monkeypatch.setenv(key, value)
    expected = config.get_aeon_model()
    assert config.get_stanza_model() == "ministral-8b-2512"
    catalog = config.get_real_id_map()
    assert catalog["thinking"] == "ministral-8b-2512"
    assert catalog["aeon"] == expected


def test_mistral_key_alone_configures_active_inference(monkeypatch):
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setenv("MISTRAL_API_KEY", "unused-test-key")
    assert nvidia_client.is_configured() is True


def test_groq_pre_token_error_propagates_without_retry_or_mistral(monkeypatch):
    primary = MagicMock(side_effect=RuntimeError("Groq unavailable"))
    fallback = MagicMock(return_value=iter([]))
    monkeypatch.setattr(groq_client, "is_configured", lambda: True)
    monkeypatch.setattr(groq_client, "iter_response", primary)
    monkeypatch.setattr(mistral_client, "iter_response", fallback)
    with pytest.raises(RuntimeError, match="Groq unavailable"):
        list(nvidia_client.iter_response_with_fallback([], model="qwen/qwen3.8-27b"))
    primary.assert_called_once()
    fallback.assert_not_called()


def test_search_classifier_ignores_mistral_when_groq_unavailable(monkeypatch):
    from app import search_router
    monkeypatch.setattr(groq_client, "is_configured", lambda: False)
    monkeypatch.setenv("MISTRAL_API_KEY", "unused-test-key")
    assert search_router._classifier_backends() == []


def test_search_classifier_uses_only_groq_when_both_keys_exist(monkeypatch):
    from app import search_router
    monkeypatch.setattr(groq_client, "is_configured", lambda: True)
    monkeypatch.setenv("MISTRAL_API_KEY", "unused-test-key")
    assert [name for name, _, _ in search_router._classifier_backends()] == ["groq"]


def test_groq_aeon_override_drives_default_and_dispatch(monkeypatch):
    monkeypatch.delenv("GROQ_AEON_MODEL", raising=False)
    monkeypatch.delenv("GROQ_MODEL", raising=False)
    monkeypatch.setenv("GROQ_MODEL", "qwen/qwen3-32b")
    stream = MagicMock(return_value=iter([{"type": "done", "content": "Groq answer"}]))
    wrong_provider = MagicMock(side_effect=AssertionError("must not call Mistral"))
    monkeypatch.setattr(groq_client, "iter_response", stream)
    monkeypatch.setattr(mistral_client, "iter_response", wrong_provider)
    events = list(nvidia_client.iter_response([], model=config.get_aeon_model()))
    assert events == [{"type": "done", "content": "Groq answer"}]
    assert groq_client.default_model() == config.get_aeon_model() == "qwen/qwen3-32b"
    stream.assert_called_once_with([], model="qwen/qwen3-32b", temperature=0.7, max_tokens=None, reasoning_effort=None, thinking=True)
    wrong_provider.assert_not_called()
