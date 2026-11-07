"""Bimo data layer — wraps the Supabase Postgres tables.

Every helper that mutates data scopes by ``user_id`` even though the gateway
already verifies the JWT, so a leaked token can never reach another user's
rows. Using the service-role client (see ``supabase_client.py``) lets us
update timestamps and run cross-row reports without RLS friction.
"""

from __future__ import annotations

import logging
import secrets
import uuid
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Optional

from postgrest.exceptions import APIError

from .supabase_client import attachments_bucket, supabase
from . import usage_service

logger = logging.getLogger("bmo.store")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_pgrst303(exc: Exception) -> bool:
    if not isinstance(exc, APIError):
        return False
    if getattr(exc, "code", None) == "PGRST303":
        return True
    raw = getattr(exc, "_raw_error", None)
    return isinstance(raw, dict) and raw.get("code") == "PGRST303"


def _execute(builder, *, max_retries: int = 2, delay: float = 0.35):
    """Execute a PostgREST query builder with retry on PGRST303 clock skew.

    PGRST303 ('JWT issued at future') is a transient Supabase infrastructure
    clock skew across load-balanced nodes. Retrying up to 2 additional times
    allows the request to hit a healthy node. Any other APIError or exception
    propagates immediately.
    """
    attempts = 0
    while True:
        try:
            return builder.execute()
        except Exception as exc:
            if attempts < max_retries and _is_pgrst303(exc):
                attempts += 1
                logger.warning("execute_failed error_type=%s", type(exc).__name__)
                time.sleep(delay)
                continue
            raise


def _fetch_all(query, *, page_size: int = 200) -> list[dict]:
    """Read past PostgREST's row cap using a deterministically ordered query."""
    rows = []
    while True:
        page = _execute(query.range(len(rows), len(rows) + page_size - 1)).data or []
        rows.extend(page)
        if len(page) < page_size:
            return rows


# ---------- profiles ----------

def upsert_profile(user) -> dict:
    payload = {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "avatar_url": user.avatar_url,
        "provider": user.provider,
        "updated_at": _now_iso(),
    }
    res = _execute(supabase().table("profiles").upsert(payload, on_conflict="id"))
    return (res.data or [payload])[0]


def set_onboarding(user_id: str, *, birthday=None, role=None, seen: bool = True) -> None:
    """Persist the "What's new in Bimo 5" survey answers + mark it seen so the
    modal never re-appears. birthday/role are optional (the user can skip or
    dismiss with "Not now"); only non-empty values are written."""
    payload = {"onboarding_seen": seen, "updated_at": _now_iso()}
    if birthday:
        payload["birthday"] = birthday
    if role:
        payload["role"] = role
    _execute(supabase().table("profiles").update(payload).eq("id", user_id))


# ---------- conversations ----------

def list_conversations(user_id: str, *, limit: int = 100) -> list[dict]:
    res = _execute(
        supabase()
        .table("conversations")
        .select("*")
        .eq("user_id", user_id)
        .order("updated_at", desc=True)
        .limit(limit)
    )
    rows = res.data or []
    return [c for c in rows if c.get("pinned")] + [c for c in rows if not c.get("pinned")]


def get_conversation(conversation_id: str, user_id: str) -> Optional[dict]:
    res = _execute(
        supabase()
        .table("conversations")
        .select("*")
        .eq("id", conversation_id)
        .eq("user_id", user_id)
        .limit(1)
    )
    return (res.data or [None])[0]


def create_conversation(
    user_id: str,
    *,
    first_message: str,
    model: Optional[str] = None,
    system_prompt: Optional[str] = None,
    project_id: Optional[str] = None,
    active_skills: Optional[list] = None,
) -> dict:
    title = (first_message or "New conversation").strip().replace("\n", " ")[:80] or "New conversation"
    payload = {
        "user_id": user_id,
        "title": title,
        "model": model,
        "system_prompt": system_prompt,
    }
    if project_id:
        payload["project_id"] = project_id
    if active_skills:
        payload["active_skills"] = active_skills
    res = _execute(supabase().table("conversations").insert(payload))
    if not res.data:
        raise RuntimeError("Could not create conversation")
    return res.data[0]


