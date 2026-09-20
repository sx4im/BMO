"""Kilo AI Gateway client for BMO.

BMO interacts with Kilo's OpenAI-compatible AI Gateway endpoint
(https://api.kilo.ai/api/gateway) for the Nexus model using Step 3.7 Flash
(stepfun/step-3.7-flash:free).

Streaming is supported natively: ``iter_response`` yields ``{"type": "delta", "data": ...}``
for content chunks and ``{"type": "reasoning_delta", "data": ...}`` for thinking chunks,
followed by a final ``{"type": "done", "content": "...", "reasoning": "..."}`` event.
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

from .config import DEFAULT_KILO_BASE_URL, DEFAULT_KILO_MODEL

logger = logging.getLogger("bmo.kilo")

# Strictly forbidden paid or auto models — Nexus will NEVER route to or fall back to these
PAID_KILO_MODELS = frozenset({
    "kilo-auto/frontier",
    "kilo-auto/efficient",
    "kilo-auto",
})

_INVISIBLE_CHARS = (" ", "​", "‌", "‍", "﻿")
_client_cache: dict[str, OpenAI] = {}


def _clean_key(raw: str) -> str:
    cleaned = raw
    for invisible in _INVISIBLE_CHARS:
        cleaned = cleaned.replace(invisible, "")
    cleaned = cleaned.strip().strip('"').strip("'").strip()
    if any(ch in cleaned for ch in ("\n", "\r", "\t", " ")):
        raise RuntimeError("Kilo API key contains whitespace inside the value.")
    return cleaned


def base_url() -> str:
    return os.getenv("KILO_BASE_URL", DEFAULT_KILO_BASE_URL).rstrip("/")


def default_model() -> str:
    return DEFAULT_KILO_MODEL


def validate_model(requested_model: Optional[str]) -> str:
    """Ensure requested model is strictly a free model and never a paid/auto model."""
    target = (requested_model or default_model()).strip()
    target_lower = target.lower()

    # Reject or coerce any paid models strictly
    if target_lower in PAID_KILO_MODELS or target_lower.startswith("kilo-auto"):
        logger.warning(
            "Attempted to route to paid Kilo model '%s'. Strictly enforcing free model '%s'.",
            target,
            DEFAULT_KILO_MODEL,
        )
        return DEFAULT_KILO_MODEL

    # Map friendly names to the exact free model ID
    if target_lower in {"deep", "nexus", "nexos"}:
        return DEFAULT_KILO_MODEL

    return target or DEFAULT_KILO_MODEL


def _read_api_key() -> str:
    raw = os.environ.get("KILO_API_KEY") or os.environ.get("KILOCODE_API_KEY")
    if not raw:
        raise RuntimeError(
            "KILO_API_KEY is not set. Add it to backend/.env or your deployment environment."
        )
    cleaned = _clean_key(raw)
    if not cleaned:
        raise RuntimeError("KILO_API_KEY is empty after stripping whitespace/quotes.")
    return cleaned


def is_configured() -> bool:
    return bool(
        (os.environ.get("KILO_API_KEY") or os.environ.get("KILOCODE_API_KEY") or "").strip()
    )


def api_key_fingerprint() -> dict:
    """Return a safe, masked summary of the configured Kilo key for logs/diagnostics."""
    try:
        key = _read_api_key()
    except RuntimeError as exc:
        return {"configured": False, "error": str(exc)}
    return {
        "configured": True,
        "length": len(key),
        "preview": f"{key[:4]}…{key[-4:]}" if len(key) > 8 else "(too short)",
    }


def is_kilo_model(model_name: Optional[str]) -> bool:
    if not model_name:
        return False
    m = model_name.lower().strip()
    return (
        m == "deep"
        or m == "nexus"
        or m == "nexos"
        or m == DEFAULT_KILO_MODEL.lower()
        or "step-3.7-flash" in m
        or m.startswith("kilo/")
    )


def _client() -> OpenAI:
    """Return a cached OpenAI client pointed at Kilo's gateway endpoint."""
    key = _read_api_key()
    target_base = base_url()
    try:
        timeout = float(os.getenv("KILO_TIMEOUT", "60"))
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


