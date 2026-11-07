"""Backend proof validation and session-bound abuse clearance."""
import importlib
import os
import time
import uuid
from unittest.mock import MagicMock

import jwt
import pytest
import requests

OWNER = "10000000-0000-0000-0000-000000000001"
SESSION = "20000000-0000-0000-0000-000000000001"


@pytest.fixture
def protection(client, monkeypatch):
    module = importlib.import_module("app.turnstile")
    monkeypatch.setenv("TURNSTILE_ENABLED", "1")
    monkeypatch.setenv("TURNSTILE_SECRET_KEY", "fixture-turnstile-secret-server-only")
    monkeypatch.setenv("TURNSTILE_EXPECTED_HOSTNAMES", "frontend.invalid")
    monkeypatch.setenv("RATELIMIT_STORAGE_URI", os.environ["BMO_TEST_REDIS_URL"])
    monkeypatch.setenv("BMO_SECURITY_NAMESPACE", "proof-" + uuid.uuid4().hex)
    from app.main import create_app
    app = create_app(); app.testing = True
    return module, app.test_client()


def token(*, session=SESSION, owner=OWNER, expiry=None):
    return jwt.encode({"sub": owner, "session_id": session, "exp": expiry or int(time.time()) + 3600,
        "aud": "authenticated", "iss": "https://example.supabase.co/auth/v1"}, "test-jwt-secret", algorithm="HS256")


def auth(**kwargs): return {"Authorization": "Bearer " + token(**kwargs)}


def siteverify(module, monkeypatch, result=None):
    post = MagicMock()
    post.return_value.ok = True
    post.return_value.json.return_value = result if result is not None else {"success": True, "hostname": "frontend.invalid", "action": "bimo_paid"}
    monkeypatch.setattr(module.requests, "post", post)
    return post


def test_paid_calls_require_clearance_even_without_browser_headers(protection):
    _, client = protection
    for path in ["/chat", "/images/generate", "/tts", "/tts/ticket", "/transcribe", "/search", "/scrape", "/attachments", "/export"]:
        assert client.post(path, headers=auth(), json={}).status_code == 403
        assert client.post(path, headers={**auth(), "Origin": "https://frontend.invalid", "X-Bimo-Clearance": "forged"}, json={}).json["code"] == "verification_required"
    assert client.post("/security/clearance", json={"token": "fixture-proof"}).status_code == 401


@pytest.mark.parametrize("result", [
    {"success":False}, {"success":True,"hostname":"attacker.invalid","action":"bimo_paid"},
    {"success":True,"hostname":"frontend.invalid","action":"other"}, [], {"success":1,"hostname":"frontend.invalid","action":"bimo_paid"},
])
def test_invalid_or_wrong_site_proof_never_gets_clearance(protection, monkeypatch, result):
    module, client = protection
    siteverify(module, monkeypatch, result)
    response = client.post("/security/clearance", headers=auth(), json={"token":"fixture-proof"})
    assert response.status_code == 403 and "clearance" not in response.json


def test_proof_replay_provider_outage_and_oversize_are_denied(protection, monkeypatch):
    module, client = protection
    post = siteverify(module, monkeypatch)
    assert client.post("/security/clearance", headers=auth(), json={"token":"fixture-proof"}).status_code == 201
    assert client.post("/security/clearance", headers=auth(), json={"token":"fixture-proof"}).status_code == 403
    assert post.call_count == 1
    post.side_effect = requests.Timeout("private provider details")
    response = client.post("/security/clearance", headers=auth(), json={"token":"fresh-proof"})
    assert response.status_code == 503 and "private provider" not in response.text
    assert client.post("/security/clearance", headers=auth(), json={"token":"x"*2049}).status_code == 422


def test_clearance_is_session_bound_expires_and_survives_access_token_refresh(protection, monkeypatch):
    module, client = protection
    post = siteverify(module, monkeypatch)
    response = client.post("/security/clearance", headers=auth(), json={"token":"fixture-proof"})
    assert response.status_code == 201 and 0 < response.json["expires_in"] <= 900
    clearance = response.json["clearance"]
    headers = {**auth(), "X-Bimo-Clearance": clearance}
    # 422 here is the real ticket endpoint's payload validation, after clearance.
    assert client.post("/tts/ticket", headers=headers, json=[]).status_code == 422
    assert client.post("/tts/ticket", headers={**auth(expiry=int(time.time())+7200), "X-Bimo-Clearance":clearance},json=[]).status_code == 422
    for wrong in [auth(session=str(uuid.uuid4())), auth(owner=str(uuid.uuid4()))]:
        assert client.post("/tts/ticket", headers={**wrong,"X-Bimo-Clearance":clearance},json=[]).status_code == 403
    assert post.call_args.kwargs["timeout"] <= 5
    from app import security_store
    keys=list(security_store.redis_client().scan_iter(match=security_store.namespace()+":clearance:*"))
    assert len(keys)==1 and clearance.encode() not in keys[0]
    security_store.redis_client().expire(keys[0],0)
    assert client.post("/tts/ticket",headers=headers,json=[]).status_code == 403


def test_only_trusted_edge_ip_goes_to_siteverify(protection, monkeypatch):
    module, client = protection
    post = siteverify(module, monkeypatch)
    client.post("/security/clearance",headers={**auth(),"CF-Connecting-IP":"203.0.113.8","X-Bimo-Client-IP":"203.0.113.8"},json={"token":"fixture-proof"})
    assert "remoteip" not in post.call_args.kwargs["data"]
