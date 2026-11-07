"""Operational failures must not echo credentials, provider bodies or user content."""
import logging
from unittest.mock import MagicMock

import jwt

from app import auth
from app.routes import helpers, media_routes

PRIVATE = "fixture-sensitive-provider-body service-key bearer-token user-message"


def test_auth_failures_never_log_or_echo_token_previews_or_exception_bodies(client, monkeypatch, caplog):
    def fail(token): raise RuntimeError(PRIVATE)
    monkeypatch.setattr(auth, "_decode", fail)
    monkeypatch.setenv("DEBUG_AUTH", "1")
    token = "private-login-token-must-not-be-previewed"
    with caplog.at_level(logging.INFO): response = client.get("/me", headers={"Authorization":"Bearer "+token})
    assert response.status_code == 401
    for private in (PRIVATE, token, token[:20]):
        assert private not in caplog.text and private not in response.text
    assert "RuntimeError" in caplog.text


def test_client_errors_never_include_raw_provider_bodies():
    assert PRIVATE not in helpers.friendly_error(RuntimeError(PRIVATE))
    assert "try again" in helpers.friendly_error(RuntimeError(PRIVATE)).lower()


def test_rest_tts_http_failures_keep_body_out_of_logs_and_response(client, monkeypatch, provider_budget, caplog):
    token = jwt.encode({"sub":"10000000-0000-0000-0000-000000000001", "exp":9999999999,"aud":"authenticated","iss":"https://example.supabase.co/auth/v1"}, "test-jwt-secret", algorithm="HS256")
    post = MagicMock()
    post.return_value.ok = False
    post.return_value.status_code = 502
    post.return_value.text = PRIVATE
    monkeypatch.setattr(media_routes.requests,"post",post)
    with caplog.at_level(logging.WARNING):
        response=client.post("/tts",headers={"Authorization":"Bearer "+token},json={"text":"hello"})
    assert response.status_code == 502
    assert PRIVATE not in response.text and PRIVATE not in caplog.text


def test_global_unhandled_error_logs_type_without_exception_value(client, caplog):
    def fail(): raise RuntimeError(PRIVATE)
    client.application.add_url_rule("/security-log-fixture",view_func=fail)
    with caplog.at_level(logging.ERROR): response=client.get("/security-log-fixture")
    assert response.status_code == 500
    assert PRIVATE not in response.text and PRIVATE not in caplog.text
    assert "RuntimeError" in caplog.text


def test_server_assigns_safe_request_ids_and_disables_library_url_info_logs(client, caplog):
    response = client.get("/health",headers={"X-Request-ID":PRIVATE})
    import uuid
    uuid.UUID(response.headers["X-Request-ID"])
    with client.application.test_request_context("/"):
        client.application.preprocess_request()
        with caplog.at_level(logging.WARNING): logging.getLogger("bmo.security-fixture").warning("safe_event")
        from flask import g
        assert caplog.records[-1].bimo_request_id == g.request_id
    for name in ("httpx", "httpcore", "urllib3", "openai"):
        assert logging.getLogger(name).getEffectiveLevel() >= logging.WARNING
