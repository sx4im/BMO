"""WhatsApp Cloud API integration for Bmo.

Provides Webhook endpoints for Meta WhatsApp Cloud API to allow users to chat
directly with Bmo (Stanza 2.5 model) over WhatsApp.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import threading
from threading import BoundedSemaphore, Thread
import requests
from flask import Blueprint, jsonify, request
from typing import Optional

from openai import OpenAI
from redis.exceptions import RedisError

from . import nvidia_client, usage_service, security_store
from .config import DEFAULT_GROQ_BASE_URL, get_aeon_model, get_stanza_model
from .prompts import WHATSAPP_SYSTEM_PROMPT

from collections import deque
import sqlite3
import time

logger = logging.getLogger("bmo.whatsapp")

whatsapp_bp = Blueprint("whatsapp", __name__)

WHATSAPP_TOKEN = os.getenv("WHATSAPP_TOKEN", "").strip()
WHATSAPP_PHONE_ID = os.getenv("WHATSAPP_PHONE_ID", "").strip()
WHATSAPP_VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN", "").strip()
WHATSAPP_APP_SECRET = os.getenv("WHATSAPP_APP_SECRET", "").strip()


def principal_for_sender(phone: str) -> str:
    """Stable keyed pseudonym; no invented Supabase account or raw phone in billing."""
    if not isinstance(phone, str) or not re.fullmatch(r"[1-9][0-9]{6,19}", phone):
        raise ValueError("Invalid WhatsApp sender")
    pepper = os.getenv("BMO_WHATSAPP_IDENTITY_PEPPER", "")
    if len(pepper) < 32:
        raise usage_service.MeteringUnavailable("WhatsApp accounting identity is not configured.")
    return "wa:" + hmac.new(pepper.encode(), phone.encode(), hashlib.sha256).hexdigest()


def _resolve_whatsapp_db_path() -> str:
    custom = os.getenv("WHATSAPP_DB_PATH", "").strip()
    if custom:
        return custom
    # Default to user's private ~/.bmo directory with 0700 permissions
    base_dir = os.path.join(os.path.expanduser("~"), ".bmo")
    try:
        os.makedirs(base_dir, mode=0o700, exist_ok=True)
        os.chmod(base_dir, 0o700)
    except Exception:
        uid = os.getuid() if hasattr(os, "getuid") else "shared"
        base_dir = os.path.join("/tmp", f".bmo_{uid}")
        os.makedirs(base_dir, mode=0o700, exist_ok=True)
        try:
            os.chmod(base_dir, 0o700)
        except Exception:
            pass
    return os.path.join(base_dir, "whatsapp_context.db")


_DB_PATH = _resolve_whatsapp_db_path()
_db_lock = threading.Lock()
_MAX_HISTORY_TURNS = 40  # up to 40 messages (20 user + 20 assistant turns)
_HISTORY_TTL_SECONDS = 24 * 3600  # 24 hours conversation memory window
_job_slots = BoundedSemaphore(2)
_MAX_WEBHOOK_BYTES = 1024 * 1024
_retention_thread = None
_retention_lock = threading.Lock()
_retention_stop = threading.Event()


def _connect_history():
    connection = sqlite3.connect(_DB_PATH, timeout=10.0)
    connection.execute("PRAGMA secure_delete=ON")
    return connection


def _init_whatsapp_db() -> None:
    """Initialize the SQLite context table and enable WAL mode for fast concurrency across workers."""
    with _db_lock:
        try:
            db_dir = os.path.dirname(_DB_PATH)
            if db_dir:
                os.makedirs(db_dir, mode=0o700, exist_ok=True)
                try:
                    os.chmod(db_dir, 0o700)
                except Exception:
                    pass
            conn = _connect_history()
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("""
                CREATE TABLE IF NOT EXISTS whatsapp_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    phone TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_phone_time ON whatsapp_messages(phone, created_at);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_whatsapp_created_at ON whatsapp_messages(created_at);")
            conn.execute("DELETE FROM whatsapp_messages WHERE created_at < ?", (time.time() - _HISTORY_TTL_SECONDS,))
            conn.commit()
            conn.close()
            if os.path.exists(_DB_PATH):
                try:
                    os.chmod(_DB_PATH, 0o600)
                except Exception:
                    pass
        except Exception as exc:
            logger.error("whatsapp_history_init_failed error_type=%s", type(exc).__name__)


