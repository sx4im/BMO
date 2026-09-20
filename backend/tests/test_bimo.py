"""Smoke tests for the Bimo Render gateway.

Full integration tests would need a real Supabase project and NVIDIA key, so
those live outside this repo. These tests just check that the Flask app boots
with valid env config, exposes ``/health``, and gates protected routes behind
JWT authentication.
"""

from __future__ import annotations

import importlib
import json

import pytest


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "test-jwt-secret")
    monkeypatch.setenv("SUPABASE_STORAGE_BUCKET", "bimo-attachments")
    monkeypatch.setenv("NVIDIA_API_KEY", "test-nvidia-key")
    monkeypatch.setenv("NVIDIA_MODEL", "meta/llama-3.3-70b-instruct")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-deepgram-key")
    monkeypatch.setenv("CORS_ORIGINS", "*")

    # Re-import so module-level env reads are fresh.
    main = importlib.import_module("app.main")
    importlib.reload(main)
    app = main.create_app()
    app.testing = True
    with app.test_client() as c:
        yield c


def test_health(client):
    res = client.get("/health")
    assert res.status_code == 200
    body = res.get_json()
    assert body["status"] == "ok"
    assert body["store"] == "supabase"
    assert body["models"] == "configured"
    assert body["tts"] == "configured"


def test_unauth_routes_require_jwt(client):
    assert client.get("/me").status_code == 401
    assert client.get("/conversations").status_code == 401
    assert client.post("/chat", json={"message": "hi"}).status_code == 401
    assert client.post("/images/generate", json={"prompt": "a cat"}).status_code == 401
    assert client.post("/search", json={"query": "weather"}).status_code == 401
    assert client.post("/scrape", json={"url": "https://example.com"}).status_code == 401
    assert client.post("/tts", json={"text": "hello"}).status_code == 401
    assert client.get("/models").status_code == 401
    assert client.get("/analytics/summary").status_code == 401


def test_invalid_jwt_is_rejected(client):
    res = client.get("/me", headers={"Authorization": "Bearer not-a-real-token"})
    assert res.status_code == 401


def test_nvidia_debug_disabled_by_default(client):
    """/nvidia-debug leaks the NVIDIA key fingerprint + real model id and burns
    rate-limited quota via a live test call. It must be OFF unless DEBUG_AUTH=1
    (the fixture does not set it), and must never run the live call while off."""
    res = client.get("/nvidia-debug")
    assert res.status_code == 404
    body = res.get_json()
    assert "key" not in body
    assert "test" not in body


def test_tts_available_when_key_configured(client):  # noqa: ARG001 — fixture sets env
    """Bimo Voice TTS is available when the Deepgram key is present."""
    from app import config

    assert config.is_deepgram_configured() is True


def test_pcm_to_wav_wrapper():
    """_pcm_to_wav must wrap raw linear PCM into a valid mono 16-bit WAV container."""
    import io
    import wave
    from app.routes.media_routes import _pcm_to_wav

    raw_pcm = b"\x01\x00" * 800  # 800 int16 PCM samples
    wav = _pcm_to_wav(raw_pcm, sample_rate=24000)

    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE"
    with wave.open(io.BytesIO(wav), "rb") as wf:
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2
        assert wf.getnframes() == 800
        assert wf.getframerate() == 24000


def test_security_headers_present(client):
    """Every response carries the defensive headers and hides the server banner."""
    res = client.get("/health")
    assert res.headers.get("X-Content-Type-Options") == "nosniff"
    assert res.headers.get("X-Frame-Options") == "DENY"
    assert res.headers.get("Referrer-Policy") == "strict-origin-when-cross-origin"
    assert "max-age=" in (res.headers.get("Strict-Transport-Security") or "")
    assert res.headers.get("Server") is None


def _enabled_limiter_client(monkeypatch):
    """Build an app instance with rate limiting explicitly turned on.

    No module reload needed: create_app() reads RATELIMIT_ENABLED at call time.
    """
    import importlib

    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "test-jwt-secret")
    monkeypatch.setenv("NVIDIA_API_KEY", "test-nvidia-key")
    monkeypatch.setenv("CORS_ORIGINS", "*")
    monkeypatch.setenv("RATELIMIT_ENABLED", "1")

    main = importlib.import_module("app.main")
    app = main.create_app()
    app.testing = True
    return app.test_client()


def test_rate_limit_disabled_when_env_off(monkeypatch):
    """RATELIMIT_ENABLED=0 (local dev) must not 429 hammered endpoints."""
    import importlib

    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "test-jwt-secret")
    monkeypatch.setenv("NVIDIA_API_KEY", "test-nvidia-key")
    monkeypatch.setenv("CORS_ORIGINS", "*")
    monkeypatch.setenv("RATELIMIT_ENABLED", "0")

    main = importlib.import_module("app.main")
    app = main.create_app()
    app.testing = True
    with app.test_client() as c:
        statuses = [c.post("/attachments").status_code for _ in range(60)]
    assert 429 not in statuses, statuses


def test_rate_limit_returns_429_when_enabled(monkeypatch):
    """When explicitly enabled, /attachments is capped at 30/min/identity and
    excess calls get a 429 with a Retry-After header and a JSON body."""
    c = _enabled_limiter_client(monkeypatch)
    statuses = [c.post("/attachments").status_code for _ in range(31)]
    assert 429 in statuses, statuses
    res = c.post("/attachments")
    assert res.status_code == 429
    assert res.headers.get("Retry-After") is not None
    body = res.get_json()
    assert "detail" in body and "quickly" in body["detail"].lower()


def test_upload_type_allowlist():
    """Server-side upload allowlist accepts supported types and rejects
    script-carrying / executable types regardless of the claimed MIME."""
    from app.main import _upload_type_allowed

    assert _upload_type_allowed("photo.png", "image/png") is True
    assert _upload_type_allowed("report.pdf", "application/pdf") is True
    assert _upload_type_allowed("notes.docx", "application/octet-stream") is True
    assert _upload_type_allowed("camera", "image/jpeg") is True  # no extension

    assert _upload_type_allowed("evil.svg", "image/svg+xml") is False
    assert _upload_type_allowed("evil.html", "text/html") is False
    assert _upload_type_allowed("evil.exe", "application/octet-stream") is False


def test_models_catalog_shape():
    """The UI_MODELS catalogue should expose the two chat modes,
    and the ids must match KNOWN_MODEL_IDS exactly."""
    from app.main import UI_MODELS, KNOWN_MODEL_IDS

    assert len(UI_MODELS) == 2
    ids = {m["id"] for m in UI_MODELS}
    assert ids == KNOWN_MODEL_IDS
    assert "thinking" in ids
    assert "deep" in ids
    stanza = next(m for m in UI_MODELS if m["id"] == "thinking")
    assert stanza["description"] == "All-round help"


def test_real_model_ids_use_defaults():
    """Default NVIDIA model IDs when env vars are unset."""
    from app.main import (
        DEFAULT_NEXOS_MODEL,
        DEFAULT_STANZA_MODEL,
        DEFAULT_VISION_MODEL,
        REAL_ID_MAP,
        VISION_MODEL,
    )
    from app import nvidia_client

    assert REAL_ID_MAP["thinking"] == DEFAULT_STANZA_MODEL
    assert REAL_ID_MAP["deep"]     == DEFAULT_NEXOS_MODEL
    assert VISION_MODEL            == DEFAULT_VISION_MODEL
    # "image" is a conversation model but has no chat-completions backing id.
    assert "image" not in REAL_ID_MAP
    # Image-generation model (env-swappable, pinned to the default).
    assert nvidia_client.image_model() == "black-forest-labs/flux.2-klein-4b"


def test_real_model_ids_follow_env(monkeypatch):
    """Each friendly lane reads its model id from the environment."""
    monkeypatch.setenv("NVIDIA_STANZA_MODEL", "vendor/stanza-custom")
    monkeypatch.setenv("NVIDIA_NEXOS_MODEL", "vendor/nexos-custom")
    monkeypatch.setenv("NVIDIA_VISION_MODEL", "vendor/vision-custom")
    monkeypatch.setenv("NVIDIA_IMAGE_MODEL", "vendor/image-custom")
    from app import main, nvidia_client
    importlib.reload(main)
    importlib.reload(nvidia_client)

    assert main.REAL_ID_MAP["thinking"] == "vendor/stanza-custom"
    assert main.REAL_ID_MAP["deep"]     == "vendor/nexos-custom"
    assert main.VISION_MODEL            == "vendor/vision-custom"
    assert nvidia_client.image_model()  == "vendor/image-custom"


