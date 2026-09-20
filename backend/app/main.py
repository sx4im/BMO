"""Flask gateway for BMO.

Modular application factory registering blueprints for chat, media, user,
analytics, and WhatsApp integrations. Configured with rate limiting,
security headers, and error handlers.
"""

from __future__ import annotations

import logging
import os
import threading

from dotenv import load_dotenv
from flask import Flask, jsonify, request
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
from .routes import analytics_bp, chat_bp, export_bp, media_bp, user_bp
from .routes.helpers import (
    friendly_error,
    get_usage_status,
    human_duration,
    is_trivial_prompt,
    user_owns_path,
    window_reset_at,
)

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

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
    app.config["MAX_CONTENT_LENGTH"] = 52 * 1024 * 1024
    CORS(app, resources={r"/*": {"origins": cors_origins()}}, supports_credentials=False)

    # ---------- Rate Limiting ----------
    app.config["RATELIMIT_ENABLED"] = os.getenv("RATELIMIT_ENABLED", "1") == "1"
    app.config["RATELIMIT_HEADERS_ENABLED"] = True
    app.config["RATELIMIT_STORAGE_URI"] = os.getenv("RATELIMIT_STORAGE_URI", "memory://")
    limiter.init_app(app)
    app.extensions["bmo_limiter"] = limiter

    @limiter.request_filter
    def _skip_cors_preflight():
        return request.method == "OPTIONS"

    # ---------- Error Handlers ----------
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
        logger.exception("unhandled error on %s %s: %s", request.method, request.path, exc)
        return jsonify({"detail": "Internal server error"}), 500

    # ---------- Security Headers ----------
    @app.after_request
    def _security_headers(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        resp.headers.pop("Server", None)
        return resp

    # ---------- Register Modular Blueprints ----------
    app.register_blueprint(analytics_bp)
    app.register_blueprint(chat_bp)
    app.register_blueprint(export_bp)
    app.register_blueprint(media_bp)
    app.register_blueprint(user_bp)
    app.register_blueprint(whatsapp.whatsapp_bp)

    return app


app = create_app()

# Warm the JWKS cache in the background
if supabase_client.is_configured():
    threading.Thread(target=prewarm_jwks, name="bmo-jwks-prewarm", daemon=True).start()

# Run a one-time API test on import
if groq_client.is_configured():
    logger.info("Groq key fingerprint: %s (model=%s)", groq_client.api_key_fingerprint(), groq_client.default_model())

if mistral_client.is_configured():
    logger.info("Mistral key fingerprint: %s (model=%s)", mistral_client.api_key_fingerprint(), mistral_client.default_model())

if nvidia_client.is_configured():
    logger.info("NVIDIA key fingerprint: %s", nvidia_client.api_key_fingerprint())
    try:
        test_result = nvidia_client.test_call()
        if test_result.get("ok"):
            logger.info("Startup API test OK — responding model: %s", test_result["model"])
        else:
            logger.warning("Startup API test failed: %s", test_result)
        all_models = nvidia_client.list_models()
        logger.info("Full model catalogue (%d models): %s", len(all_models), [m.get("id") for m in all_models])
    except Exception as exc:
        logger.warning("Startup API test exception: %s", exc)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    host = os.getenv("HOST", "0.0.0.0")
    app.run(host=host, port=port, debug=os.getenv("FLASK_DEBUG") == "1", threaded=True)
