"""Authenticate our fixed Cloudflare gateway before trusting forwarded metadata."""
from __future__ import annotations

import hmac
import ipaddress
import logging
import os
import time
from urllib.parse import urlsplit

from flask import g, jsonify, request

logger = logging.getLogger("bmo.edge")


def configure_edge(app):
    production = os.getenv("BMO_ENV", "production").strip().lower() == "production"
    current = os.getenv("BMO_EDGE_TOKEN", "")
    previous = os.getenv("BMO_EDGE_TOKEN_PREVIOUS", "")
    if (production or current) and len(current) < 32:
        raise RuntimeError("Set a server-only BMO_EDGE_TOKEN of at least 32 characters.")
    expires = 0
    if previous:
        try:
            expires = int(os.environ["BMO_EDGE_TOKEN_PREVIOUS_EXPIRES_AT"])
            if len(previous) < 32 or expires > time.time() + 3600:
                raise ValueError
        except (ValueError, KeyError):
            raise RuntimeError("BMO_EDGE_TOKEN_PREVIOUS requires a valid secret and expiry at most one hour ahead.") from None
    if production:
        origins = os.getenv("CORS_ORIGINS", "").split(",")
        try:
            for origin in origins:
                parts = urlsplit(origin.strip())
                if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.path or parts.query or parts.fragment or "*" in origin:
                    raise ValueError
                _ = parts.port
        except ValueError:
            raise RuntimeError("Production CORS_ORIGINS must list exact HTTPS frontend origins.") from None
        if os.getenv("DEBUG_AUTH", "0") != "0" or os.getenv("FLASK_DEBUG", "0").lower() not in {"0", "false", ""}:
            raise RuntimeError("Production authentication and Flask debug modes must be disabled.")

    @app.before_request
    def verify_edge():
        if not current:
            return None  # Explicit local/test runtime only; production is validated above.
        supplied = request.headers.get("X-Bimo-Edge-Token", "").encode()
        accepted = hmac.compare_digest(supplied, current.encode())
        if previous:
            # Compare both configured secrets; do not leave an indefinite fallback.
            old_match = hmac.compare_digest(supplied, previous.encode())
            accepted = accepted or (old_match and time.time() < expires)
        if not accepted:
            if request.path == "/health" and request.method in {"GET", "HEAD"}:
                return jsonify(status="ok")
            logger.warning("edge_auth_denied")
            return jsonify(detail="This API is available through its public gateway."), 403
        g.edge_verified = True
        try:
            g.edge_client_ip = str(ipaddress.ip_address(request.headers.get("X-Bimo-Client-IP", "")))
        except ValueError:
            g.edge_client_ip = None
        return None