def update_conversation(conversation_id: str, user_id: str, patch: dict) -> Optional[dict]:
    allowed = {k: v for k, v in patch.items() if k in {"title", "model", "system_prompt", "pinned", "project_id", "active_skills"}}
    if not allowed:
        return get_conversation(conversation_id, user_id)
    allowed["updated_at"] = _now_iso()
    res = _execute(
        supabase()
        .table("conversations")
        .update(allowed)
        .eq("id", conversation_id)
        .eq("user_id", user_id)
    )
    return (res.data or [None])[0]


def touch_conversation(conversation_id: str, user_id: str) -> None:
    _execute(
        supabase()
        .table("conversations")
        .update({"updated_at": _now_iso()})
        .eq("id", conversation_id)
        .eq("user_id", user_id)
    )


def user_owns_path(user_id: str, path: str) -> bool:
    return (
        isinstance(user_id, str) and bool(user_id)
        and isinstance(path, str) and path.startswith(f"{user_id}/")
        and not any(part in path for part in ("..", "\\", "\x00"))
    )


def validate_attachment_paths(attachments: list, user_id: str) -> None:
    if not isinstance(attachments, list) or not all(isinstance(a, dict) for a in attachments):
        raise ValueError("attachments must be a list of objects")
    for attachment in attachments:
        if "path" in attachment and not user_owns_path(user_id, attachment["path"]):
            raise ValueError("attachment path is not owned by this user")


def _attachment_paths(messages: list, user_id: str) -> list[str]:
    """Ignore foreign/invalid paths, including metadata saved before validation."""
    paths = []
    for msg in messages:
        for a in msg.get("attachments") or []:
            if isinstance(a, dict) and user_owns_path(user_id, a.get("path")):
                paths.append(a["path"])
    return paths


def delete_storage_paths(paths: list[str], *, strict: bool = False) -> None:
    """Best-effort removal from Supabase Storage."""
    if not paths:
        return
    bucket = attachments_bucket()
    try:
        storage = supabase().storage.from_(bucket)
        paths = list(dict.fromkeys(paths))
        for start in range(0, len(paths), 100):
            storage.remove(paths[start:start + 100])
    except Exception as exc:
        logger.warning("delete_storage_paths_failed error_type=%s", type(exc).__name__)
        if strict:
            raise


_delete_storage_paths = delete_storage_paths


def _delete_unreferenced_paths(paths: list[str], user_id: str) -> None:
    """A branch or another chat may still use the same uploaded object."""
    removable = []
    try:
        for path in dict.fromkeys(paths):
            if not user_owns_path(user_id, path):
                continue
            messages = _execute(
                supabase().table("messages").select("id,conversations!inner(user_id)")
                .eq("conversations.user_id", user_id).contains("attachments", [{"path": path}]).limit(1)
            )
            files = _execute(
                supabase().table("project_files").select("id")
                .eq("user_id", user_id).eq("storage_path", path).limit(1)
            )
            if not messages.data and not files.data:
                removable.append(path)
        delete_storage_paths(removable)
    except Exception as exc:
        logger.warning("delete_unreferenced_paths_failed error_type=%s", type(exc).__name__)


def delete_conversation(conversation_id: str, user_id: str) -> bool:
    # SECURITY: verify ownership BEFORE any destructive work. get_messages()
    # is not user-scoped, so without this check a caller could pass another
    # user's conversation id and have that user's attachment files deleted
    # from Storage even though the row delete below would no-op.
    if not get_conversation(conversation_id, user_id):
        return False

    # Clean up attachment files from Supabase Storage before deleting the
    # conversation (messages cascade to messages, but storage objects
    # do not auto-delete on Postgres FK cascade).
    msgs = get_messages(conversation_id)
    paths = _attachment_paths(msgs, user_id)
    res = _execute(
        supabase()
        .table("conversations")
        .delete()
        .eq("id", conversation_id)
        .eq("user_id", user_id)
    )
    deleted = bool(res.data)
    if deleted:
        _delete_unreferenced_paths(paths, user_id)
    return deleted