def _clean_llm_text(text: str) -> str:
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
    reasoning_effort: Optional[str] = None,
    thinking: bool = True,
    **kwargs,
) -> Iterator[dict]:
    """Stream completions from Kilo AI Gateway using stepfun/step-3.7-flash:free.

    Yields:
        {"type": "delta", "data": str} for each text chunk
        {"type": "reasoning_delta", "data": str} for each reasoning/thought chunk
        {"type": "done", "content": str, "reasoning": Optional[str]} when finished
    """
    chosen_model = validate_model(model)
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
    if max_tokens is not None:
        call_kwargs["max_tokens"] = max_tokens

    # Reasoning effort passthrough if specified
    if reasoning_effort and reasoning_effort not in {"off", "none"}:
        call_kwargs["extra_body"] = {"reasoning_effort": reasoning_effort}

    full: list[str] = []
    reasoning_full: list[str] = []
    chunk_count = 0
    in_think_tag = False

    try:
        stream = client.chat.completions.create(**call_kwargs)
        for chunk in stream:
            chunk_count += 1
            if not chunk.choices:
                continue
            choice = chunk.choices[0]

            # 1. Native reasoning_content or reasoning delta field
            reasoning = (
                getattr(choice.delta, "reasoning", None)
                or getattr(choice.delta, "reasoning_content", None)
            )
            if reasoning:
                clean_reasoning = _clean_llm_text(reasoning)
                if clean_reasoning:
                    reasoning_full.append(clean_reasoning)
                    yield {"type": "reasoning_delta", "data": clean_reasoning}

            # 2. Content delta and possible embedded <think> tags
            delta = getattr(choice.delta, "content", None) if choice.delta else None
            if delta:
                if "<think>" in delta:
                    parts = delta.split("<think>", 1)
                    if parts[0]:
                        p0 = _clean_llm_text(parts[0])
                        if p0:
                            full.append(p0)
                            yield {"type": "delta", "data": p0}
                    in_think_tag = True
                    delta = parts[1]

                if in_think_tag and delta:
                    if "</think>" in delta:
                        think_part, content_part = delta.split("</think>", 1)
                        if think_part:
                            tp = _clean_llm_text(think_part)
                            if tp:
                                reasoning_full.append(tp)
                                yield {"type": "reasoning_delta", "data": tp}
                        in_think_tag = False
                        delta = content_part
                    else:
                        tp = _clean_llm_text(delta)
                        if tp:
                            reasoning_full.append(tp)
                            yield {"type": "reasoning_delta", "data": tp}
                        delta = None

                if delta:
                    cleaned_delta = _clean_llm_text(delta)
                    if cleaned_delta:
                        full.append(cleaned_delta)
                        yield {"type": "delta", "data": cleaned_delta}

            if choice.finish_reason:
                logger.info(
                    "kilo: finish_reason=%s chunks=%d chars=%d model=%s",
                    choice.finish_reason, chunk_count, len("".join(full)), chosen_model,
                )
                break
    except RateLimitError as exc:
        logger.warning("Kilo AI Gateway rate limit: %s", exc)
        raise RuntimeError("Kilo Gateway rate limit reached for Step 3.7 Flash. Please wait a moment and try again.") from exc
    except AuthenticationError as exc:
        raise RuntimeError("Kilo authentication failed (401). Check KILO_API_KEY in backend/.env.") from exc
    except BadRequestError as exc:
        msg = getattr(exc, "message", None) or str(exc)
        raise RuntimeError(f"Kilo request rejected (400): {msg}") from exc
    except PermissionDeniedError as exc:
        raise RuntimeError("Kilo permission denied (403). Check your KILO_API_KEY permissions.") from exc
    except NotFoundError as exc:
        raise RuntimeError(f"Kilo model '{chosen_model}' was not found (404).") from exc
    except APIStatusError as exc:
        if exc.status_code == 429:
            raise RuntimeError("Kilo Gateway rate limit reached for Step 3.7 Flash. Please wait a moment and try again.") from exc
        raise RuntimeError(f"Kilo service error ({exc.status_code}): {exc.message}") from exc
    except (APIConnectionError, APITimeoutError) as exc:
        raise RuntimeError(f"Network error reaching Kilo Gateway: {exc}") from exc
    except Exception as exc:
        msg = str(exc).strip() or exc.__class__.__name__
        raise RuntimeError(f"Kilo stream interrupted: {msg}") from exc

    yield {
        "type": "done",
        "content": "".join(full),
        "reasoning": "".join(reasoning_full) or None,
    }
