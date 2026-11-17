"""Recovery after an ambiguous commit must retain one owned final snapshot."""
from __future__ import annotations

import threading
import uuid

import pytest
from postgrest.exceptions import APIError

from app import chat_persistence, store
from tests.test_regressions import MemoryQuery, conversation, db


@pytest.mark.parametrize("table,role", [("conversations", None), ("messages", "user"), ("messages", "assistant")])
def test_stable_id_recovers_commit_when_insert_response_is_lost(db, monkeypatch, table, role):
    db.rows["conversations"] = [conversation()]
    stable_id = str(uuid.uuid4())
    original = MemoryQuery.execute
    failed = False

    def lose_response(query):
        nonlocal failed
        result = original(query)
        if query.table == table and query.action == "insert" and not failed:
            failed = True
            raise ConnectionError("response lost after commit")
        return result

    monkeypatch.setattr(MemoryQuery, "execute", lose_response)
    if role is None:
        save = lambda: store.create_conversation("owner", first_message="Question", conversation_id=stable_id)
    else:
        save = lambda: store.add_message("chat", "owner", role=role, content="Text", message_id=stable_id, touch=False)
    assert save()["id"] == stable_id
    assert save()["id"] == stable_id
    assert len([row for row in db.rows[table] if row["id"] == stable_id]) == 1


def test_stable_assistant_insert_recovery_replaces_draft_with_latest_snapshot(db, monkeypatch):
    db.rows["conversations"] = [conversation()]
    stable_id = str(uuid.uuid4())
    original = MemoryQuery.execute

    def lose_confirmation(query):
        result = original(query)
        if query.table == "messages":
            raise ConnectionError("insert and reconciliation responses unavailable")
        return result

    monkeypatch.setattr(MemoryQuery, "execute", lose_confirmation)
    with pytest.raises(ConnectionError):
        store.add_message("chat", "owner", role="assistant", content="Draft", message_id=stable_id, touch=False)
    monkeypatch.setattr(MemoryQuery, "execute", original)
    saved = store.add_message("chat", "owner", role="assistant", content="Final", reasoning="Reason", message_id=stable_id, touch=False)
    assert saved["content"] == "Final" and saved["reasoning"] == "Reason"
    assert len(db.rows["messages"]) == 1


@pytest.mark.parametrize("collision", ["foreign_conversation", "foreign_message", "user_message", "different_user_content"])
def test_stable_id_collision_never_returns_or_overwrites_unrelated_rows(db, collision):
    db.rows["conversations"] = [conversation(), conversation("foreign", "victim")]
    stable_id = str(uuid.uuid4())
    if collision == "foreign_conversation":
        db.rows["conversations"][1]["id"] = stable_id
        with pytest.raises((APIError, PermissionError, ValueError)):
            store.create_conversation("owner", first_message="Tamper", conversation_id=stable_id)
        assert db.rows["conversations"][1]["user_id"] == "victim"
        return
    role = "user" if collision in ("user_message", "different_user_content") else "assistant"
    chat = "foreign" if collision == "foreign_message" else "chat"
    db.rows["messages"] = [{"id": stable_id, "conversation_id": chat, "role": role, "content": "Original"}]
    with pytest.raises((APIError, PermissionError, ValueError)):
        store.add_message("chat", "owner", role="user" if collision == "different_user_content" else "assistant",
                          content="Tamper", message_id=stable_id, touch=False)
    assert db.rows["messages"][0]["content"] == "Original"
    assert len(db.rows["messages"]) == 1


@pytest.mark.parametrize("operation", ["insert", "update"])
def test_message_commit_ack_does_not_wait_for_optional_timestamp(db, monkeypatch, operation):
    db.rows["conversations"] = [conversation()]
    entered, release, done = threading.Event(), threading.Event(), threading.Event()
    saved = store.add_message("chat", "owner", role="assistant", content="Draft")

    def blocked_touch(*args):
        entered.set()
        release.wait(2)

    monkeypatch.setattr(store, "touch_conversation", blocked_touch)
    result = []
    errors = []

    def save():
        try:
            if operation == "insert":
                result.append(store.add_message("chat", "owner", role="assistant", content="Final", touch=False))
            else:
                result.append(store.update_assistant_message("chat", "owner", saved["id"], content="Final", touch=False))
        except Exception as exc:
            errors.append(exc)
        finally:
            done.set()

    thread = threading.Thread(target=save)
    thread.start()
    try:
        assert done.wait(0.5)
        assert not errors
        assert result[0]["content"] == "Final"
        assert not entered.is_set()
    finally:
        release.set()
        thread.join(2)


