"""Deepgram Flux/Aura streaming text-to-speech bridge for Bmo.

Bridges incoming client WebSockets (authenticated via a single-use ticket) to
Deepgram's streaming text-to-speech API: Flux on /v2/speak and Aura on /v1/speak.

The client streams text chunks into Deepgram over WebSocket as tokens
generate, and Deepgram streams raw 16-bit linear PCM audio frames back
progressively with sub-second latency. The DEEPGRAM_API_KEY is stored
strictly on the server in environment variables and never exposed to the client.
"""

from __future__ import annotations

import json
import logging
import math
import re
import threading
import time
from contextlib import ExitStack
from typing import Optional

from simple_websocket import ConnectionClosed as ClientConnectionClosed
from websockets.exceptions import ConnectionClosed as DgConnectionClosed
from websockets.sync.client import connect

from .config import (
    DEFAULT_DEEPGRAM_TTS_MODEL,
    get_deepgram_api_key,
    get_deepgram_tts_model,
)

from . import usage_service
from .security_store import SecurityStoreUnavailable
from .voice_security import IDLE_SECONDS, SESSION_SECONDS, MAX_FRAME_BYTES, MAX_SPEAK_CHARS, InvalidTicket

logger = logging.getLogger("bmo.deepgram_tts")

def voice_controls(model: str, speed=None, expressivity=None) -> str:
    """Validate documented Flux delivery controls before opening a socket."""
    if speed is None and expressivity is None:
        return ""
    if not model.startswith("flux-"):
        raise ValueError("Expressive delivery requires a Flux TTS voice")
    try:
        rate = float(speed) if speed is not None else 1.0
        expression = float(expressivity) if expressivity is not None else 0
    except (TypeError, ValueError):
        raise ValueError("Invalid voice delivery settings") from None
    if not math.isfinite(rate) or not 0.5 <= rate <= 1.5 or not math.isclose(rate * 20, round(rate * 20), abs_tol=1e-8):
        raise ValueError("Voice speed must be 0.5–1.5 in steps of 0.05")
    if not math.isfinite(expression) or expression not in {-2, -1, 0, 1, 2}:
        raise ValueError("Voice expressivity must be an integer from -2 to 2")
    return f"&speed={rate:g}&expressivity={int(expression)}"


def _command(frame):
    if not isinstance(frame, str) or len(frame) > MAX_FRAME_BYTES:
        raise ValueError("Unsupported voice frame.")
    try:
        if len(frame.encode("utf-8")) > MAX_FRAME_BYTES:
            raise ValueError
        command = json.loads(frame)
    except (ValueError, RecursionError, UnicodeError):
        raise ValueError("Invalid voice command.") from None
    if not isinstance(command, dict):
        raise ValueError("Invalid voice command.")
    kind = command.get("type")
    if kind == "Speak":
        text = command.get("text")
        if set(command) != {"type", "text"} or not isinstance(text, str) or not text.strip() or len(text) > MAX_SPEAK_CHARS:
            raise ValueError("Speak requires 1–4000 text characters.")
    elif kind not in {"Flush", "Clear", "Interrupt", "Close"} or set(command) != {"type"}:
        raise ValueError("Unsupported voice command.")
    return command


