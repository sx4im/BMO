"""NVIDIA AI Foundation client for BMO.

BMO talks to NVIDIA's OpenAI-compatible chat-completions endpoint
(https://integrate.api.nvidia.com/v1) via the **official OpenAI Python SDK**,
which NVIDIA's own documentation specifies as the supported client. Using
the SDK rather than hand-rolled ``requests`` calls eliminates whole classes
of subtle bugs (SSE chunk boundary parsing, header negotiation, retry on
transient HTTP/2 stream resets) and gives us typed errors so we can tell a
real authentication failure apart from a model-permission issue.

Streaming is the default: ``iter_response`` yields ``{"type": "delta", ...}``
events as tokens arrive, then a final ``{"type": "done", "content": "..."}``
event with the assembled text. Vision / multimodal payloads are supported
by passing OpenAI-style image-bearing message content (a list of content
parts) — the SDK forwards them unchanged.
"""

from __future__ import annotations

import base64
import html
import io
import logging
import os
import queue
import random
import re
import threading
import time
from typing import Iterable, Iterator, Optional

import requests

try:
    from PIL import Image
except ImportError:
    Image = None

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

from . import groq_client, mistral_client
from .config import (
    DEFAULT_BASE_URL,
    DEFAULT_IMAGE_BASE_URL,
    DEFAULT_IMAGE_MODEL,
    DEFAULT_MODEL,
    get_nexos_model,
    get_stanza_model,
)
from .prompts import (
    CONTINUATION_VISION_PROMPT,
    DEFAULT_SYSTEM_PROMPT,
    TITLE_PROMPT,
    VISION_SYSTEM_PROMPT,
)

logger = logging.getLogger("bmo.nvidia")


def base_url(model: Optional[str] = None) -> str:
    if model:
        if groq_client.is_groq_model(model):
            return groq_client.base_url()
        if mistral_client.is_mistral_model(model):
            return mistral_client.base_url()
        m = model.lower()
        if "inkling" in m or "nexos" in m or "nemotron" in m:
            nexos_url = os.environ.get("NVIDIA_NEXOS_BASE_URL") or os.environ.get("TINKER_BASE_URL")
            if nexos_url:
                return nexos_url.rstrip("/")
    return os.getenv("NVIDIA_BASE_URL", DEFAULT_BASE_URL).rstrip("/")


def default_model() -> str:
    return os.getenv("NVIDIA_MODEL", DEFAULT_MODEL)


# Characters that look like whitespace but survive a naive ``.strip()``:
_INVISIBLE_CHARS = (" ", "​", "‌", "‍", "﻿")


def _clean_key(raw: str) -> str:
    cleaned = raw
    for invisible in _INVISIBLE_CHARS:
        cleaned = cleaned.replace(invisible, "")
    cleaned = cleaned.strip().strip('"').strip("'").strip()
    if any(ch in cleaned for ch in ("\n", "\r", "\t", " ")):
        raise RuntimeError("API key contains whitespace inside the value.")
    return cleaned


def _read_api_key(model: Optional[str] = None) -> str:
    """Read API_KEY from the environment defensively.
    Supports model-specific overrides like NVIDIA_NEXOS_KEY, TINKER_API_KEY, GROQ_API_KEY, or MISTRAL_API_KEY.
    """
    if model:
        if groq_client.is_groq_model(model):
            return groq_client._read_api_key()
        if mistral_client.is_mistral_model(model):
            return mistral_client._read_api_key()
        m = model.lower()
        if "inkling" in m or "nexos" in m or "nemotron" in m:
            nexos_key = os.environ.get("NVIDIA_NEXOS_KEY") or os.environ.get("TINKER_API_KEY")
            if nexos_key:
                return _clean_key(nexos_key)

    raw = os.environ.get("NVIDIA_API_KEY")
    if not raw:
        raise RuntimeError(
            "NVIDIA_API_KEY is not set. Add it to backend/.env or your "
            "Render service environment."
        )
    cleaned = _clean_key(raw)
    if not cleaned:
        raise RuntimeError("NVIDIA_API_KEY is empty after stripping whitespace/quotes.")
    return cleaned


