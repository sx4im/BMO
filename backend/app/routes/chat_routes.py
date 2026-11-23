"""Chat, streaming completions, and stream cancellation routes for Bmo."""

from __future__ import annotations

import base64
import io
import json
import logging
import mimetypes
import os
import queue
import re
import threading
import time
import uuid

from flask import Blueprint, Response, request, stream_with_context
from PIL import Image

from .. import document_processor, nvidia_client, search_router, skill_service, store
from ..chat_persistence import TurnWriter
from ..chat_generation import iter_completed_response
from ..auth import require_user
from ..cancellation import register as _register_cancel, signal as _signal_cancel, unregister as _unregister_cancel
from ..config import (
    ALL_VALID_MODEL_IDS,
    KNOWN_MODEL_IDS,
    SESSION_LIMIT,
    get_real_id_map,
    get_vision_model,
)
from ..limiter import limiter
from ..reply_style import ProseDashFilter, allows_long_dashes
from ..prompts import (
    AEON_SYSTEM_PROMPT,
    DEFAULT_SYSTEM_PROMPT,
    VoiceReplyFilter,
    earlier_attachment_note,
    image_settings_reply,
    wrap_attachment_content,
)
from .helpers import (
    bad_request,
    estimate_tokens,
    friendly_error,
    get_usage_status,
    human_duration,
    is_transient_model_error,
    model_error_details,
    is_trivial_prompt,
    sse_event,
    user_owns_path,
    validate_project_id,
)

logger = logging.getLogger("bmo.routes.chat")

chat_bp = Blueprint("chat_routes", __name__)
SSE_HEARTBEAT_SECONDS = 15.0
MAX_IMAGES_PER_MESSAGE = 6
_MAX_VISION_IMAGES_PER_REQUEST = 8
_VISION_OUTPUT_TOKENS = 4096
_ESTIMATED_VISION_TOKENS_PER_IMAGE = 1024

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


def _split_doc_parts_into_batches(
    doc_parts: list[dict], pages_per_batch: int, *, first_batch_pages: int,
) -> list[list[dict]]:
    text_parts = [p for p in doc_parts if p.get("type") == "text"]
    image_parts = [p for p in doc_parts if p.get("type") == "image_url"]

    full_text = text_parts[0].get("text", "") if text_parts else ""
    matches = list(re.finditer(r"--- Page (\d+) ---\n", full_text))
    header = full_text[:matches[0].start()].strip() if matches else ""

    page_texts: dict[int, str] = {}
    for i, match in enumerate(matches):
        page_num = int(match.group(1))
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(full_text)
        page_texts[page_num] = full_text[start:end].strip()

    total_pages = len(image_parts)
    batches: list[list[dict]] = []

    batch_start = 0
    while batch_start < total_pages:
        page_limit = pages_per_batch if batch_start else first_batch_pages
        batch_end = min(batch_start + page_limit, total_pages)
        batch_page_nums = list(range(batch_start + 1, batch_end + 1))

        batch_texts: list[str] = []
        if header:
            batch_texts.append(header)
        for pn in batch_page_nums:
            if pn in page_texts:
                batch_texts.append(f"--- Page {pn} ---\n{page_texts[pn]}")

        batch_parts = (text_parts[1:] if matches else text_parts[:]) if not batch_start else []
        if batch_texts:
            batch_parts.append({"type": "text", "text": "\n\n".join(batch_texts)})
        batch_parts.extend(image_parts[batch_start:batch_end])
        batches.append(batch_parts)
        batch_start = batch_end

    return batches


# Text stand-in saved on each attachment so later turns can run on the
# user's text model instead of the vision model.
TEXT_CONTEXT_KEY = "text_context"
MAX_DOC_CONTEXT_CHARS = 8000
_VISION_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
_VISION_IMAGE_LIMIT = 1536 * 1024
_ATTACHMENT_TAG_RE = re.compile(r"^<attachment_data[^>]*>\n|\n</attachment_data>$")
_describing: set[str] = set()
_describing_lock = threading.Lock()