_init_whatsapp_db()


def prune_phone_history() -> int:
    """Retire inactive senders too, and checkpoint old WAL pages when possible."""
    with _db_lock:
        connection = _connect_history()
        try:
            cursor = connection.execute("DELETE FROM whatsapp_messages WHERE created_at < ?", (time.time() - _HISTORY_TTL_SECONDS,))
            count = cursor.rowcount
            connection.commit()
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            return count
        finally:
            connection.close()


def start_retention_worker():
    """One local, non-network maintenance loop per live application worker."""
    global _retention_thread
    with _retention_lock:
        if _retention_thread and _retention_thread.is_alive():
            return

        def maintain():
            while not _retention_stop.wait(3600):
                try:
                    count = prune_phone_history()
                    logger.info("whatsapp_history_pruned count=%d", count)
                except Exception as error:
                    logger.error("whatsapp_history_retention_failed error_type=%s", type(error).__name__)

        _retention_thread = threading.Thread(target=maintain, name="bmo-retention", daemon=True)
        _retention_thread.start()


def _get_phone_history(phone: str) -> list[dict]:
    """Retrieve recent conversation history for a phone number across all worker processes."""
    cutoff = time.time() - _HISTORY_TTL_SECONDS
    principal = principal_for_sender(phone)
    with _db_lock:
        try:
            conn = _connect_history()
            conn.execute("DELETE FROM whatsapp_messages WHERE created_at < ?", (cutoff,))
            conn.commit()
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT role, content FROM whatsapp_messages
                WHERE phone = ? AND created_at >= ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (principal, cutoff, _MAX_HISTORY_TURNS),
            )
            rows = cursor.fetchall()
            conn.close()
            # Reverse so it's in chronological order
            return [{"role": r[0], "content": r[1]} for r in reversed(rows)]
        except Exception as exc:
            logger.warning("whatsapp_history_read_failed error_type=%s", type(exc).__name__)
            return []


def _append_phone_history(phone: str, role: str, content: str) -> None:
    """Store a message turn in SQLite, immediately visible to all gunicorn workers."""
    if not content:
        return
    now = time.time()
    principal = principal_for_sender(phone)
    with _db_lock:
        try:
            conn = _connect_history()
            conn.execute(
                "INSERT INTO whatsapp_messages (phone, role, content, created_at) VALUES (?, ?, ?, ?)",
                (principal, role, content, now),
            )
            # Prune inactive senders as well; SELECT's LIMIT alone does not bound storage.
            conn.execute("DELETE FROM whatsapp_messages WHERE created_at < ?", (now - _HISTORY_TTL_SECONDS,))
            conn.execute("DELETE FROM whatsapp_messages WHERE phone = ? AND id NOT IN (SELECT id FROM whatsapp_messages WHERE phone = ? ORDER BY id DESC LIMIT ?)",
                         (principal, principal, _MAX_HISTORY_TURNS))
            conn.commit()
            conn.close()
        except Exception as exc:
            logger.warning("whatsapp_history_write_failed error_type=%s", type(exc).__name__)


def _clear_phone_history(phone: str) -> None:
    """Reset conversation context for a phone number."""
    principal = principal_for_sender(phone)
    with _db_lock:
        try:
            conn = _connect_history()
            conn.execute("DELETE FROM whatsapp_messages WHERE phone = ?", (principal,))
            conn.commit()
            conn.close()
        except Exception as exc:
            logger.warning("whatsapp_history_clear_failed error_type=%s", type(exc).__name__)


def get_graph_url() -> str:
    phone_id = os.getenv("WHATSAPP_PHONE_ID", WHATSAPP_PHONE_ID).strip()
    return f"https://graph.facebook.com/v18.0/{phone_id}/messages"


def is_whatsapp_configured() -> bool:
    token = os.getenv("WHATSAPP_TOKEN", WHATSAPP_TOKEN).strip()
    phone_id = os.getenv("WHATSAPP_PHONE_ID", WHATSAPP_PHONE_ID).strip()
    return bool(token and phone_id)


