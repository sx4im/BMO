"""A direct origin request cannot bypass edge controls or forge its client IP."""
from unittest.mock import MagicMock
import time

import pytest

TOKEN = "fixture-edge-origin-secret-at-least-32-bytes"


@pytest.fixture
def edge_client(client, monkeypatch):
    from app.main import create_app
    monkeypatch.setenv("BMO_EDGE_TOKEN", TOKEN)
    monkeypatch.setenv("CORS_ORIGINS", "https://frontend.invalid")
    app = create_app()
    app.testing = True
    return app.test_client()


def test_origin_gate_denies_missing_wrong_and_forged_headers(edge_client):
    for headers in [{}, {"X-Bimo-Edge-Token": "wrong"}, {"X-Forwarded-For": "203.0.113.1", "Origin": "https://frontend.invalid"}]:
        response = edge_client.get("/me", headers=headers)
        assert response.status_code == 403
        assert TOKEN not in response.text
    assert edge_client.options("/chat").status_code == 403
    assert edge_client.post("/api/whatsapp/webhook", json={}).status_code == 403


def test_minimal_liveness_exposes_no_provider_configuration(edge_client):
    response = edge_client.get("/health")
    assert response.status_code == 200 and response.json == {"status": "ok"}
    assert edge_client.get("/health/extra").status_code == 403


def test_valid_edge_passes_to_normal_auth_and_allows_cors_preflight(edge_client):
    assert edge_client.get("/me", headers={"X-Bimo-Edge-Token": TOKEN}).status_code == 401
    response = edge_client.options("/chat", headers={"X-Bimo-Edge-Token": TOKEN, "Origin": "https://frontend.invalid", "Access-Control-Request-Method": "POST"})
    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == "https://frontend.invalid"


def test_edge_secret_rotation_has_a_bounded_explicit_previous_key(edge_client, monkeypatch):
    monkeypatch.setenv("BMO_EDGE_TOKEN_PREVIOUS", "fixture-previous-secret-at-least-32-bytes")
    monkeypatch.setenv("BMO_EDGE_TOKEN_PREVIOUS_EXPIRES_AT", str(int(time.time()) + 3500))
    from app.main import create_app
    app = create_app()
    with app.test_client() as client:
        assert client.get("/me", headers={"X-Bimo-Edge-Token": "fixture-previous-secret-at-least-32-bytes"}).status_code == 401
    monkeypatch.delenv("BMO_EDGE_TOKEN_PREVIOUS")
    with create_app().test_client() as client:
        assert client.get("/me", headers={"X-Bimo-Edge-Token": "fixture-previous-secret-at-least-32-bytes"}).status_code == 403


def test_only_verified_edge_can_supply_rate_limit_ip(edge_client):
    from app.limiter import rate_limit_key
    app = edge_client.application
    app.add_url_rule("/edge-fixture", view_func=lambda: {"key": rate_limit_key()})
    response = edge_client.get("/edge-fixture", headers={"X-Bimo-Edge-Token": TOKEN, "X-Bimo-Client-IP": "203.0.113.8", "X-Forwarded-For": "198.51.100.9"})
    assert response.json == {"key": "ip:203.0.113.8"}
    response = edge_client.get("/edge-fixture", headers={"X-Bimo-Edge-Token": TOKEN, "X-Bimo-Client-IP": "not an IP", "X-Forwarded-For": "198.51.100.9"})
    assert response.json == {"key": "ip:127.0.0.1"}


def test_production_requires_origin_secret_and_exact_https_cors(monkeypatch):
    from app.main import create_app
    monkeypatch.setenv("BMO_ENV", "production")
    monkeypatch.setenv("RATELIMIT_ENABLED", "1")
    monkeypatch.setenv("RATELIMIT_STORAGE_URI", "rediss://fixture:fixture@redis.invalid/0")
    monkeypatch.delenv("BMO_EDGE_TOKEN", raising=False)
    monkeypatch.setenv("CORS_ORIGINS", "https://frontend.invalid")
    with pytest.raises(RuntimeError, match="BMO_EDGE_TOKEN"): create_app()
    monkeypatch.setenv("BMO_EDGE_TOKEN", TOKEN)
    for origins in ["*", "http://frontend.invalid", "https://frontend.invalid/path", ""]:
        monkeypatch.setenv("CORS_ORIGINS", origins)
        with pytest.raises(RuntimeError, match="CORS_ORIGINS"): create_app()
