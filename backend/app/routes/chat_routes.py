"""Chat, streaming completions, and stream cancellation routes for BMO."""

from __future__ import annotations

import base64
import logging
import os
import queue
import re
import threading
import time
import uuid

from flask import Blueprint, Response, request, stream_with_context

from .. import document_processor, nvidia_client, project_service, search_router, store
from ..auth import require_user
from ..config import (
    ALL_VALID_MODEL_IDS,
    KNOWN_MODEL_IDS,
    SESSION_LIMIT,
    get_real_id_map,
    get_vision_model,
)
from ..limiter import limiter
from ..prompts import (
    AEON_SYSTEM_PROMPT,
    DEFAULT_SYSTEM_PROMPT,
    earlier_attachment_note,
    image_settings_reply,
    wrap_attachment_content,
)
from .helpers import (
    MODEL_BUSY_REPLY,
    bad_request,
    estimate_tokens,
    friendly_error,
    get_usage_status,
    human_duration,
    is_transient_model_error,
    is_trivial_prompt,
    sse_event,
    user_owns_path,
)

logger = logging.getLogger("bmo.routes.chat")

chat_bp = Blueprint("chat_routes", __name__)

# ---------- chat cancellation registry ----------
_cancel_events: dict[str, tuple[threading.Event, str]] = {}
_cancel_lock = threading.Lock()
_CANCEL_REGISTRY_MAX = 512