def test_usage_weighting_and_windows(monkeypatch):
    """Per-model weighting, the 5h vs weekly split, and the blocked flag."""
    from datetime import datetime, timezone, timedelta
    from app import main, store

    now = datetime.now(timezone.utc)
    old = (now - timedelta(hours=10)).isoformat()   # outside 5h, inside 7d
    recent = (now - timedelta(minutes=30)).isoformat()  # inside both
    events = [
        {"model": "thinking", "tokens": 1000, "created_at": recent},   # weight 1.0 -> 1000
        {"model": "deep", "tokens": 1000, "created_at": recent},       # weight 5.0 -> 5000
        {"model": "thinking", "tokens": 1000, "created_at": old},       # weight 1.0 -> 1000, weekly only
    ]
    monkeypatch.setattr(store, "recent_usage_events", lambda uid, since: events)

    s = main._usage_status("u1")
    assert s["session"]["used"] == 6000      # only the two recent events
    assert s["weekly"]["used"] == 7000       # all three
    assert not s["blocked"]
    # Any nonzero usage must round UP to at least 1% — flooring used to stick at 0.
    assert s["session"]["percent"] >= 1
    monkeypatch.setattr(
        store, "recent_usage_events",
        lambda uid, since: [{"model": "thinking", "tokens": 1, "created_at": recent}],
    )
    assert main._usage_status("u1")["session"]["percent"] == 1

    # Over a window -> blocked.
    monkeypatch.setattr(
        store, "recent_usage_events",
        lambda uid, since: [{"model": "deep", "tokens": main.SESSION_LIMIT, "created_at": recent}],
    )
    assert main._usage_status("u1")["blocked"] is True
    assert main._human_duration(4 * 3600 + 26 * 60) == "4h 26m"


def test_usage_reset_at_clears_below_limit_not_just_oldest():
    """Reset time = when enough old turns age out that usage drops UNDER the
    limit, not when the single oldest turn rolls off (the latter left the user
    blocked past the advertised reset)."""
    from datetime import datetime, timezone, timedelta
    from app import main

    now = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
    window_s = 5 * 3600
    limit = 100
    # Three turns of weight 60 (total 180, over 100). Expiring the oldest leaves
    # 120 (still over); expiring the 2nd leaves 60 (under) -> reset at 2nd+window.
    weighted = [
        (now - timedelta(hours=4), 60.0),
        (now - timedelta(hours=3), 60.0),
        (now - timedelta(hours=2), 60.0),
    ]
    reset = main._window_reset_at(weighted, 180.0, now, limit, window_s)
    assert reset == (now - timedelta(hours=3)) + timedelta(seconds=window_s)

    # Under the limit -> reset is just the single oldest turn rolling off.
    under = main._window_reset_at(weighted[:1], 60.0, now, limit, window_s)
    assert under == (now - timedelta(hours=4)) + timedelta(seconds=window_s)

    # No usage -> a full window from now.
    assert main._window_reset_at([], 0.0, now, limit, window_s) == now + timedelta(seconds=window_s)


def test_image_safety_blocks_unsafe_prompts():
    """The image-prompt safety gate must pass benign prompts and reject sexual,
    explicit, exploitative, and gratuitously violent ones."""
    from app import image_safety

    for ok in [
        "a watercolor fox in a misty forest",
        "an isometric coffee shop interior, warm lighting",
        "portrait of an astronaut, studio lighting",
    ]:
        assert image_safety.check_prompt(ok) is None, ok

    for bad in [
        "nude woman on a beach",
        "explicit porn scene",
        "hentai illustration",
        "graphic gore and dismemberment",
    ]:
        assert image_safety.check_prompt(bad) is not None, bad

    # Sexualizing minors is always blocked.
    assert image_safety.check_prompt("child porn") is not None


def test_image_b64_extraction_handles_variants():
    """generate_image must read the base64 image out of every response shape
    NVIDIA's image models use (artifacts / image / data)."""
    from app.nvidia_client import _extract_image_b64

    assert _extract_image_b64({"artifacts": [{"base64": "AAA"}]}) == "AAA"
    assert _extract_image_b64({"image": "data:image/png;base64,BBB"}) == "data:image/png;base64,BBB"
    assert _extract_image_b64({"data": [{"b64_json": "CCC"}]}) == "CCC"
    assert _extract_image_b64({"nope": 1}) is None


def test_generate_image_retries_filtered_empty_artifact(monkeypatch):
    """An empty artifacts[0].base64 with CONTENT_FILTERED should be treated as a
    filtered attempt, not as a hard malformed-response failure."""
    from app import nvidia_client

    calls = {"count": 0}

    def fake_post(_url, _key, _body):
        calls["count"] += 1
        if calls["count"] < 3:
            return {"artifacts": [{"base64": "", "finishReason": "CONTENT_FILTERED", "seed": 1}]}
        return {"artifacts": [{"base64": "QUFB", "finishReason": "SUCCESS", "seed": 2}]}

    monkeypatch.setattr(nvidia_client, "_read_api_key", lambda: "test-key")
    monkeypatch.setattr(nvidia_client, "_post_image", fake_post)
    monkeypatch.setattr(nvidia_client, "_is_blank_image", lambda _png: False)

    assert nvidia_client.generate_image("a cat") == b"AAA"
    assert calls["count"] == 3


def test_generate_image_filtered_empty_artifact_raises_friendly_error(monkeypatch):
    """If every attempt is filtered with an empty payload, return the same
    friendly safety/filter message as blank filtered images."""
    from app import nvidia_client

    monkeypatch.setattr(nvidia_client, "_read_api_key", lambda: "test-key")
    monkeypatch.setattr(
        nvidia_client,
        "_post_image",
        lambda _url, _key, _body: {
            "artifacts": [{"base64": "", "finishReason": "CONTENT_FILTERED", "seed": 1}]
        },
    )

    with pytest.raises(RuntimeError, match="blank image .* safety filter"):
        nvidia_client.generate_image("a cat")


def test_supabase_client_accepts_new_format_key():
    """supabase-py < 2.16 rejects sb_secret_/sb_publishable_ keys with a
    client-side regex, which masquerades as "Invalid API key" and is
    impossible to diagnose. Make sure our pinned version accepts them.
    """
    import supabase
    from supabase import create_client

    # Catch any regression where requirements.txt drifts back to a version
    # whose regex only matches JWT keys (header.payload.signature).
    major, minor = (int(x) for x in supabase.__version__.split(".")[:2])
    assert (major, minor) >= (2, 16), (
        f"supabase-py {supabase.__version__} rejects sb_secret_ keys client-side. "
        f"Pin >=2.16.0 in requirements.txt."
    )

    # Construct a client with a new-format key; should NOT raise.
    create_client("https://example.supabase.co", "sb_secret_ANY_DUMMY_VALUE")


def test_system_prompt_allows_document_generation_and_web_access():
    """Document requests provide clean markdown. Web access must avoid unsolicited sources."""
    from app.prompts import DEFAULT_SYSTEM_PROMPT, VISION_SYSTEM_PROMPT

    assert "DOCUMENTS, RESUMES & PDF REQUESTS" in DEFAULT_SYSTEM_PROMPT
    assert "clean Markdown" in DEFAULT_SYSTEM_PROMPT
    assert "CLEAN CHAT / NO SOURCE LINKS BY DEFAULT" in DEFAULT_SYSTEM_PROMPT
    assert "full live web search and webpage fetching" in DEFAULT_SYSTEM_PROMPT
    assert "Never tell the user to search" in DEFAULT_SYSTEM_PROMPT
    assert "do not add sources, citations, URLs, or Source links" in DEFAULT_SYSTEM_PROMPT
    assert "do not add sources, citations, URLs, or Source links" in VISION_SYSTEM_PROMPT
    assert "newest items by Published date" in DEFAULT_SYSTEM_PROMPT
    assert "Never lead with stale stories" in DEFAULT_SYSTEM_PROMPT
    assert "could not be reached" in DEFAULT_SYSTEM_PROMPT

    assert "DOCUMENTS, RESUMES & PDF REQUESTS" in VISION_SYSTEM_PROMPT
    assert "clean Markdown" in VISION_SYSTEM_PROMPT
    assert "Never claim you cannot browse the web" in VISION_SYSTEM_PROMPT


def test_trivial_prompts_skip_thinking():
    """Greetings / filler should be detected as trivial so Nexos answers them
    in fast non-thinking mode instead of spending minutes reasoning."""
    from app.main import _is_trivial_prompt

    for greeting in ["hi", "Hi", "hello!", "hey", "thanks", "ok", "Good morning", "yo", ""]:
        assert _is_trivial_prompt(greeting) is True, greeting

    # Real questions — even short ones — must keep thinking available.
    for real in ["2+2?", "explain quicksort", "why is the sky blue?", "write a function"]:
        assert _is_trivial_prompt(real) is False, real