def api_key_fingerprint() -> dict:
    """Return a safe, obfuscated description of the configured key for logs.

    Never logs the full key. Shows length, first 8 / last 4 chars, and
    whether the format matches NVIDIA's ``nvapi-...`` prefix so the user
    can sanity-check Render config without exposing the secret.
    """
    try:
        key = _read_api_key()
    except RuntimeError as exc:
        return {"configured": False, "error": str(exc)}
    return {
        "configured": True,
        "length": len(key),
        "preview": f"{key[:8]}…{key[-4:]}" if len(key) > 14 else "(too short)",
        "nvapi_prefix": key.startswith("nvapi-"),
    }


def is_configured() -> bool:
    return bool(os.environ.get("NVIDIA_API_KEY")) or mistral_client.is_configured() or groq_client.is_configured()


# ---------------------------------------------------------------------------
# Image generation (FLUX via NVIDIA GenAI)
# ---------------------------------------------------------------------------

def image_base_url() -> str:
    return os.getenv("NVIDIA_IMAGE_BASE_URL", DEFAULT_IMAGE_BASE_URL).rstrip("/")


def image_model() -> str:
    """Text-to-image model."""
    return os.getenv("NVIDIA_IMAGE_MODEL", DEFAULT_IMAGE_MODEL)


def _image_timeout() -> float:
    try:
        return float(os.getenv("NVIDIA_IMAGE_TIMEOUT", "120"))
    except (TypeError, ValueError):
        return 120.0


def _is_klein(model: str) -> bool:
    return "klein" in model.lower()


def _default_image_steps(model: str) -> int:
    m = model.lower()
    if "schnell" in m or "klein" in m:
        return 4
    return 50


def _default_image_cfg(model: str) -> float:
    m = model.lower()
    if "schnell" in m or "klein" in m:
        return 0.0
    return 3.5


def _extract_image_b64(data) -> Optional[str]:
    if not isinstance(data, dict):
        return None
    arts = data.get("artifacts")
    if isinstance(arts, list) and arts and isinstance(arts[0], dict):
        b64 = arts[0].get("base64") or arts[0].get("b64_json")
        if b64:
            return b64
    img = data.get("image")
    if isinstance(img, str) and img:
        return img
    d = data.get("data")
    if isinstance(d, list) and d and isinstance(d[0], dict):
        return d[0].get("b64_json") or d[0].get("base64")
    return None


def _extract_finish_reason(data) -> str:
    if isinstance(data, dict):
        arts = data.get("artifacts")
        if isinstance(arts, list) and arts and isinstance(arts[0], dict):
            return str(arts[0].get("finishReason") or arts[0].get("finish_reason") or "")
    return ""


def _is_blank_image(png_bytes: bytes) -> bool:
    if Image is None:
        return False
    try:
        with Image.open(io.BytesIO(png_bytes)) as im:
            extrema = im.convert("RGB").getextrema()
            brightest = max(hi for _lo, hi in extrema)
            return brightest <= 10
    except Exception:
        return False


def _post_image(url: str, key: str, body: dict) -> dict:
    try:
        resp = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {key}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            json=body,
            timeout=_image_timeout(),
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"Network error reaching NVIDIA image API: {exc}") from exc

    if not resp.ok:
        detail = ""
        try:
            j = resp.json()
            if isinstance(j, dict):
                detail = (
                    j.get("detail")
                    or (j.get("error") or {}).get("message")
                    or j.get("message")
                    or ""
                )
        except ValueError:
            detail = (resp.text or "")[:300]
        logger.warning("image gen non-200: status=%s detail=%s", resp.status_code, detail)
        raise RuntimeError(f"NVIDIA {resp.status_code}: {detail or 'image generation failed'}")

    try:
        return resp.json()
    except ValueError as exc:
        raise RuntimeError("NVIDIA image API returned a non-JSON response.") from exc