def _register_cancel(stream_id: str, user_id: str) -> threading.Event:
    ev = threading.Event()
    with _cancel_lock:
        if len(_cancel_events) >= _CANCEL_REGISTRY_MAX:
            for old in list(_cancel_events)[: max(1, _CANCEL_REGISTRY_MAX // 4)]:
                _cancel_events.pop(old, None)
        _cancel_events[stream_id] = (ev, user_id)
    return ev


def _signal_cancel(stream_id: str, user_id: str) -> bool:
    with _cancel_lock:
        entry = _cancel_events.get(stream_id)
    if entry and entry[1] == user_id:
        entry[0].set()
        return True
    return False


def _unregister_cancel(stream_id: str) -> None:
    with _cancel_lock:
        _cancel_events.pop(stream_id, None)


# ---------- PDF batching helpers ----------

def _estimate_payload_size(parts: list[dict]) -> int:
    total = 0
    for p in parts:
        if p.get("type") == "text":
            total += len(p.get("text", "").encode("utf-8"))
        elif p.get("type") == "image_url":
            url = p.get("image_url", {}).get("url", "")
            total += len(url.encode("utf-8"))
    return total


def _split_doc_parts_into_batches(doc_parts: list[dict], pages_per_batch: int = 5) -> list[list[dict]]:
    if not doc_parts:
        return []

    text_parts = [p for p in doc_parts if p.get("type") == "text"]
    image_parts = [p for p in doc_parts if p.get("type") == "image_url"]

    if not text_parts or not image_parts:
        return [doc_parts] if doc_parts else []

    full_text = text_parts[0].get("text", "")
    matches = list(re.finditer(r"--- Page (\d+) ---\n", full_text))
    if not matches:
        return [doc_parts]

    header = full_text[:matches[0].start()].strip() if matches[0].start() > 0 else ""

    page_texts: dict[int, str] = {}
    for i, match in enumerate(matches):
        page_num = int(match.group(1))
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(full_text)
        page_texts[page_num] = full_text[start:end].strip()

    total_pages = len(image_parts)
    batches: list[list[dict]] = []

    for batch_start in range(0, total_pages, pages_per_batch):
        batch_end = min(batch_start + pages_per_batch, total_pages)
        batch_page_nums = list(range(batch_start + 1, batch_end + 1))

        batch_texts: list[str] = []
        if header:
            batch_texts.append(header)
        for pn in batch_page_nums:
            if pn in page_texts:
                batch_texts.append(f"--- Page {pn} ---\n{page_texts[pn]}")

        batch_parts: list[dict] = []
        if batch_texts:
            batch_parts.append({"type": "text", "text": "\n\n".join(batch_texts)})
        batch_parts.extend(image_parts[batch_start:batch_end])
        batches.append(batch_parts)

    return batches


def _recent_history_images(history: list[dict]) -> list[dict]:
    for m in reversed(history):
        if m.get("role") != "user":
            continue
        imgs = [
            a for a in (m.get("attachments") or [])
            if isinstance(a, dict)
            and (a.get("content_type") or "").startswith("image/")
            and a.get("path")
        ]
        if imgs:
            return imgs
    return []


# Text stand-in saved on each attachment so later turns can run on the
# user's text model instead of the vision model.
TEXT_CONTEXT_KEY = "text_context"
MAX_DOC_CONTEXT_CHARS = 8000
_ATTACHMENT_TAG_RE = re.compile(r"^<attachment_data[^>]*>\n|\n</attachment_data>$")
_describing: set[str] = set()
_describing_lock = threading.Lock()


def _is_image(a: dict) -> bool:
    return (a.get("content_type") or "").startswith("image/")


def _latest_attachment_message(history: list[dict]) -> dict | None:
    for m in reversed(history):
        if m.get("role") == "user" and m.get("attachments"):
            return m
    return None


def _images_missing_context(attachments) -> list[dict]:
    return [
        a for a in (attachments or [])
        if isinstance(a, dict) and _is_image(a) and a.get("path") and not a.get(TEXT_CONTEXT_KEY)
    ]


def _history_with_attachment_context(history: list[dict]) -> list[dict]:
    out = []
    for m in history:
        notes = [
            earlier_attachment_note(a[TEXT_CONTEXT_KEY], is_image=_is_image(a))
            for a in (m.get("attachments") or [])
            if isinstance(a, dict) and a.get(TEXT_CONTEXT_KEY)
        ]
        if m.get("role") == "user" and notes:
            m = {**m, "content": "\n\n".join([*notes, m.get("content") or ""]).strip()}
        out.append(m)
    return out


def _doc_text_context(filename: str, parts: list[dict]) -> str:
    raw = "\n\n".join(
        _ATTACHMENT_TAG_RE.sub("", p["text"]) for p in parts if p.get("type") == "text" and p.get("text")
    ).strip()
    if not raw:
        return ""
    if len(raw) > MAX_DOC_CONTEXT_CHARS:
        raw = raw[:MAX_DOC_CONTEXT_CHARS].rstrip() + "\n[rest of the file truncated]"
    return wrap_attachment_content(filename, raw)


def _image_part(a: dict, user_id: str) -> dict | None:
    path = a.get("path")
    if path and not user_owns_path(user_id, path):
        return None
    if path:
        try:
            img_bytes = store.download_attachment(path, user_id=user_id)
            mime = a.get("content_type") or "image/png"
            b64 = base64.b64encode(img_bytes).decode("ascii")
            return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
        except Exception as exc:  # noqa: BLE001
            logger.warning("chat: failed to inline image path=%s err=%s", path, exc)
    supa = os.environ.get("SUPABASE_URL", "").rstrip("/")
    if supa and str(a.get("url", "")).startswith(supa + "/"):
        return {"type": "image_url", "image_url": {"url": a["url"]}}
    return None


def _describe_with_retry(image_part: dict) -> str:
    for delay in (0, 2.0, 5.0):
        time.sleep(delay)
        try:
            return nvidia_client.describe_image(image_part)
        except Exception as exc:  # noqa: BLE001
            if not is_transient_model_error(exc):
                raise
            logger.warning("chat: image description busy, retrying: %s", exc)
    return ""


def _describe_attachments_in_background(message_id: str, user_id: str, attachments) -> None:
    """Save a text version of each image on its message, off the request path."""
    if not message_id or not _images_missing_context(attachments):
        return
    with _describing_lock:
        if message_id in _describing:
            return
        _describing.add(message_id)

    def run():
        try:
            updated = [dict(a) if isinstance(a, dict) else a for a in attachments]
            changed = False
            for a in _images_missing_context(updated):
                part = _image_part(a, user_id)
                if not part:
                    continue
                text = _describe_with_retry(part)
                if text:
                    a[TEXT_CONTEXT_KEY] = wrap_attachment_content(a.get("filename") or "image", text)
                    changed = True
            if changed:
                store.update_message_attachments(message_id, user_id, updated)
                logger.info("chat: saved image text context for message=%s", message_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("chat: image description failed for message=%s: %s", message_id, exc)
        finally:
            with _describing_lock:
                _describing.discard(message_id)

    threading.Thread(target=run, name="bmo-image-context", daemon=True).start()


# ---------- chat endpoints ----------

@chat_bp.post("/chat")
@chat_bp.post("/chat/incognito")
@limiter.limit("20 per minute")
@require_user
def chat(user):
    is_incognito = request.path.endswith("/incognito")
    t0 = time.time()
    payload = request.get_json(silent=True) or {}
    raw_message = payload.get("message") or ""
    if not isinstance(raw_message, str):
        return bad_request("message must be a string", 422)
    message_text = raw_message.strip()
    attachments = payload.get("attachments") or []
    model = payload.get("model")
    system_prompt = payload.get("system_prompt")
    conversation_id = payload.get("conversation_id")
    project_id = payload.get("project_id")
    augmented_message = payload.get("augmented_message")
    stream_id = payload.get("stream_id")
    auto_search = payload.get("auto_search", True)
    force_search = payload.get("force_search", False)

    if not isinstance(auto_search, bool):
        return bad_request("auto_search must be a boolean", 422)
    if not isinstance(force_search, bool):
        return bad_request("force_search must be a boolean", 422)
    if project_id is not None and not isinstance(project_id, str):
        return bad_request("project_id must be a string", 422)
    if stream_id is not None and (not isinstance(stream_id, str) or len(stream_id) > 100):
        return bad_request("stream_id must be a short string", 422)
    if not isinstance(attachments, list) or not all(isinstance(a, dict) for a in attachments):
        return bad_request("attachments must be a list", 422)
    for a in attachments:
        a.pop(TEXT_CONTEXT_KEY, None)
    if model is not None and not isinstance(model, str):
        return bad_request("model must be a string", 422)
    if model and model not in ALL_VALID_MODEL_IDS:
        return bad_request("unknown model", 422)
    reasoning_effort = payload.get("reasoning_effort")
    if reasoning_effort is not None and not isinstance(reasoning_effort, str):
        return bad_request("reasoning_effort must be a string", 422)
    if reasoning_effort in {"off", "none"}:
        reasoning_effort = None
    elif reasoning_effort and reasoning_effort not in {"low", "medium", "high", "max"}:
        return bad_request("reasoning_effort must be one of: low, medium, high, max", 422)
    if system_prompt is not None and not isinstance(system_prompt, str):
        return bad_request("system_prompt must be a string", 422)
    if system_prompt and len(system_prompt) > 8000:
        return bad_request("system prompt too long (max 8000 chars)", 422)
    if conversation_id is not None and not isinstance(conversation_id, str):
        return bad_request("conversation_id must be a string", 422)
    if augmented_message is not None and not isinstance(augmented_message, str):
        return bad_request("augmented_message must be a string", 422)
    if not message_text and not attachments:
        return bad_request("message or attachments required", 422)
    if len(message_text) > 16000:
        return bad_request("message too long (max 16000 chars)", 422)
    if augmented_message and len(augmented_message) > 200000:
        return bad_request("augmented_message too long (max 200000 chars)", 422)
    t_validation = time.time()

    usage = get_usage_status(user.id)
    if usage["blocked"]:
        over = usage["session"] if usage["session"]["used"] >= SESSION_LIMIT else usage["weekly"]
        return bad_request(
            "You've reached your usage limit for now. "
            f"Access resets in {human_duration(over['resets_in_seconds'])}.",
            429,
        )

    defer_user_persist = False
    try:
        if is_incognito:
            convo = {
                "id": f"incognito_{uuid.uuid4().hex[:8]}",
                "model": model or "thinking",
                "system_prompt": system_prompt,
                "title": "Incognito Chat",
            }
            history = []
            user_message = {
                "id": f"msg_{uuid.uuid4().hex[:8]}",
                "role": "user",
                "content": message_text,
                "attachments": attachments or None,
            }
        elif conversation_id:
            convo = store.get_conversation(conversation_id, user.id)
            if not convo:
                return bad_request("conversation not found", 404)
            convo_patch = {}
            if model and model != convo.get("model"):
                convo_patch["model"] = model
            if system_prompt is not None and system_prompt != convo.get("system_prompt"):
                convo_patch["system_prompt"] = system_prompt
            if project_id is not None and project_id != convo.get("project_id"):
                convo_patch["project_id"] = project_id
            if convo_patch:
                convo = store.update_conversation(conversation_id, user.id, convo_patch) or convo

            history = store.get_messages(convo["id"])
            user_message = {
                "id": f"msg_pending_{uuid.uuid4().hex[:8]}",
                "role": "user",
                "content": message_text,
                "attachments": attachments or None,
            }
            defer_user_persist = True
        else:
            title_seed = (message_text or "Image conversation").strip().replace("\n", " ")[:80] or "New conversation"
            convo = {
                "id": f"pending_{uuid.uuid4().hex[:8]}",
                "model": model or "thinking",
                "system_prompt": system_prompt,
                "project_id": project_id,
                "title": title_seed,
                "_new": True,
            }
            history = []
            user_message = {
                "id": f"msg_pending_{uuid.uuid4().hex[:8]}",
                "role": "user",
                "content": message_text,
                "attachments": attachments or None,
            }
            defer_user_persist = True
    except Exception as exc:  # noqa: BLE001
        logger.exception("chat: persistence failed for user=%s: %s", user.id, exc)
        return bad_request(f"Could not save conversation. {friendly_error(exc)}", 500)

    model_text = augmented_message or message_text

    image_attachments = [
        a for a in attachments
        if (a.get("content_type") or "").startswith("image/")
    ]
    has_image_attachment = bool(image_attachments)
    has_any_attachment = bool(attachments)
    images_with_url = [a for a in image_attachments if a.get("url")]

    # A turn that brings attachments goes to the vision model. Later turns use
    # the user's text model with saved text versions of those attachments,
    # unless the latest images have no text version yet.
    latest_attachment_msg = _latest_attachment_message(history)
    followup_needs_vision = bool(
        latest_attachment_msg and _images_missing_context(latest_attachment_msg.get("attachments"))
    )
    conversation_is_visual = has_any_attachment or followup_needs_vision
    model_history = _history_with_attachment_context(history)

    if conversation_is_visual and not images_with_url:
        carried = _recent_history_images(history)
        if carried:
            images_with_url = carried

    if has_image_attachment and not images_with_url:
        return bad_request("Image upload returned no URL. Try re-attaching the image.", 500)

    non_image_files = [
        a for a in attachments
        if not (a.get("content_type") or "").startswith("image/")
    ]

    def _scoped_download(path: str) -> bytes:
        if not user_owns_path(user.id, path):
            raise PermissionError(f"attachment path not owned by user: {path!r}")
        return store.download_attachment(path, user_id=user.id)

    doc_parts: list[dict] = []
    failed_files: list[str] = []
    for a in non_image_files:
        parts = document_processor.process_attachment(a, _scoped_download)
        if parts:
            doc_parts.extend(parts)
            text_context = _doc_text_context(a.get("filename") or "file", parts)
            if text_context:
                a[TEXT_CONTEXT_KEY] = text_context
        else:
            failed_files.append(a.get("filename", "file"))

    if failed_files:
        file_note = "\n\n[Attached files — metadata:]\n" + "\n".join(f"- {name}" for name in failed_files)
        model_text = (model_text or "") + file_note

    content_parts: list[dict] = []
    content_parts.extend(doc_parts)

    for a in images_with_url:
        part = _image_part(a, user.id)
        if part:
            content_parts.append(part)

    # Held as a reference so an auto-search can prepend live results to the
    # user's turn after streaming has already started (see generate()).
    user_text_part: dict | None = None
    if model_text:
        user_text_part = {"type": "text", "text": model_text}
        content_parts.append(user_text_part)

    MAX_BATCH_PAYLOAD_MB = 15
    PAGES_PER_BATCH = 5

    doc_img_count = sum(1 for p in doc_parts if p.get("type") == "image_url")
    use_batches = doc_img_count > PAGES_PER_BATCH

    batches: list[list[dict]] = []
    if use_batches:
        pdf_batches = _split_doc_parts_into_batches(doc_parts, pages_per_batch=PAGES_PER_BATCH)
        non_pdf_parts = [p for p in content_parts if p not in doc_parts and p.get("type") != "text"]
        for idx, batch in enumerate(pdf_batches):
            batch_content: list[dict] = []
            if idx == 0:
                batch_content.extend(non_pdf_parts)
            batch_content.extend(batch)
            if user_text_part:
                batch_content.append(user_text_part)
            batch_text_parts = [p for p in batch if p.get("type") == "text"]
            batch_img_parts = [p for p in batch if p.get("type") == "image_url"]
            while _estimate_payload_size(batch_content) > MAX_BATCH_PAYLOAD_MB * 1024 * 1024 and len(batch_img_parts) > 1:
                batch_img_parts = batch_img_parts[: max(1, len(batch_img_parts) // 2)]
                batch_content = []
                if idx == 0:
                    batch_content.extend(non_pdf_parts)
                batch_content.extend(batch_text_parts)
                batch_content.extend(batch_img_parts)
                if user_text_part:
                    batch_content.append(user_text_part)
            batches.append(batch_content)
    else:
        batches.append(content_parts)

    chosen_friendly = convo.get("model") or model or "thinking"
    real_id_map = get_real_id_map()
    chosen_model = real_id_map.get(chosen_friendly, nvidia_client.default_model())
    if conversation_is_visual:
        chosen_model = get_vision_model()

    if reasoning_effort is None:
        if chosen_friendly == "thinking":
            reasoning_effort = "low"
        elif chosen_friendly == "deep":
            reasoning_effort = "low"

    use_thinking = True
    if chosen_friendly == "aeon":
        use_thinking = False

    is_first_turn = not history
    cancel_event = _register_cancel(stream_id, user.id) if stream_id else threading.Event()

    # Voice turns stay on the fast path, and a client-supplied augmented_message
    # means the turn already carries its own retrieved context (scraped URLs).
    search_allowed = (
        (auto_search or force_search)
        and not augmented_message
        and chosen_friendly != "aeon"
    )
    # Chat cannot draw. Answer image asks here so the model cannot refuse them.
    settings_reply = "" if chosen_friendly == "image" else image_settings_reply(message_text)
    if settings_reply:
        search_allowed = False

    def generate():
        nonlocal convo, user_message
        t_gen_start = time.time()
        persist_error = []

        def materialize_user_turn():
            nonlocal convo, user_message
            try:
                if convo.get("_new"):
                    real = store.create_conversation(
                        user.id,
                        first_message=message_text or "Image conversation",
                        model=convo.get("model") or model,
                        system_prompt=convo.get("system_prompt"),
                        project_id=convo.get("project_id"),
                    )
                    real_msg = store.add_message(
                        real["id"],
                        user.id,
                        role="user",
                        content=message_text,
                        attachments=attachments or None,
                    )
                    convo = real
                    user_message = real_msg
                elif defer_user_persist:
                    user_message = store.add_message(
                        convo["id"],
                        user.id,
                        role="user",
                        content=message_text,
                        attachments=attachments or None,
                    )
            except Exception as exc:  # noqa: BLE001
                logger.exception("chat: deferred persist failed user=%s: %s", user.id, exc)
                persist_error.append(exc)

        persist_thread = None
        if defer_user_persist and not is_incognito:
            persist_thread = threading.Thread(
                target=materialize_user_turn, name="bmo-chat-persist", daemon=True
            )
            persist_thread.start()

        yield sse_event({"type": "conversation", "data": {k: v for k, v in convo.items() if not str(k).startswith("_")}})
        yield sse_event({"type": "user_message", "data": user_message})

        if search_allowed:
            try:
                needs_search, search_query = search_router.should_search(
                    message_text,
                    history=history,
                    has_attachments=has_any_attachment,
                    force=force_search,
                )
            except Exception as exc:  # noqa: BLE001 — routing must never break the turn
                logger.warning("chat: search routing failed: %s", exc)
                needs_search, search_query = False, ""

            if needs_search:
                yield sse_event({"type": "searching", "query": search_query})
                t_search = time.time()
                results = search_router.run_search(search_query)
                elapsed = time.time() - t_search
                # Everything the search card renders: the results BMO actually
                # read, plus how long the round trip took.
                yield sse_event({
                    "type": "search_complete",
                    "count": len(results),
                    "elapsed_ms": int(elapsed * 1000),
                    "results": [
                        {
                            "title": r.get("title") or "",
                            "url": r.get("url") or "",
                            "snippet": (r.get("content") or "").strip()[:220],
                            "published_date": r.get("published_date") or "",
                        }
                        for r in results if r.get("url")
                    ],
                })
                logger.info(
                    "chat: auto-search query=%r results=%d in %.2fs",
                    search_query, len(results), elapsed,
                )
                if results and user_text_part is not None:
                    context = search_router.build_search_context(search_query, results)
                    user_text_part["text"] = f"{context}\n\n{model_text}"

        full_reply = ""
        full_reasoning = ""
        saved = False

        def ensure_user_persisted():
            if persist_thread is not None:
                persist_thread.join(timeout=60)
            if persist_error:
                raise persist_error[0]
            if convo.get("_new"):
                raise RuntimeError("Could not save conversation")

        def persist_reply():
            nonlocal saved
            if saved or is_incognito:
                return None
            text = full_reply.strip()
            if not text:
                return None
            try:
                ensure_user_persisted()
                msg = store.add_message(
                    convo["id"], user.id, role="assistant", content=full_reply,
                    reasoning=full_reasoning or None,
                )
                saved = True
                store.record_usage(
                    user.id, chosen_friendly,
                    estimate_tokens(message_text, full_reply, full_reasoning),
                )
                return msg
            except Exception as exc:  # noqa: BLE001
                logger.exception("chat: failed to persist assistant message convo=%s: %s", convo.get("id"), exc)
                return None

        try:
            if settings_reply:
                full_reply = settings_reply
                yield sse_event({"type": "token", "data": {"delta": settings_reply}})
            for batch_idx, batch_content in enumerate(batches):
                if settings_reply:
                    break
                is_first_batch = batch_idx == 0
                if is_first_batch:
                    active_project_id = convo.get("project_id")
                    project = store.get_project(active_project_id, user.id) if active_project_id else None
                    project_files = store.list_project_files(active_project_id, user.id) if project else None

                    base_sys = AEON_SYSTEM_PROMPT if chosen_friendly == "aeon" else DEFAULT_SYSTEM_PROMPT
                    if project or project_files:
                        assembled_base = project_service.assemble_project_system_prompt(
                            project=project,
                            base_system_prompt=base_sys,
                            project_files=project_files,
                            user_query=message_text,
                        )
                    else:
                        assembled_base = base_sys

                    extra_sys = convo.get("system_prompt")

                    if conversation_is_visual:
                        messages_payload = nvidia_client.build_messages_for_vision(
                            model_history,
                            batch_content,
                            system_prompt=assembled_base if (project or project_files) else None,
                        )
                    else:
                        messages_payload = nvidia_client.build_messages(
                            model_history,
                            batch_content,
                            base_system_prompt=assembled_base,
                            system_prompt=extra_sys,
                        )
                else:
                    messages_payload = nvidia_client.build_continuation_messages(
                        model_history, batch_content,
                    )

                if use_batches and len(batches) > 1:
                    batch_imgs = sum(1 for p in batch_content if p.get("type") == "image_url")
                    prev_imgs = sum(
                        1 for b in batches[:batch_idx] for p in b if p.get("type") == "image_url"
                    )
                    start_page = prev_imgs + 1
                    end_page = prev_imgs + batch_imgs
                    header = f"\n\n--- Analyzing pages {start_page}-{end_page} ---\n\n"
                    full_reply += header
                    yield sse_event({"type": "token", "data": {"delta": header}})

                batch_reply = ""
                max_tokens_override = 300 if chosen_friendly == "aeon" else None
                retry_delays = (1.5, 3.0)
                for attempt in range(len(retry_delays) + 1):
                    streamed = False
                    try:
                        for ev in nvidia_client.iter_response_with_fallback(
                            messages_payload,
                            model=chosen_model,
                            reasoning_effort=reasoning_effort,
                            thinking=use_thinking,
                            max_tokens=max_tokens_override,
                        ):
                            if cancel_event.is_set():
                                logger.info("chat: generation cancelled by user for convo=%s", convo.get("id"))
                                return
                            if ev["type"] == "delta":
                                streamed = True
                                batch_reply += ev["data"]
                                full_reply += ev["data"]
                                yield sse_event({"type": "token", "data": {"delta": ev["data"]}})
                            elif ev["type"] == "reasoning_delta":
                                streamed = True
                                full_reasoning += ev["data"]
                                yield sse_event({"type": "reasoning_token", "data": {"delta": ev["data"]}})
                            elif ev["type"] == "done":
                                batch_reply += ev["content"] or ""
                                full_reasoning += ev.get("reasoning") or ""
                        break
                    except Exception as exc:  # noqa: BLE001
                        # Retrying after tokens reached the client would duplicate them.
                        if not streamed and attempt < len(retry_delays) and is_transient_model_error(exc):
                            logger.warning(
                                "chat: model %s busy (attempt %d), retrying: %s",
                                chosen_model, attempt + 1, exc,
                            )
                            if cancel_event.wait(retry_delays[attempt]):
                                return
                            continue
                        logger.warning(
                            "chat: model %s failed for convo=%s batch=%d: %s",
                            chosen_model, convo.get("id"), batch_idx + 1, exc,
                        )
                        if len(batches) > 1:
                            error_note = f"\n\n[Part {batch_idx + 1} couldn't be read. {MODEL_BUSY_REPLY}]\n\n"
                        elif full_reply.strip():
                            error_note = f"\n\n{MODEL_BUSY_REPLY}"
                        else:
                            error_note = MODEL_BUSY_REPLY
                        full_reply += error_note
                        yield sse_event({"type": "token", "data": {"delta": error_note}})
                        break

            # Final pass over the assembled reply: catch highlight.js markup
            # that arrived split across SSE chunks and decode entities the
            # highlighter escaped. Covers persist, incognito payload and the
            # title snapshot in one place.
            full_reply = nvidia_client.sanitize_reply(full_reply)

            if not full_reply.strip():
                full_reply = (
                    "I received your document but wasn't able to generate a response. "
                    "Please try asking again."
                )

            yield sse_event({"type": "complete"})

            assistant_message = persist_reply()
            if is_incognito:
                yield sse_event({"type": "conversation", "data": convo})
                if full_reply.strip():
                    yield sse_event({
                        "type": "assistant_message",
                        "data": {
                            "id": f"msg_{uuid.uuid4().hex[:8]}",
                            "role": "assistant",
                            "content": full_reply,
                            "reasoning": full_reasoning or None,
                        },
                    })
            else:
                ensure_user_persisted()
                refreshed = store.get_conversation(convo["id"], user.id) or convo
                yield sse_event({"type": "conversation", "data": refreshed})
                yield sse_event({"type": "user_message", "data": user_message})
                if assistant_message:
                    yield sse_event({"type": "assistant_message", "data": assistant_message})

                if has_image_attachment:
                    _describe_attachments_in_background(user_message.get("id"), user.id, attachments)
                elif followup_needs_vision:
                    _describe_attachments_in_background(
                        latest_attachment_msg.get("id"), user.id, latest_attachment_msg.get("attachments"),
                    )

                if is_first_turn and message_text:
                    convo_id_for_title = convo["id"]
                    user_id_for_title = user.id
                    reply_snapshot = full_reply

                    def _bg_title():
                        try:
                            new_title = nvidia_client.generate_title(message_text, reply_snapshot)
                            if new_title:
                                store.update_conversation(
                                    convo_id_for_title, user_id_for_title, {"title": new_title}
                                )
                        except Exception as title_exc:  # noqa: BLE001
                            logger.warning("title generation failed for convo=%s: %s", convo_id_for_title, title_exc)

                    threading.Thread(target=_bg_title, name="bmo-chat-title", daemon=True).start()
        except (GeneratorExit, BrokenPipeError, ConnectionError):
            logger.info("chat: client disconnected mid-stream for convo=%s; saving partial", convo.get("id"))
            persist_reply()
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("chat: streaming failed for user=%s model=%s: %s", user.id, chosen_model, exc)
            persist_reply()
            yield sse_event({"type": "error", "detail": friendly_error(exc) or "Streaming failed"})
        finally:
            persist_reply()
            if stream_id:
                _unregister_cancel(stream_id)
            logger.info("chat: generate finished model=%s convo=%s chars=%d in %.3fs", chosen_model, convo.get("id"), len(full_reply), time.time() - t_gen_start)

    sse_queue: "queue.Queue" = queue.Queue()
    _DONE = object()

    def _pump():
        try:
            for chunk in generate():
                sse_queue.put(chunk)
        except Exception as exc:  # noqa: BLE001
            logger.exception("chat: producer thread crashed: %s", exc)
        finally:
            sse_queue.put(_DONE)

    threading.Thread(target=_pump, name="bmo-chat-gen", daemon=True).start()

    def drain():
        try:
            while True:
                chunk = sse_queue.get()
                if chunk is _DONE:
                    break
                yield chunk
        finally:
            # If the HTTP client aborts, closes browser tab, or drops connection,
            # Flask terminates drain() via GeneratorExit. Signal cancel_event so
            # background generation loop immediately halts instead of leaking API tokens.
            cancel_event.set()

    return Response(
        stream_with_context(drain()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@chat_bp.post("/chat/<stream_id>/cancel")
@require_user
def cancel_chat(user, stream_id):
    found = _signal_cancel(stream_id, user.id)
    return {"cancelled": bool(found)}