def test_iter_response_thinking_toggle_for_deepseek(monkeypatch):
    """thinking=False must send chat_template_kwargs.thinking=False (fast path),
    thinking=True must enable it. Non-DeepSeek models ignore the flag."""
    from app import nvidia_client

    captured = {}

    class _FakeStream:
        def __iter__(self):
            return iter(())

    class _FakeClient:
        class chat:  # noqa: N801
            class completions:  # noqa: N801
                @staticmethod
                def create(**kwargs):
                    captured.clear()
                    captured.update(kwargs)
                    return _FakeStream()

    monkeypatch.setattr(nvidia_client, "_client", lambda *a, **k: _FakeClient())

    list(nvidia_client.iter_response([{"role": "user", "content": "hi"}],
                                     model="deepseek-ai/deepseek-v4-flash", thinking=False))
    assert captured["extra_body"]["chat_template_kwargs"]["thinking"] is False

    list(nvidia_client.iter_response([{"role": "user", "content": "hard problem"}],
                                     model="deepseek-ai/deepseek-v4-flash", thinking=True,
                                     reasoning_effort="high"))
    assert captured["extra_body"]["chat_template_kwargs"]["thinking"] is True
    assert captured["extra_body"]["chat_template_kwargs"]["reasoning_effort"] == "high"

    # MiniMax uses the same chat_template_kwargs mechanism (retained handler),
    # and pins MiniMax's recommended sampling (temperature=1.0, top_p=0.95).
    list(nvidia_client.iter_response([{"role": "user", "content": "hi"}],
                                     model="minimaxai/minimax-m3", thinking=False))
    assert captured["extra_body"]["chat_template_kwargs"]["thinking"] is False
    assert captured["top_p"] == 0.95
    assert captured["temperature"] == 1.0

    # Nemotron-3-Super supports reasoning_effort, enable_thinking, and directive
    list(nvidia_client.iter_response([{"role": "user", "content": "hard problem"}],
                                     model="nvidia/nemotron-3-super-120b-a12b", thinking=True,
                                     reasoning_effort="high"))
    assert captured["extra_body"]["chat_template_kwargs"]["thinking"] is True
    assert captured["extra_body"]["chat_template_kwargs"]["enable_thinking"] is True
    assert captured["extra_body"]["chat_template_kwargs"]["reasoning_effort"] == "high"

    # GPT-OSS supports reasoning_effort
    list(nvidia_client.iter_response([{"role": "user", "content": "hard problem"}],
                                     model="openai/gpt-oss-120b", thinking=True,
                                     reasoning_effort="medium"))
    assert captured["extra_body"]["chat_template_kwargs"]["thinking"] is True
    assert captured["extra_body"]["chat_template_kwargs"]["reasoning_effort"] == "medium"


def test_qwen_stanza_gets_full_token_budget(monkeypatch):
    """Stanza (qwen) must get the same 16384 output cap as the other lanes — not
    the lower env default it used to fall through to, which capped its replies at
    half the others and truncated them mid-sentence."""
    from app import nvidia_client

    captured = {}

    class _FakeStream:
        def __iter__(self):
            return iter(())

    class _FakeClient:
        class chat:  # noqa: N801
            class completions:  # noqa: N801
                @staticmethod
                def create(**kwargs):
                    captured.clear()
                    captured.update(kwargs)
                    return _FakeStream()

    monkeypatch.setattr(nvidia_client, "_client", lambda *a, **k: _FakeClient())
    list(nvidia_client.iter_response(
        [{"role": "user", "content": "hi"}],
        model="qwen/qwen3-next-80b-a3b-instruct",
    ))
    assert captured["max_tokens"] == 16384


def test_nemotron_reasoning_directive(monkeypatch):
    """Nemotron (the Nexos deep model) gates reasoning via a system directive,
    not chat_template_kwargs: thinking=True -> 'detailed thinking on',
    thinking=False -> 'detailed thinking off', capped at 16384 output tokens."""
    from app import nvidia_client

    captured = {}

    class _FakeStream:
        def __iter__(self):
            return iter(())

    class _FakeClient:
        class chat:  # noqa: N801
            class completions:  # noqa: N801
                @staticmethod
                def create(**kwargs):
                    captured.clear()
                    captured.update(kwargs)
                    return _FakeStream()

    monkeypatch.setattr(nvidia_client, "_client", lambda *a, **k: _FakeClient())
    base = [{"role": "system", "content": "You are Bimo."}, {"role": "user", "content": "hi"}]

    list(nvidia_client.iter_response(base, model="nvidia/nemotron-3-ultra-550b-a55b", thinking=True))
    assert "detailed thinking on" in captured["messages"][0]["content"].lower()
    assert captured["max_tokens"] == 16384

    list(nvidia_client.iter_response(base, model="nvidia/nemotron-3-ultra-550b-a55b", thinking=False))
    assert "detailed thinking off" in captured["messages"][0]["content"].lower()



def test_client_is_cached(monkeypatch):
    """The OpenAI client must be reused across calls (warm connection pool)
    and only rebuilt when the key/base URL/timeout change."""
    from app import nvidia_client

    monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-cache-test-key")
    nvidia_client._client_cache.clear()

    first = nvidia_client._client()
    second = nvidia_client._client()
    assert first is second

    # Rotating the key rebuilds the client.
    monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-rotated-key")
    third = nvidia_client._client()
    assert third is not first


def test_friendly_error_disambiguates_supabase_vs_nvidia():
    """'Invalid API key' is ambiguous — we MUST name which service rejected us."""
    from app.main import _friendly_error

    # Supabase rejection -> should explicitly name SUPABASE_SERVICE_ROLE_KEY
    supabase_msg = _friendly_error(Exception("Invalid API key"))
    assert "SUPABASE_SERVICE_ROLE_KEY" in supabase_msg
    assert "Supabase" in supabase_msg

    # NVIDIA rejection (already prefixed by nvidia_client._format_api_error)
    # should NOT be misclassified as Supabase
    nvidia_msg = _friendly_error(Exception("NVIDIA 401: Invalid API key"))
    assert "SUPABASE_SERVICE_ROLE_KEY" not in nvidia_msg
    assert "NVIDIA 401" in nvidia_msg

    # Unrelated errors pass through untouched
    other = _friendly_error(Exception("connection reset by peer"))
    assert other == "connection reset by peer"


def test_coerce_alternating_fixes_broken_history():
    """NVIDIA 400 "roles must alternate" fix: malformed stored history must be
    coerced into a strictly alternating payload (the bug poisoned a whole
    conversation until a new chat was started)."""
    from app import nvidia_client as nc

    # Two consecutive user turns (an assistant turn was dropped for empty
    # content) must merge so the model sees strict alternation.
    msgs = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "a"},
        {"role": "user", "content": "b"},
        {"role": "assistant", "content": "c"},
        {"role": "user", "content": "d"},
    ]
    out = nc._coerce_alternating(msgs)
    assert [m["role"] for m in out] == ["system", "user", "assistant", "user"]
    assert out[1]["content"] == "a\n\nb"  # merged, no context lost

    # A leading assistant turn (first non-system message) is dropped — the model
    # must start from the user.
    msgs2 = [
        {"role": "system", "content": "s"},
        {"role": "assistant", "content": "x"},
        {"role": "user", "content": "y"},
    ]
    assert [m["role"] for m in nc._coerce_alternating(msgs2)] == ["system", "user"]

    # Vision (list) content merges by concatenating parts in order.
    assert nc._merge_content([{"type": "text", "text": "p"}], "q") == [
        {"type": "text", "text": "p"},
        {"type": "text", "text": "q"},
    ]

    # End-to-end: the real builder applied to broken history alternates.
    built = nc.build_messages(
        [{"role": "user", "content": "u1"}, {"role": "user", "content": "u2"}],
        "now",
    )
    non_system = [m["role"] for m in built if m["role"] != "system"]
    assert all(non_system[i] != non_system[i + 1] for i in range(len(non_system) - 1))
    assert non_system[-1] == "user"


def test_whatsapp_signature_verification(monkeypatch):
    """WhatsApp webhook must verify Meta's X-Hub-Signature-256 HMAC-SHA256."""
    import hashlib
    import hmac
    from app.whatsapp import verify_meta_signature

    secret = "test_meta_app_secret"
    payload = b'{"entry":[{"changes":[{"value":{"messages":[{"from":"123","type":"text","text":{"body":"hi"}}]}}]}]}'
    valid_sig = "sha256=" + hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    invalid_sig = "sha256=wrongsignature00000000000000000000000000000000000000000000000000"

    monkeypatch.setenv("WHATSAPP_APP_SECRET", secret)
    assert verify_meta_signature(payload, valid_sig) is True
    assert verify_meta_signature(payload, invalid_sig) is False
    assert verify_meta_signature(payload, None) is False

    monkeypatch.setenv("WHATSAPP_APP_SECRET", "")
    assert verify_meta_signature(payload, valid_sig) is False


