"""Chat provider routing, message formatting, and Iris image generation."""

from __future__ import annotations

import base64
import html
import io
import logging
import os
import queue
import re
import threading
import time
from typing import Iterable, Iterator, Optional

import requests

try:
    from PIL import Image
except ImportError:
    Image = None

from . import groq_client, mistral_client
from .config import (
    DEFAULT_IMAGE_BASE_URL,
    DEFAULT_IMAGE_MODEL,
    IMAGE_STEPS,
    get_nexos_model,
    get_stanza_model,
    get_vision_model,
)
from .prompts import (
    CONTINUATION_VISION_PROMPT,
    DEFAULT_SYSTEM_PROMPT,
    IMAGE_CONTEXT_PROMPT,
    TITLE_PROMPT,
    VISION_SYSTEM_PROMPT,
)

logger = logging.getLogger(__name__)


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


def _read_api_key() -> str:
    """Read the key used for Iris image generation."""
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


def is_configured() -> bool:
    return groq_client.is_configured() or mistral_client.is_configured()


# ---------------------------------------------------------------------------
# Image generation (FLUX via NVIDIA GenAI)
# ---------------------------------------------------------------------------

def image_base_url() -> str:
    return os.getenv("NVIDIA_IMAGE_BASE_URL", DEFAULT_IMAGE_BASE_URL).rstrip("/")


def image_model() -> str:
    """Text-to-image model. Not env-configurable, so a stale Render value can't swap it."""
    return DEFAULT_IMAGE_MODEL


def _image_timeout() -> float:
    try:
        return float(os.getenv("NVIDIA_IMAGE_TIMEOUT", "120"))
    except (TypeError, ValueError):
        return 120.0


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
    width: int = 1024,
    height: int = 1024,
    seed: Optional[int] = None,
    steps: int = IMAGE_STEPS,
) -> bytes:
    """Generate an image and return the raw PNG bytes."""
    chosen = image_model()
    key = _read_api_key()
    url = f"{image_base_url()}/{chosen}"

    pinned_seed = seed is not None
    attempts = 1 if pinned_seed else 3
    for attempt in range(attempts):
        # FLUX3 rejects seed as an extra input. Keep the Python argument only
        # for caller compatibility; generation randomness belongs to the API.
        body = {"prompt": prompt, "steps": steps, "width": width, "height": height}
        data = _post_image(url, key, body)

        finish = _extract_finish_reason(data).upper()
        b64 = _extract_image_b64(data)
        if not b64:
            if "FILTER" in finish:
                logger.warning(
                    "image gen filtered with empty payload (attempt %d/%d, finish=%s) model=%s",
                    attempt + 1, attempts, finish or "?", chosen,
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
            "image gen blank/filtered (attempt %d/%d, finish=%s blank=%s) model=%s",
            attempt + 1, attempts, finish or "?", blank, chosen,
        )

    raise RuntimeError(
        "The image service returned a blank image (its safety filter may have "
        "flagged the result). Try rephrasing your prompt."
    )


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


# Recognize complete span tags; malformed or unmatched markup stays untouched.
_RAW_SPAN_RE = re.compile(r"""</?span\b(?:[^>"']|"[^"]*"|'[^']*')*>""", re.IGNORECASE)
_SPAN_RE = re.compile(
    _RAW_SPAN_RE.pattern + r"|&(?:amp;)*(?:lt|#0*60|#x0*3c);/?span\b.*?&(?:amp;)*(?:gt|#0*62|#x0*3e);",
    re.IGNORECASE | re.DOTALL,
)
_SPAN_ATTR_RE = re.compile(r"""([^\s=<>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?""")


def sanitize_reply(text: str) -> str:
    """Remove balanced highlight.js wrappers from an assembled reply only."""
    return _strip_leaked_highlight_spans(text) if text else text


def _strip_leaked_highlight_spans(text: str) -> str:
    """Preserve source outside proven, balanced hljs serialization regions.

    An ordinary span (including its matching closing tag), incomplete markup,
    and unrelated entity escapes are source, not highlighter debris. Explicit
    hljs classes are the evidence for cleanup; literal examples of those classes
    remain inherently ambiguous, so only balanced wrappers are recognized.
    """
    if not text or "span" not in text.lower():
        return text
    tokens = []
    stacks = {}
    pairs = {}
    for match in _SPAN_RE.finditer(text):
        tag = match.group()
        depth = 0
        while not tag.startswith("<"):
            decoded = html.unescape(tag)
            if decoded == tag:
                break
            tag = decoded
            depth += 1
        if not _RAW_SPAN_RE.fullmatch(tag):
            continue
        index = len(tokens)
        tokens.append((match.start(), match.end(), depth))
        stack = stacks.setdefault(depth, [])
        if tag.startswith("</"):
            if stack:
                opener, highlighted = stack.pop()
                if highlighted:
                    pairs[opener] = index
        elif not tag.endswith("/>"):
            classes = []
            for attribute in _SPAN_ATTR_RE.finditer(tag[5:-1]):
                if attribute[1].lower() == "class":
                    classes = (attribute[2] or "").strip("\"'").split()
            highlighted = any(c == "hljs" or c.startswith("hljs-") for c in classes)
            stack.append((index, highlighted))
    if not pairs:
        return text
    closers = {closer: opener for opener, closer in pairs.items()}
    active = {}
    result = []
    cursor = 0

    def decode(value):
        for _ in range(max(active.values(), default=-1) + 1):
            value = html.unescape(value)
        return value

    for index, (start, end, depth) in enumerate(tokens):
        result.append(decode(text[cursor:start]))
        if index in pairs:
            active[index] = depth
        elif index in closers:
            active.pop(closers[index], None)
        else:
            # Preserve raw attributes exactly, even within a highlighter wrapper.
            result.append(decode(text[start:end]) if depth else text[start:end])
        cursor = end
    result.append(decode(text[cursor:]))
    return "".join(result)


