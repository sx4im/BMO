"""Streaming durability and latency regression tests using the real route/store."""
from __future__ import annotations

import json
import threading
import time

import pytest

from app import nvidia_client, store
from app.routes import chat_routes
from tests.test_regressions import MemoryQuery, conversation, db, gateway, headers


def events(response):
    for chunk in response.response:
        for line in chunk.decode().splitlines():
            if line.startswith("data: "):
                yield json.loads(line[6:])


@pytest.fixture(autouse=True)
def no_external_calls(monkeypatch):
    monkeypatch.setattr(chat_routes, "get_usage_status", lambda uid: {"blocked": False})
    monkeypatch.setattr(nvidia_client, "generate_title", lambda *a: None)


def test_assistant_draft_and_saved_ids_arrive_before_model_finishes(gateway, headers, db, monkeypatch):
    release = threading.Event()
    model_waiting = threading.Event()

    def stream(*a, **k):
        yield {"type": "delta", "data": "First draft"}
        model_waiting.set()
        release.wait(3)
        yield {"type": "delta", "data": " complete"}

    monkeypatch.setattr(nvidia_client, "iter_response_with_fallback", stream)
    response = gateway.post("/chat", headers=headers, json={"message": "Explain", "auto_search": False}, buffered=False)
    try:
        assert model_waiting.wait(1)
        deadline = time.monotonic() + 0.7
        while not any(m["role"] == "assistant" for m in db.rows["messages"]) and time.monotonic() < deadline:
            time.sleep(0.01)
        drafts = [m for m in db.rows["messages"] if m["role"] == "assistant"]
        assert drafts and drafts[0]["content"] == "First draft"
        received = []
        for event in events(response):
            received.append(event)
            if event["type"] == "user_message" and not event["data"]["id"].startswith("msg_pending_"):
                break
        assert received[0]["type"] == "conversation" and received[0]["data"]["id"].startswith("pending_")
        assert received[1]["type"] == "user_message" and received[1]["data"]["id"].startswith("msg_pending_")
        assert not release.is_set()
    finally:
        release.set()
        response.get_data()
        response.close()