@pytest.mark.parametrize("committed", [False, True])
def test_failed_checkpoint_recovers_latest_final_snapshot(db, monkeypatch, committed):
    db.rows["conversations"] = [conversation()]
    stable_id = str(uuid.uuid4())
    failed = threading.Event()
    original = MemoryQuery.execute

    def unavailable(query):
        if query.table == "messages":
            failed.set()
            if committed:
                original(query)
            raise ConnectionError("checkpoint unavailable")
        return original(query)

    monkeypatch.setattr(MemoryQuery, "execute", unavailable)

    def write(previous, content, reasoning):
        if previous is None:
            return store.add_message("chat", "owner", role="assistant", content=content,
                                     reasoning=reasoning, message_id=stable_id, touch=False)
        return store.update_assistant_message("chat", "owner", previous["id"], content=content,
                                              reasoning=reasoning, touch=False)

    writer = chat_persistence.TurnWriter(lambda: None, write, retry_safe=True)
    writer.submit("Draft", "")
    assert failed.wait(1)
    monkeypatch.setattr(MemoryQuery, "execute", original)
    saved = writer.finish("Final", "Final reasoning", timeout=2)
    assert saved["content"] == "Final" and saved["reasoning"] == "Final reasoning"
    assert writer.error is None
    assert len(db.rows["messages"]) == 1


def test_initializer_transient_failure_recovers_and_persistent_failure_stays_visible(monkeypatch):
    monkeypatch.setattr(chat_persistence, "RETRY_DELAY", 0.01)
    attempts = []

    def initialize():
        attempts.append(True)
        if len(attempts) == 1:
            raise ConnectionError("temporary read error")

    writer = chat_persistence.TurnWriter(initialize, lambda previous, content, reasoning: {"id": "saved", "content": content}, retry_safe=True)
    assert writer.finish("Final", "", timeout=1)["content"] == "Final"
    assert len(attempts) == 2

    writes = []

    def failed_write(*args):
        writes.append(True)
        raise ConnectionError("database unavailable")

    failed = chat_persistence.TurnWriter(lambda: None, failed_write, retry_safe=True)
    assert failed.finish("Final", "", timeout=1) is None
    assert isinstance(failed.error, ConnectionError)
    assert len(writes) == 3


@pytest.mark.parametrize("error", [PermissionError("not owned"), ValueError("invalid input"),
                                  APIError({"code": "42703", "message": "column missing", "details": "", "hint": ""})])
def test_nontransient_failures_are_not_retried(error):
    attempts = []

    def initialize():
        attempts.append(True)
        raise error

    writer = chat_persistence.TurnWriter(initialize, lambda *args: None, retry_safe=True)
    assert writer.finish("Final", "", timeout=1) is None
    assert len(attempts) == 1
    assert writer.error is error


def test_retries_require_an_explicitly_idempotent_callback():
    attempts = []

    def initialize():
        attempts.append(True)
        raise ConnectionError("ambiguous unsafe insert")

    writer = chat_persistence.TurnWriter(initialize, lambda *args: None)
    assert writer.finish("Final", "", timeout=1) is None
    assert len(attempts) == 1


def test_final_can_reuse_confirmed_snapshot_after_a_different_checkpoint_failed(monkeypatch):
    monkeypatch.setattr(chat_persistence, "CHECKPOINT_INTERVAL", 0.01)
    first_saved, failed = threading.Event(), threading.Event()

    def write(previous, content, reasoning):
        if content == "Failed draft":
            failed.set()
            raise ConnectionError("checkpoint failed before commit")
        first_saved.set()
        return {"id": "saved", "content": content}

    writer = chat_persistence.TurnWriter(lambda: None, write, retry_safe=True)
    writer.submit("Confirmed draft", "")
    assert first_saved.wait(1)
    writer.submit("Failed draft", "")
    assert failed.wait(1)
    saved = writer.finish("Confirmed draft", "", timeout=1)
    assert saved["content"] == "Confirmed draft"
    assert writer.error is None
