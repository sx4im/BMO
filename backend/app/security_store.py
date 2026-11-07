"""Shared Redis configuration for request counters and short-lived security state."""
from __future__ import annotations

from functools import lru_cache
import os
import re
from urllib.parse import urlsplit

import redis
from redis.backoff import NoBackoff
from redis.retry import Retry


class SecurityStoreUnavailable(RuntimeError):
    """Security state cannot be checked; new protected work must be denied."""


def _connection_options(uri: str) -> dict:
    options = {"socket_connect_timeout": 1.0, "socket_timeout": 1.0,
               "max_connections": 20, "retry": Retry(NoBackoff(), 0)}
    if urlsplit(uri).scheme == "rediss":
        options.update(ssl_cert_reqs="required", ssl_check_hostname=True)
    return options


def rate_limit_configuration() -> dict:
    mode = os.getenv("BMO_ENV", "production").strip().lower()
    if mode not in {"production", "development", "test"}:
        raise RuntimeError("BMO_ENV must be production, development, or test.")
    enabled = os.getenv("RATELIMIT_ENABLED", "1")
    if enabled not in {"0", "1"} or (mode == "production" and enabled != "1"):
        raise RuntimeError("Production requires RATELIMIT_ENABLED=1.")
    uri = os.getenv("RATELIMIT_STORAGE_URI", "").strip()
    try:
        parts = urlsplit(uri)
        scheme = parts.scheme
        valid = scheme in {"redis", "rediss"} and bool(parts.hostname) and (not parts.path or re.fullmatch(r"/\d+", parts.path))
        if parts.port is not None and not 0 < parts.port <= 65535:
            valid = False
        if mode != "production":
            valid = valid or uri == "memory://" or (scheme == "redis+unix" and bool(parts.path) and not parts.hostname)
        if not valid or parts.query or parts.fragment:
            raise ValueError
    except ValueError:
        raise RuntimeError("Set a valid shared Redis RATELIMIT_STORAGE_URI without query or fragment options. Memory is an explicit local/test option only.") from None
    base = os.getenv("BMO_SECURITY_NAMESPACE", "bimo")
    if not re.fullmatch(r"[A-Za-z0-9:_-]{1,48}", base):
        raise RuntimeError("BMO_SECURITY_NAMESPACE must use letters, numbers, colon, underscore or hyphen.")
    prefix = f"{base}:{mode}"
    config = {
        "RATELIMIT_ENABLED": enabled == "1", "RATELIMIT_STORAGE_URI": uri,
        "RATELIMIT_KEY_PREFIX": prefix, "RATELIMIT_HEADERS_ENABLED": True,
        "RATELIMIT_SWALLOW_ERRORS": False, "RATELIMIT_IN_MEMORY_FALLBACK_ENABLED": False,
    }
    if scheme != "memory":
        config["RATELIMIT_STORAGE_OPTIONS"] = {**_connection_options(uri), "key_prefix": f"{prefix}:limits", "wrap_exceptions": True}
    return config


def namespace() -> str:
    return rate_limit_configuration()["RATELIMIT_KEY_PREFIX"]


@lru_cache(maxsize=4)
def _redis_client(uri: str):
    return redis.Redis.from_url(uri.replace("redis+unix://", "unix://", 1), **_connection_options(uri))


def redis_client():
    uri = rate_limit_configuration()["RATELIMIT_STORAGE_URI"]
    if uri == "memory://":
        raise SecurityStoreUnavailable("Shared security storage is not configured.")
    return _redis_client(uri)