def test_blocked_user_write_does_not_delay_first_token(gateway, headers, db, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    original = store.add_message

    def blocked(*a, **k):
        if k.get("role") == "user":
            entered.set()
            release.wait(3)
        return original(*a, **k)

    monkeypatch.setattr(store, "add_message", blocked)
    monkeypatch.setattr(nvidia_client, "iter_response_with_fallback", lambda *a, **k: iter([{"type": "delta", "data": "Immediate"}]))
    started = time.monotonic()
    response = gateway.post("/chat", headers=headers, json={"message": "Explain", "auto_search": False}, buffered=False)
    try:
        assert entered.wait(1)
        assert next(e for e in events(response) if e["type"] == "token")["data"]["delta"] == "Immediate"
        assert time.monotonic() - started < 1
    finally:
        release.set()
        response.get_data()
        response.close()


def test_insert_error_with_reasoning_is_not_retried(db, monkeypatch):
    db.rows["conversations"] = [conversation()]
    original = MemoryQuery.execute
    attempts = []

    def failing(query):
        if query.table == "messages" and query.action == "insert":
            attempts.append(query.values.copy())
            raise ConnectionError("connection lost after commit")
        return original(query)

    monkeypatch.setattr(MemoryQuery, "execute", failing)
    with pytest.raises(ConnectionError):
        store.add_message("chat", "owner", role="assistant", content="Hello", reasoning="Thinking")
    assert len(attempts) == 1


def test_conversation_touch_failure_does_not_hide_committed_message(db, monkeypatch):
    db.rows["conversations"] = [conversation()]
    monkeypatch.setattr(store, "touch_conversation", lambda *a: (_ for _ in ()).throw(ConnectionError("touch failed")))
    saved = store.add_message("chat", "owner", role="assistant", content="Durable")
    assert saved["id"] == db.rows["messages"][0]["id"]


def test_checkpoint_updates_are_owned_and_cannot_modify_user_or_other_chat(db):
    db.rows["conversations"] = [conversation(), conversation("foreign", "victim")]
    user_message = store.add_message("chat", "owner", role="user", content="Question")
    assistant = store.add_message("chat", "owner", role="assistant", content="Draft")
    foreign = store.add_message("foreign", "victim", role="assistant", content="Private")
    for chat_id, uid, message_id in [
        ("chat", "victim", assistant["id"]),
        ("chat", "owner", user_message["id"]),
        ("chat", "owner", foreign["id"]),
    ]:
        with pytest.raises(PermissionError):
            store.update_assistant_message(chat_id, uid, message_id, content="Tampered")
    updated = store.update_assistant_message("chat", "owner", assistant["id"], content="Final", reasoning="Reason")
    assert updated["id"] == assistant["id"] and updated["content"] == "Final"
    assert [m["content"] for m in db.rows["messages"]] == ["Question", "Final", "Private"]


def test_coalescing_keeps_one_row_and_final_cannot_be_overwritten(db, monkeypatch):
    from app.chat_persistence import TurnWriter

    db.rows["conversations"] = [conversation()]
    started, release = threading.Event(), threading.Event()
    writes = []

    def write(previous, content, reasoning):
        writes.append(content)
        if previous is None:
            started.set()
            release.wait(2)
            return store.add_message("chat", "owner", role="assistant", content=content, reasoning=reasoning)
        return store.update_assistant_message("chat", "owner", previous["id"], content=content, reasoning=reasoning)

    writer = TurnWriter(lambda: None, write)
    writer.submit("First", "")
    assert started.wait(1)
    for i in range(500):
        writer.submit(f"Draft {i}", "")
    assert writer.finish("Sanitized final", "Final reasoning", timeout=0.01) is None
    writer.submit("Stale after final", "")
    release.set()
    saved = writer.finish("Ignored duplicate final", "", timeout=1)
    assert saved["content"] == "Sanitized final" and saved["reasoning"] == "Final reasoning"
    assert writes == ["First", "Sanitized final"]
    assert len(db.rows["messages"]) == 1


def test_reasoning_is_durable_before_content_and_final_remains_reasoning_only(gateway, headers, db, monkeypatch):
    draft_saved = threading.Event()
    original = store.add_message

    def add(*a, **k):
        result = original(*a, **k)
        if k.get("role") == "assistant":
            draft_saved.set()
        return result

    def stream(*a, **k):
        yield {"type": "reasoning_delta", "data": "Reasoning without answer"}
        assert draft_saved.wait(1)

    monkeypatch.setattr(store, "add_message", add)
    monkeypatch.setattr(nvidia_client, "iter_response_with_fallback", stream)
    response = gateway.post("/chat", headers=headers, json={"message": "Explain", "auto_search": False})
    received = list(events(response))
    saved = next(e["data"] for e in received if e["type"] == "assistant_message")
    assert saved["content"] == "" and saved["reasoning"] == "Reasoning without answer"
    assert len([m for m in db.rows["messages"] if m["role"] == "assistant"]) == 1
    assert len(db.rows["usage_events"]) == 1


def test_cancel_preserves_partial_reply_and_meters_once(gateway, headers, db, monkeypatch):
    def stream(*a, **k):
        yield {"type": "delta", "data": "Partial answer"}
        assert chat_routes._signal_cancel("stream-partial", "owner")
        # Cross-worker cancellation deliberately polls its SQLite registry at 100 ms.
        time.sleep(0.12)
        yield {"type": "delta", "data": "Must not appear"}

    monkeypatch.setattr(nvidia_client, "iter_response_with_fallback", stream)
    response = gateway.post("/chat", headers=headers, json={"message": "Explain", "auto_search": False, "stream_id": "stream-partial"})
    response.get_data()
    assistant = [m for m in db.rows["messages"] if m["role"] == "assistant"]
    assert len(assistant) == 1 and assistant[0]["content"] == "Partial answer"
    assert len(db.rows["usage_events"]) == 1


def test_failed_final_update_is_visible_and_never_claimed_saved(gateway, headers, db, monkeypatch):
    draft_saved = threading.Event()
    original = store.add_message

    def add(*a, **k):
        result = original(*a, **k)
        if k.get("role") == "assistant":
            draft_saved.set()
        return result

    def stream(*a, **k):
        yield {"type": "delta", "data": "Durable draft"}
        assert draft_saved.wait(1)
        yield {"type": "delta", "data": " final"}

    monkeypatch.setattr(store, "add_message", add)
    monkeypatch.setattr(store, "update_assistant_message", lambda *a, **k: (_ for _ in ()).throw(ConnectionError("database down")))
    monkeypatch.setattr(nvidia_client, "iter_response_with_fallback", stream)
    response = gateway.post("/chat", headers=headers, json={"message": "Explain", "auto_search": False})
    received = list(events(response))
    assert any(e["type"] == "complete" for e in received)
    assert any(e["type"] == "error" and "saved" in e["detail"] for e in received)
    assert not any(e["type"] == "assistant_message" for e in received)
    assert [m["content"] for m in db.rows["messages"] if m["role"] == "assistant"] == ["Durable draft"]
    assert len(db.rows["usage_events"]) == 1


def test_complete_precedes_bounded_final_flush_and_saved_ack(gateway, headers, db, monkeypatch):
    from app import chat_persistence

    monkeypatch.setattr(chat_persistence, "FINAL_FLUSH_TIMEOUT", 0.05)
    entered, release = threading.Event(), threading.Event()
    original = store.add_message

    def blocked(*a, **k):
        if k.get("role") == "assistant":
            entered.set()
            release.wait(2)
        return original(*a, **k)

    monkeypatch.setattr(store, "add_message", blocked)
    monkeypatch.setattr(nvidia_client, "iter_response_with_fallback", lambda *a, **k: iter([{"type": "delta", "data": "Immediate"}]))
    started = time.monotonic()
    response = gateway.post("/chat", headers=headers, json={"message": "Explain", "auto_search": False})
    try:
        received = list(events(response))
        assert entered.wait(0.1)
        assert time.monotonic() - started < 0.7
        types = [e["type"] for e in received]
        assert types.index("complete") < types.index("error")
        assert "assistant_message" not in types
    finally:
        release.set()


def test_usage_failure_still_closes_writer_with_final_snapshot(gateway, headers, db, monkeypatch):
    saved_draft = threading.Event()
    original = store.add_message

    def add(*a, **k):
        result = original(*a, **k)
        if k.get("role") == "assistant":
            saved_draft.set()
        return result

    def stream(*a, **k):
        yield {"type": "delta", "data": "First"}
        assert saved_draft.wait(1)
        yield {"type": "delta", "data": " final"}

    monkeypatch.setattr(store, "add_message", add)
    monkeypatch.setattr(store, "record_usage", lambda *a: (_ for _ in ()).throw(ConnectionError("meter unavailable")))
    monkeypatch.setattr(nvidia_client, "iter_response_with_fallback", stream)
    response = gateway.post("/chat", headers=headers, json={"message": "Explain", "auto_search": False})
    response.get_data()
    assert [m["content"] for m in db.rows["messages"] if m["role"] == "assistant"] == ["First final"]


def test_periodic_checkpoint_saves_latest_without_waiting_for_model_end(db, monkeypatch):
    from app import chat_persistence

    monkeypatch.setattr(chat_persistence, "CHECKPOINT_INTERVAL", 0.05)
    db.rows["conversations"] = [conversation()]
    first_saved, next_saved = threading.Event(), threading.Event()
    writes = []

    def write(previous, content, reasoning):
        if previous is None:
            result = store.add_message("chat", "owner", role="assistant", content=content)
            first_saved.set()
        else:
            result = store.update_assistant_message("chat", "owner", previous["id"], content=content)
            next_saved.set()
        writes.append(content)
        return result

    writer = chat_persistence.TurnWriter(lambda: None, write)
    writer.submit("First", "")
    assert first_saved.wait(1)
    for i in range(100):
        writer.submit(f"Latest {i}", "")
    assert next_saved.wait(1)
    assert db.rows["messages"][0]["content"] == "Latest 99"
    # The final identical state does not add another DB write.
    assert writer.finish("Latest 99", "", timeout=1)["content"] == "Latest 99"
    assert writes == ["First", "Latest 99"]


def test_model_error_preserves_partial_and_final_saved_ack(gateway, headers, db, monkeypatch):
    def stream(*a, **k):
        yield {"type": "delta", "data": "Partial answer"}
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(nvidia_client, "iter_response_with_fallback", stream)
    response = gateway.post("/chat", headers=headers, json={"message": "Explain", "auto_search": False})
    received = list(events(response))
    assistant = [m for m in db.rows["messages"] if m["role"] == "assistant"]
    assert len(assistant) == 1 and assistant[0]["content"].startswith("Partial answer")
    saved = next(e["data"] for e in received if e["type"] == "assistant_message")
    assert saved["id"] == assistant[0]["id"] and saved["content"] == assistant[0]["content"]
    assert len(db.rows["usage_events"]) == 1


def test_user_persistence_failure_streams_answer_without_false_saved_ids(gateway, headers, db, monkeypatch):
    monkeypatch.setattr(store, "add_message", lambda *a, **k: (_ for _ in ()).throw(ConnectionError("database unavailable")))
    monkeypatch.setattr(nvidia_client, "iter_response_with_fallback", lambda *a, **k: iter([{"type": "delta", "data": "Visible answer"}]))
    response = gateway.post("/chat", headers=headers, json={"message": "Explain", "auto_search": False})
    received = list(events(response))
    assert any(e["type"] == "token" and e["data"]["delta"] == "Visible answer" for e in received)
    assert any(e["type"] == "error" and "saved" in e["detail"] for e in received)
    assert not any(e["type"] == "assistant_message" for e in received)
    user_acks = [e for e in received if e["type"] == "user_message"]
    assert len(user_acks) == 1 and user_acks[0]["data"]["id"].startswith("msg_pending_")
    assert not db.rows["messages"]


def test_incognito_reasoning_only_keeps_response_without_message_writes(gateway, headers, db, monkeypatch):
    monkeypatch.setattr(nvidia_client, "iter_response_with_fallback", lambda *a, **k: iter([{"type": "reasoning_delta", "data": "Private reasoning"}]))
    response = gateway.post("/chat/incognito", headers=headers, json={"message": "Explain", "auto_search": False})
    received = list(events(response))
    assistant = next((e["data"] for e in received if e["type"] == "assistant_message"), None)
    assert assistant and assistant["content"] == "" and assistant["reasoning"] == "Private reasoning"
    assert not db.rows["messages"] and not db.rows["conversations"]
    assert len(db.rows["usage_events"]) == 1