def branch_conversation(conversation_id: str, user_id: str, before_message_id: str) -> Optional[dict]:
    original = get_conversation(conversation_id, user_id)
    if not original:
        return None
    messages = get_messages(conversation_id)
    index = next((i for i, message in enumerate(messages)
                  if message["id"] == before_message_id and message["role"] == "user"), None)
    if index is None:
        return None
    for message in messages[:index]:
        validate_attachment_paths(message.get("attachments") or [], user_id)
    active_skills = [skill_id for skill_id in original.get("active_skills") or []
                     if (skill := get_skill(skill_id, user_id)) and skill.get("enabled")]
    branch = create_conversation(
        user_id, first_message=original["title"], model=original.get("model"),
        system_prompt=original.get("system_prompt"), project_id=original.get("project_id"),
        active_skills=active_skills,
    )
    rows = [
        {"conversation_id": branch["id"], **{key: message.get(key) for key in
         ("role", "content", "attachments", "reasoning", "created_at", "skills") if message.get(key) is not None}}
        for message in messages[:index]
    ]
    previous_time = None
    for row in rows:
        stamp = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
        if previous_time is not None and stamp <= previous_time:
            stamp = previous_time + timedelta(microseconds=1)
        row["created_at"] = stamp.isoformat()
        previous_time = stamp
    try:
        saved = []
        for start in range(0, len(rows), 200):
            batch = rows[start:start + 200]
            inserted = _execute(supabase().table("messages").insert(batch)).data or []
            if len(inserted) != len(batch):
                raise RuntimeError("Could not copy conversation history")
            saved.extend(inserted)
    except Exception:
        _execute(supabase().table("conversations").delete().eq("id", branch["id"]).eq("user_id", user_id))
        raise
    return {"conversation": branch, "messages": saved or []}


# ---------- messages ----------

def get_messages(conversation_id: str, *, limit: Optional[int] = None) -> list[dict]:
    query = (
        supabase()
        .table("messages")
        .select("*")
        .eq("conversation_id", conversation_id)
        .order("created_at", desc=limit is not None)
        .order("id", desc=limit is not None)
    )
    if limit is None:
        return _fetch_all(query)
    return list(reversed(_execute(query.limit(limit)).data or []))


def add_message(
    conversation_id: str,
    user_id: str,
    *,
    role: str,
    content: str,
    attachments: Optional[list] = None,
    reasoning: Optional[str] = None,
    skills: Optional[list] = None,
) -> dict:
    if not get_conversation(conversation_id, user_id):
        raise PermissionError("conversation not found")
    validate_attachment_paths(attachments or [], user_id)
    payload = {
        "conversation_id": conversation_id,
        "role": role,
        "content": content,
        "attachments": attachments,
    }
    if reasoning:
        payload["reasoning"] = reasoning
    if skills:
        payload["skills"] = skills
    try:
        res = _execute(supabase().table("messages").insert(payload))
    except Exception as exc:
        # If the insert failed because the reasoning column doesn't exist
        # (e.g., migration not yet run), retry without it so the message
        # is not lost.
        if reasoning and "reasoning" in payload:
            logger.warning("message_reasoning_fallback migration=0002_message_reasoning.sql error_type=%s", type(exc).__name__)
            payload.pop("reasoning")
            res = _execute(supabase().table("messages").insert(payload))
        else:
            raise
    if not res.data:
        raise RuntimeError("Could not insert message")
    msg = res.data[0]
    touch_conversation(conversation_id, user_id)
    return msg


def update_message_attachments(message_id: str, user_id: str, attachments: list) -> None:
    if not message_belongs_to_user(message_id, user_id):
        raise PermissionError("message not found")
    validate_attachment_paths(attachments, user_id)
    _execute(supabase().table("messages").update({"attachments": attachments}).eq("id", message_id))


def message_belongs_to_user(message_id: str, user_id: str) -> bool:
    msg = _execute(
        supabase()
        .table("messages")
        .select("conversation_id")
        .eq("id", message_id)
        .limit(1)
    )
    row = (msg.data or [None])[0]
    if not row:
        return False
    convo = get_conversation(row["conversation_id"], user_id)
    return convo is not None


# ---------- feedback ----------