def test_whatsapp_uses_aeon_model_groq(monkeypatch):
    from app import whatsapp

    sent_messages = []
    def mock_send(to_phone, msg):
        sent_messages.append((to_phone, msg))
        return True

    captured_groq = {}
    def mock_generate_groq(model_id, messages, groq_key):
        captured_groq["model_id"] = model_id
        captured_groq["messages"] = messages
        captured_groq["groq_key"] = groq_key
        return "Hello from Groq Aeon on WhatsApp!"

    monkeypatch.setattr(whatsapp, "send_whatsapp_message", mock_send)
    monkeypatch.setattr(whatsapp, "_generate_groq_reply", mock_generate_groq)
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test123")
    monkeypatch.setenv("GROQ_AEON_MODEL", "qwen/qwen3.8-27b")

    whatsapp._process_and_reply_async("1234567890", "hi")
    assert captured_groq.get("model_id") == "qwen/qwen3.8-27b"
    assert captured_groq.get("groq_key") == "gsk_test123"
    assert len(sent_messages) == 1
    assert "Hello from Groq Aeon on WhatsApp!" in sent_messages[0][1]


def test_whatsapp_uses_aeon_model(monkeypatch):
    from app import whatsapp

    sent_messages = []
    def mock_send(to_phone, msg):
        sent_messages.append((to_phone, msg))
        return True

    captured_kwargs = {}
    def mock_iter_response_with_fallback(messages, **kwargs):
        captured_kwargs.update(kwargs)
        captured_kwargs["messages"] = messages
        yield {"type": "delta", "data": "Hello from Aeon on WhatsApp!"}

    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setattr(whatsapp, "send_whatsapp_message", mock_send)
    monkeypatch.setattr("app.nvidia_client.iter_response_with_fallback", mock_iter_response_with_fallback)
    monkeypatch.setenv("GROQ_AEON_MODEL", "qwen/qwen3.8-27b")

    whatsapp._process_and_reply_async("1234567890", "hi")
    assert captured_kwargs.get("model") == "qwen/qwen3.8-27b"
    assert captured_kwargs.get("thinking") is False
    assert captured_kwargs.get("max_tokens") == 400
    assert len(sent_messages) == 1
    assert "Hello from Aeon on WhatsApp!" in sent_messages[0][1]


def test_cors_origins_default_excludes_localhost(monkeypatch):
    from app.config import cors_origins
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    origins = cors_origins()
    assert origins == ["https://bimo.qzz.io"]
    assert "http://localhost:5500" not in origins


def test_whatsapp_webhook_verification_security(client, monkeypatch):
    monkeypatch.delenv("WHATSAPP_VERIFY_TOKEN", raising=False)
    from app import whatsapp
    monkeypatch.setattr(whatsapp, "WHATSAPP_VERIFY_TOKEN", "")

    # When unconfigured, GET verification should return 503
    resp = client.get("/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=bimo_whatsapp_verify_token_2026&hub.challenge=test_challenge")
    assert resp.status_code == 503

    # When configured with a secret, wrong token returns 403, correct returns 200
    monkeypatch.setenv("WHATSAPP_VERIFY_TOKEN", "super_secret_token_123")
    monkeypatch.setattr(whatsapp, "WHATSAPP_VERIFY_TOKEN", "super_secret_token_123")
    resp = client.get("/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=test_challenge")
    assert resp.status_code == 403
    resp = client.get("/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=super_secret_token_123&hub.challenge=test_challenge")
    assert resp.status_code == 200
    assert resp.get_data(as_text=True) == "test_challenge"


def test_tts_voice_validation(client, monkeypatch):
    import time
    import jwt

    claims = {
        "sub": "test_tts_user",
        "email": "tts@test.com",
        "aud": "authenticated",
        "iss": "https://example.supabase.co/auth/v1",
        "exp": int(time.time()) + 3600,
    }
    token = jwt.encode(claims, "test-jwt-secret", algorithm="HS256")
    headers = {"Authorization": f"Bearer {token}"}

    # Invalid voice containing special/injected characters should be rejected with 422
    resp = client.post("/tts", headers=headers, json={"text": "hello", "voice": "flux&injected=1"})
    assert resp.status_code == 422
    assert "invalid voice" in resp.get_json()["detail"]


def test_whatsapp_maintains_conversation_context(monkeypatch):
    from app import whatsapp

    sent_messages = []
    def mock_send(to_phone, msg):
        sent_messages.append((to_phone, msg))
        return True

    captured_messages = []
    def mock_generate_groq(model_id, messages, groq_key):
        captured_messages.append(list(messages))
        return f"Reply #{len(captured_messages)}"

    monkeypatch.setattr(whatsapp, "send_whatsapp_message", mock_send)
    monkeypatch.setattr(whatsapp, "_generate_groq_reply", mock_generate_groq)
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test123")

    test_phone = "9876543210_test_suite"
    whatsapp._clear_phone_history(test_phone)

    # Turn 1
    whatsapp._process_and_reply_async(test_phone, "My name is Saim")
    assert len(captured_messages) == 1
    assert captured_messages[0][-1] == {"role": "user", "content": "My name is Saim"}

    # Turn 2: must include turn 1 history
    whatsapp._process_and_reply_async(test_phone, "What is my name?")
    assert len(captured_messages) == 2
    # Check that turn 1 user & assistant are passed in messages
    roles = [m["role"] for m in captured_messages[1]]
    assert roles == ["system", "user", "assistant", "user"]
    assert captured_messages[1][1] == {"role": "user", "content": "My name is Saim"}
    assert captured_messages[1][2] == {"role": "assistant", "content": "Reply #1"}
    assert captured_messages[1][3] == {"role": "user", "content": "What is my name?"}


def test_whatsapp_formatting_converts_markdown():
    from app.whatsapp import format_for_whatsapp

    # Double asterisks to single
    assert format_for_whatsapp("This is **bold** text") == "This is *bold* text"
    # Headers to single asterisk bold
    assert format_for_whatsapp("### Heading 3") == "*Heading 3*"
    # Strikethrough
    assert format_for_whatsapp("Old ~~price~~") == "Old ~price~"
    # Numbered bold list items with stray double asterisks
    assert format_for_whatsapp("**1. Build Foundation**\n**6.") == "*1. Build Foundation*\n*6.*"
    # List dashes to unicode bullets
    assert format_for_whatsapp("- item one\n* item two") == "• item one\n• item two"


