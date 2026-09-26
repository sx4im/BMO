"""Regression tests for the WhatsApp webhook hardening (finding a).

- Sender allowlist (WHATSAPP_ALLOWED_NUMBERS) rejects unknown senders and
  fails closed when unset.
- Per-sender daily usage cap rejects over-limit senders.
- Logs never contain raw phone numbers or message bodies.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import sys
import types

# Ensure missing socket packages don't block tests
mock_sock = types.ModuleType("flask_sock")
mock_sock.Sock = type("Sock", (), {"__init__": lambda self, app=None: None, "route": lambda self, *a, **k: lambda f: f})
sys.modules.setdefault("flask_sock", mock_sock)

mock_sw = types.ModuleType("simple_websocket")
mock_sw.ConnectionClosed = type("ConnectionClosed", (Exception,), {})
sys.modules.setdefault("simple_websocket", mock_sw)

import pytest

from app import whatsapp


@pytest.fixture()
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "test-jwt-secret")
    monkeypatch.setenv("SUPABASE_STORAGE_BUCKET", "bimo-attachments")
    monkeypatch.setenv("NVIDIA_API_KEY", "test-nvidia-key")
    monkeypatch.setenv("CORS_ORIGINS", "*")
    monkeypatch.setenv("WHATSAPP_APP_SECRET", "test-app-secret")
    # Point the WhatsApp SQLite memory at a throwaway DB per test.
    monkeypatch.setattr(whatsapp, "_DB_PATH", str(tmp_path / "wa.db"))
    whatsapp._init_whatsapp_db()

    import importlib

    main = importlib.import_module("app.main")
    importlib.reload(main)
    app = main.create_app()
    app.testing = True
    with app.test_client() as c:
        yield c


def _signed_payload(secret: str, body: dict, sender: str, text: str):
    payload = {
        "entry": [
            {
                "changes": [
                    {
                        "value": {
                            "messages": [
                                {
                                    "from": sender,
                                    "type": "text",
                                    "text": {"body": text},
                                }
                            ]
                        }
                    }
                ]
            }
        ]
    }
    raw = json.dumps(payload).encode()
    sig = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return raw, {"X-Hub-Signature-256": f"sha256={sig}", "Content-Type": "application/json"}


def _post_message(client, sender, text="hello", monkeypatch=None):
    import threading as _real_threading

    spawns = []

    class RecordingThread:
        def __init__(self, target=None, args=(), daemon=None, **kwargs):
            spawns.append((target, args))

        def start(self):
            pass

    class ThreadShim:
        """Shadows only app.whatsapp's `threading` reference: Thread spawns
        are recorded while the real threading module (and its Timer internals)
        stays untouched."""

        Thread = RecordingThread

        def __getattr__(self, name):
            return getattr(_real_threading, name)

    monkeypatch.setattr(whatsapp, "threading", ThreadShim())
    raw, headers = _signed_payload("test-app-secret", {}, sender, text)
    res = client.post("/api/whatsapp/webhook", data=raw, headers=headers)
    # Only count the WhatsApp worker spawns.
    worker_spawns = [t for t in spawns if t[0] is whatsapp._process_and_reply_async]
    return res, worker_spawns


def test_rejects_unknown_sender(client, monkeypatch):
    monkeypatch.setenv("WHATSAPP_ALLOWED_NUMBERS", "+15551234567")
    res, threads = _post_message(client, "+19998887777", monkeypatch=monkeypatch)
    assert res.status_code == 200
    assert threads == []


def test_allows_listed_sender(client, monkeypatch):
    monkeypatch.setenv("WHATSAPP_ALLOWED_NUMBERS", "+1 555-123-4567")
    res, threads = _post_message(client, "15551234567", monkeypatch=monkeypatch)
    assert res.status_code == 200
    assert len(threads) == 1  # _process_and_reply_async spawned


def test_fail_closed_when_allowlist_unset(client, monkeypatch):
    monkeypatch.delenv("WHATSAPP_ALLOWED_NUMBERS", raising=False)
    res, threads = _post_message(client, "+15551234567", monkeypatch=monkeypatch)
    assert res.status_code == 200
    assert threads == []


def test_daily_usage_cap(client, monkeypatch):
    monkeypatch.setenv("WHATSAPP_ALLOWED_NUMBERS", "+15551234567")
    monkeypatch.setattr(whatsapp, "WHATSAPP_DAILY_LIMIT", 2)
    for _ in range(2):
        whatsapp._append_phone_history("+15551234567", "user", "prior message")
    res, threads = _post_message(client, "+15551234567", monkeypatch=monkeypatch)
    assert res.status_code == 200
    assert threads == []


def test_under_cap_is_processed(client, monkeypatch):
    monkeypatch.setenv("WHATSAPP_ALLOWED_NUMBERS", "+15551234567")
    monkeypatch.setattr(whatsapp, "WHATSAPP_DAILY_LIMIT", 5)
    res, threads = _post_message(client, "+15551234567", monkeypatch=monkeypatch)
    assert res.status_code == 200
    assert len(threads) == 1


def test_invalid_signature_still_rejected(client, monkeypatch):
    monkeypatch.setenv("WHATSAPP_ALLOWED_NUMBERS", "+15551234567")
    raw, _ = _signed_payload("wrong-secret", {}, "+15551234567", "hello")
    res = client.post(
        "/api/whatsapp/webhook",
        data=raw,
        headers={"X-Hub-Signature-256": "sha256=deadbeef", "Content-Type": "application/json"},
    )
    assert res.status_code == 403


def test_logs_scrub_phone_and_body(client, monkeypatch, caplog):
    monkeypatch.setenv("WHATSAPP_ALLOWED_NUMBERS", "+15551234567")
    secret_body = "my secret medical question 4829"
    with caplog.at_level(logging.INFO, logger="bmo.whatsapp"):
        _post_message(client, "+15551234567", text=secret_body, monkeypatch=monkeypatch)
    log_text = caplog.text
    assert secret_body not in log_text
    assert "+15551234567" not in log_text
    assert "15551234567" not in log_text


def test_verify_webhook_unconfigured_returns_403_not_503(client, monkeypatch):
    monkeypatch.setenv("WHATSAPP_VERIFY_TOKEN", "")
    monkeypatch.setattr(whatsapp, "WHATSAPP_VERIFY_TOKEN", "")
    res = client.get(
        "/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=abc"
    )
    assert res.status_code == 403  # same as a token mismatch: no config-state oracle
