"""Production storage configuration and fail-closed rate-limit behavior."""
import pytest
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

from app import security_store


@pytest.mark.parametrize("uri", [None, "", "memory://", "redis+unix:///tmp/redis.sock", "https://example.invalid", "redis://"])
def test_production_requires_shared_redis(monkeypatch, uri):
    monkeypatch.setenv("BMO_ENV", "production")
    monkeypatch.setenv("RATELIMIT_ENABLED", "1")
    if uri is None: monkeypatch.delenv("RATELIMIT_STORAGE_URI", raising=False)
    else: monkeypatch.setenv("RATELIMIT_STORAGE_URI", uri)
    with pytest.raises(RuntimeError):
        security_store.rate_limit_configuration()


def test_production_cannot_disable_rate_limiting(monkeypatch):
    monkeypatch.setenv("BMO_ENV", "production")
    monkeypatch.setenv("RATELIMIT_ENABLED", "0")
    monkeypatch.setenv("RATELIMIT_STORAGE_URI", "rediss://fixture:fixture@redis.invalid:6379/0")
    with pytest.raises(RuntimeError):
        security_store.rate_limit_configuration()


def test_redis_configuration_has_bounded_io_no_memory_fallback_and_tls_verification(monkeypatch):
    monkeypatch.setenv("BMO_ENV", "production")
    monkeypatch.setenv("RATELIMIT_ENABLED", "1")
    monkeypatch.setenv("RATELIMIT_STORAGE_URI", "rediss://fixture:fixture@redis.invalid:6379/0")
    config = security_store.rate_limit_configuration()
    options = config["RATELIMIT_STORAGE_OPTIONS"]
    assert 0 < options["socket_connect_timeout"] <= 2
    assert 0 < options["socket_timeout"] <= 2
    assert options["max_connections"] <= 32
    assert options["ssl_cert_reqs"] == "required"
    assert options["ssl_check_hostname"] is True
    assert config["RATELIMIT_SWALLOW_ERRORS"] is False
    assert config["RATELIMIT_IN_MEMORY_FALLBACK_ENABLED"] is False
    assert "bimo:production" in options["key_prefix"]


def test_local_memory_storage_is_an_explicit_choice(monkeypatch):
    monkeypatch.setenv("BMO_ENV", "development")
    monkeypatch.delenv("RATELIMIT_STORAGE_URI", raising=False)
    with pytest.raises(RuntimeError): security_store.rate_limit_configuration()
    monkeypatch.setenv("RATELIMIT_STORAGE_URI", "memory://")
    assert security_store.rate_limit_configuration()["RATELIMIT_STORAGE_URI"] == "memory://"


def test_authenticated_unix_socket_is_allowed_only_for_local_tests(monkeypatch):
    monkeypatch.setenv("BMO_ENV", "test")
    uri = "redis+unix://:fixture-password@/redis/redis.sock"
    monkeypatch.setenv("RATELIMIT_STORAGE_URI", uri)
    assert security_store.rate_limit_configuration()["RATELIMIT_STORAGE_URI"] == uri


def test_environment_namespaces_cannot_collide(monkeypatch):
    monkeypatch.setenv("RATELIMIT_STORAGE_URI", "redis://localhost:6379/0")
    monkeypatch.setenv("RATELIMIT_ENABLED", "1")
    monkeypatch.setenv("BMO_ENV", "production")
    production = security_store.rate_limit_configuration()["RATELIMIT_KEY_PREFIX"]
    monkeypatch.setenv("BMO_ENV", "test")
    assert security_store.rate_limit_configuration()["RATELIMIT_KEY_PREFIX"] != production


@pytest.mark.parametrize("suffix", ["?socket_timeout=0", "?ssl_cert_reqs=none", "#fragment"])
def test_redis_url_cannot_override_security_options(monkeypatch, suffix):
    monkeypatch.setenv("BMO_ENV", "production")
    monkeypatch.setenv("RATELIMIT_ENABLED", "1")
    monkeypatch.setenv("RATELIMIT_STORAGE_URI", "rediss://fixture:secret-not-for-output@redis.invalid:6379/0" + suffix)
    with pytest.raises(RuntimeError) as error:
        security_store.rate_limit_configuration()
    assert "secret-not-for-output" not in str(error.value)


def test_app_factory_enforces_production_storage(monkeypatch):
    from app.main import create_app
    monkeypatch.setenv("BMO_ENV", "production")
    monkeypatch.setenv("RATELIMIT_ENABLED", "1")
    monkeypatch.setenv("RATELIMIT_STORAGE_URI", "memory://")
    with pytest.raises(RuntimeError): create_app()


def worker(namespace, count=1, *, path="/rate-fixture", unavailable=False):
    uri = os.getenv("BMO_TEST_REDIS_URL")
    assert uri, "Run this integration test with the isolated Redis test fixture."
    if unavailable: uri = uri.replace("redis.sock", "missing.sock")
    env = {**os.environ, "BMO_ENV": "test", "RATELIMIT_ENABLED": "1", "RATELIMIT_STORAGE_URI": uri,
           "BMO_SECURITY_NAMESPACE": namespace, "SUPABASE_URL": "https://fixture.invalid",
           "SUPABASE_JWT_SECRET": "fixture-rate-limit-key-at-least-32-bytes"}
    for key in ("SUPABASE_SERVICE_ROLE_KEY", "NVIDIA_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "DEEPGRAM_API_KEY"):
        env.pop(key, None)
    result = subprocess.run([sys.executable, str(Path(__file__).with_name("rate_limit_worker.py")), "--requests", str(count), "--path", path],
                            env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr[-3000:]
    line = next((line for line in result.stdout.splitlines() if line.startswith("BMO_RATE_RESULT=")), None)
    assert line, result.stderr[-3000:]
    return json.loads(line.split("=", 1)[1])


def test_two_workers_share_limits_and_worker_restart_does_not_reset_them():
    namespace = "bimo-" + uuid.uuid4().hex
    first = worker(namespace, 2)
    second = worker(namespace, 2)
    assert [r["status"] for r in first + second] == [200, 200, 200, 429]
    restarted = worker(namespace)
    assert restarted[0]["status"] == 429
    assert "quickly" in restarted[0]["detail"]
    assert worker("bimo-" + uuid.uuid4().hex)[0]["status"] == 200


def test_storage_failure_denies_protected_requests_and_liveness_stays_available():
    namespace = "bimo-" + uuid.uuid4().hex
    assert worker(namespace, unavailable=True)[0]["status"] == 503
    assert worker(namespace, path="/health", unavailable=True)[0]["status"] == 200