def test_document_processor_zip_bomb_and_traversal():
    """ZIP extractor must reject suspicious decompression ratios and path traversal."""
    import io
    import zipfile
    from app.document_processor import _extract_zip

    bio = io.BytesIO()
    with zipfile.ZipFile(bio, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("safe.txt", "Hello Bimo")
    parts = _extract_zip(bio.getvalue())
    assert any("Hello Bimo" in p.get("text", "") for p in parts)

    bio_trav = io.BytesIO()
    with zipfile.ZipFile(bio_trav, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("../evil.txt", "evil")
    parts_trav = _extract_zip(bio_trav.getvalue())
    assert not any("evil" in p.get("text", "") for p in parts_trav)

    bio_bomb = io.BytesIO()
    with zipfile.ZipFile(bio_bomb, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("bomb.txt", b"\x00" * 200_000)
    parts_bomb = _extract_zip(bio_bomb.getvalue())
    assert not any("\x00" * 20 in p.get("text", "") for p in parts_bomb)
    assert any("high compression ratio" in p.get("text", "") for p in parts_bomb)


def test_store_download_attachment_ownership_guard(monkeypatch):
    """store.download_attachment must validate user ownership and reject directory traversal."""
    from app import store

    with pytest.raises(PermissionError):
        store.download_attachment("../secrets.env", user_id="user-123")

    with pytest.raises(PermissionError):
        store.download_attachment("/etc/passwd", user_id="user-123")

    with pytest.raises(PermissionError):
        store.download_attachment("victim-user/photo.png", user_id="attacker-user")

    with pytest.raises(PermissionError):
        store.download_attachment("user-123/photo.png", user_id="")


def test_build_continuation_messages_exists():
    """chat_routes.py calls build_continuation_messages for batch_idx > 0."""
    from app import nvidia_client

    assert hasattr(nvidia_client, "build_continuation_messages")
    msgs = nvidia_client.build_continuation_messages(
        [{"role": "user", "content": "Page 1"}, {"role": "assistant", "content": "Analysis 1"}],
        [{"type": "text", "text": "Page 2 text"}],
    )
    # 1 system + 2 history turns + 1 current user batch = 4
    assert len(msgs) == 4
    assert msgs[0]["role"] == "system"
    assert msgs[-1]["role"] == "user"


def test_rate_limit_key_isolation(client):
    """Unauthenticated and forged JWTs key by IP; verified JWTs key by user id."""
    import time
    import jwt
    from app.main import _rate_limit_key

    with client.application.test_request_context("/"):
        assert _rate_limit_key().startswith("ip:")

    claims = {
        "sub": "user-abc",
        "aud": "authenticated",
        "iss": "https://example.supabase.co/auth/v1",
        "exp": int(time.time()) + 3600,
    }
    good = jwt.encode(claims, "test-jwt-secret", algorithm="HS256")
    with client.application.test_request_context("/", headers={"Authorization": f"Bearer {good}"}):
        assert _rate_limit_key() == "user:user-abc"

    spoofed = jwt.encode(claims, "wrong-secret", algorithm="HS256")
    with client.application.test_request_context("/", headers={"Authorization": f"Bearer {spoofed}"}):
        assert _rate_limit_key().startswith("ip:")




# --------------------------------------------------------------------------
# Leaked highlight.js span scrubbing (nvidia_client.sanitize_reply)
#
# The upstream model sometimes pastes pre-rendered highlight.js output into
# code fences instead of plain source, both raw and entity-escaped. See the
# issue ticket: code blocks rendered literal `<span class="hljs-*">` text.
# --------------------------------------------------------------------------

from app.nvidia_client import _clean_llm_text, sanitize_reply


def test_strip_raw_hljs_spans():
    src = '<span class="hljs-meta">#</span>include <vector>'
    assert _clean_llm_text(src) == "#include <vector>"


def test_strip_nested_raw_hljs_spans():
    src = (
        '<span class="hljs-meta">#<span class="hljs-keyword">include</span>'
        '</span> main'
    )
    assert _clean_llm_text(src) == "#include main"


def test_strip_entity_escaped_hljs_spans_and_decode_inner_entities():
    # The escaped-span variant: hljs output arrived as literal text.
    src = '&lt;span class=&quot;hljs-keyword&quot;&gt;int&lt;/span&gt; x;'
    assert _clean_llm_text(src) == "int x;"


def test_screenshot_leak_full_shape():
    # Exact shape from the bug report screenshot.
    src = (
        '<span class="hljs-meta">#<span class="hljs-keyword">include</span> '
        '<span class="hljs-string">&lt;iostream&gt;</span></span>\n'
        '<span class="hljs-keyword">struct</span>'
    )
    assert sanitize_reply(src) == "#include <iostream>\nstruct"


def test_split_chunk_span_is_cleaned_once_assembled():
    # A span split across two SSE chunks: per-chunk cleaning can't catch it,
    # the final sanitize_reply() pass must.
    assembled = '<span cla' + 'ss="hljs-keyword">struct</span> Node {'
    assert sanitize_reply(assembled) == "struct Node {"


def test_legit_code_without_spans_untouched():
    src = "```cpp\n#include <iostream>\nint main() { return 0; }\n```"
    assert _clean_llm_text(src) == src


def test_entities_without_span_evidence_untouched():
    # No leak proven -> text must be byte-identical (no entity decoding).
    src = "a &lt; b and c &gt; d &amp; e"
    assert _clean_llm_text(src) == src


def test_plain_text_untouched():
    for src in ("plain text", "", "<b>bold prose</b>"):
        assert _clean_llm_text(src) == src


def test_channel_tokens_still_stripped_alongside_spans():
    src = '<|channel|>thought<|channel|><span class="hljs-keyword">int</span> x'
    assert _clean_llm_text(src) == "int x"






# --------------------------------------------------------------------------
# Supabase PGRST303 transient clock-skew retry & reasoning migration logging
# --------------------------------------------------------------------------

from postgrest.exceptions import APIError
from app import store


def test_store_pgrst303_retry_succeeds():
    """PGRST303 (JWT issued at future) retries and succeeds if a healthy node responds."""
    calls = 0

    class _MockResult:
        data = [{"id": "c1", "title": "Test Convo"}]

    class _MockBuilder:
        def execute(self):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise APIError({"code": "PGRST303", "message": "JWT issued at future"})
            return _MockResult()

    builder = _MockBuilder()
    res = store._execute(builder, delay=0.01)
    assert res.data[0]["id"] == "c1"
    assert calls == 2


def test_store_unrelated_apierror_not_retried():
    """Any non-PGRST303 APIError code must propagate immediately without retry."""
    calls = 0

    class _MockBuilder:
        def execute(self):
            nonlocal calls
            calls += 1
            raise APIError({"code": "PGRST100", "message": "parsing failed"})

    builder = _MockBuilder()
    with pytest.raises(APIError) as exc_info:
        store._execute(builder, delay=0.01)
    assert exc_info.value.code == "PGRST100"
    assert calls == 1


def test_store_pgrst303_exhausted_retries_raises():
    """If all 2 retries (3 total attempts) fail with PGRST303, the original APIError propagates."""
    calls = 0

    class _MockBuilder:
        def execute(self):
            nonlocal calls
            calls += 1
            raise APIError({"code": "PGRST303", "message": "JWT issued at future"})

    builder = _MockBuilder()
    with pytest.raises(APIError):
        store._execute(builder, max_retries=2, delay=0.01)
    assert calls == 3


def test_store_add_message_missing_reasoning_fallback(monkeypatch, caplog):
    """When inserting with reasoning fails on missing column, warning is logged and insert falls back."""
    calls = 0

    class _MockResult:
        data = [{"id": "m1", "role": "assistant", "content": "Answer"}]

    class _MockTable:
        def insert(self, payload):
            nonlocal calls
            calls += 1
            self.payload = payload
            return self

        def execute(self):
            if "reasoning" in self.payload:
                raise Exception("column messages.reasoning does not exist")
            return _MockResult()

    class _MockSupabase:
        def table(self, name):
            assert name == "messages"
            return _MockTable()

    monkeypatch.setattr(store, "supabase", lambda: _MockSupabase())
    monkeypatch.setattr(store, "get_conversation", lambda cid, uid: {"id": cid})
    monkeypatch.setattr(store, "touch_conversation", lambda cid, uid: None)

    with caplog.at_level("WARNING"):
        msg = store.add_message("c1", "u1", role="assistant", content="Answer", reasoning="Step 1")
    assert msg["id"] == "m1"
    assert "0002_message_reasoning.sql" in caplog.text
    assert calls == 2


def test_aeon_voice_model_properties(monkeypatch):
    from app.config import (
        UI_MODELS,
        KNOWN_MODEL_IDS,
        ALL_VALID_MODEL_IDS,
        get_real_id_map,
        get_aeon_model,
        DEFAULT_AEON_MODEL,
    )

    # Aeon should not be in UI dropdown
    ui_ids = {m["id"] for m in UI_MODELS}
    assert "aeon" not in ui_ids
    assert "aeon" in ALL_VALID_MODEL_IDS
    assert get_real_id_map()["aeon"] == DEFAULT_AEON_MODEL

    monkeypatch.setenv("NVIDIA_AEON_MODEL", "google/diffusiongemma-26b-a4b-it")
    assert get_aeon_model() == "google/diffusiongemma-26b-a4b-it"


def test_chat_aeon_model_stream(client, monkeypatch):
    import time
    import jwt
    from app import store
    from app.prompts import AEON_SYSTEM_PROMPT

    claims = {
        "sub": "test_aeon_user",
        "email": "aeon@test.com",
        "aud": "authenticated",
        "iss": "https://example.supabase.co/auth/v1",
        "exp": int(time.time()) + 3600,
    }
    token = jwt.encode(claims, "test-jwt-secret", algorithm="HS256")

    monkeypatch.setattr(store, "get_conversation", lambda cid, uid: {"id": cid, "user_id": uid, "model": "aeon"})
    monkeypatch.setattr(store, "get_messages", lambda cid, limit=None: [])
    monkeypatch.setattr(store, "add_message", lambda *args, **kwargs: {"id": "m_aeon", "role": kwargs.get("role", "assistant")})
    monkeypatch.setattr(store, "touch_conversation", lambda cid, uid: None)
    monkeypatch.setattr(store, "record_usage", lambda *args, **kwargs: None)

    captured_kwargs = {}
    def mock_iter_response_with_fallback(messages, **kwargs):
        captured_kwargs.update(kwargs)
        captured_kwargs["messages"] = messages
        yield {"type": "delta", "data": "Linear algebra is the study of vectors and matrices in simple terms."}
        yield {"type": "done", "content": "Linear algebra is the study of vectors and matrices in simple terms."}

    monkeypatch.setattr("app.nvidia_client.iter_response_with_fallback", mock_iter_response_with_fallback)

    resp = client.post(
        "/chat",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "conversation_id": "c_aeon_test",
            "message": "tell me about linear algebra",
            "model": "aeon",
        },
    )
    assert resp.status_code == 200
    assert captured_kwargs.get("thinking") is False
    assert captured_kwargs.get("max_tokens") == 300
    # Verify AEON_SYSTEM_PROMPT is used
    sys_msgs = [m["content"] for m in captured_kwargs.get("messages", []) if m["role"] == "system"]
    assert any("You are Aeon" in m for m in sys_msgs)


def test_chat_default_reasoning_efforts(client, monkeypatch):
    import time
    import jwt
    from app import store

    claims = {
        "sub": "test_effort_user",
        "email": "effort@test.com",
        "aud": "authenticated",
        "iss": "https://example.supabase.co/auth/v1",
        "exp": int(time.time()) + 3600,
    }
    token = jwt.encode(claims, "test-jwt-secret", algorithm="HS256")

    monkeypatch.setattr("app.routes.chat_routes.get_usage_status", lambda uid: {"blocked": False, "session": {"used": 0, "limit": 100000}, "weekly": {"used": 0, "limit": 1000000}})
    monkeypatch.setattr(store, "recent_usage_events", lambda *args, **kwargs: [])
    monkeypatch.setattr(store, "get_conversation", lambda cid, uid: {"id": cid, "user_id": uid, "model": "deep" if "2" in cid else "thinking"})
    monkeypatch.setattr(store, "update_conversation", lambda cid, uid, patch: {"id": cid, "user_id": uid, **patch})
    monkeypatch.setattr(store, "get_messages", lambda cid, limit=None: [])
    monkeypatch.setattr(store, "add_message", lambda *args, **kwargs: {"id": "m_test", "role": kwargs.get("role", "assistant")})
    monkeypatch.setattr(store, "touch_conversation", lambda cid, uid: None)
    monkeypatch.setattr(store, "record_usage", lambda *args, **kwargs: None)

    captured_kwargs = {}
    def mock_iter_response_with_fallback(messages, **kwargs):
        captured_kwargs.clear()
        captured_kwargs.update(kwargs)
        yield {"type": "delta", "data": "Test answer"}
        yield {"type": "done", "content": "Test answer"}

    monkeypatch.setattr("app.nvidia_client.iter_response_with_fallback", mock_iter_response_with_fallback)

    monkeypatch.setattr("app.nvidia_client.generate_title", lambda *a, **k: "Title")

    # 1. Stanza default reasoning effort is 'low'
    resp = client.post(
        "/chat",
        headers={"Authorization": f"Bearer {token}"},
        json={"conversation_id": "c_1", "message": "explain gravity", "model": "thinking"},
    )
    assert resp.status_code == 200
    list(resp.response)
    assert captured_kwargs.get("reasoning_effort") == "low"
    assert captured_kwargs.get("thinking") is True

    # 2. Nexos default reasoning effort is 'low'
    resp = client.post(
        "/chat",
        headers={"Authorization": f"Bearer {token}"},
        json={"conversation_id": "c_2", "message": "explain gravity", "model": "deep"},
    )
    assert resp.status_code == 200
    list(resp.response)
    assert captured_kwargs.get("reasoning_effort") == "low"
    assert captured_kwargs.get("thinking") is True

    # 3. Extended thinking sets reasoning effort to 'high' for both
    resp = client.post(
        "/chat",
        headers={"Authorization": f"Bearer {token}"},
        json={"conversation_id": "c_1", "message": "explain gravity", "model": "thinking", "reasoning_effort": "high"},
    )
    assert resp.status_code == 200
    list(resp.response)
    assert captured_kwargs.get("reasoning_effort") == "high"

    resp = client.post(
        "/chat",
        headers={"Authorization": f"Bearer {token}"},
        json={"conversation_id": "c_2", "message": "explain gravity", "model": "deep", "reasoning_effort": "high"},
    )
    assert resp.status_code == 200
    list(resp.response)
    assert captured_kwargs.get("reasoning_effort") == "high"

    # 4. Voice assistant / client passing 'off' or 'none' is accepted and normalized
    resp = client.post(
        "/chat",
        headers={"Authorization": f"Bearer {token}"},
        json={"conversation_id": "c_1", "message": "hello voice", "model": "aeon", "reasoning_effort": "off"},
    )
    assert resp.status_code == 200
    list(resp.response)
    assert captured_kwargs.get("reasoning_effort") is None

    resp = client.post(
        "/chat",
        headers={"Authorization": f"Bearer {token}"},
        json={"conversation_id": "c_1", "message": "hello voice", "model": "aeon", "reasoning_effort": "none"},
    )
    assert resp.status_code == 200
    list(resp.response)
    assert captured_kwargs.get("reasoning_effort") is None


def test_scrape_endpoint(client, monkeypatch):
    import time
    import jwt
    import requests

    claims = {
        "sub": "test_scrape_user",
        "email": "scrape@test.com",
        "aud": "authenticated",
        "iss": "https://example.supabase.co/auth/v1",
        "exp": int(time.time()) + 3600,
    }
    token = jwt.encode(claims, "test-jwt-secret", algorithm="HS256")
    headers = {"Authorization": f"Bearer {token}"}

    # 1. Missing URL -> 422
    res = client.post("/scrape", headers=headers, json={})
    assert res.status_code == 422

    # 2. Web scraping not configured (no key) -> 503
    monkeypatch.delenv("TINYFISH_API_KEY", raising=False)
    res = client.post("/scrape", headers=headers, json={"url": "example.com"})
    assert res.status_code == 503

    # 3. Successful scrape with mock TinyFish response
    monkeypatch.setenv("TINYFISH_API_KEY", "tf-test-key")

    class MockResponse:
        def __init__(self, status_code, json_data):
            self.status_code = status_code
            self._json = json_data

        def raise_for_status(self):
            if self.status_code >= 400:
                raise requests.HTTPError(f"HTTP {self.status_code}")

        def json(self):
            return self._json

    captured_req = {}
    def mock_post(url, **kwargs):
        captured_req["url"] = url
        captured_req.update(kwargs)
        return MockResponse(200, {
            "results": [
                {
                    "url": "https://example.com",
                    "final_url": "https://example.com",
                    "title": "Example Domain",
                    "description": "Example Domain description",
                    "text": "# Example Domain\nThis domain is for use in illustrative examples.",
                    "format": "markdown",
                }
            ],
            "errors": [],
        })

    monkeypatch.setattr(requests, "post", mock_post)

    res = client.post("/scrape", headers=headers, json={"url": "example.com"})
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    assert "Example Domain" in data["markdown"]
    assert data["title"] == "Example Domain"
    assert data["url"] == "https://example.com"
    assert captured_req["url"] == "https://api.fetch.tinyfish.ai"
    assert captured_req["headers"]["X-API-Key"] == "tf-test-key"
    assert captured_req["json"]["urls"] == ["https://example.com"]
    assert captured_req["json"]["format"] == "markdown"

    # 4. TinyFish error -> 502
    def mock_post_err(url, **kwargs):
        raise requests.RequestException("TinyFish down")

    monkeypatch.setattr(requests, "post", mock_post_err)
    res = client.post("/scrape", headers=headers, json={"url": "https://example.com"})
    assert res.status_code == 502


def test_search_endpoint(client, monkeypatch):
    import time
    import jwt
    import requests

    claims = {
        "sub": "test_search_user",
        "email": "search@test.com",
        "aud": "authenticated",
        "iss": "https://example.supabase.co/auth/v1",
        "exp": int(time.time()) + 3600,
    }
    token = jwt.encode(claims, "test-jwt-secret", algorithm="HS256")
    headers = {"Authorization": f"Bearer {token}"}

    # 1. Missing query -> 422
    res = client.post("/search", headers=headers, json={})
    assert res.status_code == 422

    # 2. Web search not configured (no key) -> 503
    monkeypatch.delenv("TINYFISH_API_KEY", raising=False)
    res = client.post("/search", headers=headers, json={"query": "python"})
    assert res.status_code == 503

    # 3. Successful search with mock TinyFish response
    monkeypatch.setenv("TINYFISH_API_KEY", "tf-test-key")

    class MockResponse:
        def __init__(self, status_code, json_data):
            self.status_code = status_code
            self._json = json_data

        def raise_for_status(self):
            if self.status_code >= 400:
                raise requests.HTTPError(f"HTTP {self.status_code}")

        def json(self):
            return self._json

    captured_req = {}
    def mock_get(url, **kwargs):
        captured_req["url"] = url
        captured_req.update(kwargs)
        return MockResponse(200, {
            "query": "python news",
            "results": [
                {
                    "position": 1,
                    "title": "Python 3.14 Released",
                    "snippet": "Python 3.14 is now available with major improvements.",
                    "url": "https://python.org/news/3.14",
                    "date": "2026-09-01",
                }
            ],
        })

    monkeypatch.setattr(requests, "get", mock_get)

    res = client.post("/search", headers=headers, json={"query": "python news"})
    assert res.status_code == 200
    data = res.get_json()
    assert len(data["results"]) == 1
    assert data["results"][0]["title"] == "Python 3.14 Released"
    assert data["results"][0]["content"] == "Python 3.14 is now available with major improvements."
    assert data["results"][0]["url"] == "https://python.org/news/3.14"
    assert data["results"][0]["published_date"] == "2026-09-01"
    assert captured_req["url"] == "https://api.search.tinyfish.ai/"
    assert captured_req["headers"]["X-API-Key"] == "tf-test-key"
    assert captured_req["params"]["query"].startswith("python news")
    assert captured_req["params"]["domain_type"] == "news"

    # 4. TinyFish error -> 502
    def mock_get_err(url, **kwargs):
        raise requests.RequestException("TinyFish down")

    monkeypatch.setattr(requests, "get", mock_get_err)
    res = client.post("/search", headers=headers, json={"query": "python"})
    assert res.status_code == 502


# ---------- Autonomous web search router ----------

@pytest.mark.parametrize(
    ("prompt", "expected"),
    [
        ("Hello Bimo", False),
        ("hi", False),
        ("thanks!", False),
        ("Explain photosynthesis", False),
        ("What is the derivative of x^2?", False),
        ("Write a quicksort function", False),
        ("write a python script that reverses a string", False),
        ("help me write a cover letter", False),
        ("who are you", False),
        ("what model are you", False),
        ("who was the first president of the United States", False),
        ("What is the price of Bitcoin today?", True),
        ("Who won yesterday's Champions League match?", True),
        ("Latest tech news this week", True),
        ("what's the weather in Lahore right now", True),
        ("current NVDA stock price", True),
        ("who is the CEO of Twitter", True),
        ("when is the next SpaceX launch", True),
        ("what is the latest version of React", True),
    ],
)
def test_should_search_rules_decide_without_the_classifier(prompt, expected, monkeypatch):
    """Tier 1 must settle every obvious prompt on its own.

    The classifier is replaced with a landmine: if any of these prompts reaches
    it, the test fails. That is both the correctness check and the latency
    guarantee, since Tier 1 is pure Python and never touches the network.
    """
    from app import search_router

    def landmine(*args, **kwargs):
        raise AssertionError(f"Tier 2 classifier was invoked for {prompt!r}")

    monkeypatch.setattr(search_router, "_classify", landmine)

    needs_search, query = search_router.should_search(prompt)
    assert needs_search is expected
    if expected:
        assert query


def test_should_search_drops_hey_bimo_from_the_retrieval_query(monkeypatch):
    from app import search_router

    monkeypatch.setattr(search_router, "_classify", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("classifier should not run")
    ))

    needs, query = search_router.should_search(
        "Hey Bimo, what are the key takeaways from today's UCL matches?"
    )
    assert needs is True
    assert query == "what are the key takeaways from today's UCL matches?"
    assert "bimo" not in query.lower()

    needs, query = search_router.should_search("Bimo, bitcoin price today")
    assert needs is True
    assert query == "bitcoin price today"


def test_should_search_skips_when_attachments_are_present(monkeypatch):
    """A question about an uploaded file is grounded in the file, not the web."""
    from app import search_router

    monkeypatch.setattr(search_router, "_classify", lambda *a, **k: (True, "x"))

    needs_search, _ = search_router.should_search(
        "what's in this screenshot?", has_attachments=True
    )
    assert needs_search is False


def test_image_plus_which_is_best_still_searches(monkeypatch):
    """A file on the turn must not block a question that needs live facts."""
    from app import search_router

    monkeypatch.setattr(
        search_router,
        "_classify",
        lambda query, history=None, reformulate_only=False: (
            True,
            "ministral 3 8b vs codestral 2508 benchmarks",
        ),
    )
    needs, query = search_router.should_search(
        "from these two mistral models which one is best overall",
        has_attachments=True,
    )
    assert needs is True
    assert query


def test_search_classifier_defaults_to_aeon_qwen(monkeypatch):
    """The Groq search classifier must use Aeon (Qwen 3.8), not retired Llama ids."""
    from app import groq_client, search_router
    from app.config import get_aeon_model

    monkeypatch.delenv("SEARCH_CLASSIFIER_MODEL", raising=False)
    monkeypatch.setattr(groq_client, "is_configured", lambda: True)
    monkeypatch.setattr(search_router.mistral_client, "is_configured", lambda: False)

    backends = search_router._classifier_backends()
    assert backends[0][0] == "groq"
    assert backends[0][2] == get_aeon_model()
    assert "llama-3.1-8b-instant" not in backends[0][2]


def test_which_is_best_and_benchmarks_always_search(monkeypatch):
    """Follow-ups like 'which is best' must search without the user saying search."""
    from app import search_router

    monkeypatch.setattr(
        search_router,
        "_classify",
        lambda query, history=None, reformulate_only=False: (
            True,
            "ministral 3 8b vs codestral 2508 benchmarks",
        ),
    )
    history = [
        {"role": "assistant", "content": "The two models are Ministral 3 8B and Codestral 2508."},
    ]
    for prompt in (
        "which model is best model",
        "which is better",
        "compare both models",
        "search for both benchmarks and tell me which is best",
    ):
        needs, query = search_router.should_search(prompt, history=history)
        assert needs is True, prompt
        assert query


def test_should_search_defers_ambiguous_prompts_to_the_classifier(monkeypatch):
    from app import search_router

    seen = {}

    def fake_classify(query, history=None, reformulate_only=False):
        seen["query"] = query
        return True, "openai board composition 2026"

    monkeypatch.setattr(search_router, "_classify", fake_classify)

    needs_search, query = search_router.should_search("who sits on the OpenAI board")
    assert needs_search is True
    assert query == "openai board composition 2026"
    assert seen["query"] == "who sits on the OpenAI board"


def test_should_search_fails_open_when_the_classifier_is_unavailable(monkeypatch):
    """No Groq key, no Mistral key, or a timeout must never block the answer."""
    from app import search_router

    monkeypatch.setattr(search_router, "_classify", lambda *a, **k: None)

    needs_search, _ = search_router.should_search("who sits on the OpenAI board")
    assert needs_search is False


def test_should_search_honours_a_negative_classifier_verdict(monkeypatch):
    from app import search_router

    monkeypatch.setattr(search_router, "_classify", lambda *a, **k: (False, ""))

    needs_search, _ = search_router.should_search("status of the artemis program")
    assert needs_search is False


def test_force_search_overrides_the_rules_but_still_reformulates(monkeypatch):
    from app import search_router

    calls = []

    def fake_classify(query, history=None, reformulate_only=False):
        calls.append(reformulate_only)
        return True, "bimo ai assistant"

    monkeypatch.setattr(search_router, "_classify", fake_classify)

    needs_search, query = search_router.should_search("Hello Bimo", force=True)
    assert needs_search is True
    assert query == "bimo ai assistant"
    assert calls == [True]


def test_force_search_falls_back_to_the_raw_prompt(monkeypatch):
    from app import search_router

    monkeypatch.setattr(search_router, "_classify", lambda *a, **k: None)

    needs_search, query = search_router.should_search("Hello Bimo", force=True)
    assert needs_search is True
    assert query == "Hello Bimo"


def test_run_search_normalizes_tinyfish_results(monkeypatch):
    import requests

    from app import search_router

    monkeypatch.setenv("TINYFISH_API_KEY", "tf-test-key")

    class MockResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "results": [
                    {
                        "title": "Bitcoin price",
                        "snippet": "BTC trades at 91,204 USD.",
                        "url": "https://example.com/btc",
                        "date": "2026-09-09",
                    }
                ]
            }

    captured = {}

    def mock_get(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return MockResponse()

    monkeypatch.setattr(requests, "get", mock_get)

    results = search_router.run_search("bitcoin price today")
    assert results == [
        {
            "title": "Bitcoin price",
            "content": "BTC trades at 91,204 USD.",
            "url": "https://example.com/btc",
            "published_date": "2026-09-09",
        }
    ]
    assert captured["url"] == "https://api.search.tinyfish.ai/"
    assert captured["headers"]["X-API-Key"] == "tf-test-key"
    assert captured["params"]["query"].startswith("bitcoin price today")
    assert captured["params"]["domain_type"] == "news"


def test_run_search_orders_results_newest_first(monkeypatch):
    import requests

    from app import search_router

    monkeypatch.setenv("TINYFISH_API_KEY", "tf-test-key")

    class MockResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "results": [
                    {
                        "title": "Old story",
                        "snippet": "From last month.",
                        "url": "https://example.com/old",
                        "date": "2026-08-01",
                    },
                    {
                        "title": "Fresh story",
                        "snippet": "From today.",
                        "url": "https://example.com/new",
                        "date": "2026-09-11",
                    },
                ]
            }

    monkeypatch.setattr(requests, "get", lambda *a, **k: MockResponse())
    results = search_router.run_search("latest AI news")
    assert [r["title"] for r in results] == ["Fresh story", "Old story"]


