"""Admission-service behavior; SQL isolation/concurrency is tested in real PG."""
from types import SimpleNamespace
import uuid

import pytest

from app import usage_service

USER = "10000000-0000-0000-0000-000000000001"
REQUEST = "20000000-0000-0000-0000-000000000001"


@pytest.fixture
def rpc(monkeypatch):
    calls = []
    response = {"admitted": True, "fresh": True, "request_id": REQUEST, "reserved_units": 100}

    def invoke(name, params):
        calls.append((name, params))
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=dict(response)))

    monkeypatch.setattr(usage_service, "supabase", lambda: SimpleNamespace(rpc=invoke))
    monkeypatch.setenv("BMO_GLOBAL_THINKING_UNITS_PER_DAY", "1000000")
    return calls, response


def test_reserves_authoritatively_before_allowing_work(rpc):
    calls, _ = rpc
    reservation = usage_service.reserve_usage(USER, REQUEST, "thinking", 100)
    assert reservation["request_id"] == REQUEST
    assert calls[0][0] == "bmo_reserve_usage"
    assert calls[0][1]["p_user_id"] == USER
    assert calls[0][1]["p_units"] == 100
    assert calls[0][1]["p_global_limit"] == 1000000


@pytest.mark.parametrize("reason", ["user_limit", "resource_user_limit", "global_limit"])
def test_quota_denials_never_admit_work(rpc, reason):
    _, response = rpc
    response.update(admitted=False, reason=reason)
    with pytest.raises(usage_service.QuotaExceeded):
        usage_service.reserve_usage(USER, REQUEST, "thinking", 100)


def test_reused_reservation_cannot_authorize_another_provider_call(rpc):
    _, response = rpc
    response["fresh"] = False
    with pytest.raises(usage_service.AdmissionConflict):
        usage_service.reserve_usage(USER, REQUEST, "thinking", 100)


def test_missing_or_invalid_global_budget_fails_closed(rpc, monkeypatch):
    calls, _ = rpc
    for value in [None, "", "0", "-1", "unlimited"]:
        if value is None:
            monkeypatch.delenv("BMO_GLOBAL_THINKING_UNITS_PER_DAY", raising=False)
        else:
            monkeypatch.setenv("BMO_GLOBAL_THINKING_UNITS_PER_DAY", value)
        with pytest.raises(usage_service.MeteringUnavailable):
            usage_service.reserve_usage(USER, str(uuid.uuid4()), "thinking", 100)
    assert calls == []


def test_database_failure_never_returns_an_admission(rpc, monkeypatch):
    monkeypatch.setattr(usage_service, "supabase", lambda: (_ for _ in ()).throw(ConnectionError("offline")))
    with pytest.raises(usage_service.MeteringUnavailable):
        usage_service.reserve_usage(USER, REQUEST, "thinking", 100)


@pytest.mark.parametrize("data", [{}, None, [], {"admitted": True}, {"admitted": "yes", "fresh": True}])
def test_malformed_rpc_response_fails_closed(rpc, monkeypatch, data):
    monkeypatch.setattr(usage_service, "supabase", lambda: SimpleNamespace(rpc=lambda *_: SimpleNamespace(execute=lambda: SimpleNamespace(data=data))))
    with pytest.raises(usage_service.MeteringUnavailable):
        usage_service.reserve_usage(USER, REQUEST, "thinking", 100)


def test_settlement_is_bound_to_identity_and_request(rpc):
    calls, _ = rpc
    usage_service.settle_usage(USER, REQUEST, 90)
    assert calls == [("bmo_settle_usage", {"p_user_id": USER, "p_external_principal": None, "p_request_id": REQUEST, "p_used_units": 90})]


def test_settlement_failure_is_explicit_so_the_reservation_can_be_retained(rpc, monkeypatch):
    monkeypatch.setattr(usage_service, "supabase", lambda: (_ for _ in ()).throw(ConnectionError("offline")))
    with pytest.raises(usage_service.MeteringUnavailable):
        usage_service.settle_usage(USER, REQUEST, 90)