def generate_image(
    prompt: str,
    *,
    model: Optional[str] = None,
    width: int = 1024,
    height: int = 1024,
    seed: Optional[int] = None,
    steps: Optional[int] = None,
    cfg_scale: Optional[float] = None,
) -> bytes:
    """Generate an image and return the raw PNG bytes."""
    chosen = model or image_model()
    steps = steps if steps is not None else _default_image_steps(chosen)
    cfg_scale = cfg_scale if cfg_scale is not None else _default_image_cfg(chosen)
    klein = _is_klein(chosen)
    key = _read_api_key()
    url = f"{image_base_url()}/{chosen}"

    pinned_seed = seed is not None
    attempts = 1 if pinned_seed else 3
    for attempt in range(attempts):
        use_seed = seed if pinned_seed else random.randint(0, 2_147_483_646)
        body: dict = {"prompt": prompt, "seed": use_seed, "steps": steps}
        if cfg_scale and not klein:
            body["cfg_scale"] = cfg_scale

        if not klein:
            body["mode"] = "base"

        body["width"] = width
        body["height"] = height

        data = _post_image(url, key, body)

        finish = _extract_finish_reason(data).upper()
        b64 = _extract_image_b64(data)
        if not b64:
            if "FILTER" in finish:
                logger.warning(
                    "image gen filtered with empty payload (attempt %d/%d, finish=%s) model=%s seed=%s",
                    attempt + 1, attempts, finish or "?", chosen, use_seed,
                )
                continue
            logger.warning(
                "image gen: no image data in response keys=%s model=%s finish=%s",
                list(data.keys()) if isinstance(data, dict) else type(data), chosen, finish or "?",
            )
            raise RuntimeError("NVIDIA image API returned no image data.")
        if b64.startswith("data:"):
            b64 = b64.split(",", 1)[-1]
        try:
            png = base64.b64decode(b64)
        except Exception as exc:
            raise RuntimeError("NVIDIA image API returned malformed image data.") from exc

        blank = _is_blank_image(png)
        if "FILTER" not in finish and not blank:
            return png

        logger.warning(
            "image gen blank/filtered (attempt %d/%d, finish=%s blank=%s) model=%s seed=%s",
            attempt + 1, attempts, finish or "?", blank, chosen, use_seed,
        )

    raise RuntimeError(
        "The image service returned a blank image (its safety filter may have "
        "flagged the result). Try rephrasing your prompt."
    )


def _max_retries() -> int:
    try:
        return max(0, int(os.getenv("NVIDIA_MAX_RETRIES", "3")))
    except (TypeError, ValueError):
        return 3


_client_cache: dict[str, object] = {}


def _client(model: Optional[str] = None) -> OpenAI:
    """Return a cached OpenAI client pointed at the target model's API endpoint."""
    try:
        timeout = float(os.getenv("NVIDIA_TIMEOUT", "300"))
    except (TypeError, ValueError):
        timeout = 300.0
    key = _read_api_key(model)
    target_base = base_url(model)
    retries = _max_retries()
    signature = f"{target_base}::{key}::{timeout}::{retries}"
    cached = _client_cache.get(signature)
    if cached is not None:
        return cached  # type: ignore[return-value]
    client = OpenAI(base_url=target_base, api_key=key, timeout=timeout, max_retries=retries)
    _client_cache[signature] = client
    return client


def max_output_tokens() -> int:
    try:
        return int(os.getenv("NVIDIA_MAX_TOKENS", "16384"))
    except (TypeError, ValueError):
        return 16384


def _format_api_error(exc: APIStatusError) -> str:
    body = getattr(exc, "body", None)
    detail = None
    if isinstance(body, dict):
        detail = body.get("detail")
        if not detail and isinstance(body.get("error"), dict):
            detail = body["error"].get("message")
        if not detail:
            detail = body.get("message")
    detail = detail or getattr(exc, "message", None) or str(exc)
    return f"NVIDIA {exc.status_code}: {detail}"


def list_models() -> list[dict]:
    """Fetch the full model catalogue from NVIDIA."""
    try:
        client = _client()
        page = client.models.list()
        models = [{"id": m.id} for m in page.data]
        logger.info(
            "Available models on API (%d total): %s",
            len(models), [m["id"] for m in models],
        )
        return models
    except APIStatusError as exc:
        logger.warning("list_models non-200: status=%s body=%s", exc.status_code, exc.body)
        return []
    except Exception as exc:
        logger.warning("Could not list models: %s", exc)
        return []


