"""Media, image generation, attachment uploads, voice transcription, TTS, and web search routes."""

from __future__ import annotations

import json
import logging
import os
import re
import time

import requests
from flask import Blueprint, Response, jsonify, request
from flask_sock import Sock

from .. import deepgram_tts, image_safety, nvidia_client, riva_transcribe, search_router, store, usage_service, voice_security
from ..auth import require_user
from ..security_store import SecurityStoreUnavailable
from ..audio_limits import MAX_AUDIO_BYTES, canonical_pcm16
from ..config import (
    IMAGE_MODEL_ID,
    SESSION_LIMIT,
    WHISPER_MODEL,
    get_deepgram_api_key,
    get_deepgram_tts_model,
    is_deepgram_configured,
    upload_magic_ok,
    upload_type_allowed,
)
from ..limiter import limiter
from .helpers import bad_request, friendly_error, get_usage_status, human_duration

logger = logging.getLogger("bmo.routes.media")

media_bp = Blueprint("media_routes", __name__)
sock = Sock(media_bp)


def _rest_transcription_provider():
    base = os.getenv("TRANSCRIBE_BASE_URL")
    key = os.getenv("TRANSCRIBE_API_KEY")
    if base and key:
        return base.rstrip("/"), key, WHISPER_MODEL
    groq = os.getenv("GROQ_API_KEY")
    if groq:
        return "https://api.groq.com/openai/v1", groq, "whisper-large-v3"
    openai_key = os.getenv("OPENAI_API_KEY")
    if openai_key:
        return "https://api.openai.com/v1", openai_key, "whisper-1"
    return None, None, None


# ---------- Image Generation (Iris) ----------

