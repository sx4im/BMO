"""Unit and integration tests for Deepgram Aura-1 streaming text-to-speech."""

from __future__ import annotations

import json
import time
from unittest.mock import MagicMock, patch

import jwt
import pytest
from simple_websocket import ConnectionClosed as ClientConnectionClosed
from websockets.exceptions import ConnectionClosed as DgConnectionClosed

from app import config, deepgram_tts


def test_deepgram_config(monkeypatch):
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    monkeypatch.delenv("DEEPGRAM_TTS_MODEL", raising=False)
    assert not config.is_deepgram_configured()
    assert config.get_deepgram_api_key() == ""
    assert config.get_deepgram_tts_model() == "flux-hannah-en"

    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-deepgram-key")
    monkeypatch.setenv("DEEPGRAM_TTS_MODEL", "flux-hannah-en")
    assert config.is_deepgram_configured()
    assert config.get_deepgram_api_key() == "test-deepgram-key"
    assert config.get_deepgram_tts_model() == "flux-hannah-en"


def test_relay_tts_stream_unconfigured():
    mock_ws = MagicMock()
    deepgram_tts.relay_tts_stream(mock_ws, api_key="")
    mock_ws.send.assert_called_once()
    sent_data = json.loads(mock_ws.send.call_args[0][0])
    assert sent_data["type"] == "Error"
    mock_ws.close.assert_called_once()


def test_relay_tts_stream_bidirectional():
    mock_ws = MagicMock()
    mock_ws.receive.side_effect = [
        json.dumps({"type": "Speak", "text": "Hello world"}),
        json.dumps({"type": "Flush"}),
        ClientConnectionClosed(),
    ]

    mock_dg_ws = MagicMock()

    def dg_recv_generator():
        yield b"\x00\x01\x02\x03"
        time.sleep(0.05)
        yield json.dumps({"type": "Flushed"})
        time.sleep(0.05)
        raise DgConnectionClosed(None, None)

    mock_dg_ws.recv.side_effect = dg_recv_generator()

    with patch("app.deepgram_tts.connect") as mock_connect:
        mock_connect.return_value.__enter__.return_value = mock_dg_ws
        deepgram_tts.relay_tts_stream(
            mock_ws,
            model="aura-asteria-en",
            api_key="dg-secret-key",
            sample_rate=24000,
        )

        mock_connect.assert_called_once()
        assert "aura-asteria-en" in mock_connect.call_args[0][0]
        assert mock_connect.call_args[1]["additional_headers"]["Authorization"] == "Token dg-secret-key"

        # Check client sent messages to Deepgram
        sent_to_dg = [call[0][0] for call in mock_dg_ws.send.call_args_list]
        assert any("Speak" in s for s in sent_to_dg)
        assert any("Flush" in s for s in sent_to_dg)

        # Check Deepgram audio and events sent to client
        sent_to_client = [call[0][0] for call in mock_ws.send.call_args_list]
        assert b"\x00\x01\x02\x03" in sent_to_client
        assert any("Flushed" in str(s) for s in sent_to_client)


def test_relay_tts_stream_flux():
    mock_ws = MagicMock()
    mock_ws.receive.side_effect = [
        json.dumps({"type": "Speak", "text": "Hello Flux"}),
        json.dumps({"type": "Clear"}),
        ClientConnectionClosed(),
    ]

    mock_dg_ws = MagicMock()

    def dg_recv_generator():
        yield b"\xaa\xbb"
        time.sleep(0.05)
        yield json.dumps({"type": "Flushed"})
        time.sleep(0.05)
        raise DgConnectionClosed(None, None)

    mock_dg_ws.recv.side_effect = dg_recv_generator()

    with patch("app.deepgram_tts.connect") as mock_connect:
        mock_connect.return_value.__enter__.return_value = mock_dg_ws
        deepgram_tts.relay_tts_stream(
            mock_ws,
            model="flux-hannah-en",
            api_key="dg-secret-key",
            sample_rate=24000,
        )

        mock_connect.assert_called_once()
        assert "v2/speak" in mock_connect.call_args[0][0]
        assert "flux-hannah-en" in mock_connect.call_args[0][0]

        sent_to_dg = [call[0][0] for call in mock_dg_ws.send.call_args_list]
        assert any("Speak" in s for s in sent_to_dg)
        assert any("Interrupt" in s for s in sent_to_dg)


def test_rest_tts_fallback_to_deepgram(client, monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "dg-test-key")
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)

    token = jwt.encode(
        {"sub": "usr_123", "exp": 9999999999, "aud": "authenticated", "iss": "https://example.supabase.co/auth/v1"},
        "test-jwt-secret",
        algorithm="HS256",
    )

    with patch("app.routes.media_routes.riva_tts.tts_available", return_value=False):
        with patch("app.routes.media_routes.requests.post") as mock_post:
            mock_post.return_value.ok = True
            mock_post.return_value.content = b"RIFFmockwavcontent"

            res = client.post(
                "/tts",
                headers={"Authorization": f"Bearer {token}"},
                json={"text": "Hello fallback"},
            )
            assert res.status_code == 200
            assert res.data == b"RIFFmockwavcontent"
            assert mock_post.called
            assert "deepgram.com" in mock_post.call_args[0][0]