def test_call() -> dict:
    """Minimal chat completion to verify the key + the configured model."""
    try:
        model_to_test = default_model() or get_stanza_model() or DEFAULT_MODEL
        client = _client(model_to_test)
        completion = client.chat.completions.create(
            model=model_to_test,
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "Say 'API test OK' and nothing else."},
            ],
            max_tokens=20,
            temperature=0.0,
        )
        model = completion.model
        logger.info("API test call OK — responding model: %s", model)
        return {"ok": True, "model": model}
    except AuthenticationError as exc:
        logger.warning("API test call auth failure: %s", exc)
        return {"ok": False, "error_kind": "auth", "status": 401, "detail": _format_api_error(exc)}
    except PermissionDeniedError as exc:
        logger.warning("API test call permission denied: %s", exc)
        return {"ok": False, "error_kind": "permission", "status": 403, "detail": _format_api_error(exc)}
    except NotFoundError as exc:
        logger.warning("API test call model not found: %s", exc)
        return {"ok": False, "error_kind": "not_found", "status": 404, "detail": _format_api_error(exc)}
    except BadRequestError as exc:
        logger.warning("API test call bad request: %s", exc)
        return {"ok": False, "error_kind": "bad_request", "status": 400, "detail": _format_api_error(exc)}
    except RateLimitError as exc:
        logger.warning("API test call rate limited: %s", exc)
        return {"ok": False, "error_kind": "rate_limit", "status": 429, "detail": _format_api_error(exc)}
    except APIStatusError as exc:
        logger.warning("API test call non-200: status=%s body=%s", exc.status_code, exc.body)
        return {"ok": False, "error_kind": "http", "status": exc.status_code, "detail": _format_api_error(exc)}
    except (APIConnectionError, APITimeoutError) as exc:
        logger.warning("API test call network error: %s", exc)
        return {"ok": False, "error_kind": "network", "detail": str(exc)}
    except RuntimeError as exc:
        logger.warning("API test call config error: %s", exc)
        return {"ok": False, "error_kind": "config", "detail": str(exc)}
    except Exception as exc:
        logger.warning("API test call failed: %s", exc)
        return {"ok": False, "error_kind": "unknown", "detail": str(exc)}


def _merge_content(a, b):
    if isinstance(a, list) or isinstance(b, list):
        ap = a if isinstance(a, list) else [{"type": "text", "text": str(a)}]
        bp = b if isinstance(b, list) else [{"type": "text", "text": str(b)}]
        return ap + bp
    return f"{a}\n\n{b}"


def _coerce_alternating(messages: list[dict]) -> list[dict]:
    system = [m for m in messages if m.get("role") == "system"]
    rest = [m for m in messages if m.get("role") != "system"]
    while rest and rest[0].get("role") == "assistant":
        rest.pop(0)
    merged: list[dict] = []
    for m in rest:
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1] = {"role": m["role"], "content": _merge_content(merged[-1]["content"], m["content"])}
        else:
            merged.append({"role": m["role"], "content": m["content"]})
    return system + merged


_SPAN_RE = re.compile(r"</?span\b[^>]*>", re.IGNORECASE)

# A span opener hiding behind HTML entities: &lt;span / &#60;span etc. The
# optional "amp;" catches the double-escaped "&amp;lt;span" form too.
_ESCAPED_SPAN_RE = re.compile(r"&(?:amp;|)lt;(?:amp;|)\s*span\b", re.IGNORECASE)


def sanitize_reply(text: str) -> str:
    """Final-pass cleaner for COMPLETE assistant replies.

    Runs once over the assembled reply (after SSE chunks are joined back into
    contiguous markup): strip raw + entity-escaped highlight.js spans. Entities
    outside deleted spans are never decoded, so legitimate escaped source like
    ``#include &lt;iostream&gt;`` survives untouched.
    """
    if not text:
        return text
    return _strip_leaked_highlight_spans(text)


def _strip_leaked_highlight_spans(text: str) -> str:
    """Remove leaked highlight.js span markup — raw and entity-escaped forms.

    The upstream model occasionally pastes pre-rendered highlight.js output
    into its markdown code fences, either as raw HTML or as entity-escaped
    literal text (&lt;span class=...&gt;). hljs also entity-escapes the code
    itself (&lt;vector&gt;), so once a leak is PROVEN every remaining entity
    in the text is treated as highlighter serialization and decoded back to
    the original source characters. Text without any span evidence is returned
    byte-identical.
    """
    if not text or ("span" not in text.lower() and "&" not in text):
        return text

    leaked = False
    prev = None
    while prev != text:
        prev = text
        stripped = _SPAN_RE.sub("", text)
        if stripped != text:
            text = stripped          # removed a raw <span ...> layer
            leaked = True
            continue
        if _ESCAPED_SPAN_RE.search(text):
            text = html.unescape(text)  # reveal an entity-escaped layer
            leaked = True
            continue
        break

    if not leaked:
        return text
    # Decode whatever the highlighter escaped inside the leaked markup.
    return html.unescape(text)


