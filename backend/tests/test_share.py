"""Tests for shared conversations and public snapshot endpoints."""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock, patch

# Ensure missing socket packages don't block tests
mock_sock = types.ModuleType("flask_sock")
mock_sock.Sock = type("Sock", (), {"__init__": lambda self, app=None: None, "route": lambda self, *a, **k: lambda f: f})
sys.modules.setdefault("flask_sock", mock_sock)

mock_sw = types.ModuleType("simple_websocket")
mock_sw.ConnectionClosed = type("ConnectionClosed", (Exception,), {})
sys.modules.setdefault("simple_websocket", mock_sw)

import pytest
import jwt


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "test-jwt-secret")
    monkeypatch.setenv("SUPABASE_STORAGE_BUCKET", "bimo-attachments")
    monkeypatch.setenv("NVIDIA_API_KEY", "test-nvidia-key")
    monkeypatch.setenv("CORS_ORIGINS", "*")

    from app.main import create_app
    app = create_app()
    app.testing = True
    with app.test_client() as c:
        yield c


def make_token(user_id="user-123"):
    return jwt.encode(
        {"sub": user_id, "aud": "authenticated", "iss": "https://example.supabase.co/auth/v1", "exp": 9999999999},
        "test-jwt-secret",
        algorithm="HS256",
    )


def test_unauth_share_routes_require_jwt(client):
    assert client.post("/conversations/conv-1/share").status_code == 401
    assert client.get("/conversations/conv-1/share").status_code == 401
    assert client.delete("/conversations/conv-1/share").status_code == 401


def test_public_share_route_accessible_without_auth(client):
    with patch("app.store.get_public_shared_conversation", return_value=None):
        res = client.get("/share/non-existent-share-id")
        assert res.status_code == 404
        assert "not found" in res.get_json()["detail"].lower()


def test_public_share_returns_snapshot(client):
    mock_snapshot = {
        "id": "share-abc-123",
        "title": "Quantum Physics Overview",
        "model": "thinking",
        "messages": [
            {"role": "user", "content": "What is quantum superposition?"},
            {"role": "assistant", "content": "Superposition is a principle of quantum mechanics..."},
        ],
        "created_at": "2026-09-26T12:00:00Z",
        "updated_at": "2026-09-26T12:00:00Z",
    }
    with patch("app.store.get_public_shared_conversation", return_value=mock_snapshot):
        res = client.get("/share/share-abc-123")
        assert res.status_code == 200
        data = res.get_json()
        assert data["id"] == "share-abc-123"
        assert data["title"] == "Quantum Physics Overview"
        assert len(data["messages"]) == 2


