"""NVIDIA Riva speech-to-text (parakeet-ctc-0.6b-asr) over gRPC.

Parakeet is served through Riva ASR over gRPC at ``grpc.nvcf.nvidia.com:443``
with a per-model ``function-id``. This module wraps the official
``nvidia-riva-client`` so the rest of the app can transcribe a WAV blob with
one call. It's faster than whisper-large-v3 with SOTA English accuracy.

The audio sent from the browser is normalised to 16 kHz mono 16-bit PCM WAV
(see frontend), which is exactly what Riva's offline recognize expects.
"""

from __future__ import annotations

import io
import logging
import os
import wave
from .audio_limits import canonical_pcm16

logger = logging.getLogger("bmo.riva")

# Public function-id for nvidia/parakeet-ctc-0.6b-asr on build.nvidia.com.
# (whisper-large-v3 was b702f636-f60c-4a3d-a6f4-f3568c13bd7d.) Overridable in
# case NVIDIA rotates it or you pin a different ASR model.
RIVA_ASR_FUNCTION_ID = os.getenv(
    "RIVA_FUNCTION_ID", "d8dd4e9b-fbf5-4fb0-9dba-8cf436c8d965"
)
RIVA_SERVER = os.getenv("RIVA_SERVER", "grpc.nvcf.nvidia.com:443")


def riva_available() -> bool:
    """True when an NVIDIA key is present and the riva client import works."""
    if not os.getenv("NVIDIA_API_KEY"):
        return False
    try:
        import riva.client  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return True


def transcribe_wav(wav_bytes: bytes, language_code: str = "en") -> str:
    """Transcribe 16 kHz mono 16-bit PCM WAV bytes via Riva gRPC.

    Raises RuntimeError with a readable message on any failure so the caller
    can surface it to the client.
    """
    api_key = os.getenv("NVIDIA_API_KEY")
    if not api_key:
        raise RuntimeError("NVIDIA_API_KEY is not set")

    try:
        import riva.client
        from riva.client.asr import streaming_request_generator
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"nvidia-riva-client not installed: {exc}") from exc

    # Parse the WAV to extract raw PCM + its real sample rate, so we configure
    # Riva precisely instead of letting header bytes leak into the audio.
    try:
        wav_bytes, _ = canonical_pcm16(wav_bytes)
        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            sample_rate = wf.getframerate()
            channels = wf.getnchannels()
            pcm = wf.readframes(wf.getnframes())
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"invalid WAV audio: {exc}") from exc

    # parakeet expects a full locale ("en-US"); the browser sends a bare "en".
    lang = (language_code or "en").strip() or "en"
    if lang.lower() == "en":
        lang = "en-US"

    # NVCF requires the function-id + bearer token as gRPC metadata.
    metadata = [
        ["function-id", RIVA_ASR_FUNCTION_ID],
        ["authorization", f"Bearer {api_key}"],
    ]

    auth = None
    responses = None
    try:
        auth = riva.client.Auth(
            None,  # no SSL cert path — use system roots
            True,  # use_ssl
            RIVA_SERVER,
            metadata,
        )
        asr_service = riva.client.ASRService(auth)

        config = riva.client.RecognitionConfig(
            encoding=riva.client.AudioEncoding.LINEAR_PCM,
            sample_rate_hertz=sample_rate,
            audio_channel_count=channels,
            language_code=lang,
            max_alternatives=1,
            enable_automatic_punctuation=True,
        )

        # parakeet-ctc-0.6b on NVCF serves STREAMING recognition only —
        # offline_recognize() fails with INVALID_ARGUMENT "Unavailable model
        # requested ... type=offline". Feed the PCM through the streaming API
        # in ~100 ms chunks and keep the final segments. (whisper-large-v3's
        # function-id also accepts streaming, so this works if that's pinned.)
        streaming_config = riva.client.StreamingRecognitionConfig(
            config=config, interim_results=False,
        )
        chunk = max(1, sample_rate * 2 // 10)  # 100 ms of 16-bit mono PCM

        def _chunks():
            for i in range(0, len(pcm), chunk):
                yield pcm[i:i + chunk]

        # The SDK's convenience generator omits gRPC's deadline parameter.
        # Its public request generator + generated stub retain that bound.
        responses = asr_service.stub.StreamingRecognize(
            streaming_request_generator(_chunks(), streaming_config),
            metadata=auth.get_auth_metadata(), timeout=65,
        )
        parts: list[str] = []
        for resp in responses:
            for result in resp.results:
                if result.is_final and result.alternatives:
                    parts.append(result.alternatives[0].transcript)
    except Exception as exc:  # noqa: BLE001
        logger.warning("riva_transcription_failed error_type=%s", type(exc).__name__)
        raise RuntimeError("Riva transcription failed. Please try again.") from exc
    finally:
        if responses is not None:
            try:
                responses.cancel()
            except Exception as error:
                logger.warning("riva_rpc_cleanup_failed error_type=%s", type(error).__name__)
        if auth is not None:
            try:
                auth.channel.close()
            except Exception as error:
                logger.warning("riva_channel_cleanup_failed error_type=%s", type(error).__name__)

    return " ".join(p.strip() for p in parts if p).strip()