def _clean_llm_text(text: str) -> str:
    if not text:
        return ""
    # Strip channel tokens e.g. <|channel|>thought, <|channel|>, <channel|>
    text = re.sub(r"<\|channel\|>[a-zA-Z0-9_]*|<\|channel\|>|<channel\|>[a-zA-Z0-9_]*|<channel\|>", "", text)
    text = _strip_leaked_highlight_spans(text)
    return text


def build_messages_for_vision(
    history: Iterable[dict],
    user_content,
    *,
    history_limit: int = 24,
) -> list[dict]:
    out: list[dict] = [{"role": "system", "content": VISION_SYSTEM_PROMPT}]
    history = [m for m in history if m.get("role") in {"user", "assistant"}]
    for m in history[-history_limit:]:
        role = m["role"]
        content = m.get("content")
        if isinstance(content, list):
            out.append({"role": role, "content": content})
        elif content:
            out.append({"role": role, "content": _clean_llm_text(str(content))})
    out.append({"role": "user", "content": user_content})
    return _coerce_alternating(out)



def build_vision_continuation_messages(
    history: Iterable[dict],
    user_content,
    *,
    history_limit: int = 24,
) -> list[dict]:
    out: list[dict] = [{"role": "system", "content": CONTINUATION_VISION_PROMPT}]
    history = [m for m in history if m.get("role") in {"user", "assistant"}]
    for m in history[-history_limit:]:
        role = m["role"]
        content = m.get("content")
        if isinstance(content, list):
            out.append({"role": role, "content": content})
        elif content:
            out.append({"role": role, "content": _clean_llm_text(str(content))})
    out.append({"role": "user", "content": user_content})
    return _coerce_alternating(out)


# Alias for backward-compatibility with chat_routes batching
build_continuation_messages = build_vision_continuation_messages


def build_messages(
    history: Iterable[dict],
    user_content,
    *,
    system_prompt: Optional[str] = None,
    base_system_prompt: Optional[str] = None,
    history_limit: int = 24,
) -> list[dict]:
    base_prompt = base_system_prompt or DEFAULT_SYSTEM_PROMPT
    if system_prompt and system_prompt != base_prompt:
        base_prompt = f"{base_prompt}\n\nAdditional instructions: {system_prompt}"
    out: list[dict] = [{"role": "system", "content": base_prompt}]
    history = [m for m in history if m.get("role") in {"user", "assistant"}]
    for m in history[-history_limit:]:
        role = m["role"]
        content = m.get("content")
        if isinstance(content, list):
            out.append({"role": role, "content": content})
        elif content:
            out.append({"role": role, "content": _clean_llm_text(str(content))})
    out.append({"role": "user", "content": user_content})
    return _coerce_alternating(out)


_NEMOTRON_REASONING_ON = "detailed thinking on"
_NEMOTRON_REASONING_OFF = "detailed thinking off"


def _nemotron_set_reasoning(messages: list[dict], on: bool) -> list[dict]:
    directive = _NEMOTRON_REASONING_ON if on else _NEMOTRON_REASONING_OFF
    out = [dict(m) for m in messages]
    for m in out:
        if m.get("role") == "system":
            content = m.get("content")
            if isinstance(content, str) and directive not in content.lower():
                m["content"] = f"{directive}\n\n{content}"
            return out
    out.insert(0, {"role": "system", "content": directive})
    return out


