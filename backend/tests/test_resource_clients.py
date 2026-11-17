"""Resource reuse and transport isolation without external requests."""
import concurrent.futures
import os
from pathlib import Path
import subprocess
import sys
import threading
from types import SimpleNamespace

import httpx
import pytest

from app import supabase_client


@pytest.fixture
def admin_config(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_first")
    monkeypatch.setattr(supabase_client, "_cached_client", None, raising=False)


def test_admin_client_reuses_one_initialized_instance_across_threads(admin_config):
    start = threading.Barrier(8)

    def get_client(_):
        start.wait()
        client = supabase_client.supabase()
        assert client._postgrest is not None
        assert client._storage is not None
        return client

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        clients = list(executor.map(get_client, range(8)))
    assert all(client is clients[0] for client in clients)
    assert supabase_client.supabase() is clients[0]


def test_admin_client_rotates_configuration_without_closing_inflight_client(admin_config, monkeypatch):
    first = supabase_client.supabase()
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_second")
    second = supabase_client.supabase()
    assert second is not first
    assert not first.postgrest.session.is_closed
    monkeypatch.setenv("SUPABASE_URL", "https://other.supabase.co")
    third = supabase_client.supabase()
    assert third is not second
    assert supabase_client.supabase() is third
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY")
    with pytest.raises(RuntimeError):
        supabase_client.supabase()


def test_admin_transport_timeouts_fit_acknowledgment_budget(admin_config):
    client = supabase_client.supabase()
    for timeout in (client.postgrest.session.timeout, client.storage.session.timeout, client.auth._http_client.timeout):
        assert 0 < timeout.connect <= 5
        assert 0 < timeout.read <= 20
        assert 0 < timeout.write <= 20
        assert 0 < timeout.pool <= 5
    assert not client.options.auto_refresh_token
    assert not client.options.persist_session


def test_admin_requests_keep_component_urls_and_original_credentials(admin_config, monkeypatch):
    requests = []

    def send(self, request, **kwargs):
        requests.append(request)
        if "/rest/v1/" in str(request.url):
            return httpx.Response(200, json=[], request=request)
        if "/storage/v1/" in str(request.url):
            return httpx.Response(200, content=b"attachment", request=request)
        return httpx.Response(200, json={}, request=request)

    monkeypatch.setattr(httpx.Client, "send", send)
    first = supabase_client.supabase()
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_second")
    second = supabase_client.supabase()
    for client in (first, second):
        assert client.table("messages").select("id").execute().data == []
        assert client.storage.from_("files").download("user/file") == b"attachment"
        client.auth.admin.delete_user("00000000-0000-4000-8000-000000000001")
    assert [request.url.path for request in requests] == [
        "/rest/v1/messages", "/storage/v1/object/files/user/file", "/auth/v1/admin/users/00000000-0000-4000-8000-000000000001",
    ] * 2
    assert [request.headers["authorization"] for request in requests] == ["Bearer sb_secret_first"] * 3 + ["Bearer sb_secret_second"] * 3
    assert [request.headers["apikey"] for request in requests] == ["sb_secret_first"] * 3 + ["sb_secret_second"] * 3


def test_chat_startup_defers_heavy_analytics_imports():
    backend = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "-c", "import dotenv; dotenv.load_dotenv=lambda *a,**k:False; import app.main,sys; assert 'pandas' not in sys.modules; assert 'matplotlib.pyplot' not in sys.modules; assert 'plotly' not in sys.modules"],
        cwd=backend, env={"PATH": os.defpath, "RATELIMIT_ENABLED": "0"},
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr


def test_deferred_analytics_still_returns_report_and_png(monkeypatch):
    from flask import Flask
    from app.routes import analytics_routes

    monkeypatch.setattr(analytics_routes.store, "all_feedback_dataframe_rows", lambda user_id: [
        {"rating": 4, "correctness": "correct", "length": "just_right"},
        {"rating": 2, "correctness": "incorrect", "length": "too_long"},
    ])
    app = Flask(__name__)
    with app.test_request_context():
        report = analytics_routes.analytics_report.__wrapped__(SimpleNamespace(id="test-user"))
        assert report.get_json() == {
            "total": 2, "average_rating": 3.0,
            "ratings": [{"rating": 2, "count": 1}, {"rating": 4, "count": 1}],
            "correctness": [{"label": "correct", "count": 1}, {"label": "incorrect", "count": 1}],
            "length": [{"label": "just_right", "count": 1}, {"label": "too_long", "count": 1}],
        }
        chart = analytics_routes.analytics_chart.__wrapped__(SimpleNamespace(id="test-user"))
        chart.direct_passthrough = False
        assert chart.mimetype == "image/png"
        assert chart.get_data().startswith(b"\x89PNG\r\n\x1a\n")