def verify_meta_signature(raw_payload: bytes, signature_header: Optional[str]) -> bool:
    """Validate Meta's X-Hub-Signature-256 HMAC-SHA256 against WHATSAPP_APP_SECRET."""
    secret = os.getenv("WHATSAPP_APP_SECRET", WHATSAPP_APP_SECRET).strip()
    if not secret:
        return False
    if not isinstance(signature_header, str) or not re.fullmatch(r"sha256=[a-f0-9]{64}", signature_header):
        return False
    expected_sig = signature_header.split("sha256=", 1)[1].strip()
    computed_sig = hmac.new(secret.encode("utf-8"), raw_payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected_sig, computed_sig)


def format_for_whatsapp(text: str) -> str:
    """Format markdown reply for clean display on WhatsApp.

    WhatsApp Formatting Spec:
      - Bold: *text* (Markdown **text** or __text__ must be converted to *text*)
      - Italic: _text_ (Markdown *text* converted if single, but avoid colliding with bold)
      - Strikethrough: ~text~ (Markdown ~~text~~ -> ~text~)
      - Monospace/Code inline: `text`
      - Code block: ```code```
      - Headings: # Heading -> *Heading*
      - Bullets: - item -> • item
    """
    if not text:
        return ""

    # 1. Strip markdown headings e.g. '### Heading' -> '*Heading*'
    text = re.sub(r"^#{1,6}\s*(.+)$", r"*\1*", text, flags=re.MULTILINE)

    # 2. Convert standard Markdown bold **text** or __text__ to WhatsApp bold *text*
    text = re.sub(r"\*\*(.+?)\*\*", r"*\1*", text)
    text = re.sub(r"__(.+?)__", r"*\1*", text)

    # 3. Convert strikethrough ~~text~~ to ~text~
    text = re.sub(r"~~(.+?)~~", r"~\1~", text)

    # 4. Convert markdown list dashes '- ' or '* ' at line starts to WhatsApp bullet point '• '
    text = re.sub(r"^[-*]\s+", r"• ", text, flags=re.MULTILINE)

    # 5. Clean up stray double asterisks left at start or end of lines e.g. '**6.' -> '*6.*'
    text = re.sub(r"\*\*(\d+[\.\)])", r"*\1*", text)
    text = re.sub(r"\*\*", r"*", text)

    # 6. Ensure code blocks have clean formatting
    text = re.sub(r"```[a-zA-Z]*\n([\s\S]*?)\n```", r"```\n\1\n```", text)

    # 7. Clean up excessive blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def send_whatsapp_message(to_phone: str, message_text: str) -> bool:
    """Send an outbound text message via Meta Graph API."""
    token = os.getenv("WHATSAPP_TOKEN", WHATSAPP_TOKEN).strip()
    url = get_graph_url()

    if not token or not url:
        logger.warning("WhatsApp message not sent: WHATSAPP_TOKEN or WHATSAPP_PHONE_ID is not configured.")
        return False

    clean_phone = re.sub(r"[^\d]", "", to_phone)
    if not clean_phone:
        logger.error("whatsapp_recipient_invalid")
        return False

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    # Split into multiple messages if length exceeds WhatsApp 4096 char limit
    chunks = [message_text[i:i + 4000] for i in range(0, len(message_text), 4000)] or [message_text]
    success = True

    for chunk in chunks:
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": clean_phone,
            "type": "text",
            "text": {"body": chunk},
        }
        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=15)
            if resp.status_code not in (200, 201):
                logger.error("whatsapp_delivery_failed status=%d", resp.status_code)
                success = False
            else:
                logger.info("whatsapp_delivery_succeeded")
        except Exception as exc:
            logger.error("whatsapp_delivery_failed error_type=%s", type(exc).__name__)
            success = False
    return success


def _generate_groq_reply(model_id: str, messages: list[dict], groq_key: str) -> str:
    """Generate a chat completion using Groq's low-latency API."""
    base_url = os.getenv("GROQ_BASE_URL", DEFAULT_GROQ_BASE_URL).strip()
    client = OpenAI(api_key=groq_key, base_url=base_url, timeout=20.0, max_retries=0)
    try:
        resp = usage_service.llm_create(client, {
            "model": model_id, "messages": messages, "max_tokens": 400, "temperature": 0.7,
        }, resource="aeon")
        if resp.choices and resp.choices[0].message:
            return resp.choices[0].message.content or ""
        return ""
    finally:
        client.close()


