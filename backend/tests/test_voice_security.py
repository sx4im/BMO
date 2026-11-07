"""Voice admission, single-use credentials and bounded provider forwarding."""
import concurrent.futures
import hashlib
import importlib
import json
import os
import subprocess
import sys
import time
import uuid
from unittest.mock import MagicMock

import jwt
import pytest
from redis.exceptions import ConnectionError as RedisConnectionError
from simple_websocket import ConnectionClosed

from app import deepgram_tts, security_store, usage_service

OWNER = "10000000-0000-0000-0000-000000000001"
SETTINGS = {"model": "flux-sienna-en", "sample_rate": 24000}


@pytest.fixture
def voice(monkeypatch):
    module = importlib.import_module("app.voice_security")
    monkeypatch.setenv("RATELIMIT_STORAGE_URI", os.environ["BMO_TEST_REDIS_URL"])
    monkeypatch.setenv("BMO_SECURITY_NAMESPACE", "voice-" + uuid.uuid4().hex)
    return module


def test_ticket_creation_requires_bearer_auth(client):
    assert client.post("/tts/ticket", json=SETTINGS).status_code == 401


def test_ticket_is_hashed_short_lived_resource_bound_and_single_use(voice):
    ticket = voice.issue_ticket(OWNER, SETTINGS, expires_at=time.time() + 3600)
    assert len(ticket) >= 40
    client = security_store.redis_client()
    keys = list(client.scan_iter(match=security_store.namespace() + ":voice:ticket:*"))
    assert len(keys) == 1 and ticket.encode() not in keys[0]
    assert hashlib.sha256(ticket.encode()).hexdigest().encode() in keys[0]
    assert 0 < client.ttl(keys[0]) <= 30
    with pytest.raises(voice.InvalidTicket): voice.consume_ticket(ticket, resource="other")
    # A mismatched use consumes the credential, too.
    with pytest.raises(voice.InvalidTicket): voice.consume_ticket(ticket)
    ticket = voice.issue_ticket(OWNER, SETTINGS, expires_at=time.time() + 3600)
    result = voice.consume_ticket(ticket)
    assert result["user_id"] == OWNER and result["settings"] == SETTINGS
    with pytest.raises(voice.InvalidTicket): voice.consume_ticket(ticket)


def test_expired_ticket_and_expired_parent_session_are_denied(voice):
    with pytest.raises(voice.InvalidTicket): voice.issue_ticket(OWNER, SETTINGS, expires_at=time.time() - 1)
    ticket = voice.issue_ticket(OWNER, SETTINGS, expires_at=time.time() + 3600)
    key = next(security_store.redis_client().scan_iter(match=security_store.namespace() + ":voice:ticket:*"))
    security_store.redis_client().expire(key, 0)
    with pytest.raises(voice.InvalidTicket): voice.consume_ticket(ticket)


def test_concurrent_ticket_replay_admits_once(voice):
    ticket = voice.issue_ticket(OWNER, SETTINGS, expires_at=time.time() + 3600)
    def attempt(_):
        try: voice.consume_ticket(ticket); return True
        except voice.InvalidTicket: return False
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as workers:
        assert sum(workers.map(attempt, range(8))) == 1