def test_usage_outage_does_not_report_zero(monkeypatch):
    from app.routes import helpers
    monkeypatch.setattr(helpers.store, "recent_usage_events", lambda *_: (_ for _ in ()).throw(ConnectionError("offline")))
    with pytest.raises(usage_service.MeteringUnavailable):
        helpers.get_usage_status(USER)


def test_usage_history_reads_past_the_database_row_cap(monkeypatch):
    from app import store
    rows = [{"id": str(index), "model": "thinking", "tokens": 1, "created_at": "2026-11-03T00:00:00Z"} for index in range(1201)]
    class Query:
        def select(self, *_): return self
        def eq(self, *_): return self
        def gte(self, *_): return self
        def order(self, *_): return self
        def range(self, start, end): self.slice = rows[start:end+1]; return self
        def execute(self): return SimpleNamespace(data=getattr(self, "slice", rows[:1000]))
    monkeypatch.setattr(store, "supabase", lambda: SimpleNamespace(table=lambda *_: Query()))
    monkeypatch.setattr(usage_service, "held_usage", lambda *_: [])
    assert len(store.recent_usage_events(USER, "2026-10-27")) == 1201


def test_pending_reservations_are_visible_in_usage(monkeypatch):
    from app.routes import helpers
    monkeypatch.setattr(helpers.store, "recent_usage_events", lambda *_: [
        {"model": "deep", "tokens": 1000, "created_at": "2026-11-03T00:00:00Z", "held": True},
    ])
    assert helpers.get_usage_status(USER)["pending"] == 5000


def test_historical_negative_rows_cannot_replenish_allowance(monkeypatch):
    from app.routes import helpers
    from datetime import datetime, timezone
    monkeypatch.setattr(helpers.store, "recent_usage_events", lambda *_: [
        {"model": "thinking", "tokens": -100000, "created_at": datetime.now(timezone.utc).isoformat()},
    ])
    assert helpers.get_usage_status(USER)["session"]["used"] == 0


def test_accounting_outage_returns_503_before_any_paid_work(client, monkeypatch):
    import jwt
    import time
    from app import nvidia_client, store
    secret = "fixture-only-signing-key-for-usage-tests"
    monkeypatch.setenv("SUPABASE_JWT_SECRET", secret)
    token = jwt.encode({"sub": USER, "aud": "authenticated", "iss": "https://example.supabase.co/auth/v1",
                        "exp": int(time.time()) + 3600}, secret, algorithm="HS256")
    def unavailable(*_): raise ConnectionError("offline")
    def forbidden(*_, **__): pytest.fail("Provider called during an accounting outage")
    monkeypatch.setattr(store, "recent_usage_events", unavailable)
    monkeypatch.setattr(nvidia_client, "iter_response_with_fallback", forbidden)
    monkeypatch.setattr(nvidia_client, "generate_image", forbidden)
    headers = {"Authorization": f"Bearer {token}"}
    for path, body in [("/chat", {"message": "Explain databases"}), ("/images/generate", {"prompt": "A sunset"})]:
        response = client.post(path, json=body, headers=headers)
        assert response.status_code == 503
        assert "accounting" in response.json["detail"].lower()
    assert client.get("/usage", headers=headers).status_code == 503


def test_provider_call_is_never_made_without_admission(monkeypatch):
    called = []
    def deny(*_, **__): raise usage_service.QuotaExceeded("denied")
    monkeypatch.setattr(usage_service, "reserve_usage", deny)
    provider = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: called.append(kw))))
    with usage_service.scope(USER), pytest.raises(usage_service.QuotaExceeded):
        usage_service.llm_create(provider, {"model": "fixture", "messages": [{"role": "user", "content": "Test"}], "stream": True}, resource="thinking")
    assert called == []


