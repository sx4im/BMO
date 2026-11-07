"""Bounded audio input shared by REST and Riva transcription."""
from __future__ import annotations

import io
import math
import wave

MAX_AUDIO_SECONDS = 60
MAX_AUDIO_BYTES = 2 * 1024 * 1024


def canonical_pcm16(data: bytes) -> tuple[bytes, int]:
    """Return only the validated PCM audio and its rounded-up billable seconds.

    First-party clients already produce 16 kHz mono PCM WAV. Compressed audio
    cannot be duration-bounded safely from a filename or claimed MIME type.
    Rebuilding the container prevents extra/unparsed chunks reaching a provider.
    """
    message = "Use 16 kHz mono 16-bit PCM WAV audio, at most 60 seconds."
    if not isinstance(data, bytes) or not data or len(data) > MAX_AUDIO_BYTES:
        raise ValueError(message)
    try:
        with wave.open(io.BytesIO(data), "rb") as source:
            rate, channels, width, frames = source.getframerate(), source.getnchannels(), source.getsampwidth(), source.getnframes()
            if (rate, channels, width, source.getcomptype()) != (16000, 1, 2, "NONE") or not 0 < frames <= rate * MAX_AUDIO_SECONDS:
                raise ValueError(message)
            pcm = source.readframes(frames)
            if len(pcm) != frames * channels * width:
                raise ValueError(message)
        output = io.BytesIO()
        with wave.open(output, "wb") as target:
            target.setnchannels(channels)
            target.setsampwidth(width)
            target.setframerate(rate)
            target.writeframes(pcm)
        return output.getvalue(), math.ceil(frames / rate)
    except (wave.Error, EOFError, OSError) as error:
        raise ValueError(message) from error