def _image_mime(a: dict) -> str:
    mime = str(a.get("content_type") or "").lower().split(";", 1)[0].strip()
    if not mime or mime == "application/octet-stream":
        mime = mimetypes.guess_type(str(a.get("filename") or a.get("path") or ""))[0] or ""
    return mime


def _is_image(a: dict) -> bool:
    return _image_mime(a).startswith("image/")


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
            mime = _image_mime(a)
            if mime not in _VISION_IMAGE_TYPES or len(img_bytes) > _VISION_IMAGE_LIMIT:
                # Keep the stored original. Bound each inference image so a
                # six-image turn fits comfortably after base64 encoding.
                with Image.open(io.BytesIO(img_bytes)) as img, io.BytesIO() as encoded:
                    img.thumbnail((2048, 2048))
                    first_frame = img.convert("RGBA")
                    first_frame.save(encoded, format="PNG")
                    img_bytes = encoded.getvalue()
                mime = "image/png"
                if len(img_bytes) > _VISION_IMAGE_LIMIT:
                    rgb = Image.new("RGB", first_frame.size, "white")
                    rgb.paste(first_frame, mask=first_frame.getchannel("A"))
                    for max_edge in (2048, 1280):
                        rgb.thumbnail((max_edge, max_edge))
                        with io.BytesIO() as encoded:
                            rgb.save(encoded, format="JPEG", quality=85, optimize=True)
                            img_bytes = encoded.getvalue()
                        if len(img_bytes) <= _VISION_IMAGE_LIMIT:
                            break
                    mime = "image/jpeg"
                    if len(img_bytes) > _VISION_IMAGE_LIMIT:
                        return None
            b64 = base64.b64encode(img_bytes).decode("ascii")
            return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
        except Exception as exc:  # noqa: BLE001
            logger.warning("chat: failed to inline image path=%s err=%s", path, exc)
    supa = os.environ.get("SUPABASE_URL", "").rstrip("/")
    if supa and str(a.get("url", "")).startswith(supa + "/"):
        return {"type": "image_url", "image_url": {"url": a["url"]}}
    return None