def _process_and_reply_async(sender_phone: str, user_prompt: str) -> None:
    """Worker function running in a background thread to process the AI model response."""
    try:
        principal = principal_for_sender(sender_phone)
        if not isinstance(user_prompt, str) or not 0 < len(user_prompt) <= 4096:
            raise ValueError("Invalid WhatsApp text length")
        with usage_service.scope(None, external_principal=principal, resource="aeon"):
            _reply_under_budget(sender_phone, user_prompt)
    except (usage_service.MeteringUnavailable, usage_service.QuotaExceeded, usage_service.AdmissionConflict):
        logger.warning("whatsapp_admission_denied")
        send_whatsapp_message(sender_phone, "Bmo is unavailable or has reached its allowance. Please try again later.")
    except Exception as error:
        logger.error("whatsapp_processing_failed error_type=%s", type(error).__name__)
        send_whatsapp_message(sender_phone, "Bmo could not process this message. Please try again shortly.")


def _start_message_job(sender: str, body: str, message_id: str) -> str:
    """Bound background threads and claim each signed Meta event across workers."""
    principal = principal_for_sender(sender)
    key = f"{security_store.namespace()}:wa-event:" + hashlib.sha256((principal + "\0" + message_id).encode()).hexdigest()
    if not _job_slots.acquire(blocking=False):
        return "busy"
    client = None
    claimed = False
    try:
        client = security_store.redis_client()
        if not client.set(key, "processing", ex=86400, nx=True):
            _job_slots.release()
            return "duplicate"
        claimed = True
        Thread(target=_run_message_job, args=(sender, body, client, key), name="bmo-whatsapp", daemon=True).start()
    except Exception as error:
        _job_slots.release()
        # An uncertain SET may belong to another worker: never erase its claim.
        if client is not None and claimed:
            try: client.delete(key)
            except RedisError: pass
        logger.error("whatsapp_job_admission_failed error_type=%s", type(error).__name__)
        raise security_store.SecurityStoreUnavailable("WhatsApp processing is unavailable.") from error
    return "accepted"


def _run_message_job(sender: str, body: str, client, key: str):
    try:
        if body.lower() in {"/reset", "/new", "reset", "clear", "/clear"}:
            _clear_phone_history(sender)
            send_whatsapp_message(sender, "Conversation context reset. What would you like to discuss?")
        else:
            _process_and_reply_async(sender, body)
    finally:
        try:
            client.set(key, "processed", ex=7 * 86400, xx=True)
        except RedisError:
            logger.warning("whatsapp_event_retention_pending")
        finally:
            _job_slots.release()


def _reply_under_budget(sender_phone: str, user_prompt: str) -> None:
    try:
        model_id = get_aeon_model()
        prior_turns = _get_phone_history(sender_phone)
        messages = [{"role": "system", "content": WHATSAPP_SYSTEM_PROMPT}]
        messages.extend(prior_turns)
        messages.append({"role": "user", "content": user_prompt})

        logger.info("whatsapp_processing context_turns=%d", len(prior_turns))

        raw_reply = ""
        groq_key = os.getenv("GROQ_API_KEY", "").strip()
        if groq_key:
            try:
                logger.info("Executing Groq chat completion for WhatsApp (%s)", model_id)
                raw_reply = _generate_groq_reply(model_id, messages, groq_key)
                if raw_reply:
                    logger.info("Successfully generated reply via Groq (%d chars)", len(raw_reply))
            except (usage_service.MeteringUnavailable, usage_service.QuotaExceeded, usage_service.AdmissionConflict):
                raise
            except Exception as exc:
                logger.warning("whatsapp_provider_fallback error_type=%s", type(exc).__name__)
        else:
            logger.info("GROQ_API_KEY not set, falling back to NVIDIA for WhatsApp")

        if not raw_reply:
            response_chunks = []
            for chunk in nvidia_client.iter_response_with_fallback(
                messages,
                model=model_id,
                thinking=False,
                max_tokens=400,
            ):
                chunk_type = chunk.get("type")
                if chunk_type == "delta":
                    response_chunks.append(chunk.get("data", ""))
                elif chunk_type == "done" and not response_chunks:
                    response_chunks.append(chunk.get("content", ""))

            raw_reply = "".join(response_chunks).strip()

        if not raw_reply:
            raw_reply = "I received your message! How can I help you today?"

        _append_phone_history(sender_phone, "user", user_prompt)
        _append_phone_history(sender_phone, "assistant", raw_reply)

        formatted_reply = format_for_whatsapp(raw_reply)
        send_whatsapp_message(sender_phone, formatted_reply)
    except (usage_service.MeteringUnavailable, usage_service.QuotaExceeded, usage_service.AdmissionConflict):
        raise
    except Exception as exc:
        logger.error("whatsapp_processing_failed error_type=%s", type(exc).__name__)
        send_whatsapp_message(
            sender_phone,
            "Sorry, Bmo encountered an issue while generating a response. Please try again in a moment."
        )