def test_ticket_consumption_is_atomic_between_fresh_processes(voice):
    ticket = voice.issue_ticket(OWNER, SETTINGS, expires_at=time.time() + 3600)
    script = """import sys
from app.voice_security import consume_ticket, InvalidTicket
try:
 consume_ticket(sys.argv[1]); print('admitted')
except InvalidTicket:
 print('denied')
"""
    def attempt(_):
        result = subprocess.run([sys.executable, "-c", script, ticket], env=os.environ.copy(), capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
        assert sorted(workers.map(attempt, range(2))) == ["admitted", "denied"]


def test_shared_connection_leases_limit_release_and_expire(voice):
    first, second = voice.acquire_lease(OWNER), voice.acquire_lease(OWNER)
    with pytest.raises(usage_service.QuotaExceeded): voice.acquire_lease(OWNER)
    voice.release_lease(OWNER, first)
    third = voice.acquire_lease(OWNER)
    voice.check_lease(OWNER, third)
    voice.release_lease(OWNER, third)
    voice.release_lease(OWNER, second)
    with pytest.raises(voice.InvalidTicket): voice.check_lease(OWNER, first)


def test_global_lease_limit_and_crashed_worker_expiry(voice):
    owners = [str(uuid.uuid4()) for _ in range(8)]
    leases = [voice.acquire_lease(owner) for owner in owners]
    with pytest.raises(usage_service.QuotaExceeded): voice.acquire_lease(str(uuid.uuid4()))
    client = security_store.redis_client()
    key = next(client.scan_iter(match=security_store.namespace() + ":voice:leases"))
    client.zadd(key, {f"{owners[0]}:{leases[0]}": 1})
    with pytest.raises(voice.InvalidTicket): voice.check_lease(owners[0], leases[0])
    voice.acquire_lease(str(uuid.uuid4()))


def test_security_store_outage_does_not_admit_voice(voice, monkeypatch):
    client = MagicMock()
    client.set.side_effect = RedisConnectionError("private connection URI")
    monkeypatch.setattr(security_store, "redis_client", lambda: client)
    with pytest.raises(security_store.SecurityStoreUnavailable) as error:
        voice.issue_ticket(OWNER, SETTINGS, expires_at=time.time() + 3600)
    assert "private connection" not in str(error.value)


def test_ticket_endpoint_binds_validated_settings_and_jwt_expiry(client, voice):
    token = jwt.encode({"sub": OWNER, "exp": int(time.time()) + 20, "aud": "authenticated", "iss": "https://example.supabase.co/auth/v1"}, "test-jwt-secret", algorithm="HS256")
    response = client.post("/tts/ticket", headers={"Authorization": "Bearer " + token}, json={**SETTINGS, "speed": 1.1, "expressivity": 1})
    assert response.status_code == 201
    assert 0 < response.json["expires_in"] <= 20
    admitted = voice.consume_ticket(response.json["ticket"])
    assert admitted["settings"]["speed"] == 1.1
    for bad in [{"model": "https://bad.invalid"}, {"sample_rate": 123}, {"unexpected": True}, []]:
        assert client.post("/tts/ticket", headers={"Authorization": "Bearer " + token}, json=bad).status_code == 422


def test_websocket_rejects_old_jwt_urls_and_ticket_setting_overrides(client, voice, monkeypatch):
    tts_stream = client.application.view_functions["media_routes.tts_stream"].__wrapped__
    relay = MagicMock()
    monkeypatch.setattr(deepgram_tts, "relay_tts_stream", relay)
    for path in ["/tts/stream?token=old-login-jwt", "/tts/stream?ticket=invalid&model=other"]:
        ws = MagicMock()
        with client.application.test_request_context(path): tts_stream(ws)
        ws.close.assert_called_once()
    relay.assert_not_called()


def test_rejected_chunk_never_opens_provider(monkeypatch):
    connect = MagicMock()
    monkeypatch.setattr(deepgram_tts, "connect", connect)
    monkeypatch.setattr(usage_service, "reserve_usage", lambda *args, **kwargs: (_ for _ in ()).throw(usage_service.QuotaExceeded()))
    ws = MagicMock()
    ws.receive.side_effect = [json.dumps({"type": "Speak", "text": "Denied"}), ConnectionClosed()]
    with usage_service.scope(OWNER): deepgram_tts.relay_tts_stream(ws, api_key="fixture-key")
    connect.assert_not_called()
    assert json.loads(ws.send.call_args[0][0])["status"] == 429


@pytest.mark.parametrize("frame", [b"binary", "[]", "{", '{"type":"Configure"}', '{"type":"Speak","text":"ok","extra":1}', json.dumps({"type": "Speak", "text": "a" * 4001}), " " * 20001])
def test_invalid_frames_never_open_provider(monkeypatch, frame):
    connect = MagicMock()
    monkeypatch.setattr(deepgram_tts, "connect", connect)
    ws = MagicMock()
    ws.receive.side_effect = [frame, ConnectionClosed()]
    deepgram_tts.relay_tts_stream(ws, api_key="fixture-key")
    connect.assert_not_called()
    assert json.loads(ws.send.call_args[0][0])["status"] == 422


def test_control_spam_cannot_extend_meaningful_idle_deadline(monkeypatch):
    now = [0]
    monkeypatch.setattr(deepgram_tts.time, "monotonic", lambda: now[0])
    ws = MagicMock()
    def receive(**kwargs):
        now[0] += 20
        return '{"type":"Flush"}'
    ws.receive.side_effect = receive
    connect = MagicMock()
    monkeypatch.setattr(deepgram_tts, "connect", connect)
    deepgram_tts.relay_tts_stream(ws, api_key="fixture-key")
    assert now[0] <= 80
    connect.assert_not_called()
    assert json.loads(ws.send.call_args[0][0])["status"] == 408


def test_authorization_deadline_closes_before_next_chunk(monkeypatch):
    now = [0]
    monkeypatch.setattr(deepgram_tts.time, "monotonic", lambda: now[0])
    ws = MagicMock()
    def receive(**kwargs):
        now[0] = 31
        return '{"type":"Speak","text":"Too late"}'
    ws.receive.side_effect = receive
    connect = MagicMock()
    monkeypatch.setattr(deepgram_tts, "connect", connect)
    deepgram_tts.relay_tts_stream(ws, api_key="fixture-key", deadline=30)
    connect.assert_not_called()
    assert json.loads(ws.send.call_args[0][0])["status"] == 408


def test_valid_ticket_relay_scope_and_lease_are_released_on_failure(client, voice, monkeypatch):
    ticket = voice.issue_ticket(OWNER, SETTINGS, expires_at=time.time() + 3600)
    def relay(ws, **kwargs):
        assert usage_service.current_identity()["p_user_id"] == OWNER
        kwargs["check_lease"]()
        raise usage_service.QuotaExceeded()
    monkeypatch.setattr(deepgram_tts, "relay_tts_stream", relay)
    ws = MagicMock()
    handler = client.application.view_functions["media_routes.tts_stream"].__wrapped__
    with client.application.test_request_context("/tts/stream?ticket=" + ticket): handler(ws)
    key = security_store.namespace() + ":voice:leases"
    assert security_store.redis_client().zcard(key) == 0
    assert json.loads(ws.send.call_args[0][0])["status"] == 429


def test_server_config_bounds_inbound_websocket_frames(client):
    assert 0 < client.application.config["SOCK_SERVER_OPTIONS"]["max_message_size"] <= 20000
