"""WhatsApp must use verified, pseudonymous accounting before paid work."""
import logging
import os
import uuid
import sqlite3
import time
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app import usage_service, whatsapp

PHONE = "15551234567"
PEPPER = "fixture-whatsapp-principal-pepper-32-bytes"


@pytest.fixture
def wa(monkeypatch):
    monkeypatch.setenv("BMO_WHATSAPP_IDENTITY_PEPPER", PEPPER)
    monkeypatch.setenv("GROQ_API_KEY", "fixture-provider-key")
    monkeypatch.setattr(whatsapp, "_get_phone_history", lambda phone: [])
    monkeypatch.setattr(whatsapp, "_append_phone_history", lambda *args: None)
    monkeypatch.setattr(whatsapp, "send_whatsapp_message", MagicMock())
    return whatsapp


def test_whatsapp_principal_is_keyed_stable_and_never_a_supabase_user(wa):
    first = wa.principal_for_sender(PHONE)
    assert first == wa.principal_for_sender(PHONE)
    assert first.startswith("wa:") and len(first) == 67 and PHONE not in first
    assert first != wa.principal_for_sender("15551234568")
    assert usage_service._identity(None, first) == {"p_user_id": None, "p_external_principal": first}


def test_missing_identity_secret_denies_model_work(wa, monkeypatch):
    monkeypatch.delenv("BMO_WHATSAPP_IDENTITY_PEPPER")
    model = MagicMock(return_value="unsafe bypass")
    monkeypatch.setattr(wa, "_generate_groq_reply", model)
    wa._process_and_reply_async(PHONE, "private user message")
    model.assert_not_called()


@pytest.mark.parametrize("error", [usage_service.QuotaExceeded(), usage_service.MeteringUnavailable(), usage_service.AdmissionConflict()])
def test_whatsapp_admission_denial_never_calls_sdk_or_falls_back(wa, monkeypatch, error):
    sdk = MagicMock()
    monkeypatch.setattr(wa, "OpenAI", lambda **kwargs: sdk)
    denied = []
    def reserve(*args, **kwargs):
        denied.append((args, kwargs)); raise error
    monkeypatch.setattr(usage_service, "reserve_usage", reserve)
    fallback = MagicMock()
    monkeypatch.setattr(wa.nvidia_client, "iter_response_with_fallback", fallback)
    wa._process_and_reply_async(PHONE, "private user message")
    sdk.chat.completions.create.assert_not_called()
    fallback.assert_not_called()
    assert denied and denied[0][0][0] is None
    assert denied[0][1]["external_principal"] == wa.principal_for_sender(PHONE)
    assert "try again" in wa.send_whatsapp_message.call_args[0][1].lower()


def test_whatsapp_success_is_admitted_and_settled_once(wa, monkeypatch):
    admissions, settlements, config = [], [], []
    sdk = MagicMock()
    sdk.chat.completions.create.return_value = SimpleNamespace(usage={"total_tokens": 30}, choices=[SimpleNamespace(message=SimpleNamespace(content="Reply"))])
    def client(**kwargs): config.append(kwargs); return sdk
    monkeypatch.setattr(wa, "OpenAI", client)
    monkeypatch.setattr(usage_service, "reserve_usage", lambda *a, **k: admissions.append((a,k)))
    monkeypatch.setattr(usage_service, "settle_usage", lambda *a, **k: settlements.append((a,k)))
    wa._process_and_reply_async(PHONE, "Hello")
    assert len(admissions) == len(settlements) == 1
    assert admissions[0][0][2] == "aeon"
    assert settlements[0][0][2] == 30
    assert config[0]["max_retries"] == 0
    sdk.close.assert_called_once()
    assert wa.send_whatsapp_message.call_args[0][1] == "Reply"


def test_whatsapp_operational_logs_exclude_phone_content_and_provider_body(wa, monkeypatch, caplog):
    monkeypatch.setattr(wa, "_generate_groq_reply", lambda *args: "private reply contents")
    with caplog.at_level(logging.INFO): wa._process_and_reply_async(PHONE, "private user message")
    assert PHONE not in caplog.text
    assert "private user message" not in caplog.text
    assert "private reply contents" not in caplog.text