def test_create_share_endpoint(client):
    token = make_token("user-test-1")
    mock_res = {
        "id": "new-share-id",
        "conversation_id": "conv-456",
        "title": "My Conversation",
        "model": "deep",
        "created_at": "2026-09-26T12:00:00Z",
        "updated_at": "2026-09-26T12:00:00Z",
    }
    with patch("app.store.create_or_update_shared_conversation", return_value=mock_res):
        res = client.post(
            "/conversations/conv-456/share",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 200
        body = res.get_json()
        assert body["success"] is True
        assert body["share_id"] == "new-share-id"


def test_get_and_delete_share_endpoint(client):
    token = make_token("user-test-2")
    mock_meta = {
        "id": "share-xyz",
        "conversation_id": "conv-789",
        "title": "Test Title",
        "model": "thinking",
        "created_at": "2026-09-26T12:00:00Z",
        "updated_at": "2026-09-26T12:00:00Z",
    }
    with patch("app.store.get_shared_conversation_meta", return_value=mock_meta):
        res = client.get(
            "/conversations/conv-789/share",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 200
        assert res.get_json()["shared"] is True
        assert res.get_json()["share_id"] == "share-xyz"

    with patch("app.store.delete_shared_conversation", return_value=True):
        res = client.delete(
            "/conversations/conv-789/share",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 200
        assert res.get_json()["deleted"] is True


def test_public_share_route_is_rate_limited(client):
    """The unauthenticated share endpoint must have a per-minute cap (60/min)."""
    with patch("app.store.get_public_shared_conversation", return_value=None):
        statuses = [
            client.get("/share/rate-limit-probe").status_code for _ in range(61)
        ]
    assert all(s == 404 for s in statuses[:-1])
    assert statuses[-1] == 429


def _fake_storage(fresh_url):
    storage = MagicMock()
    storage.from_.return_value.create_signed_url.return_value = {
        "signedURL": fresh_url
    }
    sb = MagicMock()
    sb.storage = storage
    return sb


def test_public_share_resigns_attachment_urls_at_view_time():
    """Stale/long-lived signed URLs in the snapshot must be replaced with
    fresh short-lived ones; the raw path is preserved."""
    from types import SimpleNamespace

    import app.store as store

    row = {
        "id": "share-1",
        "title": "t",
        "model": "thinking",
        "snapshot": [
            {
                "role": "assistant",
                "content": "img",
                "attachments": [
                    {
                        "path": "u1/x/a.png",
                        "filename": "a.png",
                        "content_type": "image/png",
                        "size": 10,
                        "url": "https://STALE-7-day-signed-url",
                    }
                ],
            }
        ],
        "created_at": "x",
        "updated_at": "y",
    }
    sb = _fake_storage("https://fresh-1h-url")
    with patch.object(store, "_execute", return_value=SimpleNamespace(data=[row])), patch.object(
        store, "supabase", return_value=sb
    ):
        out = store.get_public_shared_conversation("12345678-1234-5678-1234-567812345678")
    att = out["messages"][0]["attachments"][0]
    assert att["url"] == "https://fresh-1h-url"
    assert "STALE" not in att["url"]
    assert att["path"] == "u1/x/a.png"
    assert att["filename"] == "a.png"


def test_public_share_drops_url_when_resign_fails():
    """If re-signing fails, no URL (stale or otherwise) is served."""
    from types import SimpleNamespace

    import app.store as store

    row = {
        "id": "share-1",
        "title": "t",
        "model": "thinking",
        "snapshot": [
            {
                "role": "assistant",
                "content": "img",
                "attachments": [
                    {
                        "path": "u1/x/a.png",
                        "filename": "a.png",
                        "content_type": "image/png",
                        "size": 10,
                        "url": "https://STALE-7-day-signed-url",
                    }
                ],
            }
        ],
        "created_at": "x",
        "updated_at": "y",
    }
    sb = MagicMock()
    sb.storage.from_.return_value.create_signed_url.side_effect = RuntimeError("boom")
    with patch.object(store, "_execute", return_value=SimpleNamespace(data=[row])), patch.object(
        store, "supabase", return_value=sb
    ):
        out = store.get_public_shared_conversation("12345678-1234-5678-1234-567812345678")
    att = out["messages"][0]["attachments"][0]
    assert "url" not in att
    assert att["path"] == "u1/x/a.png"


def test_create_share_snapshot_never_persists_signed_urls():
    """The snapshot row written to shared_conversations must not contain
    bearer signed URLs — only path/filename metadata."""
    from types import SimpleNamespace

    import app.store as store

    messages = [
        {
            "id": "m1",
            "role": "assistant",
            "content": "hi",
            "reasoning": None,
            "attachments": [
                {
                    "path": "u1/x/a.png",
                    "filename": "a.png",
                    "content_type": "image/png",
                    "size": 10,
                    "url": "https://STALE-7-day-signed-url",
                }
            ],
            "created_at": "x",
        }
    ]
    captured = {}

    class FakeTable:
        def select(self, *a, **k):
            return self

        def eq(self, *a, **k):
            return self

        def insert(self, payload):
            captured.update(payload)
            return self

        def update(self, payload):
            captured.update(payload)
            return self

    sb = MagicMock()
    sb.table.return_value = FakeTable()
    with patch.object(store, "get_conversation", return_value={"title": "t", "model": "thinking"}), patch.object(
        store, "get_messages", return_value=messages
    ), patch.object(store, "_execute", return_value=SimpleNamespace(data=[])), patch.object(
        store, "supabase", return_value=sb
    ):
        store.create_or_update_shared_conversation("conv-1", "user-1")

    snap = captured["snapshot"]
    assert len(snap) == 1
    for att in snap[0]["attachments"]:
        assert "url" not in att
        assert att["path"] == "u1/x/a.png"
        assert att["filename"] == "a.png"


def test_limiter_honors_redis_url_env(monkeypatch):
    """REDIS_URL is honored as a fallback storage backend for the limiter."""
    import app.limiter as limiter_mod

    monkeypatch.delenv("RATELIMIT_STORAGE_URI", raising=False)
    monkeypatch.delenv("REDIS_URL", raising=False)
    assert limiter_mod.resolve_storage_uri() == "memory://"

    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")
    assert limiter_mod.resolve_storage_uri() == "redis://localhost:6379/0"

    monkeypatch.setenv("RATELIMIT_STORAGE_URI", "redis://other:6379/0")
    assert limiter_mod.resolve_storage_uri() == "redis://other:6379/0"


def test_rate_limit_key_stashes_verified_user_for_require_user(client):
    """A single JWT decode should serve both the limiter pass and @require_user."""
    import app.auth as auth_mod
    import app.limiter as limiter_mod

    token = make_token("user-xyz")
    calls = {"n": 0}
    real_decode = auth_mod.user_from_token

    def counting_decode(t):
        calls["n"] += 1
        return real_decode(t)

    # limiter.py binds user_from_token by name at import; patch both namespaces.
    with patch.object(auth_mod, "user_from_token", side_effect=counting_decode), patch.object(
        limiter_mod, "user_from_token", side_effect=counting_decode
    ):
        res = client.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    assert res.get_json()["id"] == "user-xyz"
    assert calls["n"] == 1
