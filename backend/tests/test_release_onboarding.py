"""Account-scoped Bmo release acknowledgments through fresh Auth metadata."""
from __future__ import annotations

import copy
from types import SimpleNamespace

import pytest

from app import store
from tests.test_regressions import db, gateway, headers


@pytest.fixture
def admin(db):
    metadata = {
        "owner": {"full_name": "Owner Name", "avatar_url": "https://example.com/avatar.png", "custom": {"theme": "dark"}},
        "victim": {"full_name": "Other account"},
    }
    calls = []

    def get_user_by_id(uid):
        calls.append(("get", uid))
        return SimpleNamespace(user=SimpleNamespace(id=uid, user_metadata=copy.deepcopy(metadata[uid])))

    def update_user_by_id(uid, attributes):
        calls.append(("update", uid, copy.deepcopy(attributes)))
        # Model replacement so omitting unrelated metadata loses it in tests.
        metadata[uid] = copy.deepcopy(attributes["user_metadata"])
        return SimpleNamespace(user=SimpleNamespace(id=uid, user_metadata=copy.deepcopy(metadata[uid])))

    db.auth = SimpleNamespace(admin=SimpleNamespace(get_user_by_id=get_user_by_id, update_user_by_id=update_user_by_id))
    return SimpleNamespace(metadata=metadata, calls=calls, api=db.auth.admin)


def test_mark_release_merges_fresh_metadata_and_preserves_other_fields(admin):
    assert store.get_seen_release("owner") is None
    store.mark_release_seen("owner", "6.0")
    assert admin.metadata["owner"] == {
        "full_name": "Owner Name", "avatar_url": "https://example.com/avatar.png", "custom": {"theme": "dark"},
        "bmo_release_seen": "6.0",
    }
    assert store.get_seen_release("owner") == "6.0"
    assert admin.metadata["victim"] == {"full_name": "Other account"}
    assert admin.calls[1][0:2] == ("get", "owner")
    assert admin.calls[2][0:2] == ("update", "owner")


def test_me_reads_release_fresh_even_with_same_stale_jwt(gateway, headers, admin):
    first = gateway.get("/me", headers=headers)
    assert first.status_code == 200 and first.json["onboarding_release"] is None
    # Another device saves this marker; the current JWT remains unchanged.
    admin.metadata["owner"]["bmo_release_seen"] = "6.0"
    second = gateway.get("/me", headers=headers)
    assert second.json["onboarding_release"] == "6.0"
    assert "user_metadata" not in second.json and "custom" not in second.json
    assert len([c for c in admin.calls if c == ("get", "owner")]) == 2


def test_post_release_uses_authenticated_account_only(gateway, headers, db, admin):
    response = gateway.post("/onboarding", headers=headers, json={"release": "6.0", "user_id": "victim"})
    assert response.status_code == 200 and response.json == {"status": "ok", "release": "6.0"}
    assert admin.metadata["owner"]["bmo_release_seen"] == "6.0"
    assert "bmo_release_seen" not in admin.metadata["victim"]
    assert not db.rows["profiles"]  # Release-only acknowledgment does not require profile survey columns.


@pytest.mark.parametrize("release", [None, "", "5.0", "7.0", 6, 6.0, True, [], {}])
def test_post_release_rejects_unsupported_values_without_writes(gateway, headers, admin, release):
    response = gateway.post("/onboarding", headers=headers, json={"release": release})
    assert response.status_code == 422
    assert admin.calls == []


def test_release_routes_require_authentication(gateway, admin):
    assert gateway.get("/me").status_code == 401
    assert gateway.post("/onboarding", json={"release": "6.0"}).status_code == 401
    assert admin.calls == []


def test_optional_release_read_failure_does_not_break_me_or_expose_error(gateway, headers, admin):
    admin.api.get_user_by_id = lambda uid: (_ for _ in ()).throw(RuntimeError("private service error"))
    response = gateway.get("/me", headers=headers)
    assert response.status_code == 200 and response.json["onboarding_release"] is None
    assert "private service error" not in response.get_data(as_text=True)


def test_release_save_failure_returns_generic_error(gateway, headers, admin):
    admin.api.update_user_by_id = lambda *a: (_ for _ in ()).throw(RuntimeError("private service error"))
    response = gateway.post("/onboarding", headers=headers, json={"release": "6.0"})
    assert response.status_code == 500
    assert "private service error" not in response.get_data(as_text=True)
    assert "bmo_release_seen" not in admin.metadata["owner"]


def test_legacy_birthday_role_payload_still_updates_profile(gateway, headers, db, admin):
    gateway.get("/me", headers=headers)
    response = gateway.post("/onboarding", headers=headers, json={"birthday": "2000-01-02", "role": "Developer"})
    assert response.status_code == 200 and response.json == {"status": "ok"}
    assert db.rows["profiles"][0]["onboarding_seen"] is True
    assert db.rows["profiles"][0]["birthday"] == "2000-01-02"
    assert db.rows["profiles"][0]["role"] == "Developer"
    assert not any(c[0] == "update" for c in admin.calls)
