"""WhatsApp Cloud API integration for BMO.

Provides Webhook endpoints for Meta WhatsApp Cloud API to allow users to chat
directly with BMO (Stanza 2.5 model) over WhatsApp.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import threading
import requests
from flask import Blueprint, jsonify, request
from typing import Optional

from openai import OpenAI

from . import nvidia_client
from .config import DEFAULT_GROQ_BASE_URL, get_aeon_model, get_stanza_model
from .limiter import limiter
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
# Comma-separated E.164 numbers allowed to chat with the bot over WhatsApp.
# Empty = deny all incoming messages (fail closed; see _sender_allowed).
# Max inbound messages per sender per rolling 24h window.
WHATSAPP_DAILY_LIMIT = int(os.getenv("WHATSAPP_DAILY_LIMIT", "100") or 100)

_logged_whatsapp_config_warning = False


def _sender_log_id(phone: str) -> str:
    """Stable, non-reversible identifier for logs — never log raw phone numbers."""
    return hashlib.sha256(phone.encode("utf-8")).hexdigest()[:12]


def _normalize_phone(phone: str) -> str:
    return re.sub(r"[^\d]", "", phone or "")


def _whatsapp_allowlist() -> set[str]:
    # Re-read at request time so tests (and config reloads) can monkeypatch the env.
    return {
        re.sub(r"[^\d]", "", n)
        for n in os.getenv("WHATSAPP_ALLOWED_NUMBERS", "").split(",")
        if re.sub(r"[^\d]", "", n)
    }


def _sender_allowed(sender_phone: str) -> bool:
    """True only if the normalized sender is on the allowlist. Fail closed."""
    normalized = _normalize_phone(sender_phone)
    if not normalized:
        return False
    return normalized in _whatsapp_allowlist()


def _warn_allowlist_unset() -> None:
    global _logged_whatsapp_config_warning
    if _logged_whatsapp_config_warning:
        return
    _logged_whatsapp_config_warning = True
    logger.error(
        "WHATSAPP_ALLOWED_NUMBERS is not set — rejecting all incoming WhatsApp "
        "messages. Set it to a comma-separated list of E.164 numbers."
    )


def _sender_message_count_24h(phone: str) -> int:
    """Count inbound turns from a sender in the last 24h (usage metering)."""
    cutoff = time.time() - _HISTORY_TTL_SECONDS
    with _db_lock:
        try:
            conn = sqlite3.connect(_DB_PATH, timeout=10.0)
            cursor = conn.cursor()
            cursor.execute(
                "SELECT COUNT(*) FROM whatsapp_messages "
                "WHERE phone = ? AND role = 'user' AND created_at >= ?",
                (phone, cutoff),
            )
            row = cursor.fetchone()
            conn.close()
            return int(row[0]) if row else 0
        except Exception as exc:
            logger.warning("Error counting WhatsApp usage for %s: %s", _sender_log_id(phone), exc)
            return 0


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
            conn = sqlite3.connect(_DB_PATH, timeout=10.0)
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
            conn.commit()
            conn.close()
            if os.path.exists(_DB_PATH):
                try:
                    os.chmod(_DB_PATH, 0o600)
                except Exception:
                    pass
        except Exception as exc:
            logger.exception("Failed to initialize WhatsApp SQLite database: %s", exc)


_init_whatsapp_db()


def _get_phone_history(phone: str) -> list[dict]:
    """Retrieve recent conversation history for a phone number across all worker processes."""
    cutoff = time.time() - _HISTORY_TTL_SECONDS
    with _db_lock:
        try:
            conn = sqlite3.connect(_DB_PATH, timeout=10.0)
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT role, content FROM whatsapp_messages
                WHERE phone = ? AND created_at >= ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (phone, cutoff, _MAX_HISTORY_TURNS),
            )
            rows = cursor.fetchall()
            conn.close()
            # Reverse so it's in chronological order
            return [{"role": r[0], "content": r[1]} for r in reversed(rows)]
        except Exception as exc:
            logger.warning("Error reading WhatsApp history for %s: %s", _sender_log_id(phone), exc)
            return []


def _append_phone_history(phone: str, role: str, content: str) -> None:
    """Store a message turn in SQLite, immediately visible to all gunicorn workers."""
    if not content:
        return
    now = time.time()
    with _db_lock:
        try:
            conn = sqlite3.connect(_DB_PATH, timeout=10.0)
            conn.execute(
                "INSERT INTO whatsapp_messages (phone, role, content, created_at) VALUES (?, ?, ?, ?)",
                (phone, role, content, now),
            )
            # Prune ancient messages for this phone to prevent unbounded growth
            conn.execute(
                "DELETE FROM whatsapp_messages WHERE phone = ? AND created_at < ?",
                (phone, now - _HISTORY_TTL_SECONDS * 2),
            )
            conn.commit()
            conn.close()
        except Exception as exc:
            logger.warning("Error saving WhatsApp message for %s: %s", _sender_log_id(phone), exc)


def _clear_phone_history(phone: str) -> None:
    """Reset conversation context for a phone number."""
    with _db_lock:
        try:
            conn = sqlite3.connect(_DB_PATH, timeout=10.0)
            conn.execute("DELETE FROM whatsapp_messages WHERE phone = ?", (phone,))
            conn.commit()
            conn.close()
        except Exception as exc:
            logger.warning("Error clearing WhatsApp history for %s: %s", _sender_log_id(phone), exc)


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
    if not signature_header or not signature_header.startswith("sha256="):
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
        logger.error("Invalid recipient phone number: %s", _sender_log_id(to_phone))
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
                logger.error("WhatsApp API error (%d) for %s: %s", resp.status_code, _sender_log_id(clean_phone), resp.text)
                success = False
            else:
                logger.info("Successfully sent WhatsApp reply to %s", _sender_log_id(clean_phone))
        except Exception as exc:
            logger.exception("Failed to send WhatsApp message to %s: %s", _sender_log_id(clean_phone), exc)
            success = False
    return success


def _generate_groq_reply(model_id: str, messages: list[dict], groq_key: str) -> str:
    """Generate a chat completion using Groq's low-latency API."""
    base_url = os.getenv("GROQ_BASE_URL", DEFAULT_GROQ_BASE_URL).strip()
    client = OpenAI(api_key=groq_key, base_url=base_url, timeout=20.0)
    resp = client.chat.completions.create(
        model=model_id,
        messages=messages,
        max_tokens=400,
        temperature=0.7,
    )
    if resp.choices and resp.choices[0].message:
        return resp.choices[0].message.content or ""
    return ""


