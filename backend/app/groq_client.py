"""Groq AI client for Bmo.

Bmo interacts with Groq's low-latency OpenAI-compatible chat completions endpoint
(https://api.groq.com/openai/v1) for the Aeon Voice model.

Streaming is supported natively: ``iter_response`` yields ``{"type": "delta", "data": ...}``
chunks as tokens arrive, followed by a final ``{"type": "done", "content": "..."}`` event.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Iterator, Optional

import httpx
from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AuthenticationError,
    BadRequestError,
    NotFoundError,
    OpenAI,
    PermissionDeniedError,
    RateLimitError,
)

from .config import DEFAULT_GROQ_BASE_URL, get_aeon_model

logger = logging.getLogger("bmo.groq")

_INVISIBLE_CHARS = (" ", "​", "‌", "‍", "﻿")
_client_cache: dict[str, OpenAI] = {}


def _clean_key(raw: str) -> str:
    cleaned = raw
    for invisible in _INVISIBLE_CHARS:
        cleaned = cleaned.replace(invisible, "")
    cleaned = cleaned.strip().strip('"').strip("'").strip()
    if any(ch in cleaned for ch in ("\n", "\r", "\t", " ")):
        raise RuntimeError("Groq API key contains whitespace inside the value.")
    return cleaned


def base_url() -> str:
    return os.getenv("GROQ_BASE_URL", DEFAULT_GROQ_BASE_URL).rstrip("/")


def default_model() -> str:
    return get_aeon_model()


def _read_api_key() -> str:
    raw = os.environ.get("GROQ_API_KEY")
    if not raw:
        raise RuntimeError(
            "GROQ_API_KEY is not set. Add it to backend/.env or your "
            "deployment environment."
        )
    cleaned = _clean_key(raw)
    if not cleaned:
        raise RuntimeError("GROQ_API_KEY is empty after stripping whitespace/quotes.")
    return cleaned


def is_configured() -> bool:
    return bool(os.environ.get("GROQ_API_KEY", "").strip())


def api_key_fingerprint() -> dict:
    """Return a safe, masked summary of the configured Groq key for logs."""
    try:
        key = _read_api_key()
    except RuntimeError as exc:
        return {"configured": False, "error": str(exc)}
    return {
        "configured": True,
        "length": len(key),
        "preview": f"{key[:4]}…{key[-4:]}" if len(key) > 8 else "(too short)",
    }


def is_groq_model(model_name: Optional[str]) -> bool:
    if not model_name:
        return False
    m = model_name.lower().strip()
    if m.startswith("nvidia/"):
        return False
    aeon_m = default_model().lower().strip()
    return (
        m == "aeon"
        or m == aeon_m
        or m.startswith("groq/")
        or m in {"qwen/qwen3.8-27b", "qwen-2.5-32b", "llama-3.3-70b-versatile"}
    )


def _client() -> OpenAI:
    """Return a cached OpenAI client pointed at Groq's endpoint."""
    key = _read_api_key()
    target_base = base_url()
    try:
        timeout = float(os.getenv("GROQ_TIMEOUT", "60"))
    except (TypeError, ValueError):
        timeout = 60.0
    retries = 2
    signature = f"{target_base}::{key}::{timeout}::{retries}"
    cached = _client_cache.get(signature)
    if cached is not None:
        return cached
    http_client = httpx.Client(
        limits=httpx.Limits(max_keepalive_connections=10, max_connections=20, keepalive_expiry=60.0),
        timeout=timeout,
    )
    client = OpenAI(
        base_url=target_base,
        api_key=key,
        timeout=timeout,
        max_retries=retries,
        http_client=http_client,
    )
    _client_cache[signature] = client
    return client


def _clean_text(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r"<\|channel\|>[a-zA-Z0-9_]*|<\|channel\|>|<channel\|>[a-zA-Z0-9_]*|<channel\|>", "", text)
    return text


