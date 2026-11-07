"""Shared pytest fixtures for BMO backend tests."""

from __future__ import annotations

import importlib
import pytest


@pytest.fixture(autouse=True)
def local_test_runtime(monkeypatch):
    # Production defaults require shared storage. Unit tests explicitly choose
    # local memory; integration workers supply their isolated Redis URI.
    monkeypatch.setenv("BMO_ENV", "test")
    monkeypatch.setenv("RATELIMIT_STORAGE_URI", "memory://")


@pytest.fixture
def provider_budget(monkeypatch):
    """A billing-service double for existing adapter/protocol unit tests.

    These tests replace the provider SDK already. Admission denial/DB behavior
    is exercised separately with the real service and real Postgres SQL tests.
    """
    from app import usage_service
    admissions, settlements = [], []
    monkeypatch.setattr(usage_service, "reserve_usage", lambda *args, **kwargs: admissions.append((args, kwargs)))
    monkeypatch.setattr(usage_service, "settle_usage", lambda *args, **kwargs: settlements.append((args, kwargs)))
    with usage_service.scope("10000000-0000-0000-0000-000000000001"):
        yield admissions, settlements


@pytest.fixture()
def client(monkeypatch):
    # Legacy gateway tests stub their persistence calls individually. Customize
    # storage is exercised with the real store and a tenant-aware DB double.
    from app import store
    monkeypatch.setattr(store, "get_preferences", lambda user_id: {"instructions": ""})
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "test-jwt-secret")
    monkeypatch.setenv("SUPABASE_STORAGE_BUCKET", "bimo-attachments")
    monkeypatch.setenv("NVIDIA_API_KEY", "test-nvidia-key")
    monkeypatch.setenv("NVIDIA_MODEL", "meta/llama-3.3-70b-instruct")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-deepgram-key")
    monkeypatch.setenv("CORS_ORIGINS", "*")

    main = importlib.import_module("app.main")
    importlib.reload(main)
    app = main.create_app()
    app.testing = True
    with app.test_client() as c:
        yield c
