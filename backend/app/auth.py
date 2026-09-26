"""Supabase JWT verification for the Bimo Render gateway.

The frontend obtains an ``access_token`` from Supabase Auth (Google OAuth) and
attaches it to every API request as ``Authorization: Bearer <token>``.

Supabase issues JWTs in two shapes depending on project age:

* Legacy projects sign with HS256 using the project's shared
  ``SUPABASE_JWT_SECRET``.
* Newer projects (those using ``sb_publishable_...`` anon keys) sign with
  an asymmetric algorithm (RS256 / ES256) and publish their public keys at
  ``<SUPABASE_URL>/auth/v1/.well-known/jwks.json``.

This module tries asymmetric verification first when a JWKS URL is
reachable, then falls back to the shared secret. Decode failures are
recorded on ``request`` so ``/me`` can return a debug payload when
``DEBUG_AUTH=1``.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from functools import wraps
from typing import Optional

import jwt
from flask import g, jsonify, request

logger = logging.getLogger("bmo.auth")


@dataclass(frozen=True)
class User:
    id: str
    email: Optional[str]
    name: Optional[str]
    avatar_url: Optional[str]
    provider: Optional[str]
    raw: dict

    def to_public(self) -> dict:
        return {
            "id": self.id,
            "email": self.email,
            "name": self.name,
            "avatar_url": self.avatar_url,
            "provider": self.provider,
        }


def _debug_enabled() -> bool:
    return os.environ.get("DEBUG_AUTH") == "1"


def _bearer_token() -> Optional[str]:
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None


def bearer_token() -> Optional[str]:
    """Public accessor for the current request's bearer token."""
    return _bearer_token()


def _jwks_url() -> Optional[str]:
    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    if not base:
        return None
    return f"{base}/auth/v1/.well-known/jwks.json"


def _expected_issuer() -> Optional[str]:
    """Supabase issues tokens with iss=<SUPABASE_URL>/auth/v1. Pinning it
    rejects tokens minted by a *different* Supabase project that would
    otherwise carry a valid signature, audience, and expiry."""
    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    if not base:
        return None
    return f"{base}/auth/v1"


_jwks_client_cache: dict[str, jwt.PyJWKClient] = {}


def _jwks_client() -> Optional[jwt.PyJWKClient]:
    url = _jwks_url()
    if not url:
        return None
    if url not in _jwks_client_cache:
        try:
            # timeout is REQUIRED: PyJWKClient defaults to no timeout, so one
            # network stall to Supabase's JWKS endpoint hangs the fetch — and
            # with it EVERY @require_user request — forever. 8s is well under the
            # gunicorn worker timeout and prewarm_jwks() warms the cache at boot.
            _jwks_client_cache[url] = jwt.PyJWKClient(url, cache_keys=True, timeout=8)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not init JWKS client for %s: %s", url, exc)
            return None
    return _jwks_client_cache[url]


def prewarm_jwks() -> None:
    """Fetch + cache the JWKS signing keys once so the first authed request
    doesn't pay the round-trip (and a cold-start stall can't hang it). Run from
    a background thread at boot, never inline at import — the test fixture's
    fake SUPABASE_URL would otherwise stall startup until the 8s timeout.
    Best-effort: any failure is logged and the per-request path still works."""
    client = _jwks_client()
    if not client:
        return
    try:
        client.get_signing_keys()
        logger.info("JWKS prewarm OK")
    except Exception as exc:  # noqa: BLE001
        logger.warning("JWKS prewarm failed (will fetch lazily): %s", exc)