def test_provider_output_is_bounded_and_uncertain_consumption_keeps_full_charge(monkeypatch):
    admissions, settlements, calls = [], [], []
    monkeypatch.setattr(usage_service, "reserve_usage", lambda *args, **kwargs: admissions.append((args, kwargs)))
    monkeypatch.setattr(usage_service, "settle_usage", lambda *args, **kwargs: settlements.append((args, kwargs)))
    class Stream:
        closed = False
        def __iter__(self): return self
        def __next__(self): raise ConnectionError("lost")
        def close(self): self.closed = True
    stream = Stream()
    def create(**kwargs): calls.append(kwargs); return stream
    provider = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    with usage_service.scope(USER):
        response = usage_service.llm_create(provider, {"model": "fixture", "messages": [{"role": "user", "content": "Test"}], "stream": True}, resource="thinking")
        with pytest.raises(ConnectionError): list(response)
    assert 0 < calls[0]["max_tokens"] <= 8192
    assert admissions[0][0][3] >= calls[0]["max_tokens"] + len("Test")
    assert settlements[0][0][2] == admissions[0][0][3]
    assert stream.closed


def test_provider_settlement_failure_preserves_successful_output(monkeypatch, caplog):
    monkeypatch.setattr(usage_service, "reserve_usage", lambda *_, **__: None)
    def unavailable(*_, **__): raise usage_service.MeteringUnavailable("offline")
    monkeypatch.setattr(usage_service, "settle_usage", unavailable)
    provider = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: SimpleNamespace(usage=SimpleNamespace(total_tokens=10), content="Completed"))))
    with usage_service.scope(USER):
        result = usage_service.llm_create(provider, {"model": "fixture", "messages": [], "stream": False}, resource="thinking")
    assert result.content == "Completed"
    assert "settlement_pending" in caplog.text


def test_vision_admission_includes_documented_image_tokens_even_for_a_tiny_uri(monkeypatch):
    import json
    reserved = []
    monkeypatch.setattr(usage_service,"reserve_usage",lambda *args,**kwargs:reserved.append(args[3]))
    monkeypatch.setattr(usage_service,"settle_usage",lambda *args,**kwargs:None)
    provider=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs:SimpleNamespace(usage=None))))
    messages=[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}} for _ in range(3)]}]
    with usage_service.scope(USER):
        usage_service.llm_create(provider,{"model":"google/diffusiongemma-26b-a4b-it","messages":messages,"max_tokens":10},resource="thinking")
    assert reserved[0] >= len(json.dumps(messages,ensure_ascii=False).encode()) + 10 + 1024 + 3*1120


def test_unknown_vision_models_need_an_explicit_documented_budget_before_provider_work(monkeypatch):
    calls=[]
    monkeypatch.setattr(usage_service,"reserve_usage",lambda *a,**k:calls.append('admitted'))
    monkeypatch.setattr(usage_service,"settle_usage",lambda *a,**k:None)
    provider=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs:calls.append('provider') or SimpleNamespace(usage=None))))
    request={"model":"custom/vision","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://fixture.invalid/image"}}]}]}
    with usage_service.scope(USER):
        with pytest.raises(usage_service.MeteringUnavailable):usage_service.llm_create(provider,request,resource="thinking")
        assert calls==[]
        monkeypatch.setenv("BMO_VISION_TOKEN_BUDGETS",'{"custom/vision":8192}')
        usage_service.llm_create(provider,request,resource="thinking")
        assert calls==['admitted','provider']