def iter_response(
    messages: list[dict],
    *,
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
    reasoning_effort: Optional[str] = None,
    thinking: bool = True,
) -> Iterator[dict]:
    """Stream text chunks from the selected model via NVIDIA API.

    Yields:
        {"type": "delta", "data": str} for answer tokens
        {"type": "reasoning_delta", "data": str} for reasoning tokens
        {"type": "usage", "data": dict} at the end if provided
    """
    chosen_model = (model or default_model()).strip()
    if mistral_client.is_mistral_model(chosen_model):
        yield from mistral_client.iter_response(
            messages,
            model=chosen_model,
            temperature=temperature,
            max_tokens=max_tokens,
            reasoning_effort=reasoning_effort,
        )
        return

    if groq_client.is_groq_model(chosen_model):
        if groq_client.is_configured():
            try:
                yield from groq_client.iter_response(
                    messages,
                    model=chosen_model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
                return
            except Exception as exc:
                logger.warning("Groq inference failed for %s, falling back to Stanza: %s", chosen_model, exc)
                yield from mistral_client.iter_response(
                    messages,
                    model=get_stanza_model(),
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
                return
        else:
            logger.info("GROQ_API_KEY not configured for %s, falling back to Stanza", chosen_model)
            yield from mistral_client.iter_response(
                messages,
                model=get_stanza_model(),
                temperature=temperature,
                max_tokens=max_tokens,
            )
            return

    kwargs = {}

    if any(k in chosen_model.lower() for k in ("deepseek", "inkling", "thinking", "mistral", "gpt-oss", "oss", "nexos", "gemma", "diffusiongemma", "google")):
        if max_tokens is None:
            max_tokens = 16384
        if thinking:
            effort = reasoning_effort or "low"
            kwargs["reasoning_effort"] = effort
            kwargs["extra_body"] = {
                "chat_template_kwargs": {
                    "thinking": True,
                    "enable_thinking": True,
                    "reasoning_effort": effort,
                }
            }
        else:
            kwargs["extra_body"] = {
                "chat_template_kwargs": {
                    "thinking": False,
                    "enable_thinking": False,
                }
            }
    elif "minimax" in chosen_model.lower():
        if max_tokens is None:
            max_tokens = 16384
        temperature = 1.0
        kwargs["top_p"] = 0.95
        if thinking:
            effort = reasoning_effort or "high"
            kwargs["reasoning_effort"] = effort
            kwargs["extra_body"] = {"chat_template_kwargs": {"thinking": True, "reasoning_effort": effort}}
        else:
            kwargs["extra_body"] = {"chat_template_kwargs": {"thinking": False}}
    elif "nemotron" in chosen_model.lower():
        if max_tokens is None:
            max_tokens = 16384
        effort = reasoning_effort or "low"
        is_super = "super" in chosen_model.lower()
        # On Nemotron Super, low effort means fast concise thinking without long 'detailed thinking' prefix
        if thinking:
            if not is_super or effort in ("high", "max"):
                messages = _nemotron_set_reasoning(messages, True)
        else:
            messages = _nemotron_set_reasoning(messages, False)

        # Official NVIDIA NIM recommendation for Nemotron 3 Super: temperature=1.0, top_p=0.95
        if is_super:
            temperature = 1.0
            kwargs["top_p"] = 0.95

        if thinking:
            kwargs["reasoning_effort"] = effort
            kwargs["extra_body"] = {
                "chat_template_kwargs": {
                    "thinking": True,
                    "enable_thinking": True,
                    "low_effort": (effort == "low"),
                    "reasoning_effort": effort,
                }
            }
        else:
            kwargs["extra_body"] = {
                "chat_template_kwargs": {
                    "thinking": False,
                    "enable_thinking": False,
                }
            }
    elif any(k in chosen_model.lower() for k in ("muse", "stanza")):
        if max_tokens is None:
            max_tokens = 16384
        if thinking:
            effort = reasoning_effort or "low"
            kwargs["reasoning_effort"] = effort
            kwargs["extra_body"] = {"chat_template_kwargs": {"thinking": True, "reasoning_effort": effort}}
        else:
            kwargs["extra_body"] = {"chat_template_kwargs": {"thinking": False}}
    elif "qwen" in chosen_model.lower():
        if max_tokens is None:
            max_tokens = 16384
        if thinking and reasoning_effort:
            kwargs["reasoning_effort"] = reasoning_effort
            kwargs["extra_body"] = {"chat_template_kwargs": {"thinking": True, "reasoning_effort": reasoning_effort}}
    elif "step" in chosen_model.lower():
        if max_tokens is None:
            max_tokens = 16384
        if thinking and reasoning_effort:
            kwargs["reasoning_effort"] = reasoning_effort
            kwargs["extra_body"] = {"chat_template_kwargs": {"thinking": True, "reasoning_effort": reasoning_effort}}
    elif "llama" in chosen_model.lower():
        if max_tokens is None:
            max_tokens = 4096
    else:
        if max_tokens is None:
            max_tokens = max_output_tokens()
        if thinking and reasoning_effort:
            kwargs["reasoning_effort"] = reasoning_effort
            kwargs["extra_body"] = {"chat_template_kwargs": {"thinking": True, "reasoning_effort": reasoning_effort}}

    t_sdk_start = time.time()
    try:
        client = _client(chosen_model)
        t_client = time.time()
        stream = client.chat.completions.create(
            model=chosen_model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=True,
            **kwargs
        )
        t_stream_obj = time.time()
        logger.info(
            "nvidia: sdk_setup=%.3fs (client=%.3fs create=%.3fs) model=%s msgs=%d",
            t_stream_obj - t_sdk_start,
            t_client - t_sdk_start,
            t_stream_obj - t_client,
            chosen_model,
            len(messages),
        )
    except AuthenticationError as exc:
        raise RuntimeError(_format_api_error(exc)) from exc
    except PermissionDeniedError as exc:
        raise RuntimeError(_format_api_error(exc)) from exc
    except NotFoundError as exc:
        raise RuntimeError(
            f"Model '{chosen_model}' was not found on NVIDIA. "
            f"Check NVIDIA_MODEL in Render. ({_format_api_error(exc)})"
        ) from exc
    except BadRequestError as exc:
        raise RuntimeError(_format_api_error(exc)) from exc
    except RateLimitError as exc:
        raise RuntimeError(_format_api_error(exc)) from exc
    except APIStatusError as exc:
        raise RuntimeError(_format_api_error(exc)) from exc
    except (APIConnectionError, APITimeoutError) as exc:
        raise RuntimeError(f"Network error reaching NVIDIA: {exc}") from exc
    except Exception as exc:
        msg = str(exc).strip() or exc.__class__.__name__
        raise RuntimeError(
            f"NVIDIA request failed: {msg}. If this is a large PDF, "
            "the image payload may have exceeded the API size limit."
        ) from exc

    in_think_tag = False
    in_channel_thought = False
    full: list[str] = []
    reasoning_full: list[str] = []
    chunk_count = 0
    got_finish = False
    show_thought_ui = True

    try:
        for chunk in stream:
            chunk_count += 1
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            
            reasoning = (
                getattr(choice.delta, "reasoning", None) or getattr(choice.delta, "reasoning_content", None)
            )
            delta = getattr(choice.delta, "content", None) if choice.delta else None
            
            if reasoning:
                clean_reasoning = _clean_llm_text(reasoning)
                if clean_reasoning:
                    reasoning_full.append(clean_reasoning)
                    if show_thought_ui:
                        yield {"type": "reasoning_delta", "data": clean_reasoning}
                
            if delta:
                delta = _strip_leaked_highlight_spans(delta)

                if "<|channel|>thought" in delta:
                    parts = delta.split("<|channel|>thought", 1)
                    if parts[0]:
                        p0 = _clean_llm_text(parts[0])
                        if p0:
                            full.append(p0)
                            yield {"type": "delta", "data": p0}
                    in_channel_thought = True
                    delta = parts[1]

                if in_channel_thought and delta:
                    if "<|channel|>" in delta:
                        think_part, content_part = delta.split("<|channel|>", 1)
                        if think_part:
                            tp = _clean_llm_text(think_part)
                            if tp:
                                reasoning_full.append(tp)
                                if show_thought_ui:
                                    yield {"type": "reasoning_delta", "data": tp}
                        in_channel_thought = False
                        delta = content_part
                    else:
                        tp = _clean_llm_text(delta)
                        if tp:
                            reasoning_full.append(tp)
                            if show_thought_ui:
                                yield {"type": "reasoning_delta", "data": tp}
                        delta = None

                if delta and "<think>" in delta:
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
                                if show_thought_ui:
                                    yield {"type": "reasoning_delta", "data": tp}
                        in_think_tag = False
                        delta = content_part
                    else:
                        tp = _clean_llm_text(delta)
                        if tp:
                            reasoning_full.append(tp)
                            if show_thought_ui:
                                yield {"type": "reasoning_delta", "data": tp}
                        delta = None

            if delta:
                delta = _clean_llm_text(delta)
                if delta:
                    full.append(delta)
                    yield {"type": "delta", "data": delta}
                
            if choice.finish_reason:
                got_finish = True
                logger.info(
                    "nvidia: finish_reason=%s chunks=%d chars=%d model=%s",
                    choice.finish_reason, chunk_count, len("".join(full)), chosen_model,
                )
                break
    except APIStatusError as exc:
        raise RuntimeError(_format_api_error(exc)) from exc
    except (APIConnectionError, APITimeoutError) as exc:
        raise RuntimeError(f"Stream interrupted: {exc}") from exc
    except Exception as exc:
        msg = str(exc).strip() or exc.__class__.__name__
        raise RuntimeError(f"Stream interrupted: {msg}") from exc

    content = "".join(full)
    if not content.strip():
        logger.warning(
            "nvidia: model returned EMPTY content (chunks=%d finish=%s model=%s). "
            "If this is a PDF, the model may have timed out or rejected the image payload.",
            chunk_count, got_finish, chosen_model,
        )
    yield {"type": "done", "content": content, "reasoning": "".join(reasoning_full)}


def iter_response_with_fallback(
    messages: list[dict],
    *,
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
    reasoning_effort: Optional[str] = None,
    thinking: bool = True,
) -> Iterator[dict]:
    """Wraps `iter_response` with automatic fallback to Stanza 2.5 if primary times out."""
    chosen_model = model or default_model()

    stanza_id = get_stanza_model().lower()
    nexos_id = get_nexos_model().lower()
    
    current_lower = chosen_model.lower()
    
    # Auto-switch timeout for first token: Nexos 50s
    if current_lower == nexos_id or "inkling" in current_lower or "deepseek" in current_lower or "mistral-medium" in current_lower:
        first_token_timeout = 50.0
    else:
        first_token_timeout = None

    stanza_model = get_stanza_model()

    if not first_token_timeout or current_lower == stanza_id:
        yield from iter_response(
            messages,
            model=chosen_model,
            temperature=temperature,
            max_tokens=max_tokens,
            reasoning_effort=reasoning_effort,
            thinking=thinking,
        )
        return

    q: queue.Queue = queue.Queue()
    stop_event = threading.Event()

    def _worker(target_model: str):
        try:
            for item in iter_response(
                messages,
                model=target_model,
                temperature=temperature,
                max_tokens=max_tokens,
                reasoning_effort=reasoning_effort,
                thinking=thinking,
            ):
                if stop_event.is_set():
                    break
                q.put(("data", item))
            q.put(("end", None))
        except Exception as exc:
            q.put(("error", exc))

    t = threading.Thread(target=_worker, args=(chosen_model,), daemon=True)
    t.start()

    try:
        kind, first_val = q.get(timeout=first_token_timeout)
    except queue.Empty:
        stop_event.set()
        kind, first_val = "timeout", f"No token within {int(first_token_timeout)}s"

    if kind == "data":
        yield first_val
        while True:
            k, v = q.get()
            if k == "end":
                break
            if k == "error":
                raise v
            if k == "data":
                yield v
        return

    logger.warning(
        "nvidia: primary model %s failed first-token check (%s). Auto-switching to Stanza 2.5 (%s)...",
        chosen_model, first_val, stanza_model
    )

    yield from iter_response(
        messages,
        model=stanza_model,
        temperature=temperature,
        max_tokens=max_tokens,
        reasoning_effort=reasoning_effort,
        thinking=thinking,
    )


def complete(
    messages: list[dict],
    *,
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
) -> str:
    """Non-streaming convenience — buffers iter_response into a single string."""
    text: list[str] = []
    for ev in iter_response(messages, model=model, temperature=temperature, max_tokens=max_tokens):
        if ev["type"] == "delta":
            text.append(ev["data"])
        elif ev["type"] == "done":
            return ev["content"]
    return "".join(text)


def generate_title(user_message: str, assistant_reply: str) -> Optional[str]:
    """Ask a small model for a clean 3-6 word title for the conversation."""
    user_snippet = (user_message or "").strip()[:600]
    assistant_snippet = (assistant_reply or "").strip()[:600]
    if not user_snippet:
        return None
    try:
        model_to_use = get_stanza_model() or default_model()
        if mistral_client.is_mistral_model(model_to_use):
            client = mistral_client._client()
        else:
            client = _client(model_to_use)
        completion = client.chat.completions.create(
            model=model_to_use,
            messages=[
                {"role": "system", "content": TITLE_PROMPT},
                {
                    "role": "user",
                    "content": (
                        f"User message:\n{user_snippet}\n\n"
                        f"Assistant reply (first part):\n{assistant_snippet}\n\n"
                        "Title:"
                    ),
                },
            ],
            max_tokens=24,
            temperature=0.3,
        )
        raw = (completion.choices[0].message.content or "").strip()
    except Exception as exc:
        logger.warning("generate_title failed: %s", exc)
        return None

    title = raw.strip().strip("`").strip()
    for prefix in ("Title:", "title:", "TITLE:"):
        if title.startswith(prefix):
            title = title[len(prefix):].strip()
    title = title.strip("\"'*. \n")
    title = title.split("\n", 1)[0].strip()
    if not title or len(title) > 80:
        return None
    return title