def _process_and_reply_async(sender_phone: str, user_prompt: str) -> None:
    """Worker function running in a background thread to process the AI model response."""
    try:
        model_id = get_aeon_model()
        prior_turns = _get_phone_history(sender_phone)
        messages = [{"role": "system", "content": WHATSAPP_SYSTEM_PROMPT}]
        messages.extend(prior_turns)
        messages.append({"role": "user", "content": user_prompt})

        logger.info(
            "Processing WhatsApp query for %s using Aeon model (%s, context_turns=%d, prompt_chars=%d)",
            _sender_log_id(sender_phone), model_id, len(prior_turns), len(user_prompt),
        )

        raw_reply = ""
        groq_key = os.getenv("GROQ_API_KEY", "").strip()
        if groq_key:
            try:
                logger.info("Executing Groq chat completion for WhatsApp (%s)", model_id)
                raw_reply = _generate_groq_reply(model_id, messages, groq_key)
                if raw_reply:
                    logger.info("Successfully generated reply via Groq (%d chars)", len(raw_reply))
            except Exception as exc:
                logger.warning("Groq inference failed for WhatsApp (%s), falling back to NVIDIA: %s", model_id, exc)
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
    except Exception as exc:
        logger.exception("Error processing WhatsApp message for %s: %s", _sender_log_id(sender_phone), exc)
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
        return jsonify({"error": "Verification token mismatch"}), 403

    if mode == "subscribe" and token and token == expected_verify_token:
        logger.info("WhatsApp webhook verified successfully!")
        return challenge, 200

    logger.warning("WhatsApp webhook verification failed. Token mismatch or invalid mode.")
    return jsonify({"error": "Verification token mismatch"}), 403


@whatsapp_bp.post("/api/whatsapp/webhook")
@limiter.limit("30 per minute")
def handle_incoming_message():
    """Receives incoming message events from Meta (POST) with HMAC-SHA256 signature verification."""
    raw_data = request.get_data()
    sig_header = request.headers.get("X-Hub-Signature-256")
    if not verify_meta_signature(raw_data, sig_header):
        logger.warning("Rejected WhatsApp webhook POST with invalid X-Hub-Signature-256 signature.")
        return jsonify({"error": "Invalid signature"}), 403

    data = request.get_json(silent=True) or {}

    # Meta webhook payloads contain an 'entry' array
    entries = data.get("entry", [])
    if not entries:
        return jsonify({"status": "ignored"}), 200

    for entry in entries:
        for change in entry.get("changes", []):
            value = change.get("value", {})
            messages = value.get("messages", [])

            for msg in messages:
                sender_phone = msg.get("from")
                msg_type = msg.get("type")

                if not sender_phone:
                    continue

                # Sender allowlist: reject anyone not explicitly configured.
                if not _sender_allowed(sender_phone):
                    _warn_allowlist_unset()
                    logger.warning(
                        "Rejected WhatsApp message from unauthorized sender %s",
                        _sender_log_id(sender_phone),
                    )
                    continue

                # Simple per-sender usage cap (rolling 24h).
                if _sender_message_count_24h(sender_phone) >= WHATSAPP_DAILY_LIMIT:
                    logger.warning(
                        "WhatsApp usage cap reached for %s (%d/24h)",
                        _sender_log_id(sender_phone), WHATSAPP_DAILY_LIMIT,
                    )
                    continue

                if msg_type == "text":
                    body = msg.get("text", {}).get("body", "").strip()
                    if body:
                        # Allow user to reset context on demand via command
                        if body.lower() in {"/reset", "/new", "reset", "clear", "/clear"}:
                            _clear_phone_history(sender_phone)
                            send_whatsapp_message(sender_phone, "Conversation context reset. What would you like to discuss?")
                            continue

                        logger.info(
                            "Received WhatsApp message from %s (chars=%d)",
                            _sender_log_id(sender_phone), len(body),
                        )
                        # Spawn background thread so Webhook responds 200 OK immediately to Meta
                        threading.Thread(
                            target=_process_and_reply_async,
                            args=(sender_phone, body),
                            daemon=True,
                        ).start()

    return jsonify({"status": "received"}), 200
