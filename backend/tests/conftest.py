"""Shared pytest fixtures for BMO backend tests."""

from __future__ import annotations

import importlib
import pytest


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
