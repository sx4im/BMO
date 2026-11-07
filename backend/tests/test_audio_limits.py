"""Duration and canonicalization are verified before paid transcription."""
import io
import wave

import pytest

from app.audio_limits import canonical_pcm16


def wav(seconds=1, *, channels=1, width=2, rate=16000):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(width)
        output.setframerate(rate)
        output.writeframes(b"\0" * int(seconds * rate * channels * width))
    return buffer.getvalue()


def test_canonical_audio_bills_actual_duration_and_discards_unparsed_trailing_data():
    original = wav(1.25)
    canonical, seconds = canonical_pcm16(original + b"unparsed trailing data")
    assert canonical == original
    assert seconds == 2


@pytest.mark.parametrize("data", [b"", b"OggSfixture", b"\x1aE\xdf\xa3fixture", wav(61), wav(0),
    wav(channels=2), wav(width=1), wav(rate=8000), wav()[:-1], b"x" * (2 * 1024 * 1024 + 1)])
def test_unverifiable_or_over_budget_audio_is_rejected(data):
    with pytest.raises(ValueError):
        canonical_pcm16(data)


def test_duration_boundary_accepts_exactly_sixty_seconds():
    canonical, seconds = canonical_pcm16(wav(60))
    assert seconds == 60
    assert len(canonical) == 60 * 16000 * 2 + 44


def test_riva_uses_a_deadline_and_releases_its_rpc_and_channel(monkeypatch):
    from types import SimpleNamespace
    import riva.client
    from app import riva_transcribe
    monkeypatch.setenv("NVIDIA_API_KEY", "fixture-only")
    calls, released = [], []
    auth = SimpleNamespace(get_auth_metadata=lambda: [("authorization", "fixture")],
                           channel=SimpleNamespace(close=lambda: released.append("channel")))
    monkeypatch.setattr(riva.client, "Auth", lambda *_args, **_kwargs: auth)
    class Responses:
        def __iter__(self):
            yield SimpleNamespace(results=[SimpleNamespace(is_final=True, alternatives=[SimpleNamespace(transcript="Bounded transcript")])])
        def cancel(self): released.append("rpc")
    def recognize(requests, **kwargs):
        calls.append((list(requests), kwargs)); return Responses()
    def unbounded(**kwargs):
        calls.append((list(kwargs["audio_chunks"]), kwargs)); return Responses()
    monkeypatch.setattr(riva.client, "ASRService", lambda _: SimpleNamespace(stub=SimpleNamespace(StreamingRecognize=recognize), streaming_response_generator=unbounded))
    assert riva_transcribe.transcribe_wav(wav()) == "Bounded transcript"
    assert calls[0][1].get("timeout") == 65
    assert set(released) == {"rpc", "channel"}
