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

from .. import deepgram_tts, image_safety, nvidia_client, riva_transcribe, riva_tts, search_router, store
from ..auth import require_user, user_from_token
from ..config import (
    IMAGE_MODEL_ID,
    IMAGE_USAGE_TOKENS,
    WHISPER_MODEL,
    get_deepgram_api_key,
    get_deepgram_tts_model,
    is_deepgram_configured,
    upload_magic_ok,
    upload_type_allowed,
)
from ..limiter import limiter
from .helpers import bad_request, friendly_error

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
    if conversation_id is not None and not isinstance(conversation_id, str):
        return bad_request("conversation_id must be a string", 422)

    refusal = image_safety.check_prompt(prompt)

    try:
        if conversation_id:
            convo = store.get_conversation(conversation_id, user.id)
            if not convo:
                return bad_request("conversation not found", 404)
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
        logger.exception("images: persistence failed for user=%s: %s", user.id, exc)
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
        chosen_model = nvidia_client.image_model()
        t_img = time.time()
        png = nvidia_client.generate_image(prompt, model=chosen_model)
        logger.info(
            "images: generated user=%s convo=%s model=%s bytes=%d in %.2fs",
            user.id, convo.get("id"), chosen_model, len(png), time.time() - t_img,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("images: generation failed user=%s: %s", user.id, exc)
        return bad_request(f"Image generation failed. {friendly_error(exc)}", 502)

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
        logger.exception("images: could not store generated image user=%s: %s", user.id, exc)
        return bad_request(f"Could not save the generated image. {friendly_error(exc)}", 500)

    assistant_message = store.add_message(
        convo["id"], user.id, role="assistant", content="Here's your image.",
        attachments=[attachment],
    )
    try:
        store.record_usage(user.id, "image", IMAGE_USAGE_TOKENS)
    except Exception:
        logger.exception("images: usage recording failed user=%s", user.id)

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
    if not upload_magic_ok(data):
        return bad_request("file content does not match a supported type", 422)
    try:
        attachment = store.upload_attachment_for_user(
            user.id,
            filename=f.filename or "file",
            file_bytes=data,
            content_type=f.mimetype or "application/octet-stream",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("attachment upload failed: %s", exc)
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
    audio_bytes = audio_file.read()
    if not audio_bytes:
        return bad_request("empty audio file", 422)
    if len(audio_bytes) > 25 * 1024 * 1024:
        return bad_request("audio file too large (max 25 MB)", 413)
    _audio_ok = (
        (audio_bytes[:4] == b"RIFF" and audio_bytes[8:12] == b"WAVE")
        or audio_bytes[:4] == b"\x1aE\xdf\xa3"
        or audio_bytes[:4] == b"OggS"
        or audio_bytes[:3] == b"ID3"
        or audio_bytes[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")
        or audio_bytes[4:8] == b"ftyp"
    )
    if not _audio_ok:
        return bad_request("unsupported audio format", 422)

    language = (request.form.get("language") or "en").strip() or "en"

    if riva_transcribe.riva_available():
        try:
            text = riva_transcribe.transcribe_wav(audio_bytes, language)
            return jsonify({"text": text})
        except Exception as exc:  # noqa: BLE001
            logger.warning("Riva transcription failed, trying REST fallback: %s", exc)

    base_url, api_key, model = _rest_transcription_provider()
    if not base_url:
        if os.getenv("NVIDIA_API_KEY"):
            return bad_request(
                "Voice transcription via NVIDIA Riva failed. Check server logs or set GROQ_API_KEY.",
                502,
            )
        return bad_request("Server-side voice transcription is not configured.", 503)

    try:
        resp = requests.post(
            f"{base_url}/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": (audio_file.filename or "recording.wav", audio_bytes, audio_file.content_type or "audio/wav")},
            data={"model": model, "response_format": "json"},
            timeout=60,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("transcription request failed: %s", exc)
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
    if voice is not None and (not isinstance(voice, str) or len(voice) > 80):
        return bad_request("invalid voice", 422)
    if language is not None and (not isinstance(language, str) or len(language) > 20):
        return bad_request("invalid language", 422)

    # Prioritize Deepgram (Flux Hannah)
    if is_deepgram_configured():
        try:
            dg_model = voice or get_deepgram_tts_model()
            endpoint = "v2" if dg_model.startswith("flux") else "v1"
            resp = requests.post(
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
            logger.warning("Deepgram REST TTS returned status %s: %s", resp.status_code, resp.text)
        except Exception as exc:
            logger.warning("Deepgram REST TTS failed: %s", exc)

    # Fallback to NVIDIA Riva if available
    if riva_tts.tts_available():
        try:
            wav = riva_tts.synthesize_wav(text, voice=voice, language=language)
            return Response(wav, mimetype="audio/wav")
        except Exception as exc:  # noqa: BLE001
            logger.warning("Riva TTS failed: %s", exc)
            return bad_request(f"TTS failed: {exc}", 502)

    return bad_request(
        "Text-to-speech is not configured. Set DEEPGRAM_API_KEY or configure NVIDIA Riva.",
        503,
    )


# ---------- Deepgram Aura-1 Streaming TTS (WebSocket) ----------

@sock.route("/tts/stream")
def tts_stream(ws):
    token = request.args.get("token")
    user = user_from_token(token)
    if not user:
        try:
            ws.send(json.dumps({"type": "Error", "message": "Authentication required"}))
            ws.close(4401, "Unauthorized")
        except Exception:
            pass
        return

    model = request.args.get("model")
    raw_rate = request.args.get("sample_rate")
    try:
        sample_rate = int(raw_rate) if raw_rate else 24000
    except (ValueError, TypeError):
        sample_rate = 24000

    deepgram_tts.relay_tts_stream(ws, model=model, sample_rate=sample_rate)


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
        logger.warning("search: TinyFish request failed: %s", exc)
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
        resp = requests.post(
            "https://api.fetch.tinyfish.ai",
            json={"urls": [target_url], "format": "markdown"},
            headers={"X-API-Key": api_key, "Content-Type": "application/json"},
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as exc:
        logger.warning("scrape: TinyFish request failed: %s", exc)
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