@media_bp.post("/images/generate")
@limiter.limit("10 per minute")
@require_user
def generate_image_route(user):
    payload = request.get_json(silent=True) or {}
    prompt = payload.get("prompt")
    conversation_id = payload.get("conversation_id")
    attachments = payload.get("attachments") or []

    if not isinstance(prompt, str) or not prompt.strip():
        return bad_request("prompt is required", 422)
    prompt = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", prompt).strip()
    if not prompt:
        return bad_request("prompt is required", 422)
    if len(prompt) > 2000:
        return bad_request("prompt too long (max 2000 chars)", 422)
    if not isinstance(attachments, list) or not all(isinstance(a, dict) for a in attachments):
        return bad_request("attachments must be a list", 422)
    try:
        store.validate_attachment_paths(attachments, user.id)
    except ValueError as exc:
        return bad_request(str(exc), 403)
    if conversation_id is not None and not isinstance(conversation_id, str):
        return bad_request("conversation_id must be a string", 422)

    usage = get_usage_status(user.id)
    if usage["blocked"]:
        over = usage["session"] if usage["session"]["used"] >= SESSION_LIMIT else usage["weekly"]
        return bad_request(
            "You've reached your usage limit for now. "
            f"Access resets in {human_duration(over['resets_in_seconds'])}.",
            429,
        )

    refusal = image_safety.check_prompt(prompt)

    # Validate ownership before paid work, but leave the recoverable draft
    # untouched until generation succeeds (or produces a local safety refusal).
    convo = store.get_conversation(conversation_id, user.id) if conversation_id else None
    if conversation_id and not convo:
        return bad_request("conversation not found", 404)

    if not refusal:
        try:
            chosen_model = nvidia_client.image_model()
            t_img = time.time()
            png = nvidia_client.generate_image(prompt)
            logger.info(
                "images: generated user=%s model=%s bytes=%d in %.2fs",
                user.id, chosen_model, len(png), time.time() - t_img,
            )
        except (usage_service.MeteringUnavailable, usage_service.QuotaExceeded, usage_service.AdmissionConflict):
            raise
        except Exception as exc:  # noqa: BLE001
            logger.error("generate_image_route_failed error_type=%s", type(exc).__name__)
            return bad_request(f"Image generation failed. {friendly_error(exc)}", 502)

    try:
        if convo:
            if convo.get("model") != IMAGE_MODEL_ID:
                convo = store.update_conversation(
                    conversation_id, user.id, {"model": IMAGE_MODEL_ID}
                ) or convo
        else:
            convo = store.create_conversation(
                user.id, first_message=prompt, model=IMAGE_MODEL_ID
            )
        user_message = store.add_message(
            convo["id"], user.id, role="user", content=prompt,
            attachments=attachments or None,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("generate_image_route_failed error_type=%s", type(exc).__name__)
        return bad_request(f"Could not save conversation. {friendly_error(exc)}", 500)

    if refusal:
        logger.info("images: blocked unsafe prompt user=%s convo=%s", user.id, convo.get("id"))
        assistant_message = store.add_message(
            convo["id"], user.id, role="assistant", content=refusal,
        )
        return jsonify({
            "conversation": store.get_conversation(convo["id"], user.id) or convo,
            "user_message": user_message,
            "assistant_message": assistant_message,
            "blocked": True,
        })

    try:
        slug = re.sub(r"[^a-z0-9]+", "-", prompt.lower()).strip("-")[:40] or "image"
        attachment = store.upload_attachment_for_user(
            user.id,
            filename=f"{slug}.png",
            file_bytes=png,
            content_type="image/png",
            expires_in=7 * 24 * 3600,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("generate_image_route_failed error_type=%s", type(exc).__name__)
        return bad_request(f"Could not save the generated image. {friendly_error(exc)}", 500)

    assistant_message = store.add_message(
        convo["id"], user.id, role="assistant", content="Here's your image.",
        attachments=[attachment],
    )

    return jsonify({
        "conversation": store.get_conversation(convo["id"], user.id) or convo,
        "user_message": user_message,
        "assistant_message": assistant_message,
    })


# ---------- Attachments Upload ----------

@media_bp.post("/attachments")
@limiter.limit("30 per minute")
@require_user
def upload_attachment(user):
    if "file" not in request.files:
        return bad_request("file is required", 422)
    f = request.files["file"]
    if not upload_type_allowed(f.filename or "", f.mimetype or ""):
        return bad_request("unsupported file type", 422)
    data = f.read()
    if not data:
        return bad_request("empty file", 422)
    if len(data) > 50 * 1024 * 1024:
        return bad_request("max attachment size is 50 MB", 413)
    if not upload_magic_ok(data, f.filename or ""):
        return bad_request("file content does not match a supported type", 422)
    try:
        attachment = store.upload_attachment_for_user(
            user.id,
            filename=f.filename or "file",
            file_bytes=data,
            content_type=f.mimetype or "application/octet-stream",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("upload_attachment_failed error_type=%s", type(exc).__name__)
        return bad_request("upload failed", 500)
    return jsonify(attachment)


# ---------- Voice Transcription (Whisper / Riva) ----------

@media_bp.post("/transcribe")
@limiter.limit("20 per minute")
@require_user
def transcribe(user):  # noqa: ARG001
    if "audio" not in request.files:
        return bad_request("audio file is required", 422)
    audio_file = request.files["audio"]
    audio_bytes = audio_file.read(MAX_AUDIO_BYTES + 1)
    if not audio_bytes:
        return bad_request("empty audio file", 422)
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        return bad_request("audio file too large (max 2 MB)", 413)
    try:
        audio_bytes, audio_seconds = canonical_pcm16(audio_bytes)
    except ValueError as error:
        return bad_request(str(error), 422)

    language = (request.form.get("language") or "en").strip() or "en"

    if riva_transcribe.riva_available():
        try:
            with usage_service.charge("transcribe", audio_seconds):
                text = riva_transcribe.transcribe_wav(audio_bytes, language)
            return jsonify({"text": text})
        except (usage_service.MeteringUnavailable, usage_service.QuotaExceeded, usage_service.AdmissionConflict):
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("transcribe_failed error_type=%s", type(exc).__name__)

    base_url, api_key, model = _rest_transcription_provider()
    if not base_url:
        if os.getenv("NVIDIA_API_KEY"):
            return bad_request(
                "Voice transcription via NVIDIA Riva failed. Check server logs or set GROQ_API_KEY.",
                502,
            )
        return bad_request("Server-side voice transcription is not configured.", 503)

    try:
        resp = usage_service.paid_http("transcribe", audio_seconds, requests.post,
            f"{base_url}/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": (audio_file.filename or "recording.wav", audio_bytes, audio_file.content_type or "audio/wav")},
            data={"model": model, "response_format": "json"},
            timeout=60,
        )
    except (usage_service.MeteringUnavailable, usage_service.QuotaExceeded, usage_service.AdmissionConflict):
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("transcribe_failed error_type=%s", type(exc).__name__)
        return bad_request("transcription request failed", 502)

    if not resp.ok:
        return bad_request(f"transcription failed ({resp.status_code})", 502)
    try:
        text = (resp.json().get("text") or "").strip()
    except Exception:
        return bad_request("invalid transcription response", 502)
    return jsonify({"text": text})


def _pcm_to_wav(pcm_bytes: bytes, sample_rate: int = 24000, channels: int = 1) -> bytes:
    """Wrap raw mono 16-bit linear PCM in a standard RIFF/WAVE header."""
    import struct

    byte_rate = sample_rate * channels * 2
    block_align = channels * 2
    data_size = len(pcm_bytes)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        data_size + 36,
        b"WAVE",
        b"fmt ",
        16,
        1,  # PCM format
        channels,
        sample_rate,
        byte_rate,
        block_align,
        16,  # 16 bits per sample
        b"data",
        data_size,
    )
    return header + pcm_bytes


# ---------- Text-to-Speech (Deepgram Flux / Riva) ----------

@media_bp.post("/tts")
@limiter.limit("90 per minute")
@require_user
def tts(user):  # noqa: ARG001
    payload = request.get_json(silent=True) or {}
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        return bad_request("text is required", 422)
    text = text.strip()
    if len(text) > 4000:
        return bad_request("text too long (max 4000 chars)", 422)
    voice = payload.get("voice")
    language = payload.get("language")
    if voice is not None and (not isinstance(voice, str) or not re.match(r"^[a-zA-Z0-9_-]{1,64}$", voice)):
        return bad_request("invalid voice", 422)
    if language is not None and (not isinstance(language, str) or len(language) > 20):
        return bad_request("invalid language", 422)

    if not is_deepgram_configured():
        return bad_request("Text-to-speech is not configured. Set DEEPGRAM_API_KEY.", 503)

    try:
        dg_model = voice or get_deepgram_tts_model()
        endpoint = "v2" if dg_model.startswith("flux") else "v1"
        resp = usage_service.paid_http("tts", len(text), requests.post,
            f"https://api.deepgram.com/{endpoint}/speak?model={dg_model}&encoding=linear16&sample_rate=24000",
            headers={
                "Authorization": f"Token {get_deepgram_api_key()}",
                "Content-Type": "application/json",
            },
            json={"text": text},
            timeout=30,
        )
        if resp.ok and resp.content:
            data = resp.content
            if not data.startswith(b"RIFF"):
                data = _pcm_to_wav(data, 24000)
            return Response(data, mimetype="audio/wav")
        logger.warning("tts_provider_failed status=%s", resp.status_code)
        return bad_request(f"Deepgram TTS synthesis failed ({resp.status_code})", 502)
    except (usage_service.MeteringUnavailable, usage_service.QuotaExceeded, usage_service.AdmissionConflict):
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("tts_failed error_type=%s", type(exc).__name__)
        return bad_request(f"TTS failed: {exc}", 502)


# ---------- Deepgram Flux/Aura Streaming TTS (WebSocket) ----------

@media_bp.post("/tts/ticket")
@limiter.limit("10 per minute")
@require_user
def tts_ticket(user):
    payload = request.get_json(silent=True)
    allowed = {"model", "sample_rate", "speed", "expressivity"}
    if not isinstance(payload, dict) or set(payload) - allowed:
        return bad_request("Invalid voice settings", 422)
    model = payload.get("model", get_deepgram_tts_model())
    rate = payload.get("sample_rate", 24000)
    if not isinstance(model, str) or not re.fullmatch(r"(?:flux|aura)[A-Za-z0-9_-]{1,59}", model):
        return bad_request("Invalid voice model", 422)
    if type(rate) is not int or rate not in {8000, 16000, 24000, 32000, 48000}:
        return bad_request("Invalid voice sample rate", 422)
    try:
        deepgram_tts.voice_controls(model, payload.get("speed"), payload.get("expressivity"))
        settings = {"model": model, "sample_rate": rate, **{k: payload[k] for k in ("speed", "expressivity") if k in payload}}
        expires_at = user.raw["exp"]
        ticket = voice_security.issue_ticket(user.id, settings, expires_at=expires_at)
    except voice_security.InvalidTicket:
        return bad_request("Sign in again to start voice.", 401)
    except ValueError as error:
        return bad_request(str(error), 422)
    return jsonify(ticket=ticket, expires_in=min(voice_security.TICKET_TTL, max(1, int(expires_at - time.time())))), 201


@sock.route("/tts/stream")
def tts_stream(ws):
    lease, owner = None, None
    try:
        if set(request.args) != {"ticket"} or len(request.args.getlist("ticket")) != 1:
            raise voice_security.InvalidTicket("Start voice again to reconnect.")
        payload = voice_security.consume_ticket(request.args["ticket"])
        owner = payload["user_id"]
        started = time.monotonic()
        lease = voice_security.acquire_lease(owner)
        deadline = min(started + voice_security.SESSION_SECONDS, started + max(0, payload["expires_at"] - time.time()))
        with usage_service.scope(owner):
            deepgram_tts.relay_tts_stream(ws, **payload["settings"], deadline=deadline,
                check_lease=lambda: voice_security.check_lease(owner, lease))
    except (voice_security.InvalidTicket, usage_service.QuotaExceeded, SecurityStoreUnavailable) as error:
        status = 401 if isinstance(error, voice_security.InvalidTicket) else 429 if isinstance(error, usage_service.QuotaExceeded) else 503
        try:
            ws.send(json.dumps({"type": "Error", "status": status, "message": str(error)}))
            ws.close(4000 + status, "Voice unavailable")
        except Exception:
            pass
    finally:
        if owner and lease:
            voice_security.release_lease(owner, lease)


# ---------- Web Search (TinyFish) ----------

@media_bp.post("/search")
@limiter.limit("20 per minute")
@require_user
def search(user):  # noqa: ARG001
    payload = request.get_json(silent=True) or {}
    query = payload.get("query")
    if not isinstance(query, str) or not query.strip():
        return bad_request("query is required", 422)
    if not os.environ.get("TINYFISH_API_KEY"):
        return bad_request("web search is not configured", 503)

    q = query.strip()
    try:
        results = search_router.fetch_results(q, timeout=12)
    except (requests.RequestException, ValueError) as exc:
        logger.warning("search_failed error_type=%s", type(exc).__name__)
        return bad_request("web search failed", 502)
    return jsonify({"answer": "", "results": results, "live": search_router.is_live_query(q)})


# ---------- Web Scraping (TinyFish Fetch) ----------

@media_bp.post("/scrape")
@limiter.limit("20 per minute")
@require_user
def scrape(user):  # noqa: ARG001
    payload = request.get_json(silent=True) or {}
    url = payload.get("url")
    if not isinstance(url, str) or not url.strip():
        return bad_request("url is required", 422)
    api_key = os.environ.get("TINYFISH_API_KEY")
    if not api_key:
        return bad_request("web scraping is not configured", 503)

    target_url = url.strip()
    if not re.match(r"^https?://", target_url, re.IGNORECASE):
        target_url = "https://" + target_url

    try:
        resp = usage_service.paid_http("scrape", 1, requests.post,
            "https://api.fetch.tinyfish.ai",
            json={"urls": [target_url], "format": "markdown"},
            headers={"X-API-Key": api_key, "Content-Type": "application/json"},
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as exc:
        logger.warning("scrape_failed error_type=%s", type(exc).__name__)
        return bad_request("web scraping failed", 502)

    results = data.get("results") or []
    if not results:
        return bad_request("web scraping failed", 502)

    item = results[0]
    markdown = item.get("text") or ""
    title = item.get("title") or ""
    description = item.get("description") or ""
    final_url = item.get("final_url") or item.get("url") or target_url

    return jsonify({
        "success": True,
        "markdown": markdown,
        "title": title,
        "description": description,
        "url": final_url,
    })
