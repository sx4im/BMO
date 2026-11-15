# Deepgram live input — 2026-11-15

The Voice assistant uses Nova-3 with interim results. Mono PCM is captured by an AudioWorklet and sent every 80 ms at the actual browser sample rate. The gateway authenticates the user and rate-limits token grants to 20/minute; a 30-second Deepgram JWT permits direct browser streaming without exposing the permanent API key. REST transcription remains Voice's recovery path.

The composer uses the record-first flow: its recording bar replaces the input while it records locally, then confirmation converts the complete clip to WAV and calls `/transcribe`. Text is appended only after transcription finishes. Cancel discards the recording or aborts an in-progress upload and preserves the exact draft. Its language selector is removed; every composer request uses Nova-3 multilingual recognition, regardless of previous Voice preferences. Composer does not request a streaming token. `/transcribe` uses server-side Nova-3 when Deepgram is configured; the original Riva/REST providers remain available when no Deepgram key is set.

Voice keeps streaming on its existing microphone stream. Its selector provides **Auto** plus all 42 Flux TTS languages, including Urdu. The native selector retains keyboard/mobile operation, with a custom arrow inset 14 px and a compact width that follows the selected label. All selected voices are explicit documented Flux model IDs. The default English voice is Hannah. The prompt explicitly supports all 42 catalog languages. The original orb and surrounding Voice layout remain unchanged.

Auto uses Nova-3 multilingual language metadata to choose the reply language and matching Flux voice. **Nova-3 multilingual does not include Urdu; select Urdu explicitly in Voice.** Nova-3 supports `language=ur`. The composer always uses multilingual detection and no longer inherits Voice's explicit preference. Multilingual detection can recognize languages outside Flux's catalog; unsupported detected languages do not select an invented TTS voice.

## Continuous conversation

The user selected a **4,000 ms pause after speech**. Nova-3 endpointing, local VAD, and native-recognition fallback use that threshold. A provider endpoint is ignored when the microphone already shows resumed speech. Idle waiting no longer stops after eight seconds. Silent backup recordings renew after 60 seconds without submitting a user turn; spoken takes retain a five-minute safety cap. Empty successful takes return to listening instead of leaving the microphone off.

After playback finishes, the mic reopens automatically after the existing 250 ms echo-clearance gap. The restart timer is canceled on interruption/close and checked against the current turn; microphone requests use sequence guards to prevent duplicate or stale captures. The pause and idle-wait settings are separate: thinking before a question does not end the call.

Final STT word timing and measured microphone volume provide weak gentle/neutral/lively delivery hints. Conversation context takes priority through the existing voice-style marker. Flux expression stays within -1/0/1. Non-English connections omit custom speed because that control is not supported uniformly across languages. This is contextual delivery adaptation, not a verified emotion detector. Several Flux languages, including Urdu, remain provider Early Access; numbers and dates are written in words in the response language.

## Render

Keep/set `DEEPGRAM_API_KEY` to a valid Deepgram API key with **Member permissions** (required by Voice's `/v1/auth/grant`; recorded composer requests only need transcription access). Create a key in Deepgram Console → API Keys → Create Key → Advanced → Member, then replace the Render variable and save/deploy the latest commit. Set `DEEPGRAM_TTS_MODEL=flux-hannah-en` for the server's English fallback. Nova-3 is selected in code, so no STT model env variable is required. No database migration or new dependency is required. Do not place the permanent key in Vercel or browser configuration.

## Verification

Automated tests cover auth and sanitized provider failures, credential lifetime/no-store response, interim/final merging, audio flush ordering, cancellation, draft preservation, language changes, Urdu, automatic voice selection, and recovery from streaming failure without truncating a question.

Current suite results: **116 frontend tests and 426 backend tests passed**, with 105 existing backend dependency deprecation warnings. [Original streaming browser evidence](deepgram-live-input-browser.json) records the initial release; [record-first correction evidence](composer-record-first-browser.json) verifies that the composer sends no audio or token requests before confirmation, then uploads a nonempty 16 kHz mono WAV and appends text afterward. Tests now also cover selector removal, the four-second speech gap, waiting beyond the old eight-second cutoff, a second spoken question without tapping, incidental sound with no recognized words, canceling a scheduled microphone restart, and a stopped take being superseded by a typed question.

[Continuous-call browser evidence](voice-call-browser.json) verifies two actual capture/playback rounds without tapping, a ten-second thinking pause between questions, microphone cleanup, and the 88 px Auto selector with 14 px arrow inset. Mobile theme captures: [light](voice-call-mobile.png), [dark](voice-call-mobile-dark.png).

Chromium smoke testing uses real AudioContext/AudioWorklet PCM capture and real MediaRecorder capture/conversion with a synthetic microphone. Deepgram credential and transcript responses are mocked. A local Deepgram API key is unavailable, so live-provider recognition accuracy, pronunciation across all languages, and physical-phone behavior remain unverified.

## Authoritative references

- [Nova-3 languages](https://developers.deepgram.com/docs/models-languages-overview)
- [Nova-3 streaming protocol](https://developers.deepgram.com/reference/speech-to-text/listen-streaming)
- [Temporary token authentication and Member permission requirement](https://developers.deepgram.com/guides/fundamentals/token-based-authentication)
- [CloseStream finalization](https://developers.deepgram.com/docs/close-stream)
- [Flux voice catalog](https://developers.deepgram.com/docs/flux-tts/voices)
- [Flux streaming lifecycle](https://developers.deepgram.com/docs/flux-tts/quickstart)
- [Flux expressivity](https://developers.deepgram.com/docs/tts-expressivity)
