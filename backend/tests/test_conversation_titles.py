"""Generated conversation titles respect user edits and bounded provider calls."""
from types import SimpleNamespace

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


def test_title_request_has_a_short_independent_budget(monkeypatch):
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
    monkeypatch.setattr(nvidia_client, "_client", lambda *a, **k: Client())
    monkeypatch.setattr(nvidia_client.mistral_client, "is_mistral_model", lambda _: False)
    assert nvidia_client.generate_title("Explain sorting", "An explanation") == "Sorting Algorithms"
    assert options == [{"timeout": 8.0, "max_retries": 0}]
    assert requests[0]["messages"][-1]["content"].startswith("User message:\nExplain sorting")