def iter_response(
    messages: list[dict],
    *,
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
    **kwargs,
) -> Iterator[dict]:
    """Stream completions from Groq.

    Yields upstream "inference" metadata once, then
    {"type": "delta", "data": str} for each incoming token chunk,
    then {"type": "done", "content": str} when complete.
    """
    chosen_model = model or default_model()
    client = _client()

    cleaned_messages: list[dict] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if not role or content is None:
            continue
        cleaned_messages.append({"role": role, "content": content})

    call_kwargs = {
        "model": chosen_model,
        "messages": cleaned_messages,
        "temperature": temperature,
        "stream": True,
    }
    # Groq's implicit completion default can be too small for generated code.
    # Qwen 3.8's documented output ceiling is 16,384 tokens (not its 131K context).
    if chosen_model == "qwen/qwen3.8-27b":
        if max_tokens is None:
            try:
                max_tokens = int(os.getenv("GROQ_MAX_TOKENS", "16384"))
            except (TypeError, ValueError):
                max_tokens = 16384
            if max_tokens <= 0:
                max_tokens = 16384
        max_tokens = min(max_tokens, 16384)
    if max_tokens is not None:
        call_kwargs["max_completion_tokens"] = max_tokens
    call_kwargs["stream_options"] = {"include_usage": True}

    full: list[str] = []
    chunk_count = 0
    finish_reason = None
    usage = None
    stream = None

    try:
        stream = client.chat.completions.create(**call_kwargs)
        for chunk in stream:
            chunk_count += 1
            if chunk_count == 1:
                yield {
                    "type": "inference",
                    "provider": "groq",
                    "requested_model": chosen_model,
                    "reported_model": getattr(chunk, "model", None),
                    "request_id": getattr(chunk, "id", None),
                }
            metadata = getattr(chunk, "x_groq", None)
            if metadata is not None and not isinstance(metadata, dict):
                metadata = metadata.model_dump()
            if metadata and metadata.get("error"):
                raise RuntimeError("Groq stream stopped early due to a provider error.")
            chunk_usage = getattr(chunk, "usage", None) or (metadata or {}).get("usage")
            if chunk_usage is not None:
                usage = chunk_usage if isinstance(chunk_usage, dict) else chunk_usage.model_dump()
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            delta = getattr(choice.delta, "content", None)
            if delta:
                cleaned_delta = _clean_text(delta)
                if cleaned_delta:
                    full.append(cleaned_delta)
                    yield {"type": "delta", "data": cleaned_delta}

            if choice.finish_reason:
                finish_reason = choice.finish_reason
                logger.info(
                    "groq: finish_reason=%s chunks=%d chars=%d model=%s",
                    choice.finish_reason, chunk_count, len("".join(full)), chosen_model,
                )
    except AuthenticationError as exc:
        raise RuntimeError("Groq authentication failed (401). Check GROQ_API_KEY.") from exc
    except RateLimitError as exc:
        raise RuntimeError("Groq rate limit exceeded (429). Please wait a moment.") from exc
    except BadRequestError as exc:
        msg = getattr(exc, "message", None) or str(exc)
        raise RuntimeError(f"Groq request rejected (400): {msg}") from exc
    except PermissionDeniedError as exc:
        raise RuntimeError("Groq permission denied (403). Check your account permissions.") from exc
    except NotFoundError as exc:
        raise RuntimeError(f"Groq model '{chosen_model}' was not found (404). Check GROQ_AEON_MODEL.") from exc
    except APIStatusError as exc:
        raise RuntimeError(f"Groq service error ({exc.status_code}): {exc.message}") from exc
    except (APIConnectionError, APITimeoutError) as exc:
        raise RuntimeError(f"Network error reaching Groq: {exc}") from exc
    except Exception as exc:
        msg = str(exc).strip() or exc.__class__.__name__
        raise RuntimeError(f"Groq stream interrupted: {msg}") from exc

    finally:
        if stream is not None:
            close = getattr(stream, "close", None)
            if callable(close):
                close()

    if finish_reason is None:
        raise RuntimeError("Groq stream ended before a finish reason was received.")
    yield {
        "type": "done", "content": "".join(full),
        "finish_reason": finish_reason, "usage": usage,
        "complete": finish_reason == "stop",
    }