def upsert_feedback(
    user_id: str,
    message_id: str,
    *,
    rating: int,
    correctness: str,
    length: str,
) -> dict:
    existing = _execute(
        supabase()
        .table("feedback")
        .select("id")
        .eq("user_id", user_id)
        .eq("message_id", message_id)
        .limit(1)
    )
    payload = {
        "user_id": user_id,
        "message_id": message_id,
        "rating": rating,
        "correctness": correctness,
        "length": length,
        "updated_at": _now_iso(),
    }
    if existing.data:
        res = _execute(
            supabase()
            .table("feedback")
            .update(payload)
            .eq("id", existing.data[0]["id"])
        )
        return (res.data or [payload])[0]
    res = _execute(supabase().table("feedback").insert(payload))
    return (res.data or [payload])[0]


def user_feedback(user_id: str) -> list[dict]:
    res = _execute(supabase().table("feedback").select("*").eq("user_id", user_id))
    return res.data or []


def message_feedback_map(user_id: str) -> dict[str, dict]:
    return {row["message_id"]: row for row in user_feedback(user_id)}


# ---------- usage metering ----------

def record_usage(user_id: str, model: str, tokens: int) -> None:
    """Log one completed turn's token use. Best-effort — never raise, because
    metering must not break a chat reply that already streamed to the user."""
    try:
        _execute(
            supabase().table("usage_events").insert(
                {"user_id": user_id, "model": model, "tokens": int(max(0, tokens))}
            )
        )
    except Exception as exc:
        logger.warning("record_usage_failed error_type=%s", type(exc).__name__)


def recent_usage_events(user_id: str, since_iso: str) -> list[dict]:
    """All of a user's usage rows since ``since_iso`` (the widest window we
    report). The gateway slices the shorter session window in Python."""
    rows = _fetch_all(
        supabase()
        .table("usage_events")
        .select("model,tokens,created_at")
        .eq("user_id", user_id)
        .gte("created_at", since_iso)
        .order("created_at")
        .order("id")
    )
    return rows + usage_service.held_usage(user_id)


# ---------- analytics ----------

def analytics_summary(user_id: str) -> dict:
    sb = supabase()
    convos = _execute(
        sb.table("conversations")
        .select("id", count="exact")
        .eq("user_id", user_id)
        .limit(1000)
    )
    convo_count = convos.count or 0
    convo_ids = [c["id"] for c in (convos.data or [])]
    msg_count = 0
    if convo_ids:
        # Query in chunks of 100 to prevent PostgREST URI overflow (414) on large sets
        CHUNK_SIZE = 100
        for i in range(0, len(convo_ids), CHUNK_SIZE):
            chunk = convo_ids[i : i + CHUNK_SIZE]
            msgs = _execute(
                sb.table("messages")
                .select("id", count="exact")
                .in_("conversation_id", chunk)
                .limit(1)
            )
            msg_count += msgs.count or 0

    feedback_rows = user_feedback(user_id)
    ratings = [r["rating"] for r in feedback_rows]
    return {
        "conversations": convo_count,
        "messages": msg_count,
        "feedback_count": len(feedback_rows),
        "average_rating": round(sum(ratings) / len(ratings), 2) if ratings else 0,
        "correctness": dict(Counter(r["correctness"] for r in feedback_rows)),
        "length": dict(Counter(r["length"] for r in feedback_rows)),
        "rating_distribution": dict(Counter(ratings)),
    }


def all_feedback_dataframe_rows(user_id: Optional[str] = None) -> list[dict]:
    query = supabase().table("feedback").select("*")
    if user_id:
        query = query.eq("user_id", user_id)
    res = _execute(query)
    return res.data or []


# ---------- account deletion ----------

