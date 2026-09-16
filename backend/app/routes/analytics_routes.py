"""Analytics, health status, feedback, and diagnostic routes."""

from __future__ import annotations

import io
import logging
import os

from flask import Blueprint, jsonify, request, send_file

from .. import nvidia_client, riva_tts, store, supabase_client
from ..analytics import build_summary, ratings_chart_png
from ..auth import require_user
from ..config import is_deepgram_configured
from .helpers import bad_request, friendly_error

logger = logging.getLogger("bmo.routes.analytics")

analytics_bp = Blueprint("analytics_routes", __name__)


# ---------- Health Check ----------

@analytics_bp.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "store": "supabase" if supabase_client.is_configured() else "unconfigured",
        "models": "configured" if nvidia_client.is_configured() else "unconfigured",
        "tts": "configured" if (riva_tts.tts_available() or is_deepgram_configured()) else "unconfigured",
    })


# ---------- Feedback ----------

@analytics_bp.post("/feedback")
@require_user
def feedback(user):
    payload = request.get_json(silent=True) or {}
    message_id = payload.get("message_id")
    rating = payload.get("rating")
    correctness = payload.get("correctness")
    length = payload.get("length")

    if not (message_id and type(rating) is int and correctness and length):
        return bad_request("message_id, rating, correctness and length are required", 422)
    if rating < 1 or rating > 5:
        return bad_request("rating must be 1-5", 422)
    if correctness not in {"correct", "partially_correct", "incorrect"}:
        return bad_request("invalid correctness", 422)
    if length not in {"too_short", "ideal", "too_long"}:
        return bad_request("invalid length", 422)
    if not store.message_belongs_to_user(message_id, user.id):
        return bad_request("message not found", 404)

    return jsonify(
        store.upsert_feedback(
            user.id,
            message_id,
            rating=rating,
            correctness=correctness,
            length=length,
        )
    )


# ---------- Analytics & Reports ----------

@analytics_bp.get("/analytics/summary")
@require_user
def analytics_summary(user):
    try:
        return jsonify(store.analytics_summary(user.id))
    except Exception as exc:  # noqa: BLE001
        logger.exception("analytics_summary failed for user=%s: %s", user.id, exc)
        return bad_request(f"Could not load analytics. {friendly_error(exc)}", 500)


@analytics_bp.get("/analytics/report")
@require_user
def analytics_report(user):
    try:
        return jsonify(build_summary(store.all_feedback_dataframe_rows(user.id)))
    except Exception as exc:  # noqa: BLE001
        logger.exception("analytics_report failed for user=%s: %s", user.id, exc)
        return bad_request(f"Could not build report. {friendly_error(exc)}", 500)


@analytics_bp.get("/analytics/chart.png")
@require_user
def analytics_chart(user):
    try:
        png_bytes = ratings_chart_png(store.all_feedback_dataframe_rows(user.id))
    except Exception as exc:  # noqa: BLE001
        logger.exception("analytics_chart failed for user=%s: %s", user.id, exc)
        return bad_request(f"Could not render chart. {friendly_error(exc)}", 500)
    return send_file(
        io.BytesIO(png_bytes),
        mimetype="image/png",
        download_name="rating_distribution.png",
    )


# ---------- Diagnostics ----------

@analytics_bp.get("/nvidia-debug")
def nvidia_debug():
    if os.environ.get("DEBUG_AUTH") != "1":
        return jsonify({"detail": "nvidia debug disabled"}), 404
    result = {
        "base_url": nvidia_client.base_url(),
        "default_model": nvidia_client.default_model(),
        "key": nvidia_client.api_key_fingerprint(),
    }
    if result["key"].get("configured"):
        result["test"] = nvidia_client.test_call()
    else:
        result["test"] = {"ok": False, "skipped": "key not configured"}
    return jsonify(result)