def test_run_search_falls_back_to_web_when_news_is_empty(monkeypatch):
    import requests

    from app import search_router

    monkeypatch.setenv("TINYFISH_API_KEY", "tf-test-key")
    calls = []

    class MockResponse:
        def __init__(self, results):
            self.status_code = 200
            self._results = results

        def raise_for_status(self):
            return None

        def json(self):
            return {"results": self._results}

    def mock_get(url, **kwargs):
        params = kwargs.get("params") or {}
        calls.append(params)
        if params.get("domain_type") == "news":
            return MockResponse([])
        return MockResponse([{
            "title": "UCL takeaways",
            "snippet": "City drew 1-1.",
            "url": "https://example.com/ucl",
            "date": "2026-09-10",
        }])

    monkeypatch.setattr(requests, "get", mock_get)

    results = search_router.run_search("Hey Bimo, today's UCL matches?")
    assert [c.get("domain_type") for c in calls] == ["news", None]
    assert results[0]["title"] == "UCL takeaways"
    assert results[0]["url"] == "https://example.com/ucl"


def test_run_search_returns_empty_instead_of_raising(monkeypatch):
    import requests

    from app import search_router

    monkeypatch.setenv("TINYFISH_API_KEY", "tf-test-key")

    def mock_get(url, **kwargs):
        raise requests.RequestException("TinyFish down")

    monkeypatch.setattr(requests, "get", mock_get)
    assert search_router.run_search("bitcoin price today") == []

    monkeypatch.delenv("TINYFISH_API_KEY", raising=False)
    assert search_router.run_search("bitcoin price today") == []


