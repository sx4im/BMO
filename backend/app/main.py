"""Flask gateway for Bmo.

Modular application factory registering blueprints for chat, media, user,
analytics, and WhatsApp integrations. Configured with rate limiting,
security headers, and error handlers.
"""

from __future__ import annotations

import logging
import os
import threading
import uuid

from dotenv import load_dotenv
from flask import Flask, g, jsonify, request
from flask_cors import CORS

from . import groq_client, mistral_client, nvidia_client, store, supabase_client, whatsapp
from .auth import prewarm_jwks
from .config import (
    DEFAULT_IMAGE_MODEL,
    DEFAULT_NEXOS_MODEL,
    DEFAULT_STANZA_MODEL,
    DEFAULT_VISION_MODEL,
    IMAGE_MODEL_ID,
    SESSION_LIMIT,
    SESSION_WINDOW_S,
    UI_MODELS,
    USAGE_WEIGHTS,
    WEEKLY_LIMIT,
    WEEKLY_WINDOW_S,
    cors_origins,
    get_internal_models,
    get_known_model_ids,
    get_real_id_map,
    get_vision_model,
    upload_magic_ok,
    upload_type_allowed,
)
from .limiter import limiter, rate_limit_key
from .routes import analytics_bp, chat_bp, customize_bp, export_bp, media_bp, project_bp, user_bp
from .routes.helpers import (
    friendly_error,
    get_usage_status,
    human_duration,
    is_trivial_prompt,
    user_owns_path,
    window_reset_at,
)

load_dotenv()

from .observability import configure_logging
configure_logging()

logger = logging.getLogger("bmo.main")

# Backward-compatibility aliases
_INTERNAL_MODELS = get_internal_models()
REAL_ID_MAP = get_real_id_map()
KNOWN_MODEL_IDS = get_known_model_ids()
VISION_MODEL = get_vision_model()
_friendly_error = friendly_error
_upload_type_allowed = upload_type_allowed
_upload_magic_ok = upload_magic_ok
_user_owns_path = user_owns_path
_is_trivial_prompt = is_trivial_prompt
_usage_status = get_usage_status
_window_reset_at = window_reset_at
_human_duration = human_duration
_rate_limit_key = rate_limit_key


def create_app() -> Flask:
    app = Flask(__name__)

    @app.before_request
    def assign_request_id():
        g.request_id = str(uuid.uuid4())

    from .edge_access import configure_edge
    configure_edge(app)
    app.config["MAX_CONTENT_LENGTH"] = 52 * 1024 * 1024
    from .voice_security import MAX_FRAME_BYTES
    app.config["SOCK_SERVER_OPTIONS"] = {"max_message_size": MAX_FRAME_BYTES, "ping_interval": 25}
    CORS(app, resources={r"/*": {"origins": cors_origins()}}, supports_credentials=False)

    # ---------- Rate Limiting ----------
    from .security_store import SecurityStoreUnavailable, rate_limit_configuration
    app.config.update(rate_limit_configuration())
    limiter.init_app(app)
    app.extensions["bmo_limiter"] = limiter
    from .turnstile import configure_turnstile
    configure_turnstile(app)

    @limiter.request_filter
    def _skip_cors_preflight():
        return request.method == "OPTIONS"

    # ---------- Error Handlers ----------
    from .usage_service import AdmissionConflict, MeteringUnavailable, QuotaExceeded
    from limits.errors import StorageError
    from redis.exceptions import RedisError

    @app.errorhandler(SecurityStoreUnavailable)
    @app.errorhandler(StorageError)
    @app.errorhandler(RedisError)
    def _handle_security_store_unavailable(exc):
        logger.error("security_store_unavailable error_type=%s", type(exc).__name__)
        return jsonify({"detail": "Security checks are temporarily unavailable. Please try again shortly."}), 503, {"Retry-After": "1"}

    @app.errorhandler(MeteringUnavailable)
    def _handle_metering_unavailable(exc):
        return jsonify({"detail": str(exc)}), 503

    @app.errorhandler(QuotaExceeded)
    def _handle_usage_limit(exc):
        return jsonify({"detail": str(exc)}), 429

    @app.errorhandler(AdmissionConflict)
    def _handle_admission_conflict(exc):
        return jsonify({"detail": str(exc)}), 409

    @app.errorhandler(429)
    def _handle_rate_limited(exc):  # noqa: ARG001
        return (
            jsonify({"detail": "You're sending requests too quickly. Please wait a moment and try again."}),
            429,
        )

    @app.errorhandler(Exception)
    def _handle_uncaught(exc):
        from werkzeug.exceptions import HTTPException

        if isinstance(exc, HTTPException):
            return jsonify({"detail": exc.description or exc.name}), exc.code
        logger.error("handle_uncaught_failed error_type=%s", type(exc).__name__)
        return jsonify({"detail": "Internal server error"}), 500

    # ---------- Security Headers ----------
    @app.after_request
    def _security_headers(resp):
        # API and bearer-link responses must never enter a browser/CDN shared
        # cache, including error responses and revoked share lookups.
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["X-Request-ID"] = g.request_id
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        resp.headers.pop("Server", None)
        return resp

    # ---------- Register Modular Blueprints ----------
    app.register_blueprint(analytics_bp)
    app.register_blueprint(chat_bp)
    app.register_blueprint(customize_bp)
    app.register_blueprint(export_bp)
    app.register_blueprint(media_bp)
    app.register_blueprint(project_bp)
    app.register_blueprint(user_bp)
    app.register_blueprint(whatsapp.whatsapp_bp)
    whatsapp.start_retention_worker()

    return app


app = create_app()

# Warm the JWKS cache in the background
if supabase_client.is_configured():
    threading.Thread(target=prewarm_jwks, name="bmo-jwks-prewarm", daemon=True).start()

# Worker startup must not make billable calls or log credential fragments.
logger.info("Provider configuration: nvidia=%s mistral=%s groq=%s",
            nvidia_client.is_configured(), mistral_client.is_configured(), groq_client.is_configured())


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    host = os.getenv("HOST", "0.0.0.0")
    app.run(host=host, port=port, debug=os.getenv("FLASK_DEBUG") == "1", threaded=True)