# ---------- Flask Routes ----------

@whatsapp_bp.get("/api/whatsapp/webhook")
def verify_webhook():
    """Meta Webhook verification handshake (GET)."""
    mode = request.args.get("hub.mode")
    token = request.args.get("hub.verify_token")
    challenge = request.args.get("hub.challenge")

    expected_verify_token = os.getenv("WHATSAPP_VERIFY_TOKEN", WHATSAPP_VERIFY_TOKEN).strip()
    if not expected_verify_token:
        logger.warning("WhatsApp webhook verification failed: WHATSAPP_VERIFY_TOKEN is not configured.")
        return jsonify({"error": "Webhook verification not configured"}), 503

    if mode == "subscribe" and token and challenge and hmac.compare_digest(token.encode(), expected_verify_token.encode()):
        logger.info("WhatsApp webhook verified successfully!")
        return challenge, 200

    logger.warning("WhatsApp webhook verification failed. Token mismatch or invalid mode.")
    return jsonify({"error": "Verification token mismatch"}), 403


@whatsapp_bp.post("/api/whatsapp/webhook")
def handle_incoming_message():
    """Receives incoming message events from Meta (POST) with HMAC-SHA256 signature verification."""
    if request.content_length and request.content_length > _MAX_WEBHOOK_BYTES:
        return jsonify(error="Webhook payload too large"), 413
    raw_data = request.stream.read(_MAX_WEBHOOK_BYTES + 1)
    if len(raw_data) > _MAX_WEBHOOK_BYTES:
        return jsonify(error="Webhook payload too large"), 413
    sig_header = request.headers.get("X-Hub-Signature-256")
    if not verify_meta_signature(raw_data, sig_header):
        logger.warning("Rejected WhatsApp webhook POST with invalid X-Hub-Signature-256 signature.")
        return jsonify({"error": "Invalid signature"}), 403

    try:
        data = json.loads(raw_data)
    except (ValueError, UnicodeError):
        return jsonify(error="Invalid webhook payload"), 422
    if not isinstance(data, dict) or not isinstance(data.get("entry", []), list):
        return jsonify(error="Invalid webhook payload"), 422
    
    # Meta webhook payloads contain an 'entry' array
    entries = data.get("entry", [])
    if not entries:
        return jsonify({"status": "ignored"}), 200

    processed = 0
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("changes", []), list):
            continue
        for change in entry.get("changes", []):
            if not isinstance(change, dict): continue
            value = change.get("value", {})
            if not isinstance(value, dict): continue
            messages = value.get("messages", [])
            if not isinstance(messages, list): continue

            for msg in messages:
                if not isinstance(msg, dict): continue
                sender_phone = msg.get("from")
                msg_type = msg.get("type")

                if not sender_phone:
                    continue

                if msg_type == "text":
                    text = msg.get("text", {})
                    body = text.get("body") if isinstance(text, dict) else None
                    message_id = msg.get("id")
                    if not isinstance(body, str) or not body.strip() or len(body) > 4096:
                        continue
                    if not isinstance(sender_phone, str) or not re.fullmatch(r"[1-9][0-9]{6,19}", sender_phone):
                        continue
                    if not isinstance(message_id, str) or not 0 < len(message_id) <= 512:
                        continue
                    processed += 1
                    if processed > 20:
                        return jsonify(error="Webhook batch too large"), 422
                    try:
                        outcome = _start_message_job(sender_phone, body.strip(), message_id)
                    except (security_store.SecurityStoreUnavailable, usage_service.MeteringUnavailable):
                        return jsonify(error="WhatsApp processing is unavailable"), 503
                    if outcome == "busy":
                        return jsonify(error="WhatsApp is busy; retry delivery"), 503, {"Retry-After":"3"}
                    logger.info("whatsapp_event outcome=%s", outcome)

    return jsonify({"status": "received"}), 200
