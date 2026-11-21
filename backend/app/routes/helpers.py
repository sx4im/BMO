"""Shared helper functions for Bmo route blueprints."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from flask import jsonify

from .. import store
from ..config import SESSION_LIMIT, SESSION_WINDOW_S, USAGE_WEIGHTS, WEEKLY_LIMIT, WEEKLY_WINDOW_S

logger = logging.getLogger("bmo.routes.helpers")


def bad_request(detail: str, status: int = 400):
    return jsonify({"detail": detail}), status


def sse_event(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


def friendly_error(exc: Exception) -> str:
    """Turn a low-level exception into an actionable, user-friendly message."""
    msg = str(exc).strip() or exc.__class__.__name__
    lower = msg.lower()
    if "invalid api key" in lower and "nvidia" not in lower:
        return (
            "Supabase rejected the service-role key. Update SUPABASE_SERVICE_ROLE_KEY "
            "in your Render env with the secret/service_role key from Supabase → "
            f"Settings → API. (Underlying error: {msg})"
        )
    if "jwt expired" in lower or "jwt is invalid" in lower:
        return f"Supabase JWT verification failed: {msg}"
    return msg


MODEL_BUSY_REPLY = "Bmo is busy right now. Please try again in a moment."

_TRANSIENT_MODEL_ERRORS = (
    "resourceexhausted", "request limit", "provider_unavailable", "overloaded",
    "rate limit", "429", "500", "502", "503", "504", "unavailable",
    "timeout", "timed out", "network error", "stream interrupted",
)


def model_error_details(exc: Exception) -> dict:
    """Public error state without leaking provider payloads or credentials."""
    if getattr(exc, "code", None) in {"output_limit", "model_incomplete", "empty_response", "model_connection"}:
        return {"code": exc.code, "detail": str(exc), "retryable": bool(getattr(exc, "retryable", False))}
    cause = exc
    seen = set()
    status = None
    retry_after = None
    while cause is not None and id(cause) not in seen:
        seen.add(id(cause))
        status = getattr(cause, "status_code", None) or status
        response = getattr(cause, "response", None)
        headers = getattr(response, "headers", {})
        try:
            if headers.get("retry-after") is not None:
                retry_after = max(0.0, float(headers["retry-after"]))
        except (TypeError, ValueError):
            pass
        cause = cause.__cause__
    lower = str(exc).lower()
    if status == 429 or "rate limit" in lower or "429" in lower:
        result = {"code": "rate_limited", "detail": "The model's rate limit was reached. Please retry after a short wait.", "retryable": True}
    elif status in (401, 403, 404) or any(word in lower for word in ("api_key", "authentication failed", "not configured")):
        result = {"code": "model_unavailable", "detail": "This model is unavailable. Please choose another model.", "retryable": False}
    elif status in (400, 413, 422):
        result = {"code": "model_request", "detail": "The model could not accept this request. Try reducing the input or attachments.", "retryable": False}
    elif status in (408, 504) or "timeout" in lower or "timed out" in lower:
        result = {"code": "model_timeout", "detail": "The model did not respond in time. Your received content has been kept.", "retryable": True}
    elif status in (500, 502, 503) or any(word in lower for word in ("unavailable", "overloaded", "resourceexhausted")):
        result = {"code": "model_unavailable", "detail": "The model service is temporarily unavailable. Please retry shortly.", "retryable": True}
    else:
        result = {"code": "model_connection", "detail": "The model connection was interrupted. Your received content has been kept.",
                  "retryable": isinstance(exc, (ConnectionError, TimeoutError)) or any(marker in lower for marker in _TRANSIENT_MODEL_ERRORS)}
    if retry_after is not None:
        result["retry_after"] = retry_after
    return result


def is_transient_model_error(exc: Exception) -> bool:
    """True only for provider capacity/network errors worth a bounded retry."""
    return model_error_details(exc)["retryable"]


def estimate_tokens(*texts: str) -> int:
    """~4 chars per token estimate for soft quotas."""
    return sum(len(t) for t in texts if t) // 4


def parse_iso(s: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def human_duration(seconds: int) -> str:
    seconds = max(0, int(seconds))
    d, rem = divmod(seconds, 86400)
    h, rem = divmod(rem, 3600)
    m = rem // 60
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m}m"
    return f"{m}m"


def window_reset_at(weighted: list[tuple[datetime, float]], used: float, now: datetime, limit: int, window_s: int) -> datetime:
    """Calculates when a trailing window's weighted usage drops back under limit."""
    if not weighted:
        return now + timedelta(seconds=window_s)
    ordered = sorted(weighted)
    if used < limit:
        return ordered[0][0] + timedelta(seconds=window_s)
    remaining = used
    for ts, w in ordered:
        remaining -= w
        if remaining < limit:
            return ts + timedelta(seconds=window_s)
    return ordered[-1][0] + timedelta(seconds=window_s)