@pytest.mark.parametrize("conversation_id",[None,"existing"])
def test_denied_image_work_does_not_persist_a_draft_the_browser_will_restore(client,monkeypatch,conversation_id):
    import jwt
    from unittest.mock import MagicMock
    from app.routes import media_routes
    from app import nvidia_client,store
    monkeypatch.setattr(media_routes,"get_usage_status",lambda _: {"blocked":False})
    monkeypatch.setattr(media_routes.image_safety,"check_prompt",lambda _:None)
    monkeypatch.setattr(store,"get_conversation",lambda *_:{"id":"existing","model":"thinking"})
    create,update,write=MagicMock(return_value={"id":"created"}),MagicMock(return_value={"id":"existing"}),MagicMock(return_value={"id":"message"})
    monkeypatch.setattr(store,"create_conversation",create)
    monkeypatch.setattr(store,"update_conversation",update)
    monkeypatch.setattr(store,"add_message",write)
    def denied(*args,**kwargs):raise usage_service.QuotaExceeded("Allowance reached")
    monkeypatch.setattr(usage_service,"reserve_usage",denied)
    provider=MagicMock()
    monkeypatch.setattr(nvidia_client.requests,"post",provider)
    token=jwt.encode({"sub":USER,"exp":9999999999,"aud":"authenticated","iss":"https://example.supabase.co/auth/v1"},"test-jwt-secret",algorithm="HS256")
    response=client.post("/images/generate",headers={"Authorization":"Bearer "+token},json={"prompt":"A calm city","conversation_id":conversation_id})
    assert response.status_code==429
    provider.assert_not_called()
    create.assert_not_called();update.assert_not_called();write.assert_not_called()


@pytest.mark.parametrize("module,model", [("mistral_client", "fixture"), ("groq_client", "fixture"), ("nvidia_client", "native-fixture")])
def test_every_inference_adapter_requires_admission_before_the_sdk(monkeypatch, module, model):
    import importlib
    adapter = importlib.import_module(f"app.{module}")
    calls = []
    fake = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: calls.append(kw) or iter([]))))
    monkeypatch.setattr(adapter, "_client", lambda *args: fake)
    def denied(*_, **__): raise usage_service.QuotaExceeded("denied")
    monkeypatch.setattr(usage_service, "reserve_usage", denied)
    with usage_service.scope(USER), pytest.raises(usage_service.QuotaExceeded):
        list(adapter.iter_response([{"role": "user", "content": "Explain databases"}], model=model, max_tokens=50))
    assert calls == []


def test_search_classifier_never_falls_back_after_admission_denial(monkeypatch):
    from app import search_router
    calls = []
    provider = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: calls.append(kw) or SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="NO"))]))))
    monkeypatch.setattr(search_router, "_classifier_backends", lambda: [("fixture", lambda: provider, "fixture")])
    def denied(*_, **__): raise usage_service.QuotaExceeded("denied")
    monkeypatch.setattr(usage_service, "reserve_usage", denied)
    with usage_service.scope(USER), pytest.raises(usage_service.QuotaExceeded):
        search_router._classify("Explain the news")
    assert calls == []


def test_image_http_request_never_starts_without_admission(monkeypatch):
    from app import nvidia_client
    calls = []
    monkeypatch.setattr(nvidia_client.requests, "post", lambda *a, **kw: calls.append(a) or SimpleNamespace(ok=True, json=lambda: {}))
    def denied(*_, **__): raise usage_service.QuotaExceeded("denied")
    monkeypatch.setattr(usage_service, "reserve_usage", denied)
    with usage_service.scope(USER), pytest.raises(usage_service.QuotaExceeded):
        nvidia_client._post_image("https://test.invalid", "fixture-key", {})
    assert calls == []


@pytest.mark.parametrize("path,payload", [("/tts", {"text": "Hello"}), ("/search", {"query": "Latest news"}), ("/scrape", {"url": "https://example.invalid"})])
def test_auxiliary_routes_return_quota_denial_before_paid_http(client, monkeypatch, path, payload):
    import jwt
    import time
    import requests
    secret = "fixture-only-signing-key-for-usage-tests"
    monkeypatch.setenv("SUPABASE_JWT_SECRET", secret)
    monkeypatch.setenv("TINYFISH_API_KEY", "fixture-only")
    token = jwt.encode({"sub": USER, "aud": "authenticated", "iss": "https://example.supabase.co/auth/v1",
                        "exp": int(time.time()) + 3600}, secret, algorithm="HS256")
    calls = []
    response = SimpleNamespace(ok=True, content=b"fixture", status_code=200, text="", json=lambda: {"results": [{"text": "fixture"}]}, raise_for_status=lambda: None)
    monkeypatch.setattr(requests, "post", lambda *a, **kw: calls.append((a, kw)) or response)
    monkeypatch.setattr(requests, "get", lambda *a, **kw: calls.append((a, kw)) or response)
    def denied(*_, **__): raise usage_service.QuotaExceeded("denied")
    monkeypatch.setattr(usage_service, "reserve_usage", denied)
    result = client.post(path, json=payload, headers={"Authorization": f"Bearer {token}"})
    assert result.status_code == 429
    assert calls == []


