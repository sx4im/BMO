"""Deepgram Aura-1 streaming text-to-speech bridge for BMO.

Bridges incoming client WebSockets (authenticated via Supabase JWT) to
Deepgram's real-time Aura-1 streaming text-to-speech WebSocket API
(wss://api.deepgram.com/v1/speak).

The client streams text chunks into Deepgram over WebSocket as tokens
generate, and Deepgram streams raw 16-bit linear PCM audio frames back
progressively with sub-second latency. The DEEPGRAM_API_KEY is stored
strictly on the server in environment variables and never exposed to the client.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Optional

from simple_websocket import ConnectionClosed as ClientConnectionClosed
from websockets.exceptions import ConnectionClosed as DgConnectionClosed
from websockets.sync.client import connect

from .config import (
    DEFAULT_DEEPGRAM_TTS_MODEL,
    get_deepgram_api_key,
    get_deepgram_tts_model,
)

logger = logging.getLogger("bmo.deepgram_tts")


def relay_tts_stream(
    client_ws,
    *,
    model: Optional[str] = None,
    api_key: Optional[str] = None,
    sample_rate: int = 24000,
) -> None:
    """Relay streaming text-to-speech between client WebSocket and Deepgram.

    Bidirectional relay:
      - Client -> Deepgram: JSON text commands (Speak, Flush, Clear, Close)
      - Deepgram -> Client: binary frames (linear16 PCM audio), JSON messages
    """
    key = api_key or get_deepgram_api_key()
    if not key:
        err_msg = json.dumps({"type": "Error", "message": "Deepgram API key not configured"})
        try:
            client_ws.send(err_msg)
            client_ws.close(4503, "Deepgram not configured")
        except Exception:
            pass
        return

    chosen_model = (model or get_deepgram_tts_model() or DEFAULT_DEEPGRAM_TTS_MODEL).strip()
    endpoint = "v2" if chosen_model.startswith("flux") else "v1"
    dg_url = (
        f"wss://api.deepgram.com/{endpoint}/speak?model={chosen_model}&encoding=linear16&sample_rate={sample_rate}"
    )
    headers = {"Authorization": f"Token {key}"}

    stop_event = threading.Event()

    try:
        with connect(dg_url, additional_headers=headers, open_timeout=10) as dg_ws:
            logger.info("Connected to Deepgram streaming TTS endpoint=%s model=%s", endpoint, chosen_model)

            def from_deepgram_loop():
                try:
                    while not stop_event.is_set():
                        try:
                            msg = dg_ws.recv(timeout=0.5)
                        except TimeoutError:
                            continue
                        if msg is None:
                            break
                        client_ws.send(msg)
                except (DgConnectionClosed, ClientConnectionClosed):
                    pass
                except Exception as exc:
                    logger.warning("Deepgram receive loop exited: %s", exc)
                finally:
                    stop_event.set()

            reader_thread = threading.Thread(
                target=from_deepgram_loop,
                name="bmo-deepgram-tts-reader",
                daemon=True,
            )
            reader_thread.start()

            while not stop_event.is_set():
                try:
                    client_msg = client_ws.receive(timeout=0.5)
                except ClientConnectionClosed:
                    break
                except Exception as exc:
                    logger.warning("Client WS receive error: %s", exc)
                    break

                if client_msg is None:
                    continue

                try:
                    if isinstance(client_msg, str):
                        try:
                            parsed = json.loads(client_msg)
                            if isinstance(parsed, dict):
                                m_type = parsed.get("type")
                                if m_type == "Clear" and chosen_model.startswith("flux"):
                                    client_msg = json.dumps({"type": "Interrupt"})
                                elif m_type == "Interrupt" and not chosen_model.startswith("flux"):
                                    client_msg = json.dumps({"type": "Clear"})
                        except Exception:
                            pass
                    dg_ws.send(client_msg)
                except DgConnectionClosed:
                    break
                except Exception as exc:
                    logger.warning("Error forwarding to Deepgram: %s", exc)
                    break

            stop_event.set()
            reader_thread.join(timeout=2.0)
    except DgConnectionClosed as exc:
        logger.warning("Deepgram streaming connection closed: %s", exc)
    except Exception as exc:
        err_detail = str(exc)
        if hasattr(exc, "response"):
            resp = getattr(exc, "response", None)
            if resp:
                body = getattr(resp, "body", b"")
                err_detail = f"status={getattr(resp, 'status_code', '?')}, body={body.decode('utf-8', errors='ignore') if isinstance(body, (bytes, bytearray)) else body}"
        logger.warning("Failed to connect to Deepgram streaming TTS (%s): %s", chosen_model, err_detail)
        try:
            client_ws.send(json.dumps({"type": "Error", "message": f"Deepgram connection failed: {err_detail}"}))
        except Exception:
            pass
    finally:
        stop_event.set()
        try:
            client_ws.close()
        except Exception:
            pass
        logger.info("Deepgram TTS relay ended for model=%s", chosen_model)