def delete_all_user_data(user_id: str) -> None:
    """Wipe user content. Messages cascade with conversations
    via the FK in 0001_init.sql; feedback and profile go separately.
    Storage objects are cleaned up explicitly since there is no FK
    cascade from Postgres to Supabase Storage.
    """
    sb = supabase()

    # 1) Collect attachment paths from all user messages before anything
    # is deleted. We have to walk conversations because messages have no
    # user_id column.
    convos = _fetch_all(sb.table("conversations").select("id").eq("user_id", user_id).order("id"))
    all_paths: list[str] = []
    for row in convos:
        msgs = get_messages(row["id"])
        all_paths.extend(_attachment_paths(msgs, user_id))
    project_files = _fetch_all(
        sb.table("project_files").select("storage_path").eq("user_id", user_id).order("id")
    )
    all_paths.extend(f["storage_path"] for f in project_files if user_owns_path(user_id, f.get("storage_path")))
    # Do not erase the metadata needed to retry if storage is unavailable.
    _delete_storage_paths(all_paths, strict=True)

    # 2) Conversations -> cascades to messages (FK on delete cascade)
    _execute(sb.table("conversations").delete().eq("user_id", user_id))
    _execute(sb.table("projects").delete().eq("user_id", user_id))
    _execute(sb.table("skills").delete().eq("user_id", user_id))
    _execute(sb.table("preferences").delete().eq("user_id", user_id))
    # 3) Feedback (in case any orphaned rows survived the cascade)
    _execute(sb.table("feedback").delete().eq("user_id", user_id))
    # Preserve active allowances if the subsequent auth deletion fails. The
    # auth.users FK removes personal usage only after actual account deletion.
    # 5) Profile row
    _execute(sb.table("profiles").delete().eq("id", user_id))


# ---------- storage / attachments ----------

def refresh_attachment_urls(messages: list[dict], user_id: str) -> list[dict]:
    """Sign owned objects for this read; never persist short-lived URLs again."""
    paths = list(dict.fromkeys(
        a["path"] for m in messages for a in m.get("attachments") or []
        if isinstance(a, dict) and user_owns_path(user_id, a.get("path"))
    ))
    urls = {}
    if paths:
        bucket = supabase().storage.from_(attachments_bucket())
        for start in range(0, len(paths), 100):
            batch = paths[start:start + 100]
            try:
                signed_rows = bucket.create_signed_urls(batch, 3600)
            except (TypeError, KeyError):
                # storage3's batch decoder can fail on a missing object's null URL.
                signed_rows = []
                for path in batch:
                    try:
                        signed_rows.append({**bucket.create_signed_url(path, 3600), "path": path})
                    except Exception:
                        logger.warning("Could not refresh an attachment URL")
            except Exception:
                # An outage must not turn one history read into many network retries.
                logger.warning("Attachment signing unavailable; retaining existing owned URLs")
                break
            for signed in signed_rows:
                if not signed.get("error") and signed.get("path") in paths:
                    url = signed.get("signedURL") or signed.get("signedUrl") or signed.get("signed_url")
                    if url:
                        urls[signed["path"]] = url
    return [{**m, "attachments": [
        {**a, "url": urls.get(a.get("path")) or a.get("url")}
        if user_owns_path(user_id, a.get("path")) else {**a, "url": None}
        for a in m.get("attachments") or [] if isinstance(a, dict)
    ]} for m in messages]


def download_attachment(path: str, user_id: str) -> bytes:
    """Pull an attachment's raw bytes back out of Supabase Storage.

    Used by /chat to inline images as base64 so NVIDIA's vision model
    doesn't have to fetch our signed URL from its own outbound network.
    Always requires user_id and rejects paths outside that user's prefix.
    """
    if not isinstance(path, str) or not path:
        raise ValueError("Invalid attachment path")
    if not isinstance(user_id, str) or not user_id:
        raise PermissionError("user_id required")
    if not user_owns_path(user_id, path):
        raise PermissionError(f"User {user_id} does not own attachment path: {path}")
    return supabase().storage.from_(attachments_bucket()).download(path)



def upload_attachment_for_user(
    user_id: str,
    *,
    filename: str,
    file_bytes: bytes,
    content_type: str,
    expires_in: int = 60 * 60,
) -> dict:
    """Upload to Supabase Storage and return a fresh signed URL.

    Files live under ``<user_id>/<random>/<filename>`` so the storage RLS
    policy in 0001_init.sql can scope them to their owner. ``expires_in`` is the
    signed-URL lifetime in seconds (default 1 hour; generated images pass a much
    longer TTL so they stay viewable well beyond the active session).
    """
    bucket = attachments_bucket()
    safe_name = filename.replace("\\", "_").split("/")[-1] or "file"
    path = f"{user_id}/{secrets.token_hex(8)}/{safe_name}"
    sb = supabase()
    sb.storage.from_(bucket).upload(
        path=path,
        file=file_bytes,
        file_options={"content-type": content_type, "upsert": "false"},
    )
    signed = sb.storage.from_(bucket).create_signed_url(path, expires_in)
    if isinstance(signed, dict):
        url = signed.get("signedURL") or signed.get("signed_url") or signed.get("signedUrl")
    else:
        url = getattr(signed, "signed_url", None) or getattr(signed, "signedURL", None)
    if not url:
        # Different supabase-py versions return the signed URL under different
        # keys; if we still have nothing, log the shape so we can add the new
        # key. Without a URL the vision model will silently receive no image.
        logger.error(
            "storage_signing_failed response_type=%s",
            type(signed).__name__,
        )
    return {
        "path": path,
        "url": url,
        "content_type": content_type,
        "size": len(file_bytes),
        "filename": safe_name,
    }