def test_build_search_context_wraps_results_in_boundary_tags():
    from app import search_router

    context = search_router.build_search_context(
        "bitcoin price today",
        [
            {
                "title": "Bitcoin price",
                "content": "BTC trades at 91,204 USD.",
                "url": "https://example.com/btc",
                "published_date": "2026-09-09",
            }
        ],
    )
    assert context.startswith("<live_web_search")
    assert context.endswith("</live_web_search>")
    assert "Bitcoin price" in context
    assert "91,204" in context
    assert "without sources, citations, URLs, or Source links" in context
    assert "ordered newest-first" in context
    assert "Today is" in context
    assert "[Source](" not in context
    assert "https://example.com/btc" not in context
    assert "URL:" not in context

    mixed = search_router.build_search_context(
        "latest AI news",
        [
            {
                "title": "Old",
                "content": "Old blurb.",
                "url": "https://example.com/old",
                "published_date": "2026-08-01",
            },
            {
                "title": "New",
                "content": "New blurb.",
                "url": "https://example.com/new",
                "published_date": "2026-09-11",
            },
        ],
    )
    assert mixed.index("Title: New") < mixed.index("Title: Old")


def _search_chat_token():
    import time

    import jwt

    claims = {
        "sub": "test_autosearch_user",
        "email": "autosearch@test.com",
        "aud": "authenticated",
        "iss": "https://example.supabase.co/auth/v1",
        "exp": int(time.time()) + 3600,
    }
    return jwt.encode(claims, "test-jwt-secret", algorithm="HS256")


