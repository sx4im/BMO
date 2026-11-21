"""Boot/readiness must not spend inference quota or wait for model generation."""
import importlib

from app import mistral_client, supabase_client


def test_startup_does_not_issue_paid_inference_by_default(monkeypatch):
    calls = []
    monkeypatch.delenv('BMO_MODEL_STARTUP_PROBE', raising=False)
    monkeypatch.setattr(supabase_client, 'is_configured', lambda: False)
    monkeypatch.setattr(mistral_client, 'is_configured', lambda: True)
    monkeypatch.setattr(mistral_client, 'test_call', lambda: calls.append(True) or {'ok': True, 'model': 'test-model'})
    from app import main
    calls.clear()
    importlib.reload(main)
    assert calls == []


def test_operator_can_explicitly_enable_the_startup_probe(monkeypatch):
    calls = []
    monkeypatch.setenv('BMO_MODEL_STARTUP_PROBE', '1')
    monkeypatch.setattr(supabase_client, 'is_configured', lambda: False)
    monkeypatch.setattr(mistral_client, 'is_configured', lambda: True)
    monkeypatch.setattr(mistral_client, 'test_call', lambda: calls.append(True) or {'ok': True, 'model': 'test-model'})
    from app import main
    calls.clear()
    importlib.reload(main)
    assert calls == [True]
