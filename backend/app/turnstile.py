"""Siteverify proofs authorize a short Redis lease for one verified login session."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import uuid

import requests
from flask import g, jsonify, request
from redis.exceptions import RedisError

from . import security_store
from .auth import _bearer_token, current_authenticated_user, require_user, user_from_token
from .limiter import limiter

logger = logging.getLogger("bmo.turnstile")
ACTION = "bimo_paid"
CLEARANCE_SECONDS = 900
PROTECTED_PATHS = frozenset({"/chat", "/images/generate", "/tts", "/tts/ticket", "/transcribe", "/search", "/scrape", "/attachments", "/export"})


class InvalidProof(ValueError):
    pass


class VerificationUnavailable(RuntimeError):
    pass


def _store(operation):
    try:
        return operation(security_store.redis_client())
    except RedisError as error:
        raise security_store.SecurityStoreUnavailable("Verification storage is unavailable.") from error


def _key(kind, value):
    return f"{security_store.namespace()}:{kind}:" + hashlib.sha256(value.encode()).hexdigest()


def _session(user):
    try:
        return {"user_id": str(uuid.UUID(user.id)), "session_id": str(uuid.UUID(user.raw["session_id"]))}
    except (KeyError, TypeError, ValueError, AttributeError):
        raise InvalidProof("Sign in again to verify this session.") from None


def verify_turnstile(token: str, *, expected_action: str, expected_hostname, remote_ip=None) -> None:
    if not isinstance(token, str) or not 0 < len(token) <= 2048:
        raise InvalidProof("A fresh verification response is required.")
    if not _store(lambda client: client.set(_key("turnstile-proof", token), "used", ex=300, nx=True)):
        raise InvalidProof("This verification response was already used.")
    parameters = {"secret": os.environ["TURNSTILE_SECRET_KEY"], "response": token}
    if remote_ip: parameters["remoteip"] = remote_ip
    try:
        response = requests.post("https://challenges.cloudflare.com/turnstile/v0/siteverify", data=parameters, timeout=5)
        if not response.ok: raise VerificationUnavailable()
        result = response.json()
    except (requests.RequestException, ValueError) as error:
        logger.warning("turnstile_unavailable error_type=%s", type(error).__name__)
        raise VerificationUnavailable("Verification is unavailable. Please try again shortly.") from error
    hosts = {expected_hostname} if isinstance(expected_hostname, str) else set(expected_hostname)
    if not isinstance(result, dict) or result.get("success") is not True or result.get("hostname") not in hosts or result.get("action") != expected_action:
        logger.warning("turnstile_denied")
        raise InvalidProof("Verification failed. Please try again.")


def configure_turnstile(app):
    production = os.getenv("BMO_ENV", "production").strip().lower() == "production"
    enabled = os.getenv("TURNSTILE_ENABLED", "1" if production else "0")
    if enabled not in {"0", "1"} or (production and enabled != "1"):
        raise RuntimeError("Production requires TURNSTILE_ENABLED=1.")
    hosts = [host.strip().lower() for host in os.getenv("TURNSTILE_EXPECTED_HOSTNAMES", "").split(",") if host.strip()]
    if enabled == "1" and (len(os.getenv("TURNSTILE_SECRET_KEY", "")) < 20 or not hosts or any(not re.fullmatch(r"[a-z0-9.-]{1,253}", host) for host in hosts)):
        raise RuntimeError("Configure TURNSTILE_SECRET_KEY and exact TURNSTILE_EXPECTED_HOSTNAMES.")

    @app.before_request
    def require_clearance():
        if enabled != "1" or request.method != "POST" or request.path not in PROTECTED_PATHS:
            return None
        user = current_authenticated_user() or user_from_token(_bearer_token())
        if not user:
            return jsonify(detail="Authentication required"), 401
        g.current_user = user
        try:
            binding = _session(user)
        except InvalidProof:
            return jsonify(detail="Sign in again to verify this session."), 401
        clearance = request.headers.get("X-Bimo-Clearance", "")
        if re.fullmatch(r"[A-Za-z0-9_-]{43}", clearance):
            raw = _store(lambda client: client.get(_key("clearance", clearance)))
            try:
                if json.loads(raw) == binding: return None
            except (ValueError, TypeError):
                pass
        return jsonify(detail="Please complete verification to continue.", code="verification_required"), 403

    @app.post("/security/clearance")
    @limiter.limit("5 per minute")
    @require_user
    def issue_clearance(user):
        if enabled != "1":
            return jsonify(detail="Verification is not enabled in this local environment."), 404
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or not isinstance(payload.get("token"), str) or not 0 < len(payload["token"]) <= 2048:
            return jsonify(detail="A fresh verification response is required."), 422
        try:
            binding = _session(user)
            ip = getattr(g, "edge_client_ip", None) if getattr(g, "edge_verified", False) else None
            verify_turnstile(payload["token"], expected_action=ACTION, expected_hostname=hosts, remote_ip=ip)
        except InvalidProof as error:
            return jsonify(detail=str(error)), 403
        except VerificationUnavailable:
            return jsonify(detail="Verification is unavailable. Please try again shortly."), 503
        clearance = secrets.token_urlsafe(32)
        if not _store(lambda client: client.set(_key("clearance", clearance), json.dumps(binding), ex=CLEARANCE_SECONDS, nx=True)):
            raise security_store.SecurityStoreUnavailable("Verification storage is unavailable.")
        return jsonify(clearance=clearance, expires_in=CLEARANCE_SECONDS), 201