def get_usage_status(user_id: str) -> dict:
    """Trailing-window usage for the two soft limits."""
    now = datetime.now(timezone.utc)
    week_start = now - timedelta(seconds=WEEKLY_WINDOW_S)
    try:
        events = store.recent_usage_events(user_id, week_start.isoformat())
    except Exception:
        logger.warning("usage status read failed for user=%s", user_id, exc_info=True)
        events = []

    parsed: list[tuple[datetime, str, int]] = []
    for e in events:
        ts = parse_iso(e.get("created_at", ""))
        if ts is not None:
            parsed.append((ts, e.get("model", ""), e.get("tokens", 0) or 0))

    def window(start: datetime, limit: int, window_s: int) -> dict:
        weighted = [
            (ts, tokens * USAGE_WEIGHTS.get(model, 1.0))
            for ts, model, tokens in parsed if ts >= start
        ]
        used_f = sum(w for _, w in weighted)
        used = int(used_f)
        resets_at = window_reset_at(weighted, used_f, now, limit, window_s)
        percent = 0 if used <= 0 else min(100, -(-used * 100 // limit)) if limit else 0
        return {
            "used": used,
            "limit": limit,
            "percent": percent,
            "resets_at": resets_at.isoformat(),
            "resets_in_seconds": max(0, int((resets_at - now).total_seconds())),
        }

    session = window(now - timedelta(seconds=SESSION_WINDOW_S), SESSION_LIMIT, SESSION_WINDOW_S)
    weekly = window(week_start, WEEKLY_LIMIT, WEEKLY_WINDOW_S)
    return {
        "session": session,
        "weekly": weekly,
        "blocked": session["used"] >= SESSION_LIMIT or weekly["used"] >= WEEKLY_LIMIT,
    }


def user_owns_path(user_id: str, path: str) -> bool:
    """True only when a storage path sits under the caller's own folder."""
    return store.user_owns_path(user_id, path)


def validate_project_id(project_id: Optional[str], user_id: str) -> tuple[Optional[dict], Optional[tuple]]:
    """Validate project_id is a valid UUID and owned by user.

    Returns (project, None) on success.
    If project_id is None, returns (None, None).
    On error, returns (None, (error_response, status_code)).
    """
    if project_id is None:
        return None, None
    if not isinstance(project_id, str):
        return None, bad_request("project_id must be a string", 422)
    try:
        val = uuid.UUID(str(project_id))
    except (ValueError, AttributeError, TypeError):
        return None, bad_request("project not found", 404)
    project = store.get_project(str(val), user_id)
    if not project:
        return None, bad_request("project not found", 404)
    return project, None


_TRIVIAL_PHRASES = {
    "hi", "hii", "hiii", "hey", "heyy", "hello", "helo", "yo", "yoo", "sup",
    "hiya", "howdy", "hola", "salam", "salaam", "assalam o alaikum",
    "good morning", "good afternoon", "good evening", "good night", "gm", "gn",
    "thanks", "thank you", "thankyou", "thx", "ty", "tysm", "cheers",
    "ok", "okay", "okk", "kk", "cool", "nice", "great", "awesome", "perfect",
    "lol", "haha", "lmao", "np", "no problem", "welcome", "yes", "yeah", "yep",
    "no", "nope", "bye", "goodbye", "see ya", "test", "ping",
}


def is_trivial_prompt(text: str) -> bool:
    """True when user's turn is conversational filler that warrants an instant reply."""
    t = (text or "").strip().lower()
    if not t:
        return True
    stripped = t.strip(" .!,~-")
    if stripped in _TRIVIAL_PHRASES:
        return True
    if len(t) <= 12 and "?" not in t and "`" not in t and "\n" not in t:
        return True
    return False