def relay_tts_stream(client_ws, *, model: Optional[str] = None, api_key: Optional[str] = None,
                     sample_rate: int = 24000, speed=None, expressivity=None,
                     deadline=None, check_lease=None) -> None:
    """Admit each Speak before opening/forwarding to the paid provider."""
    stop = threading.Event()
    dg_ws, reader = None, None
    started = time.monotonic()
    deadline = min(deadline if deadline is not None else started + SESSION_SECONDS, started + SESSION_SECONDS)
    last_speech = started
    window_start, command_count = started, 0

    def fail(status, message):
        logger.warning("voice_denied status=%s", status)
        try:
            client_ws.send(json.dumps({"type": "Error", "status": status, "message": message}))
        except Exception:
            pass

    def close_sockets():
        stop.set()
        try:
            client_ws.close()
        except Exception:
            pass
        if dg_ws is not None:
            try:
                dg_ws.close()
            except Exception:
                pass

    def expired():
        now = time.monotonic()
        return now >= deadline or now - last_speech >= IDLE_SECONDS

    def watchdog():
        # Also interrupts blocked sends/receives; provider traffic and control
        # spam never renew the meaningful-activity or authorization deadlines.
        while not stop.wait(0.25):
            if expired():
                fail(408, "Voice session expired. Reconnect to continue.")
                close_sockets()
                return

    def from_provider():
        try:
            while not stop.is_set():
                try:
                    msg = dg_ws.recv(timeout=0.5)
                except TimeoutError:
                    continue
                if msg is None: break
                if isinstance(msg, str):
                    try:
                        event = json.loads(msg)
                    except (ValueError, RecursionError):
                        continue
                    if not isinstance(event, dict): continue
                    if event.get("type") == "Error":
                        fail(502, "Speech synthesis failed. Please try again.")
                        break
                client_ws.send(msg)
        except (DgConnectionClosed, ClientConnectionClosed):
            pass
        except Exception as error:
            logger.warning("voice_provider_receive_failed error_type=%s", type(error).__name__)
        finally:
            if not stop.is_set():
                close_sockets()

    monitor = threading.Thread(target=watchdog, name="bmo-voice-deadline", daemon=True)
    monitor.start()
    try:
        key = api_key if api_key is not None else get_deepgram_api_key()
        if not key:
            fail(503, "Voice is currently unavailable.")
            return
        chosen_model = (model or get_deepgram_tts_model() or DEFAULT_DEEPGRAM_TTS_MODEL).strip()
        if not re.fullmatch(r"(?:flux|aura)[A-Za-z0-9_-]{1,59}", chosen_model):
            raise ValueError("Invalid voice model.")
        endpoint = "v2" if chosen_model.startswith("flux-") else "v1"
        controls = voice_controls(chosen_model, speed, expressivity)
        url = f"wss://api.deepgram.com/{endpoint}/speak?model={chosen_model}&encoding=linear16&sample_rate={sample_rate}{controls}"
        with ExitStack() as stack:
            try:
                while not stop.is_set():
                    if expired():
                        fail(408, "Voice session expired. Reconnect to continue.")
                        break
                    frame = client_ws.receive(timeout=0.5)
                    if frame is None: continue
                    if expired():
                        fail(408, "Voice session expired. Reconnect to continue.")
                        break
                    now = time.monotonic()
                    if now - window_start >= 60:
                        window_start, command_count = now, 0
                    command_count += 1
                    if command_count > 240:
                        fail(429, "Too many voice commands. Please reconnect shortly.")
                        break
                    command = _command(frame)
                    kind = command["type"]
                    if kind == "Close": break
                    if kind == "Speak":
                        if check_lease: check_lease()
                        with usage_service.charge("tts", len(command["text"])):
                            if dg_ws is None:
                                dg_ws = stack.enter_context(connect(url, additional_headers={"Authorization": f"Token {key}"},
                                    open_timeout=10, close_timeout=1, max_size=262144, max_queue=4))
                                if stop.is_set() or expired(): break
                                reader = threading.Thread(target=from_provider, name="bmo-voice-reader", daemon=True)
                                reader.start()
                            dg_ws.send(json.dumps(command))
                        last_speech = time.monotonic()
                    elif dg_ws is not None:
                        if kind in {"Clear", "Interrupt"}:
                            command["type"] = "Interrupt" if endpoint == "v2" else "Clear"
                        dg_ws.send(json.dumps(command))
                    elif kind == "Flush":
                        client_ws.send(json.dumps({"type": "Warning", "code": "NO_ACTIVE_SPEECH"}))
            finally:
                stop.set()
                if dg_ws is not None:
                    dg_ws.close()
    except (ClientConnectionClosed, DgConnectionClosed):
        pass
    except (usage_service.QuotaExceeded, usage_service.AdmissionConflict):
        fail(429, "Voice usage allowance reached. Please try again later.")
    except (usage_service.MeteringUnavailable, SecurityStoreUnavailable):
        fail(503, "Voice usage checks are unavailable. Please try again shortly.")
    except InvalidTicket:
        fail(401, "Voice authorization expired. Reconnect to continue.")
    except ValueError as error:
        fail(422, str(error))
    except Exception as error:
        logger.warning("voice_provider_failed error_type=%s", type(error).__name__)
        fail(502, "Speech synthesis failed. Please try again.")
    finally:
        close_sockets()
        if reader: reader.join(timeout=1)
        monitor.join(timeout=1)