def _describe_with_retry(image_parts: list[dict]) -> list[str]:
    for delay in (2.0, 5.0, 60.0, None):
        try:
            return nvidia_client.describe_images(image_parts)
        except Exception as exc:  # noqa: BLE001
            if not is_transient_model_error(exc):
                raise
            details = model_error_details(exc)
            # Give per-minute rate limits a fresh window without extending
            # retries for other provider failures.
            if delay is None or (delay == 60.0 and details["code"] != "rate_limited"):
                break
            wait = max(delay, min(details.get("retry_after", 0), 60.0))
            logger.warning("chat: image description busy, retrying in %ss: %s", wait, exc)
            time.sleep(wait)
    return []


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
            images = []
            parts = []
            for a in _images_missing_context(updated):
                part = _image_part(a, user_id)
                if part:
                    images.append(a)
                    parts.append(part)
            if not parts:
                return
            for attachment, description in zip(images, _describe_with_retry(parts)):
                if description.strip():
                    attachment[TEXT_CONTEXT_KEY] = wrap_attachment_content(
                        attachment.get("filename") or "image", description.strip(),
                    )
            if any(a.get(TEXT_CONTEXT_KEY) for a in images):
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
    retry_message_id = payload.get("retry_message_id")
    auto_search = payload.get("auto_search", True)
    force_search = payload.get("force_search", False)

    if not isinstance(auto_search, bool):
        return bad_request("auto_search must be a boolean", 422)
    if not isinstance(force_search, bool):
        return bad_request("force_search must be a boolean", 422)
    if project_id is not None and not isinstance(project_id, str):
        return bad_request("project_id must be a string", 422)
    if project_id is not None:
        _, err = validate_project_id(project_id, user.id)
        if err:
            return err
    if stream_id is not None and (not isinstance(stream_id, str) or len(stream_id) > 100):
        return bad_request("stream_id must be a short string", 422)
    existing_conversation = None
    retry_user = retry_reply = None
    retry_history = []
    if conversation_id is not None and not isinstance(conversation_id, str):
        return bad_request("conversation_id must be a string", 422)
    if retry_message_id is not None:
        if not isinstance(retry_message_id, str) or not retry_message_id or not conversation_id or is_incognito:
            return bad_request("Retry requires a saved message and conversation.", 422)
        existing_conversation = store.get_conversation(conversation_id, user.id)
        if not existing_conversation:
            return bad_request("conversation not found", 404)
        retry_history = store.get_messages(conversation_id, limit=200)
        if retry_history and retry_history[-1]["role"] == "assistant":
            retry_reply = retry_history.pop()
        if not retry_history or retry_history[-1]["role"] != "user" or retry_history[-1]["id"] != retry_message_id:
            return bad_request("Only the latest turn can be retried here. Reload the conversation and try again.", 409)
        retry_user = retry_history.pop()
        message_text = retry_user["content"] or ""
        attachments = [dict(a) for a in retry_user.get("attachments") or []]
    if not isinstance(attachments, list) or not all(isinstance(a, dict) for a in attachments):
        return bad_request("attachments must be a list", 422)
    image_attachments = [a for a in attachments if _is_image(a)]
    if len(image_attachments) > MAX_IMAGES_PER_MESSAGE:
        return bad_request(f"You can attach up to {MAX_IMAGES_PER_MESSAGE} images per message.", 422)
    try:
        store.validate_attachment_paths(attachments, user.id)
    except ValueError as exc:
        return bad_request(str(exc), 403)
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
    if augmented_message is not None and not isinstance(augmented_message, str):
        return bad_request("augmented_message must be a string", 422)
    if not message_text and not attachments:
        return bad_request("message or attachments required", 422)
    if len(message_text) > 16000:
        return bad_request("message too long (max 16000 chars)", 422)
    if augmented_message and len(augmented_message) > 200000:
        return bad_request("augmented_message too long (max 200000 chars)", 422)
    incognito_history = payload.get("history", []) if is_incognito else []
    if not isinstance(incognito_history, list) or len(incognito_history) > 24:
        return bad_request("history must be a list of at most 24 messages", 422)
    if len(json.dumps(incognito_history, ensure_ascii=False, separators=(",", ":"))) > 200000:
        return bad_request("history too long (max 200000 characters)", 422)
    for item in incognito_history:
        if (not isinstance(item, dict) or item.get("role") not in ("user", "assistant")
                or not isinstance(item.get("content"), str)):
            return bad_request("history messages must contain a user/assistant role and text content", 422)
        previous_attachments = item.get("attachments") or []
        if not isinstance(previous_attachments, list) or not all(isinstance(a, dict) for a in previous_attachments):
            return bad_request("history attachments must be a list", 422)
        try:
            store.validate_attachment_paths(previous_attachments, user.id)
        except ValueError as exc:
            return bad_request(str(exc), 403)
        for attachment in previous_attachments:
            attachment.pop(TEXT_CONTEXT_KEY, None)
    t_validation = time.time()

    if conversation_id and not is_incognito and existing_conversation is None:
        existing_conversation = store.get_conversation(conversation_id, user.id)
        if not existing_conversation:
            return bad_request("conversation not found", 404)
    skill_ids = payload.get("skill_ids", [])
    try:
        active_skills = skill_service.resolve_skills(user.id, skill_ids)
    except LookupError as exc:
        return bad_request(str(exc), 404)
    except ValueError as exc:
        return bad_request(str(exc), 422)
    skill_ids = [skill["id"] for skill in active_skills]
    skill_labels = [{"id": skill["id"], "name": skill["name"]} for skill in active_skills]
    global_instructions = store.get_preferences(user.id).get("instructions") or ""

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
                "active_skills": [],
            }
            history = [
                {"role": m["role"], "content": m["content"], "attachments": m.get("attachments")}
                for m in incognito_history
            ]
            user_message = {
                "id": f"msg_{uuid.uuid4().hex[:8]}",
                "role": "user",
                "content": message_text,
                "attachments": attachments or None,
            }
        elif conversation_id:
            convo = existing_conversation
            convo_patch = {}
            if convo.get("active_skills"):
                convo_patch["active_skills"] = []
            if model and model != convo.get("model"):
                convo_patch["model"] = model
            if system_prompt is not None and system_prompt != convo.get("system_prompt"):
                convo_patch["system_prompt"] = system_prompt
            if project_id is not None and project_id != convo.get("project_id"):
                convo_patch["project_id"] = project_id
            if convo_patch:
                convo = store.update_conversation(conversation_id, user.id, convo_patch) or convo

            history = retry_history if retry_user else store.get_messages(convo["id"], limit=200)
            user_message = retry_user or {
                "id": f"msg_pending_{uuid.uuid4().hex[:8]}",
                "role": "user",
                "content": message_text,
                "attachments": attachments or None,
            }
            defer_user_persist = retry_user is None
        else:
            title_seed = (message_text or "Image conversation").strip().replace("\n", " ")[:80] or "New conversation"
            convo = {
                "id": f"pending_{uuid.uuid4().hex[:8]}",
                "model": model or "thinking",
                "system_prompt": system_prompt,
                "project_id": project_id,
                "title": title_seed,
                "_new": True,
                "active_skills": [],
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

    if skill_labels and not retry_user:
        user_message["skills"] = skill_labels

    model_text = augmented_message or message_text

    has_image_attachment = bool(image_attachments)
    has_any_attachment = bool(attachments)

    # A turn that brings attachments goes to the vision model. Later turns use
    # the user's text model with saved text versions of those attachments,
    # unless the latest images have no text version yet.
    latest_attachment_msg = _latest_attachment_message(history)
    if is_incognito and latest_attachment_msg:
        for attachment in latest_attachment_msg.get("attachments") or []:
            if not _is_image(attachment):
                parts = document_processor.process_attachment(
                    attachment, lambda path: store.download_attachment(path, user_id=user.id)
                )
                attachment[TEXT_CONTEXT_KEY] = _doc_text_context(attachment.get("filename") or "file", parts)
    pending_images = _images_missing_context(latest_attachment_msg.get("attachments")) if latest_attachment_msg else []
    followup_needs_vision = bool(pending_images)
    conversation_is_visual = has_any_attachment or followup_needs_vision
    model_history = _history_with_attachment_context(history)

    non_image_files = [a for a in attachments if not _is_image(a)]

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

    attachment_image_parts: list[dict] = []
    for a in image_attachments or pending_images[:MAX_IMAGES_PER_MESSAGE]:
        part = _image_part(a, user.id)
        if part:
            attachment_image_parts.append(part)
        elif has_image_attachment:
            return bad_request("Could not load an attached image. Try re-attaching it.", 500)

    content_parts = [*doc_parts, *attachment_image_parts]
    # Held as a reference so an auto-search can prepend live results to the
    # user's turn after streaming has already started (see generate()).
    user_text_part: dict | None = None
    if model_text:
        user_text_part = {"type": "text", "text": model_text}
        content_parts.append(user_text_part)

    MAX_BATCH_PAYLOAD_MB = 15
    PAGES_PER_BATCH = 5

    doc_img_count = sum(1 for p in doc_parts if p.get("type") == "image_url")
    first_batch_pages = min(PAGES_PER_BATCH, _MAX_VISION_IMAGES_PER_REQUEST - len(attachment_image_parts))

    batches: list[list[dict]] = []
    if doc_img_count > first_batch_pages:
        pdf_batches = _split_doc_parts_into_batches(doc_parts, PAGES_PER_BATCH, first_batch_pages=first_batch_pages)
        for idx, batch in enumerate(pdf_batches):
            batch_content: list[dict] = []
            if idx == 0:
                batch_content.extend(attachment_image_parts)
            batch_content.extend(batch)
            if user_text_part:
                batch_content.append(user_text_part)
            batch_text_parts = [p for p in batch if p.get("type") == "text"]
            batch_img_parts = [p for p in batch if p.get("type") == "image_url"]
            while _estimate_payload_size(batch_content) > MAX_BATCH_PAYLOAD_MB * 1024 * 1024 and len(batch_img_parts) > 1:
                batch_img_parts = batch_img_parts[: max(1, len(batch_img_parts) // 2)]
                batch_content = []
                if idx == 0:
                    batch_content.extend(attachment_image_parts)
                batch_content.extend(batch_text_parts)
                batch_content.extend(batch_img_parts)
                if user_text_part:
                    batch_content.append(user_text_part)
            batches.append(batch_content)
    else:
        batches.append(content_parts)

    chosen_friendly = convo.get("model") or model or "thinking"
    real_id_map = get_real_id_map()
    chosen_model = real_id_map.get(chosen_friendly, real_id_map["thinking"])
    if conversation_is_visual:
        chosen_model = get_vision_model()

    if chosen_friendly == "deep":
        reasoning_effort = "medium"
    elif chosen_friendly == "thinking" and reasoning_effort is None:
        reasoning_effort = "low"

    use_thinking = True
    if chosen_friendly == "aeon":
        use_thinking = False

    is_first_turn = not history and not retry_reply
    try:
        cancel_event = _register_cancel(stream_id, user.id) if stream_id else threading.Event()
    except ValueError as exc:
        return bad_request(str(exc), 409)
    except RuntimeError as exc:
        return bad_request(str(exc), 503)

    # Fetched pages are grounding, but may still need current facts elsewhere.
    search_allowed = auto_search or force_search
    # Offer the image mode shortcut on text-only requests to create an image.
    settings_reply = "" if chosen_friendly == "image" or has_image_attachment else image_settings_reply(message_text)
    if settings_reply:
        search_allowed = False

    def generate():
        nonlocal convo, user_message
        t_gen_start = time.time()
        # Queue the optimistic IDs before the writer can publish real IDs.
        yield sse_event({"type": "conversation", "data": {k: v for k, v in convo.items() if not str(k).startswith("_")}})
        yield sse_event({"type": "user_message", "data": user_message})

        durable_conversation_id = str(uuid.uuid4()) if convo.get("_new") else convo["id"]
        durable_user_id = retry_user["id"] if retry_user else str(uuid.uuid4())
        # The original stream and an overlapping retry reconcile to the same
        # assistant row even if neither has acknowledged an insert yet.
        durable_assistant_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"bmo-chat-assistant:{durable_user_id}"))
        touch_scheduled = False

        def materialize_user_turn():
            nonlocal convo, user_message
            if convo.get("_new"):
                convo = store.create_conversation(
                    user.id, first_message=message_text or "Image conversation",
                    model=convo.get("model") or model,
                    system_prompt=convo.get("system_prompt"),
                    project_id=convo.get("project_id"),
                    conversation_id=durable_conversation_id,
                )
            if defer_user_persist:
                user_message = store.add_message(
                    convo["id"], user.id, role="user", content=message_text,
                    attachments=attachments or None,
                    message_id=durable_user_id, touch=False,
                    **({"skills": skill_labels} if skill_labels else {}),
                )
                sse_queue.put(sse_event({"type": "conversation", "data": convo}))
                sse_queue.put(sse_event({"type": "user_message", "data": user_message}))

        def write_assistant(previous, content, reasoning):
            previous = previous or retry_reply
            if previous is None:
                return store.add_message(
                    convo["id"], user.id, role="assistant", content=nvidia_client.sanitize_reply(content),
                    reasoning=reasoning or None, message_id=durable_assistant_id, touch=False,
                )
            return store.update_assistant_message(
                convo["id"], user.id, previous["id"], content=nvidia_client.sanitize_reply(content),
                reasoning=reasoning or None, touch=False,
            )

        writer = None if is_incognito else TurnWriter(materialize_user_turn, write_assistant, retry_safe=True)
        full_reply = ""
        full_reasoning = ""
        generation_error = None
        finalized = False
        metered = False
        vision_tokens = 0

        def meter_vision_window(usage, messages, reply, reasoning):
            nonlocal vision_tokens
            reported = (usage or {}).get("total_tokens")
            if isinstance(reported, int) and reported > 0:
                vision_tokens += reported
                return
            vision_tokens += estimate_tokens(reply, reasoning)
            for message in messages:
                content = message["content"]
                if isinstance(content, str):
                    vision_tokens += estimate_tokens(content)
                else:
                    for part in content:
                        if part.get("type") == "image_url":
                            vision_tokens += _ESTIMATED_VISION_TOKENS_PER_IMAGE
                        elif part.get("type") == "text":
                            vision_tokens += estimate_tokens(part.get("text", ""))

        def checkpoint():
            if writer and not retry_user:
                writer.submit(full_reply, full_reasoning)

        def record_turn_usage():
            nonlocal metered
            if metered or not (vision_tokens or full_reply.strip() or full_reasoning.strip()):
                return
            metered = True
            try:
                if vision_tokens:
                    store.record_usage(user.id, "vision", vision_tokens)
                else:
                    store.record_usage(user.id, "vision" if conversation_is_visual else chosen_friendly,
                                       estimate_tokens(message_text, full_reply, full_reasoning))
            except Exception:
                logger.exception("usage recording failed for convo=%s", convo.get("id"))

        completed = False

        def persist_reply():
            nonlocal finalized, touch_scheduled
            if finalized:
                return None
            finalized = True
            # Close the writer even if usage metering fails afterward.
            if writer and retry_user and (generation_error or cancel_event.is_set() or not completed):
                writer.finish("", "")
                return None
            assistant_message = writer.finish(
                nvidia_client.sanitize_reply(full_reply), full_reasoning,
            ) if writer else None
            if assistant_message and not touch_scheduled:
                touch_scheduled = True
                def touch_after_commit():
                    try:
                        store.touch_conversation(convo["id"], user.id)
                    except Exception:
                        logger.warning("message committed but sidebar timestamp update failed convo=%s", convo.get("id"), exc_info=True)
                threading.Thread(target=touch_after_commit, name="bmo-chat-touch", daemon=True).start()
            return assistant_message

        try:
            if search_allowed and not cancel_event.is_set():
                yield sse_event({"type": "search_status", "status": "checking", "label": "Checking whether web search is needed…"})
                try:
                    needs_search, search_query = search_router.should_search(
                        message_text,
                        history=history,
                        has_attachments=has_any_attachment or bool(augmented_message),
                        force=force_search,
                    )
                except Exception as exc:  # noqa: BLE001 — routing must never break the turn
                    logger.warning("chat: search routing failed: %s", exc)
                    needs_search, search_query = False, ""

                if cancel_event.is_set():
                    return
                if needs_search:
                    yield sse_event({"type": "searching", "query": search_query})
                    t_search = time.time()
                    results = search_router.run_search(search_query)
                    if cancel_event.is_set():
                        return
                    search_status = getattr(results, "status", "ok" if results else "empty")
                    elapsed = time.time() - t_search
                    # Everything the search card renders: the results Bmo actually
                    # read, plus how long the round trip took.
                    yield sse_event({
                        "type": "search_complete",
                        "count": len(results),
                        "status": search_status,
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
                    if user_text_part is not None:
                        if results:
                            context = search_router.build_search_context(search_query, results)
                        else:
                            context = (
                                "Additional web search returned no usable evidence. Use any supplied page or attachment "
                                "only for facts it actually supports. Do not invent current facts, "
                                "prices, results, or citations. Tell the user briefly that live information "
                                "could not be verified, and offer only clearly qualified background."
                            )
                        user_text_part["text"] = f"{context}\n\n{model_text}"
                else:
                    yield sse_event({"type": "search_status", "status": "answering", "label": "Preparing response…"})

            if cancel_event.is_set():
                return
            if settings_reply:
                full_reply = settings_reply
                checkpoint()
                yield sse_event({"type": "token", "data": {"delta": settings_reply}})
            pdf_pages_analyzed = 0
            for batch_idx, batch_content in enumerate(batches):
                if settings_reply:
                    break
                is_first_batch = batch_idx == 0
                if is_first_batch:
                    active_project_id = convo.get("project_id")
                    project = store.get_project(active_project_id, user.id) if active_project_id else None
                    project_files = store.list_project_files(active_project_id, user.id, include_text=True) if project else None
                    long_dashes_allowed = allows_long_dashes(
                        global_instructions, convo.get("system_prompt"),
                        (project or {}).get("instructions"),
                        *(skill.get("instructions") for skill in active_skills), message_text,
                    )

                    base_sys = AEON_SYSTEM_PROMPT if chosen_friendly == "aeon" else DEFAULT_SYSTEM_PROMPT
                    past_user_texts = [
                        m.get("content", "") for m in model_history
                        if m.get("role") == "user" and isinstance(m.get("content"), str)
                    ]
                    retrieval_query = "\n".join(filter(None, past_user_texts[-2:] + [message_text]))
                    assembled_base = skill_service.assemble_prompt(
                        global_instructions, base_sys, active_skills,
                        project=project, project_files=project_files, user_query=retrieval_query,
                        extra_instructions=convo.get("system_prompt"),
                    )
                    if conversation_is_visual:
                        messages_payload = nvidia_client.build_messages_for_vision(
                            model_history, batch_content, system_prompt=assembled_base,
                        )
                    else:
                        messages_payload = nvidia_client.build_messages(
                            model_history, batch_content, base_system_prompt=assembled_base,
                        )
                else:
                    messages_payload = nvidia_client.build_continuation_messages(
                        model_history, batch_content, system_prompt=assembled_base,
                    )

                if len(batches) > 1:
                    batch_imgs = sum(1 for p in batch_content if p.get("type") == "image_url")
                    if is_first_batch:
                        batch_imgs -= len(attachment_image_parts)
                    start_page = pdf_pages_analyzed + 1
                    pdf_pages_analyzed += batch_imgs
                    header = f"\n\n--- Analyzing pages {start_page}-{pdf_pages_analyzed} ---\n\n"
                    full_reply += header
                    checkpoint()
                    yield sse_event({"type": "token", "data": {"delta": header}})

                batch_reply = ""
                max_tokens_override = _VISION_OUTPUT_TOKENS if conversation_is_visual else None
                if chosen_friendly == "aeon":
                    max_tokens_override = 450
                voice_filter = VoiceReplyFilter() if chosen_friendly == "aeon" else None
                prose_filter = ProseDashFilter(enabled=not long_dashes_allowed)
                # Give vision turns one more chance across a per-minute quota
                # reset, within the browser's 90-second first-output deadline.
                retry_delays = (1.5, 3.0, 60.0) if conversation_is_visual else (1.5, 3.0)
                for attempt in range(len(retry_delays) + 1):
                    if cancel_event.is_set():
                        return
                    streamed = False
                    try:
                        for ev in iter_completed_response(
                            messages_payload,
                            cancel_event=cancel_event,
                            model=chosen_model,
                            reasoning_effort=reasoning_effort,
                            thinking=use_thinking,
                            max_tokens=max_tokens_override,
                            on_usage=meter_vision_window if conversation_is_visual else None,
                        ):
                            if cancel_event.is_set():
                                logger.info("chat: generation cancelled by user for convo=%s", convo.get("id"))
                                return
                            if ev["type"] == "delta":
                                streamed = True
                                batch_reply += ev["data"]
                                delta = ev["data"]
                                if voice_filter:
                                    tone, delta = voice_filter.feed(delta)
                                    if tone:
                                        yield sse_event({"type": "voice_style", "data": {"tone": tone}})
                                delta = prose_filter.feed(delta)
                                full_reply += delta
                                checkpoint()
                                if delta:
                                    yield sse_event({"type": "token", "data": {"delta": delta}})
                            elif ev["type"] == "reasoning_delta":
                                streamed = True
                                full_reasoning += ev["data"]
                                checkpoint()
                                yield sse_event({"type": "reasoning_token", "data": {"delta": ev["data"]}})
                            elif ev["type"] == "inference":
                                yield sse_event({"type": "inference", "data": {k: v for k, v in ev.items() if k != "type"}})
                            elif ev["type"] == "generation_status":
                                yield sse_event(ev)
                            elif ev["type"] == "done":
                                if not streamed:
                                    delta = ev.get("content") or ""
                                    if voice_filter:
                                        tone, delta = voice_filter.feed(delta, final=True)
                                        if tone:
                                            yield sse_event({"type": "voice_style", "data": {"tone": tone}})
                                    delta = prose_filter.feed(delta)
                                    full_reply += delta
                                    checkpoint()
                                    if delta:
                                        yield sse_event({"type": "token", "data": {"delta": delta}})
                                batch_reply += ev["content"] or ""
                                full_reasoning += ev.get("reasoning") or ""
                                checkpoint()
                        if voice_filter:
                            tone, delta = voice_filter.feed("", final=True)
                            if tone:
                                yield sse_event({"type": "voice_style", "data": {"tone": tone}})
                            delta = prose_filter.feed(delta)
                            full_reply += delta
                            checkpoint()
                            if delta:
                                yield sse_event({"type": "token", "data": {"delta": delta}})
                        delta = prose_filter.feed("", final=True)
                        full_reply += delta
                        checkpoint()
                        if delta:
                            yield sse_event({"type": "token", "data": {"delta": delta}})
                        break
                    except Exception as exc:  # noqa: BLE001
                        # Retrying after tokens reached the client would duplicate them.
                        details = model_error_details(exc)
                        vision_rate_limit = conversation_is_visual and details["code"] == "rate_limited"
                        if not streamed and details["retryable"] and attempt < (len(retry_delays) if vision_rate_limit else 2):
                            delay = details.get("retry_after", retry_delays[attempt])
                            max_wait = min(60.0, 75.0 - (time.time() - t0)) if vision_rate_limit else 5.0
                            if vision_rate_limit and attempt == len(retry_delays) - 1 and "retry_after" not in details:
                                # Attachment preparation can consume some of the
                                # waiting window before the SSE response starts.
                                delay = min(delay, max_wait)
                            if max_wait > 0 and delay <= max_wait:
                                logger.warning(
                                    "chat: model %s busy (attempt %d), retrying in %.1fs: %s",
                                    chosen_model, attempt + 1, delay, exc,
                                )
                                if delay > 5:
                                    yield sse_event({"type": "search_status", "status": "rate_limited", "label": "Waiting for the image model to be available…"})
                                if cancel_event.wait(delay):
                                    return
                                continue
                        logger.warning(
                            "chat: model %s failed for convo=%s batch=%d: %s",
                            chosen_model, convo.get("id"), batch_idx + 1, exc,
                        )
                        delta = prose_filter.feed("", final=True)
                        full_reply += delta
                        checkpoint()
                        if delta:
                            yield sse_event({"type": "token", "data": {"delta": delta}})
                        generation_error = details
                        break
                if generation_error:
                    break


            # Final pass over the assembled reply: catch highlight.js markup
            # that arrived split across SSE chunks and decode entities the
            # highlighter escaped. Covers persist, incognito payload and the
            # title snapshot in one place.
            full_reply = nvidia_client.sanitize_reply(full_reply)

            if generation_error is None:
                completed = True
                yield sse_event({"type": "complete", "finish_reason": "stop"})

            assistant_message = persist_reply()
            if is_incognito:
                yield sse_event({"type": "conversation", "data": convo})
                if full_reply.strip() or full_reasoning.strip():
                    yield sse_event({
                        "type": "assistant_message",
                        "data": {
                            "id": f"msg_{uuid.uuid4().hex[:8]}",
                            "role": "assistant",
                            "content": full_reply,
                            "reasoning": full_reasoning or None,
                        },
                    })
                if generation_error:
                    yield sse_event({"type": "error", **generation_error})
            else:
                if not assistant_message and not (retry_user and generation_error) and (full_reply.strip() or full_reasoning.strip()):
                    yield sse_event({"type": "error", "detail": "Your response could not be fully saved. Please keep this page open and copy it if needed."})
                if assistant_message:
                    if generation_error:
                        assistant_message = {**assistant_message, "generation_status": "incomplete"}
                    yield sse_event({"type": "assistant_message", "data": assistant_message})
                if generation_error:
                    yield sse_event({"type": "error", **generation_error})
                    return
                # Background enrichment needs the real persisted user message.
                if writer.error or not writer.message:
                    return

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
                    title_seed = convo.get("title") or ""

                    def _bg_title():
                        try:
                            new_title = nvidia_client.generate_title(message_text, reply_snapshot)
                            if new_title:
                                store.set_generated_conversation_title(
                                    convo_id_for_title, user_id_for_title, title_seed, new_title,
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
                _unregister_cancel(cancel_event)
            record_turn_usage()
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
                try:
                    chunk = sse_queue.get(timeout=SSE_HEARTBEAT_SECONDS)
                except queue.Empty:
                    yield ": keep-alive\n\n"
                    continue
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