def delete_auth_user(user_id: str) -> None:
    """Delete the auth.users row via the service-role admin API.

    Raises if the configured key isn't admin-capable. Caller should treat
    this as best-effort: data is already gone by the time we reach here.
    """
    supabase().auth.admin.delete_user(user_id)


# ---------- Shared Conversations (Public Snapshots) ----------

def create_or_update_shared_conversation(conversation_id: str, user_id: str) -> dict:
    """Create or update a public read-only snapshot of a conversation."""
    convo = get_conversation(conversation_id, user_id)
    if not convo:
        raise PermissionError("conversation not found")
    messages = get_messages(conversation_id)
    clean_messages = [
        {
            "id": m.get("id"),
            "role": m.get("role"),
            "content": m.get("content"),
            "reasoning": m.get("reasoning"),
            "attachments": m.get("attachments"),
            "skills": m.get("skills") or [],
            "created_at": m.get("created_at"),
        }
        for m in messages
    ]
    now = _now_iso()
    existing = _execute(
        supabase()
        .table("shared_conversations")
        .select("id")
        .eq("conversation_id", conversation_id)
        .eq("user_id", user_id)
    )
    if existing.data:
        share_id = existing.data[0]["id"]
        res = _execute(
            supabase()
            .table("shared_conversations")
            .update({
                "title": convo.get("title") or "Shared conversation",
                "model": convo.get("model"),
                "snapshot": clean_messages,
                "updated_at": now,
            })
            .eq("id", share_id)
            .eq("user_id", user_id)
        )
        return res.data[0] if res.data else {"id": share_id, "title": convo.get("title"), "created_at": now}

    res = _execute(
        supabase()
        .table("shared_conversations")
        .insert({
            "conversation_id": conversation_id,
            "user_id": user_id,
            "title": convo.get("title") or "Shared conversation",
            "model": convo.get("model"),
            "snapshot": clean_messages,
            "created_at": now,
            "updated_at": now,
        })
    )
    return res.data[0] if res.data else {"title": convo.get("title"), "created_at": now}


def get_shared_conversation_meta(conversation_id: str, user_id: str) -> Optional[dict]:
    """Retrieve existing share metadata for the conversation owner."""
    res = _execute(
        supabase()
        .table("shared_conversations")
        .select("id, conversation_id, title, model, created_at, updated_at")
        .eq("conversation_id", conversation_id)
        .eq("user_id", user_id)
    )
    return res.data[0] if res.data else None


def delete_shared_conversation(conversation_id: str, user_id: str) -> bool:
    """Revoke public share link for a conversation."""
    res = _execute(
        supabase()
        .table("shared_conversations")
        .delete()
        .eq("conversation_id", conversation_id)
        .eq("user_id", user_id)
    )
    return bool(res.data)