def _clean_llm_text(text: str) -> str:
    return _strip_leaked_highlight_spans(_clean_stream_text(text))


def _clean_stream_text(text: str) -> str:
    """Strip protocol markers without rewriting partially streamed source markup."""
    if not text:
        return ""
    return re.sub(r"<\|channel\|>[a-zA-Z0-9_]*|<\|channel\|>|<channel\|>[a-zA-Z0-9_]*|<channel\|>", "", text)


def build_messages_for_vision(
    history: Iterable[dict],
    user_content,
    *,
    system_prompt: Optional[str] = None,
    history_limit: int = 24,
) -> list[dict]:
    sys_content = f"{system_prompt}\n\n{VISION_SYSTEM_PROMPT}" if system_prompt else VISION_SYSTEM_PROMPT
    out: list[dict] = [{"role": "system", "content": sys_content}]
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
    system_prompt: Optional[str] = None,
    history_limit: int = 24,
) -> list[dict]:
    prompt = "\n\n".join(filter(None, [system_prompt, CONTINUATION_VISION_PROMPT]))
    out: list[dict] = [{"role": "system", "content": prompt}]
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


def iter_response(
    messages: list[dict],
    *,
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
    reasoning_effort: Optional[str] = None,
    thinking: bool = True,
) -> Iterator[dict]:
    """Stream a completion from the provider of the configured chat model."""
    chosen_model = (model or get_stanza_model()).strip()
    if mistral_client.is_mistral_model(chosen_model):
        yield from mistral_client.iter_response(
            messages, model=chosen_model, temperature=temperature,
            max_tokens=max_tokens, reasoning_effort=reasoning_effort,
        )
        return

    if groq_client.is_groq_model(chosen_model):
        yield from groq_client.iter_response(
            messages, model=chosen_model, temperature=temperature,
            max_tokens=max_tokens, reasoning_effort=reasoning_effort, thinking=thinking,
        )
        return

    raise RuntimeError(f"No chat provider configured for model '{chosen_model}'.")


def iter_response_with_fallback(
    messages: list[dict],
    *,
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
    reasoning_effort: Optional[str] = None,
    thinking: bool = True,
    allow_fallback: bool = True,
) -> Iterator[dict]:
    """Wraps `iter_response` with automatic fallback to Stanza 2.5 if primary times out."""
    chosen_model = model or get_stanza_model()

    stanza_id = get_stanza_model().lower()
    nexos_id = get_nexos_model().lower()
    
    current_lower = chosen_model.lower()
    
    # Give Nexos 50 seconds to produce its first answer or reasoning token.
    if current_lower == nexos_id:
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
        first_token_deadline = time.monotonic() + first_token_timeout
        try:
            while True:
                kind, first_val = q.get(timeout=max(0, first_token_deadline - time.monotonic()))
                if kind != "data" or first_val.get("type") != "inference":
                    break
                # An upstream role/metadata chunk is evidence of a request, but
                # does not satisfy the existing first-answer-token deadline.
                yield first_val
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

        if not allow_fallback:
            if kind == "error":
                raise first_val
            raise TimeoutError(str(first_val or "Model ended before the first answer token"))

        logger.warning(
            "Primary model %s failed first-token check (%s). Auto-switching to Stanza 2.5 (%s)...",
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
    finally:
        stop_event.set()


def describe_image(image_part: dict) -> str:
    """Text version of one image, so text-only models can answer follow-ups about it."""
    messages = [{
        "role": "user",
        "content": [{"type": "text", "text": IMAGE_CONTEXT_PROMPT}, image_part],
    }]
    content = ""
    for ev in mistral_client.iter_response(messages, model=get_vision_model(), max_tokens=900):
        if ev["type"] == "done":
            content = ev["content"] or ""
    return content.strip()


def generate_title(user_message: str, assistant_reply: str) -> Optional[str]:
    """Ask a small model for a clean 3-6 word title for the conversation."""
    user_snippet = (user_message or "").strip()[:600]
    assistant_snippet = (assistant_reply or "").strip()[:600]
    if not user_snippet:
        return None
    try:
        model_to_use = get_stanza_model()
        options = {}
        if mistral_client.is_mistral_model(model_to_use):
            client = mistral_client._client()
        elif groq_client.is_groq_model(model_to_use):
            client = groq_client._client()
            if model_to_use.startswith("qwen/qwen3"):
                options["reasoning_effort"] = "none"
            elif model_to_use.startswith("openai/gpt-oss"):
                options["reasoning_effort"] = "low"
        else:
            raise RuntimeError(f"No chat provider configured for model '{model_to_use}'.")
        completion = client.with_options(timeout=8.0, max_retries=0).chat.completions.create(
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
            **options,
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
    # Normalize any CamelCase/PascalCase without spaces (e.g. InitialBoxPlacementRules -> Initial Box Placement Rules)
    if " " not in title and re.search(r"[a-z][A-Z]", title):
        title = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", title).strip()
    title = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", title).strip()
    title = re.sub(r"\s+", " ", title).strip()
    if not title or len(title) > 80:
        return None
    return title
