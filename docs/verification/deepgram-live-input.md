# Deepgram live input — 2026-11-15

The composer mic and Voice assistant use Nova-3 with interim results. Mono PCM is captured by an AudioWorklet and sent every 80 ms at the actual browser sample rate. The gateway authenticates the user and rate-limits token grants to 20/minute; a 30-second Deepgram JWT permits direct browser streaming without exposing the permanent API key. Existing REST transcription remains Voice's recovery path.

The composer keeps its draft visible, replaces interim hypotheses, waits for the final audio flush on confirm, and restores the original draft on cancel. Its recording bar offers a recognition-language dropdown. Voice uses the same client on its existing microphone stream. Its selector provides Auto plus all 42 Flux TTS languages, including Urdu. All selected voices are explicit documented Flux model IDs. The default English voice is Hannah. The original orb and surrounding Voice layout remain unchanged.

Auto uses Nova-3 multilingual language metadata to choose the reply language and matching Flux voice. **Nova-3 multilingual does not include Urdu; select Urdu explicitly in either language dropdown.** Nova-3 supports `language=ur`. The explicit selection is shared between composer and Voice. Multilingual detection can recognize languages outside Flux's catalog; unsupported detected languages do not select an invented TTS voice.

Final STT word timing and measured microphone volume provide weak gentle/neutral/lively delivery hints. Conversation context takes priority through the existing voice-style marker. Flux expression stays within -1/0/1. Non-English connections omit custom speed because that control is not supported uniformly across languages. This is contextual delivery adaptation, not a verified emotion detector. Several Flux languages, including Urdu, remain provider Early Access; numbers and dates are written in words in the response language.

## Render

Keep/set `DEEPGRAM_API_KEY` to a valid Deepgram API key with **Member permissions** (required by `/v1/auth/grant`). Set `DEEPGRAM_TTS_MODEL=flux-hannah-en` for the server's English fallback. Nova-3 is selected in code, so no STT model env variable is required. Save and deploy the latest commit. No database migration or new dependency is required. Do not place the permanent key in Vercel or browser configuration.

## Verification

Automated tests cover auth and sanitized provider failures, credential lifetime/no-store response, interim/final merging, audio flush ordering, cancellation, draft preservation, language changes, Urdu, automatic voice selection, and recovery from streaming failure without truncating a question.

Final suite results: **106 frontend tests passed; 421 backend tests passed**. Backend emits 105 existing dependency deprecation warnings. [Browser evidence](deepgram-live-input-browser.json) records real 48 kHz PCM packets sent before stop, explicit Urdu captions/model selection, and microphone cleanup.

Chromium smoke testing uses real AudioContext/AudioWorklet PCM capture and real MediaRecorder recovery capture with a synthetic microphone. Deepgram credential and transcript responses are mocked. It verifies nonzero PCM packets sent while recording, live composer text, final flush, an explicit Urdu STT request with Flux Urdu voice, and released microphone tracks. A local Deepgram API key is unavailable, so live-provider recognition accuracy, pronunciation across all languages, and physical-phone behavior remain unverified.

## Authoritative references

- [Nova-3 languages](https://developers.deepgram.com/docs/models-languages-overview)
- [Nova-3 streaming protocol](https://developers.deepgram.com/reference/speech-to-text/listen-streaming)
- [Temporary token authentication and Member permission requirement](https://developers.deepgram.com/guides/fundamentals/token-based-authentication)
- [CloseStream finalization](https://developers.deepgram.com/docs/close-stream)
- [Flux voice catalog](https://developers.deepgram.com/docs/flux-tts/voices)
- [Flux streaming lifecycle](https://developers.deepgram.com/docs/flux-tts/quickstart)
- [Flux expressivity](https://developers.deepgram.com/docs/tts-expressivity)