def _stub_chat_persistence(monkeypatch):
    from app import store

    monkeypatch.setattr(
        "app.routes.chat_routes.get_usage_status",
        lambda uid: {"blocked": False, "session": {"used": 0, "limit": 100000}, "weekly": {"used": 0, "limit": 1000000}},
    )
    monkeypatch.setattr(store, "recent_usage_events", lambda *a, **k: [])
    monkeypatch.setattr(store, "get_conversation", lambda cid, uid: {"id": cid, "user_id": uid, "model": "thinking"})
    monkeypatch.setattr(store, "update_conversation", lambda cid, uid, patch: {"id": cid, "user_id": uid, **patch})
    monkeypatch.setattr(store, "get_messages", lambda cid, limit=None: [])
    monkeypatch.setattr(store, "add_message", lambda *a, **k: {"id": "m_search", "role": k.get("role", "assistant")})
    monkeypatch.setattr(store, "touch_conversation", lambda cid, uid: None)
    monkeypatch.setattr(store, "record_usage", lambda *a, **k: None)


def test_chat_streams_search_events_and_augments_the_prompt(client, monkeypatch):
    """An auto-searched turn tells the UI it is searching, then answers with context."""
    from app import search_router

    _stub_chat_persistence(monkeypatch)

    monkeypatch.setattr(search_router, "should_search", lambda *a, **k: (True, "bitcoin price today"))
    monkeypatch.setattr(
        search_router,
        "run_search",
        lambda query, **k: [
            {
                "title": "Bitcoin price",
                "content": "BTC trades at 91,204 USD.",
                "url": "https://example.com/btc",
                "published_date": "2026-09-09",
            }
        ],
    )

    captured = {}

    def mock_stream(messages, **kwargs):
        captured["messages"] = messages
        yield {"type": "delta", "data": "Bitcoin is at 91,204 USD."}
        yield {"type": "done", "content": "Bitcoin is at 91,204 USD."}

    monkeypatch.setattr("app.nvidia_client.iter_response_with_fallback", mock_stream)

    resp = client.post(
        "/chat",
        headers={"Authorization": f"Bearer {_search_chat_token()}"},
        json={"conversation_id": "c_autosearch", "message": "What is the price of Bitcoin today?"},
    )
    assert resp.status_code == 200
    body = resp.get_data(as_text=True)

    assert '"type": "searching"' in body
    assert "bitcoin price today" in body
    assert '"type": "search_complete"' in body

    # The search card in the UI is driven straight off this payload.
    search_done = next(
        json.loads(line[5:])
        for line in body.splitlines()
        if line.startswith("data:") and '"search_complete"' in line
    )
    assert search_done["count"] == 1
    assert search_done["elapsed_ms"] >= 0
    assert search_done["results"] == [
        {
            "title": "Bitcoin price",
            "url": "https://example.com/btc",
            "snippet": "BTC trades at 91,204 USD.",
            "published_date": "2026-09-09",
        }
    ]

    last_user = [m for m in captured["messages"] if m["role"] == "user"][-1]
    content = last_user["content"]
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if p.get("type") == "text")
    assert "<live_web_search" in content
    assert "Bitcoin price" in content
    assert "91,204" in content
    assert "https://example.com/btc" not in content
    assert "What is the price of Bitcoin today?" in content


def test_chat_skips_search_when_the_router_declines(client, monkeypatch):
    from app import search_router

    _stub_chat_persistence(monkeypatch)

    monkeypatch.setattr(search_router, "should_search", lambda *a, **k: (False, ""))

    def landmine(*a, **k):
        raise AssertionError("run_search must not be called when the router declines")

    monkeypatch.setattr(search_router, "run_search", landmine)

    captured = {}

    def mock_stream(messages, **kwargs):
        captured["messages"] = messages
        yield {"type": "delta", "data": "Photosynthesis converts light into sugar."}
        yield {"type": "done", "content": "Photosynthesis converts light into sugar."}

    monkeypatch.setattr("app.nvidia_client.iter_response_with_fallback", mock_stream)

    resp = client.post(
        "/chat",
        headers={"Authorization": f"Bearer {_search_chat_token()}"},
        json={"conversation_id": "c_nosearch", "message": "Explain photosynthesis"},
    )
    assert resp.status_code == 200
    body = resp.get_data(as_text=True)
    assert '"type": "searching"' not in body

    last_user = [m for m in captured["messages"] if m["role"] == "user"][-1]
    content = last_user["content"]
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if p.get("type") == "text")
    assert "<live_web_search" not in content


def test_chat_auto_search_can_be_disabled_by_the_client(client, monkeypatch):
    from app import search_router

    _stub_chat_persistence(monkeypatch)

    def landmine(*a, **k):
        raise AssertionError("should_search must not run when auto_search is off")

    monkeypatch.setattr(search_router, "should_search", landmine)

    def mock_stream(messages, **kwargs):
        yield {"type": "delta", "data": "ok"}
        yield {"type": "done", "content": "ok"}

    monkeypatch.setattr("app.nvidia_client.iter_response_with_fallback", mock_stream)

    resp = client.post(
        "/chat",
        headers={"Authorization": f"Bearer {_search_chat_token()}"},
        json={
            "conversation_id": "c_autosearch_off",
            "message": "What is the price of Bitcoin today?",
            "auto_search": False,
        },
    )
    assert resp.status_code == 200
    assert '"type": "searching"' not in resp.get_data(as_text=True)


def test_chat_survives_a_search_that_returns_nothing(client, monkeypatch):
    """A failed or empty search still closes the bubble and answers the question."""
    from app import search_router

    _stub_chat_persistence(monkeypatch)

    monkeypatch.setattr(search_router, "should_search", lambda *a, **k: (True, "bitcoin price today"))
    monkeypatch.setattr(search_router, "run_search", lambda query, **k: [])

    captured = {}

    def mock_stream(messages, **kwargs):
        captured["messages"] = messages
        yield {"type": "delta", "data": "I could not reach live pricing."}
        yield {"type": "done", "content": "I could not reach live pricing."}

    monkeypatch.setattr("app.nvidia_client.iter_response_with_fallback", mock_stream)

    resp = client.post(
        "/chat",
        headers={"Authorization": f"Bearer {_search_chat_token()}"},
        json={"conversation_id": "c_emptysearch", "message": "What is the price of Bitcoin today?"},
    )
    assert resp.status_code == 200
    body = resp.get_data(as_text=True)
    assert '"type": "searching"' in body
    assert '"type": "search_complete"' in body
    assert '"count": 0' in body

    last_user = [m for m in captured["messages"] if m["role"] == "user"][-1]
    content = last_user["content"]
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if p.get("type") == "text")
    assert "<live_web_search" not in content





