"""Generated conversation titles respect user edits and bounded provider calls."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app import nvidia_client, store
from tests.test_regressions import conversation, db


def test_generated_title_only_updates_the_owned_unchanged_seed(db):
    db.rows["conversations"] = [conversation(title="Explain sorting"), conversation("foreign", "victim", title="Explain sorting")]
    assert store.set_generated_conversation_title("chat", "victim", "Explain sorting", "Sorting Algorithms") is None
    assert store.set_generated_conversation_title("foreign", "owner", "Explain sorting", "Sorting Algorithms") is None
    updated = store.set_generated_conversation_title("chat", "owner", "Explain sorting", "Sorting Algorithms")
    assert updated["title"] == "Sorting Algorithms"
    store.update_conversation("chat", "owner", {"title": "My custom title"})
    assert store.set_generated_conversation_title("chat", "owner", "Explain sorting", "Late generated title") is None
    assert db.rows["conversations"][0]["title"] == "My custom title"
    assert db.rows["conversations"][1]["title"] == "Explain sorting"


@pytest.mark.parametrize("legacy_override", [False, True, "mistral"])
def test_title_request_has_a_short_independent_budget(monkeypatch, legacy_override):
    options, requests = [], []
    class Client:
        def with_options(self, **kwargs):
            options.append(kwargs)
            return self
        @property
        def chat(self):
            return SimpleNamespace(completions=SimpleNamespace(create=self.create))
        def create(self, **kwargs):
            requests.append(kwargs)
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='Title: SortingAlgorithms'))])
    monkeypatch.delenv("GROQ_AEON_MODEL", raising=False)
    monkeypatch.delenv("GROQ_MODEL", raising=False)
    model = "qwen/qwen3-32b" if legacy_override else "qwen/qwen3.8-27b"
    monkeypatch.setenv("NVIDIA_AEON_MODEL" if legacy_override else "GROQ_AEON_MODEL", model)
    monkeypatch.setattr(nvidia_client.groq_client, "_client", lambda: Client())
    monkeypatch.setattr(nvidia_client, "get_stanza_model", lambda: "ministral-8b-2512" if legacy_override == "mistral" else model)
    monkeypatch.setattr(nvidia_client.mistral_client, "_client", lambda: Client())
    monkeypatch.setattr(nvidia_client, "_client", Mock(side_effect=AssertionError("wrong provider")))
    assert nvidia_client.generate_title("Explain sorting", "An explanation") == "Sorting Algorithms"
    assert options == [{"timeout": 8.0, "max_retries": 0}]
    assert requests[0]["messages"][-1]["content"].startswith("User message:\nExplain sorting")
    assert requests[0]["model"] == ("ministral-8b-2512" if legacy_override == "mistral" else model)
    if legacy_override == "mistral":
        assert "reasoning_effort" not in requests[0]
    else:
        assert requests[0]["reasoning_effort"] == "none"