def test_worker_import_never_runs_a_paid_startup_probe(monkeypatch):
    import importlib
    from app import nvidia_client
    calls = []
    monkeypatch.setattr(nvidia_client, "is_configured", lambda: True)
    monkeypatch.setattr(nvidia_client, "test_call", lambda: calls.append("completion") or {"ok": True, "model": "fixture"})
    monkeypatch.setattr(nvidia_client, "list_models", lambda: calls.append("catalogue") or [])
    main = importlib.import_module("app.main")
    calls.clear()
    importlib.reload(main)
    assert calls == []


def test_chat_search_denial_reports_error_and_releases_cancellation_lease(client, monkeypatch):
    import jwt
    import time
    from app.routes import chat_routes
    secret = "fixture-only-signing-key-for-usage-tests"
    monkeypatch.setenv("SUPABASE_JWT_SECRET", secret)
    token = jwt.encode({"sub": USER, "aud": "authenticated", "iss": "https://example.supabase.co/auth/v1",
                        "exp": int(time.time()) + 3600}, secret, algorithm="HS256")
    cleared = []
    monkeypatch.setattr(chat_routes, "get_usage_status", lambda _: {"blocked": False})
    monkeypatch.setattr(chat_routes, "_unregister_cancel", lambda event: cleared.append(event))
    def denied(*_, **__): raise usage_service.QuotaExceeded("Allowance reached")
    monkeypatch.setattr(chat_routes.search_router, "should_search", denied)
    monkeypatch.setattr(chat_routes.nvidia_client, "iter_response_with_fallback", lambda *a, **kw: pytest.fail("Inference started after routing admission failed"))
    result = client.post("/chat/incognito", json={"message": "What happened in the news?", "auto_search": True,
                                               "stream_id": "fixture-admission-denial"}, headers={"Authorization": f"Bearer {token}"})
    data = result.get_data(as_text=True)
    assert '"type": "error"' in data
    assert "Allowance reached" in data
    assert len(cleared) == 1


@pytest.mark.parametrize("case,expected", [("quota", 429), ("compressed", 422), ("riva_quota", 429)])
def test_transcription_is_bounded_and_does_not_bypass_admission_via_fallback(client, monkeypatch, case, expected):
    import io
    import time
    import wave
    import jwt
    import requests
    from app.routes import media_routes
    secret = "fixture-only-signing-key-for-usage-tests"
    monkeypatch.setenv("SUPABASE_JWT_SECRET", secret)
    token = jwt.encode({"sub": USER, "aud": "authenticated", "iss": "https://example.supabase.co/auth/v1",
                        "exp": int(time.time()) + 3600}, secret, algorithm="HS256")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1); output.setsampwidth(2); output.setframerate(16000); output.writeframes(b"\0\0" * 16000)
    data = b"OggSfixture" if case == "compressed" else buffer.getvalue()
    calls = []
    monkeypatch.setattr(media_routes.riva_transcribe, "riva_available", lambda: case == "riva_quota")
    monkeypatch.setattr(media_routes, "_rest_transcription_provider", lambda: ("https://test.invalid", "fixture", "fixture"))
    monkeypatch.setattr(requests, "post", lambda *a, **kw: calls.append(a) or SimpleNamespace(ok=True, json=lambda: {"text": "fixture"}))
    def denied(*_, **__): raise usage_service.QuotaExceeded("denied")
    monkeypatch.setattr(usage_service, "reserve_usage", denied)
    monkeypatch.setattr(media_routes.riva_transcribe, "transcribe_wav", denied)
    response = client.post("/transcribe", data={"audio": (io.BytesIO(data), "recording.wav")}, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == expected
    assert calls == []
