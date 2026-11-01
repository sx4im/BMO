"""User, profile, usage, and conversation management routes for Bmo."""

from __future__ import annotations

import logging
import os
from datetime import date, datetime, time, timedelta, timezone

from flask import Blueprint, jsonify, request

from .. import store
from ..auth import auth_diagnostics, require_user
from ..config import KNOWN_MODEL_IDS, UI_MODELS, USAGE_WEIGHTS
from .helpers import bad_request, friendly_error, get_usage_status, parse_iso, validate_project_id

logger = logging.getLogger("bmo.routes.user")

user_bp = Blueprint("user_routes", __name__)


# ---------- Profile & Account ----------

@user_bp.get("/me")
@require_user
def me(user):
    profile = None
    try:
        profile = store.upsert_profile(user)
    except Exception:
        pass
    body = user.to_public()
    body["onboarding_seen"] = bool(profile and profile.get("onboarding_seen"))
    body["birthday"] = profile.get("birthday") if profile else None
    body["role"] = profile.get("role") if profile else None
    if os.environ.get("DEBUG_AUTH") == "1":
        body["debug"] = auth_diagnostics()
    return jsonify(body)


@user_bp.post("/onboarding")
@require_user
def onboarding(user):
    data = request.get_json(silent=True) or {}
    birthday = (data.get("birthday") or "").strip() or None
    role = (data.get("role") or "").strip() or None
    try:
        store.set_onboarding(user.id, birthday=birthday, role=role, seen=True)
    except Exception as exc:  # noqa: BLE001
        return bad_request(f"Could not save your responses. {friendly_error(exc)}", 500)
    return jsonify({"status": "ok"})


@user_bp.get("/usage")
@require_user
def usage(user):
    return jsonify(get_usage_status(user.id))


@user_bp.get("/usage/history")
@require_user
def usage_history(user):
    today = datetime.now(timezone.utc).date()
    try:
        days = int(request.args.get("days", "30"))
        end_text = request.args.get("end", today.isoformat())
        end = date.fromisoformat(end_text)
        if days not in (7, 30) or end.isoformat() != end_text or end > today:
            raise ValueError
        start = end - timedelta(days=days - 1)
        stop = end + timedelta(days=1)
    except (ValueError, OverflowError):
        return bad_request("Choose 7 or 30 days and a valid end date no later than today.", 422)

    models = [*USAGE_WEIGHTS, "other"]
    points = [{"date": (start + timedelta(days=i)).isoformat(), "total": 0,
               "models": dict.fromkeys(models, 0)} for i in range(days)]
    totals = dict.fromkeys(models, 0)
    try:
        events = store.usage_history_events(
            user.id, datetime.combine(start, time.min, timezone.utc).isoformat(),
            datetime.combine(stop, time.min, timezone.utc).isoformat(),
        )
        for event in events:
            timestamp = parse_iso(event.get("created_at", ""))
            if timestamp is None:
                continue
            timestamp = timestamp.replace(tzinfo=timestamp.tzinfo or timezone.utc)
            index = (timestamp.astimezone(timezone.utc).date() - start).days
            if not 0 <= index < days:
                continue
            model = event.get("model", "")
            units = int(max(0, event.get("tokens") or 0) * USAGE_WEIGHTS.get(model, 1.0))
            category = model if model in USAGE_WEIGHTS else "other"
            points[index]["models"][category] += units
            points[index]["total"] += units
            totals[category] += units
    except Exception:
        logger.exception("usage history read failed for user=%s", user.id)
        return bad_request("Could not load usage history. Please try again.", 503)
    return jsonify({"days": days, "start": start.isoformat(), "end": end.isoformat(),
                    "timezone": "UTC", "points": points, "totals": totals})


