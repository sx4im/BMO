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
