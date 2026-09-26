"""Shared rate limiter instance and key function for Bimo."""

from __future__ import annotations

import os

from flask import g, has_request_context
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

from .auth import bearer_token, current_authenticated_user, user_from_token


def resolve_storage_uri() -> str:
    """Storage backend for the rate limiter.

    Honors ``RATELIMIT_STORAGE_URI`` (Flask-Limiter's own name), falling back
    to the more common ``REDIS_URL``. Defaults to in-process memory, which is
    NOT shared between gunicorn workers — on multi-worker deploys, point this
    at a Redis instance (e.g. a Render Redis) so limits apply globally.
    """
    return (
        os.getenv("RATELIMIT_STORAGE_URI", "").strip()
        or os.getenv("REDIS_URL", "").strip()
        or "memory://"
    )


def rate_limit_key() -> str:
    """Bucket by verified user id. Limiter runs before @require_user, so decode here."""
    if not has_request_context():
        return "ip:127.0.0.1"
    user = current_authenticated_user()
    if not (user and getattr(user, "id", None)):
        token = bearer_token()
        user = user_from_token(token) if token else None
        if user and getattr(user, "id", None):
            # Stash the verified user so @require_user below reuses it
            # instead of decoding the same JWT a second time.
            g.current_user = user
    if user and getattr(user, "id", None):
        return f"user:{user.id}"
    return f"ip:{get_remote_address()}"


limiter = Limiter(
    key_func=rate_limit_key,
    default_limits=["300 per minute"],
    storage_uri=resolve_storage_uri(),
    strategy="fixed-window",
)
