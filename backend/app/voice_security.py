"""Single-use voice credentials and shared, expiring connection leases."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import time

from redis.exceptions import RedisError

from . import security_store
from .usage_service import QuotaExceeded

logger = logging.getLogger("bmo.voice_security")
TICKET_TTL = 30
SESSION_SECONDS = 900
IDLE_SECONDS = 60
MAX_FRAME_BYTES = 20_000
MAX_SPEAK_CHARS = 4_000


class InvalidTicket(ValueError):
    """The credential or connection lease is invalid or expired."""


def _key(suffix):
    return f"{security_store.namespace()}:voice:{suffix}"


def _run(operation):
    try:
        return operation(security_store.redis_client())
    except RedisError as error:
        raise security_store.SecurityStoreUnavailable("Voice security checks are unavailable.") from error


def issue_ticket(user_id: str, settings: dict, *, expires_at: float) -> str:
    ttl = min(TICKET_TTL, int(expires_at - time.time()))
    if ttl < 1:
        raise InvalidTicket("Sign in again to start voice.")
    ticket = secrets.token_urlsafe(32)
    payload = {"resource": "tts/stream", "user_id": user_id, "settings": settings, "expires_at": expires_at}
    key = _key("ticket:" + hashlib.sha256(ticket.encode()).hexdigest())
    if not _run(lambda client: client.set(key, json.dumps(payload), ex=ttl, nx=True)):
        raise security_store.SecurityStoreUnavailable("Could not issue a voice credential.")
    return ticket


def consume_ticket(ticket: str, *, resource="tts/stream") -> dict:
    if not isinstance(ticket, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", ticket):
        raise InvalidTicket("Start voice again to reconnect.")
    raw = _run(lambda client: client.getdel(_key("ticket:" + hashlib.sha256(ticket.encode()).hexdigest())))
    try:
        payload = json.loads(raw)
        if payload["resource"] != resource or payload["expires_at"] <= time.time():
            raise ValueError
        if not isinstance(payload["user_id"], str) or not isinstance(payload["settings"], dict):
            raise ValueError
    except (ValueError, TypeError, KeyError):
        raise InvalidTicket("Start voice again to reconnect.") from None
    return payload


# One bounded sorted set makes admission atomic even on Redis Cluster.
_ACQUIRE = """
local now = redis.call('TIME')
local ms = now[1] * 1000 + math.floor(now[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ms)
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
if #members >= tonumber(ARGV[3]) then return 0 end
local count = 0
for _, member in ipairs(members) do
  if string.sub(member, 1, string.len(ARGV[1])) == ARGV[1] then count = count + 1 end
end
if count >= 2 then return 0 end
redis.call('ZADD', KEYS[1], ms + tonumber(ARGV[4]), ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]) + 1000)
return 1
"""
_CHECK = """
local now = redis.call('TIME')
local ms = now[1] * 1000 + math.floor(now[2] / 1000)
local expires = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not expires or tonumber(expires) <= ms then return 0 end
return 1
"""


def acquire_lease(user_id: str) -> str:
    try:
        limit = int(os.getenv("BMO_VOICE_MAX_CONNECTIONS", "8"))
        if not 1 <= limit <= 8: raise ValueError
    except ValueError:
        raise security_store.SecurityStoreUnavailable("Invalid voice connection limit.") from None
    lease = secrets.token_hex(16)
    admitted = _run(lambda client: client.eval(_ACQUIRE, 1, _key("leases"), f"{user_id}:", f"{user_id}:{lease}", limit, SESSION_SECONDS * 1000))
    if not admitted:
        raise QuotaExceeded("Voice is busy. Close another voice window or try again shortly.")
    return lease


def check_lease(user_id: str, lease: str):
    if not _run(lambda client: client.eval(_CHECK, 1, _key("leases"), f"{user_id}:{lease}")):
        raise InvalidTicket("This voice connection has expired. Reconnect to continue.")


def release_lease(user_id: str, lease: str):
    try:
        _run(lambda client: client.zrem(_key("leases"), f"{user_id}:{lease}"))
    except security_store.SecurityStoreUnavailable:
        logger.warning("voice_lease_release_pending")