def test_history_uses_pseudonyms_prunes_inactive_rows_and_bounds_each_sender(monkeypatch, tmp_path):
    monkeypatch.setenv("BMO_WHATSAPP_IDENTITY_PEPPER", PEPPER)
    path = tmp_path / "wa-context.db"
    monkeypatch.setattr(whatsapp, "_DB_PATH", str(path))
    whatsapp._init_whatsapp_db()
    with sqlite3.connect(path) as db:
        db.execute("INSERT INTO whatsapp_messages (phone,role,content,created_at) VALUES (?,?,?,?)", ("old raw phone", "user", "expired private text", time.time() - 86401))
    for i in range(45): whatsapp._append_phone_history(PHONE, "user", str(i))
    with sqlite3.connect(path) as db:
        rows = db.execute("SELECT phone,content FROM whatsapp_messages").fetchall()
    assert len(rows) == 40
    assert all(phone.startswith("wa:") and PHONE not in phone for phone, content in rows)
    assert whatsapp._get_phone_history(PHONE)[-1]["content"] == "44"


def test_duplicate_events_do_not_start_extra_workers_and_jobs_have_a_hard_concurrency_bound(wa,monkeypatch):
    import threading
    monkeypatch.setenv("RATELIMIT_STORAGE_URI",os.environ["BMO_TEST_REDIS_URL"])
    monkeypatch.setenv("BMO_SECURITY_NAMESPACE","wa-"+uuid.uuid4().hex)
    monkeypatch.setattr(wa,"_job_slots",threading.BoundedSemaphore(2),raising=False)
    jobs=[]
    class Worker:
        def __init__(self,*,target,args,**kwargs):jobs.append((target,args))
        def start(self):pass
    monkeypatch.setattr(wa,"Thread",Worker,raising=False)
    process=MagicMock()
    monkeypatch.setattr(wa,"_process_and_reply_async",process)
    assert wa._start_message_job(PHONE,"private body","event-1")=="accepted"
    assert wa._start_message_job(PHONE,"private body","event-1")=="duplicate"
    assert wa._start_message_job(PHONE,"second","event-2")=="accepted"
    assert wa._start_message_job(PHONE,"third","event-3")=="busy"
    assert len(jobs)==2
    for target,args in list(jobs):target(*args)
    assert process.call_count==2
    assert wa._start_message_job(PHONE,"third","event-3")=="accepted"
    from app import security_store
    keys=list(security_store.redis_client().scan_iter(match=security_store.namespace()+":wa-event:*"))
    assert all(PHONE.encode() not in key and b"event-" not in key for key in keys)


def test_invalid_signature_and_oversized_webhook_never_start_processing(client,monkeypatch):
    process=MagicMock()
    monkeypatch.setattr(whatsapp,"_process_and_reply_async",process)
    assert client.post('/api/whatsapp/webhook',data=b'x'*1_048_577,headers={'Content-Type':'application/json'}).status_code==413
    assert client.post('/api/whatsapp/webhook',data='{}',headers={'X-Hub-Signature-256':'sha256=\u00e9'}).status_code==403
    process.assert_not_called()


def test_retention_prunes_inactive_senders_without_requiring_a_new_message(monkeypatch,tmp_path):
    path=tmp_path/'history.db'
    monkeypatch.setattr(whatsapp,'_DB_PATH',str(path))
    whatsapp._init_whatsapp_db()
    with sqlite3.connect(path) as db:
        db.executemany('INSERT INTO whatsapp_messages(phone,role,content,created_at) VALUES (?,?,?,?)',[
            ('old-principal','user','expired private body',time.time()-86401),
            ('recent-principal','user','recent body',time.time()),
        ])
    assert whatsapp.prune_phone_history()==1
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT content FROM whatsapp_messages').fetchall()==[('recent body',)]