def get_public_shared_conversation(share_id: str) -> Optional[dict]:
    """Retrieve public shared conversation snapshot (unauthenticated)."""
    try:
        uuid.UUID(str(share_id).strip())
    except (ValueError, TypeError, AttributeError):
        return None
    res = _execute(
        supabase()
        .table("shared_conversations")
        .select("id,title,model,snapshot,user_id,created_at,updated_at")
        .eq("id", share_id)
    )
    if not res.data:
        return None
    row = res.data[0]
    return {
        "id": row.get("id"),
        "title": row.get("title"),
        "model": row.get("model"),
        "messages": refresh_attachment_urls(row.get("snapshot") or [], row.get("user_id")),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


# ---------- Projects ----------

def list_projects(user_id: str, *, include_archived: bool = False) -> list[dict]:
    query = supabase().table("projects").select("*").eq("user_id", user_id)
    if not include_archived:
        query = query.eq("archived", False)
    res = _execute(query.order("updated_at", desc=True))
    return res.data or []


def get_project(project_id: str, user_id: str) -> Optional[dict]:
    res = _execute(
        supabase()
        .table("projects")
        .select("*")
        .eq("id", project_id)
        .eq("user_id", user_id)
        .limit(1)
    )
    return (res.data or [None])[0]


def create_project(
    user_id: str,
    *,
    name: str,
    description: str = "",
    instructions: str = "",
) -> dict:
    payload = {
        "user_id": user_id,
        "name": (name or "Untitled Project").strip()[:100] or "Untitled Project",
        "description": (description or "").strip()[:500],
        "instructions": (instructions or "").strip()[:8000],
    }
    res = _execute(supabase().table("projects").insert(payload))
    if not res.data:
        raise RuntimeError("Could not create project")
    return res.data[0]


def update_project(project_id: str, user_id: str, patch: dict) -> Optional[dict]:
    allowed = {k: v for k, v in patch.items() if k in {"name", "description", "instructions", "archived"}}
    if not allowed:
        return get_project(project_id, user_id)
    allowed["updated_at"] = _now_iso()
    res = _execute(
        supabase()
        .table("projects")
        .update(allowed)
        .eq("id", project_id)
        .eq("user_id", user_id)
    )
    return (res.data or [None])[0]


def delete_project(project_id: str, user_id: str) -> bool:
    project = get_project(project_id, user_id)
    if not project:
        return False
    files = _fetch_all(
        supabase().table("project_files").select("storage_path")
        .eq("project_id", project_id).eq("user_id", user_id).order("id")
    )
    paths = [f["storage_path"] for f in files if user_owns_path(user_id, f.get("storage_path"))]

    # Delete DB row first
    res = _execute(
        supabase()
        .table("projects")
        .delete()
        .eq("id", project_id)
        .eq("user_id", user_id)
    )
    deleted = bool(res.data)

    # Storage cleanup is best-effort (log failure, do not raise)
    if deleted and paths:
        _delete_unreferenced_paths(paths, user_id)

    return deleted


# ---------- Project Files ----------

_FILE_LIST_COLUMNS = "id, project_id, filename, mime_type, size_bytes, token_estimate, created_at"


def list_project_files(project_id: str, user_id: str, *, include_text: bool = False) -> list[dict]:
    cols = "*" if include_text else _FILE_LIST_COLUMNS
    res = _execute(
        supabase()
        .table("project_files")
        .select(cols)
        .eq("project_id", project_id)
        .eq("user_id", user_id)
        .order("created_at", desc=False)
    )
    return res.data or []


def get_project_file(file_id: str, user_id: str) -> Optional[dict]:
    res = _execute(
        supabase()
        .table("project_files")
        .select("*")
        .eq("id", file_id)
        .eq("user_id", user_id)
        .limit(1)
    )
    return (res.data or [None])[0]


def add_project_file(
    project_id: str,
    user_id: str,
    *,
    filename: str,
    mime_type: str,
    size_bytes: int,
    storage_path: str,
    extracted_text: str = "",
    token_estimate: int = 0,
) -> dict:
    if not get_project(project_id, user_id):
        raise PermissionError("project not found")
    payload = {
        "project_id": project_id,
        "user_id": user_id,
        "filename": filename,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "storage_path": storage_path,
        "extracted_text": extracted_text,
        "token_estimate": token_estimate,
    }
    res = _execute(supabase().table("project_files").insert(payload))
    if not res.data:
        raise RuntimeError("Could not insert project file")
    _execute(
        supabase()
        .table("projects")
        .update({"updated_at": _now_iso()})
        .eq("id", project_id)
        .eq("user_id", user_id)
    )
    return res.data[0]


def delete_project_file(project_id: str, file_id: str, user_id: str) -> bool:
    pf = get_project_file(file_id, user_id)
    if not pf or pf.get("project_id") != project_id:
        return False
    path = pf.get("storage_path")

    # Delete DB row first
    res = _execute(
        supabase()
        .table("project_files")
        .delete()
        .eq("id", file_id)
        .eq("project_id", project_id)
        .eq("user_id", user_id)
    )
    deleted = bool(res.data)

    # Storage cleanup is best-effort (log failure, do not raise)
    if deleted and user_owns_path(user_id, path):
        _delete_unreferenced_paths([path], user_id)

    return deleted


def get_project_token_usage(project_id: str, user_id: str) -> int:
    res = _execute(
        supabase()
        .table("project_files")
        .select("token_estimate")
        .eq("project_id", project_id)
        .eq("user_id", user_id)
    )
    return sum((row.get("token_estimate") or 0) for row in (res.data or []))


def get_projects_file_stats(user_id: str) -> dict[str, dict[str, int]]:
    """Return {project_id: {"file_count": int, "tokens_used": int}} for all files owned by user."""
    res = _execute(
        supabase()
        .table("project_files")
        .select("project_id, token_estimate")
        .eq("user_id", user_id)
    )
    stats: dict[str, dict[str, int]] = {}
    for row in (res.data or []):
        pid = row.get("project_id")
        if not pid:
            continue
        cur = stats.setdefault(pid, {"file_count": 0, "tokens_used": 0})
        cur["file_count"] += 1
        cur["tokens_used"] += (row.get("token_estimate") or 0)
    return stats


def get_projects_chat_stats(user_id: str) -> dict[str, int]:
    """Return {project_id: chat_count} for all conversations owned by user."""
    res = _execute(
        supabase()
        .table("conversations")
        .select("project_id")
        .eq("user_id", user_id)
        .not_.is_("project_id", "null")
    )
    stats: dict[str, int] = {}
    for row in (res.data or []):
        pid = row.get("project_id")
        if pid:
            stats[pid] = stats.get(pid, 0) + 1
    return stats


def list_project_conversations(project_id: str, user_id: str) -> list[dict]:
    res = _execute(
        supabase()
        .table("conversations")
        .select("*")
        .eq("project_id", project_id)
        .eq("user_id", user_id)
        .order("updated_at", desc=True)
    )
    return res.data or []



# ---------- Customize ----------

def get_preferences(user_id: str) -> dict:
    rows = _execute(supabase().table("preferences").select("instructions").eq("user_id", user_id).limit(1)).data
    return (rows or [{"instructions": ""}])[0]


def save_preferences(user_id: str, instructions: str) -> dict:
    payload = {"user_id": user_id, "instructions": instructions, "updated_at": _now_iso()}
    rows = _execute(supabase().table("preferences").upsert(payload, on_conflict="user_id")).data
    return (rows or [payload])[0]


def list_skills(user_id: str) -> list[dict]:
    return _fetch_all(supabase().table("skills").select(
        "id,name,description,enabled,created_at,updated_at"
    ).eq("user_id", user_id).order("name").order("id"))


def get_skill(skill_id: str, user_id: str) -> Optional[dict]:
    rows = _execute(supabase().table("skills").select("*").eq("id", skill_id).eq("user_id", user_id).limit(1)).data
    return (rows or [None])[0]


def list_skill_files(skill_id: str, user_id: str) -> list[dict]:
    return _fetch_all(supabase().table("skill_files").select("filename,content,size_bytes")
                      .eq("skill_id", skill_id).eq("user_id", user_id).order("filename"))


def create_skill(user_id: str, values: dict, files: list[dict]) -> dict:
    skill = _execute(supabase().table("skills").insert({**values, "enabled": True, "user_id": user_id})).data[0]
    try:
        if files:
            _execute(supabase().table("skill_files").insert([
                {**file, "skill_id": skill["id"], "user_id": user_id} for file in files
            ]))
    except Exception:
        delete_skill(skill["id"], user_id)
        raise
    return skill


def update_skill(skill_id: str, user_id: str, values: dict) -> Optional[dict]:
    patch = {key: value for key, value in values.items() if key in {"name", "description", "instructions", "enabled"}}
    rows = _execute(supabase().table("skills").update({**patch, "updated_at": _now_iso()})
                    .eq("id", skill_id).eq("user_id", user_id)).data
    return (rows or [None])[0]


def delete_skill(skill_id: str, user_id: str) -> bool:
    return bool(_execute(supabase().table("skills").delete().eq("id", skill_id).eq("user_id", user_id)).data)
