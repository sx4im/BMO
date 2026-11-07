"""Mistral AI client for Bmo.

Bmo interacts with Mistral AI's official OpenAI-compatible chat completions
endpoint (https://api.mistral.ai/v1) using the OpenAI Python SDK. This provides
high reliability, connection pooling, and standardized error handling without
requiring extra third-party dependencies.

Streaming is supported natively: ``iter_response`` yields ``{"type": "delta", "data": ...}``
chunks as tokens stream in, followed by a final ``{"type": "done", "content": "..."}`` event.
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

logger = logging.getLogger("bmo.mistral")

from . import usage_service

DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai/v1"
DEFAULT_MISTRAL_MODEL = "ministral-8b-2512"

MISTRAL_EXTENDED_THINKING_DIRECTIVE = (
    "\n\n[EXTENDED THINKING ACTIVE]\n"
    "Apply deep, rigorous analysis before answering:\n"
    "1. Deconstruct the user's requirements and underlying goals thoroughly.\n"
    "2. Systematically evaluate edge cases, failure modes, scale constraints, and security.\n"
    "3. Mentally verify logic and dry-run code paths before writing them.\n"
    "4. Deliver clean, performant, production-grade solutions with architectural clarity.\n"
    "5. Detail key technical trade-offs where appropriate."
)
CODESTRAL_EXTENDED_THINKING_DIRECTIVE = MISTRAL_EXTENDED_THINKING_DIRECTIVE

_INVISIBLE_CHARS = (" ", "​", "‌", "‍", "﻿")
_client_cache: dict[str, OpenAI] = {}


def _clean_key(raw: str) -> str:
    cleaned = raw
    for invisible in _INVISIBLE_CHARS:
        cleaned = cleaned.replace(invisible, "")
    cleaned = cleaned.strip().strip('"').strip("'").strip()
    if any(ch in cleaned for ch in ("\n", "\r", "\t", " ")):
        raise RuntimeError("Mistral API key contains whitespace inside the value.")
    return cleaned


def base_url() -> str:
    return os.getenv("MISTRAL_BASE_URL", DEFAULT_MISTRAL_BASE_URL).rstrip("/")


def default_model() -> str:
    return os.getenv("MISTRAL_MODEL", DEFAULT_MISTRAL_MODEL).strip()


def _read_api_key() -> str:
    raw = os.environ.get("MISTRAL_API_KEY")
    if not raw:
        raise RuntimeError(
            "MISTRAL_API_KEY is not set. Add it to backend/.env or your "
            "deployment environment."
        )
    cleaned = _clean_key(raw)
    if not cleaned:
        raise RuntimeError("MISTRAL_API_KEY is empty after stripping whitespace/quotes.")
    return cleaned


def is_configured() -> bool:
    return bool(os.environ.get("MISTRAL_API_KEY", "").strip())


def api_key_fingerprint() -> dict:
    """Return a safe, masked summary of the configured Mistral key for logs."""
    try:
        key = _read_api_key()
    except RuntimeError as exc:
        return {"configured": False, "error": str(exc)}
    return {
        "configured": True,
        "length": len(key),
        "preview": f"{key[:4]}…{key[-4:]}" if len(key) > 8 else "(too short)",
    }


def is_mistral_model(model_name: Optional[str]) -> bool:
    if not model_name:
        return False
    m = model_name.lower().strip()
    return (
        m.startswith("mistral")
        or m.startswith("ministral")
        or "codestral" in m
        or "pixtral" in m
        or "ministral" in m
        or m == default_model().lower()
    )


def _client() -> OpenAI:
    """Return a cached OpenAI client pointed at Mistral's endpoint.

    Keeps connections warm. Automatic SDK retries are disabled because every
    provider attempt requires a separate authoritative budget admission.
    """
    key = _read_api_key()
    target_base = base_url()
    try:
        timeout = float(os.getenv("MISTRAL_TIMEOUT", "120"))
    except (TypeError, ValueError):
        timeout = 120.0
    retries = 0  # Retries require a new admission at the caller.
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
    # Strip any leaked channel tokens or weird control characters
    text = re.sub(r"<\|channel\|>[a-zA-Z0-9_]*|<\|channel\|>|<channel\|>[a-zA-Z0-9_]*|<channel\|>", "", text)
    return text


def iter_response(
    messages: list[dict],
    *,
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
    reasoning_effort: Optional[str] = None,
    **kwargs,
) -> Iterator[dict]:
    """Stream completions from Mistral.

    Yields {"type": "delta", "data": str} for each incoming token chunk,
    then {"type": "done", "content": str} when complete.
    """
    chosen_model = model or default_model()
    client = _client()

    # Normalize messages: Mistral expects standard role/content dicts
    cleaned_messages: list[dict] = []
    has_system = False
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if not role or content is None:
            continue
        if role == "system":
            has_system = True
        cleaned_messages.append({"role": role, "content": content})

    # For codestral and ministral, default to 0.2 temperature for faster, low-divergence decoding
    if any(k in chosen_model.lower() for k in ("codestral", "ministral")) and temperature == 0.7:
        temperature = 0.2

    # Inject extended thinking directive if requested
    if reasoning_effort in ("high", "max"):
        if has_system:
            for m in cleaned_messages:
                if m["role"] == "system":
                    m["content"] = str(m["content"]) + MISTRAL_EXTENDED_THINKING_DIRECTIVE
                    break
        else:
            cleaned_messages.insert(0, {"role": "system", "content": MISTRAL_EXTENDED_THINKING_DIRECTIVE.strip()})

    call_kwargs = {
        "model": chosen_model,
        "messages": cleaned_messages,
        "temperature": temperature,
        "stream": True,
    }
    if max_tokens is not None:
        call_kwargs["max_tokens"] = max_tokens

    full: list[str] = []
    chunk_count = 0
    stream = None

    try:
        stream = usage_service.llm_create(client, call_kwargs, resource="thinking")
        for chunk in stream:
            chunk_count += 1
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
                logger.info(
                    "mistral: finish_reason=%s chunks=%d chars=%d model=%s",
                    choice.finish_reason, chunk_count, len("".join(full)), chosen_model,
                )
                break
    except (usage_service.MeteringUnavailable, usage_service.QuotaExceeded, usage_service.AdmissionConflict):
        raise
    except AuthenticationError as exc:
        raise RuntimeError("Mistral authentication failed (401). Check MISTRAL_API_KEY.") from exc
    except RateLimitError as exc:
        raise RuntimeError(
            "Mistral rate limit exceeded (429: 20k tokens/min, 1 req/sec). Please wait a moment."
        ) from exc
    except BadRequestError as exc:
        msg = getattr(exc, "message", None) or str(exc)
        raise RuntimeError(f"Mistral request rejected (400): {msg}") from exc
    except PermissionDeniedError as exc:
        raise RuntimeError("Mistral permission denied (403). Check your account permissions.") from exc
    except NotFoundError as exc:
        raise RuntimeError(f"Mistral model '{chosen_model}' was not found (404). Check MISTRAL_MODEL.") from exc
    except APIStatusError as exc:
        raise RuntimeError(f"Mistral service error ({exc.status_code}): {exc.message}") from exc
    except (APIConnectionError, APITimeoutError) as exc:
        raise RuntimeError(f"Network error reaching Mistral: {exc}") from exc
    except Exception as exc:
        msg = str(exc).strip() or exc.__class__.__name__
        raise RuntimeError(f"Mistral stream interrupted: {msg}") from exc

    finally:
        if stream is not None:
            stream.close()

    yield {"type": "done", "content": "".join(full)}


def test_call(model: Optional[str] = None) -> dict:
    """Minimal chat completion to verify the key and model configuration."""
    chosen_model = model or default_model()
    try:
        client = _client()
        completion = usage_service.llm_create(client, dict(
            model=chosen_model,
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "Say 'API test OK' and nothing else."},
            ],
            max_tokens=20,
            temperature=0.0,
        ), resource="thinking")
        resp_model = completion.model or chosen_model
        logger.info("Mistral API test call OK — responding model: %s", resp_model)
        return {"ok": True, "model": resp_model}
    except Exception as exc:
        logger.warning("test_call_failed error_type=%s", type(exc).__name__)
        return {"ok": False, "error": str(exc)}