@user_bp.delete("/me")
@require_user
def delete_me(user):
    try:
        store.delete_all_user_data(user.id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("delete_me data wipe failed for user=%s: %s", user.id, exc)
        return bad_request(f"Could not delete account. {friendly_error(exc)}", 500)
    auth_row_deleted = False
    try:
        store.delete_auth_user(user.id)
        auth_row_deleted = True
    except Exception as exc:  # noqa: BLE001
        logger.warning("delete_me admin.delete_user failed for user=%s: %s", user.id, exc)
    return jsonify({"status": "deleted", "auth_row_deleted": auth_row_deleted})


@user_bp.get("/auth-debug")
def auth_debug():
    if os.environ.get("DEBUG_AUTH") != "1":
        return jsonify({"detail": "auth debug disabled"}), 404
    from ..auth import _bearer_token, _decode_with_diagnostics
    token = _bearer_token()
    payload, err = (None, None)
    if token:
        payload, err = _decode_with_diagnostics(token)
    body = auth_diagnostics()
    body["decode_ok"] = bool(payload)
    body["decode_error"] = err
    if payload:
        body["payload_sub"] = payload.get("sub")
        body["payload_aud"] = payload.get("aud")
        body["payload_exp"] = payload.get("exp")
        body["payload_iss"] = payload.get("iss")
    return jsonify(body)


# ---------- Models Catalog ----------

@user_bp.get("/models")
@require_user
def list_models(user):  # noqa: ARG001
    return jsonify({"models": UI_MODELS, "default": "thinking"})


# ---------- Conversations ----------

@user_bp.get("/conversations")
@require_user
def list_conversations(user):
    return jsonify(store.list_conversations(user.id))


@user_bp.get("/conversations/<conversation_id>/messages")
@require_user
def conversation_messages(user, conversation_id):
    convo = store.get_conversation(conversation_id, user.id)
    if not convo:
        return bad_request("conversation not found", 404)
    messages = store.refresh_attachment_urls(store.get_messages(conversation_id), user.id)
    feedback_map = store.message_feedback_map(user.id)
    for m in messages:
        if m["id"] in feedback_map:
            m["feedback"] = feedback_map[m["id"]]
    return jsonify({"conversation": convo, "messages": messages})


@user_bp.delete("/conversations/<conversation_id>")
@require_user
def delete_conversation(user, conversation_id):
    if not store.delete_conversation(conversation_id, user.id):
        return bad_request("conversation not found", 404)
    return jsonify({"status": "deleted"})


@user_bp.patch("/conversations/<conversation_id>")
@require_user
def patch_conversation(user, conversation_id):
    payload = request.get_json(silent=True) or {}
    for key in ("title", "model", "system_prompt"):
        if key in payload and payload[key] is not None and not isinstance(payload[key], str):
            return bad_request(f"{key} must be a string", 422)
    if "pinned" in payload and not isinstance(payload["pinned"], bool):
        return bad_request("pinned must be a boolean", 422)
    if "project_id" in payload:
        pid = payload["project_id"]
        if pid is not None and not isinstance(pid, str):
            return bad_request("project_id must be a string or null", 422)
        _, err = validate_project_id(pid, user.id)
        if err:
            return err
    if payload.get("model") and payload["model"] not in KNOWN_MODEL_IDS:
        return bad_request("unknown model", 422)
    if payload.get("title") and len(payload["title"]) > 120:
        return bad_request("title too long (max 120 chars)", 422)
    if payload.get("system_prompt") and len(payload["system_prompt"]) > 8000:
        return bad_request("system prompt too long (max 8000 chars)", 422)
    convo = store.update_conversation(conversation_id, user.id, payload)
    if not convo:
        return bad_request("conversation not found", 404)
    return jsonify(convo)


# ---------- Shared Conversations ----------

@user_bp.post("/conversations/<conversation_id>/branch")
@require_user
def branch_conversation(user, conversation_id):
    payload = request.get_json(silent=True) or {}
    message_id = payload.get("before_message_id")
    if not isinstance(message_id, str) or not message_id:
        return bad_request("before_message_id is required", 422)
    try:
        branch = store.branch_conversation(conversation_id, user.id, message_id)
    except ValueError as exc:
        return bad_request(str(exc), 422)
    if not branch:
        return bad_request("conversation or message not found", 404)
    return jsonify(branch), 201

@user_bp.post("/conversations/<conversation_id>/share")
@require_user
def share_conversation(user, conversation_id):
    try:
        shared = store.create_or_update_shared_conversation(conversation_id, user.id)
        return jsonify({
            "success": True,
            "share_id": shared.get("id"),
            "title": shared.get("title"),
            "model": shared.get("model"),
            "created_at": shared.get("created_at"),
            "updated_at": shared.get("updated_at"),
        })
    except PermissionError:
        return bad_request("conversation not found", 404)
    except Exception as exc:  # noqa: BLE001
        logger.exception("share_conversation failed for conv=%s user=%s: %s", conversation_id, user.id, exc)
        return bad_request(f"Could not create share link: {friendly_error(exc)}", 500)


@user_bp.get("/conversations/<conversation_id>/share")
@require_user
def get_conversation_share(user, conversation_id):
    try:
        shared = store.get_shared_conversation_meta(conversation_id, user.id)
        if not shared:
            return jsonify({"shared": False})
        return jsonify({
            "shared": True,
            "share_id": shared.get("id"),
            "title": shared.get("title"),
            "model": shared.get("model"),
            "created_at": shared.get("created_at"),
            "updated_at": shared.get("updated_at"),
        })
    except Exception as exc:  # noqa: BLE001
        logger.exception("get_conversation_share failed for conv=%s user=%s: %s", conversation_id, user.id, exc)
        return bad_request("Could not read share info", 500)


@user_bp.delete("/conversations/<conversation_id>/share")
@require_user
def delete_conversation_share(user, conversation_id):
    try:
        deleted = store.delete_shared_conversation(conversation_id, user.id)
        return jsonify({"success": True, "deleted": deleted})
    except Exception as exc:  # noqa: BLE001
        logger.exception("delete_conversation_share failed for conv=%s user=%s: %s", conversation_id, user.id, exc)
        return bad_request("Could not delete share link", 500)


@user_bp.get("/share/<share_id>")
def public_shared_conversation(share_id):
    try:
        shared = store.get_public_shared_conversation(share_id)
        if not shared:
            return bad_request("Shared conversation not found", 404)
        return jsonify(shared)
    except Exception as exc:  # noqa: BLE001
        logger.exception("public_shared_conversation failed for share_id=%s: %s", share_id, exc)
        return bad_request("Could not load shared conversation", 500)