def _token_header(token: str) -> dict:
    try:
        return jwt.get_unverified_header(token) or {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not parse JWT header: %s", exc)
        return {}


def _decode_with_jwks(token: str, alg: str) -> dict:
    client = _jwks_client()
    if not client:
        raise RuntimeError("JWKS client unavailable (SUPABASE_URL not set?)")
    signing_key = client.get_signing_key_from_jwt(token).key
    return jwt.decode(
        token,
        signing_key,
        algorithms=[alg],
        audience="authenticated",
        issuer=_expected_issuer(),
        options={"require": ["exp", "sub", "aud", "iss"]},
    )


def _decode_with_secret(token: str) -> dict:
    secret = os.environ.get("SUPABASE_JWT_SECRET")
    if not secret:
        raise RuntimeError("SUPABASE_JWT_SECRET is not set")
    return jwt.decode(
        token,
        secret,
        algorithms=["HS256"],
        audience="authenticated",
        issuer=_expected_issuer(),
        options={"require": ["exp", "sub", "aud", "iss"]},
    )


def _decode(token: str) -> dict:
    header = _token_header(token)
    alg = (header.get("alg") or "").upper()
    if alg in {"RS256", "ES256"}:
        return _decode_with_jwks(token, alg)
    if alg == "HS256":
        return _decode_with_secret(token)
    if not alg:
        return _decode_with_secret(token)
    raise RuntimeError(f"Unsupported JWT alg: {alg}")


def _decode_with_diagnostics(token: str) -> tuple[Optional[dict], Optional[str]]:
    """Return (payload, error_string). Logs every failure with the reason."""
    header = _token_header(token)
    alg = (header.get("alg") or "").upper()
    preview = f"{token[:20]}…" if token else ""
    try:
        payload = _decode(token)
        if _debug_enabled():
            logger.info("auth ok token=%s alg=%s sub=%s", preview, alg, payload.get("sub"))
        return payload, None
    except Exception as exc:  # noqa: BLE001
        reason = f"{type(exc).__name__}: {exc}"
        logger.warning("auth failed token=%s alg=%s reason=%s", preview, alg, reason)
        return None, reason


def user_from_token(token: Optional[str]) -> Optional[User]:
    if not token:
        g.auth_error = "missing bearer token"
        return None
    t0 = time.time()
    payload, err = _decode_with_diagnostics(token)
    t_decode = time.time() - t0
    if not payload:
        g.auth_error = err
        logger.warning("auth: decode failed in %.3fs: %s", t_decode, err)
        return None
    metadata = payload.get("user_metadata") or {}
    app_meta = payload.get("app_metadata") or {}
    email = payload.get("email")
    raw_name = (
        metadata.get("full_name")
        or metadata.get("name")
        or metadata.get("user_name")
        or metadata.get("preferred_username")
        or metadata.get("nickname")
        or metadata.get("given_name")
        or (email.split("@")[0] if email else None)
    )
    logger.info("auth: decode ok in %.3fs sub=%s", t_decode, payload.get("sub"))
    return User(
        id=payload["sub"],
        email=email,
        name=raw_name,
        avatar_url=metadata.get("avatar_url") or metadata.get("picture"),
        provider=app_meta.get("provider") or "google",
        raw=payload,
    )


def current_authenticated_user() -> Optional[User]:
    """Returns the verified User for the current request context if already authenticated."""
    return getattr(g, "current_user", None)


def unverified_subject() -> Optional[str]:
    """Extracts subject for diagnostic logging only — never for rate-limiting or authz."""
    token = _bearer_token()
    if not token:
        return None
    try:
        payload = jwt.decode(
            token,
            options={"verify_signature": False, "verify_exp": False, "verify_aud": False},
        )
    except Exception:  # noqa: BLE001
        return None
    sub = payload.get("sub")
    return str(sub) if sub else None


def auth_diagnostics() -> dict:
    """Return a debug-friendly summary of the current request's auth state."""
    token = _bearer_token()
    header = _token_header(token) if token else {}
    return {
        "has_authorization_header": bool(request.headers.get("Authorization")),
        "token_preview": (f"{token[:20]}…" if token else None),
        "token_alg": header.get("alg"),
        "token_kid": header.get("kid"),
        "supabase_url_configured": bool(os.environ.get("SUPABASE_URL")),
        "supabase_jwt_secret_configured": bool(os.environ.get("SUPABASE_JWT_SECRET")),
        "jwks_url": _jwks_url(),
        "last_error": getattr(g, "auth_error", None),
    }


def require_user(handler):
    @wraps(handler)
    def wrapper(*args, **kwargs):
        # rate_limit_key may have already decoded + verified this token during
        # the limiter pass; reuse it instead of decoding the JWT twice.
        user = current_authenticated_user() or user_from_token(bearer_token())
        if not user:
            body = {"detail": "Authentication required"}
            if _debug_enabled():
                body["debug"] = auth_diagnostics()
            return jsonify(body), 401
        g.current_user = user
        return handler(user, *args, **kwargs)

    return wrapper

