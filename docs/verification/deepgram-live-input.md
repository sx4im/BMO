# Deepgram live input — 2026-11-15

The Voice assistant uses Nova-3 with interim results. Mono PCM is captured by an AudioWorklet and sent every 80 ms at the actual browser sample rate. The gateway authenticates the user and rate-limits token grants to 20/minute; a 30-second Deepgram JWT permits direct browser streaming without exposing the permanent API key. REST transcription remains Voice's recovery path.

The composer uses the record-first flow: its recording bar replaces the input while it records locally, then confirmation converts the complete clip to WAV and calls `/transcribe`. Text is appended only after transcription finishes. Cancel discards the recording or aborts an in-progress upload and preserves the exact draft. Its language selector is removed; every composer request uses Nova-3 multilingual recognition, regardless of previous Voice preferences. Composer does not request a streaming token. `/transcribe` uses server-side Nova-3 when Deepgram is configured; the original Riva/REST providers remain available when no Deepgram key is set.

Voice keeps streaming on its existing microphone stream. Its selector provides **Auto** plus all 42 Flux TTS languages, including Urdu. The native selector retains keyboard/mobile operation, with a custom arrow inset 14 px and a compact width that follows the selected label. All selected voices are explicit documented Flux model IDs. The default English voice is Hannah. The prompt explicitly supports all 42 catalog languages. The original orb and surrounding Voice layout remain unchanged.

Auto uses Nova-3 multilingual language metadata to choose the reply language and matching Flux voice. **Nova-3 multilingual does not include Urdu; select Urdu explicitly in Voice.** Nova-3 supports `language=ur`. The composer always uses multilingual detection and no longer inherits Voice's explicit preference. Multilingual detection can recognize languages outside Flux's catalog; unsupported detected languages do not select an invented TTS voice.

## Continuous conversation

Normal Voice submission now uses **semantic turn completion**, preserving Nova-3 and all existing language choices. After 300 ms of stable captions and microphone quiet, `/voice/turn` asks the existing Groq model whether the utterance is a completed question, request, or contextual short answer. An unfinished phrase receives a negative verdict and remains open for more words, regardless of elapsed silence. New words, resumed audio, clearing a caption, closing Voice, changing language, or a typed turn cancel outstanding decisions. Only a current positive verdict closes capture; Nova-3 is flushed before its finalized transcript is submitted. Prior assistant context is limited to 1,200 characters; transcript input to the classifier is limited to its last 6,000 characters. Source text sent to chat is not truncated.

The completion endpoint requires authentication, limits each user to 120 checks/minute, disables model retries, applies a one-second provider request timeout, and validates a JSON boolean. The client bounds each check to 1.8 seconds including transport. Each stable transcript/audio revision is evaluated once; a negative verdict does not cause polling during a thinking pause. Groq reasoning is disabled for Qwen, with low reasoning effort for GPT-OSS; the existing Mistral client is used only if Groq is not configured. There is no second provider retry on a failed check. These are bounded request settings, not a guarantee of live response latency or classification accuracy.

A four-second pause is retained **only for service outages or compatibility recovery**, including a missing live caption source. It cannot override a valid incomplete semantic verdict. A failed semantic service produces one explanatory toast per overlay. Nova-3's four-second `speech_final` endpoint remains transcript segmentation/recovery metadata, rather than normal turn-submission authority. The local VAD uses waveform RMS relative to room level, accounts for startup gain ramp, and does not learn sustained speech as background. Continued captions reset the recovery quiet window. Recorded-only browsers and lost caption connections recover using the full recording instead of waiting for a semantic verdict that cannot arrive.

Idle waiting no longer stops after eight seconds. Silent backup recordings renew after 60 seconds without submitting a user turn; spoken takes retain a five-minute safety cap. Empty successful takes return to listening instead of leaving the microphone off.

After playback finishes, the mic reopens automatically after the existing 250 ms echo-clearance gap. The restart timer is canceled on interruption/close and checked against the current turn; microphone requests use sequence guards to prevent duplicate or stale captures. Thinking before a question or during an incomplete thought does not end the call.

Final STT word timing and measured microphone volume provide weak gentle/neutral/lively delivery hints. Conversation context takes priority through the existing voice-style marker. Flux expression stays within -1/0/1. Non-English connections omit custom speed because that control is not supported uniformly across languages. This is contextual delivery adaptation, not a verified emotion detector. Several Flux languages, including Urdu, remain provider Early Access; numbers and dates are written in words in the response language.

## Render

Keep/set `DEEPGRAM_API_KEY` to a valid Deepgram API key with **Member permissions** (required by Voice's `/v1/auth/grant`; recorded composer requests only need transcription access). Create a key in Deepgram Console → API Keys → Create Key → Advanced → Member, then replace the Render variable and save/deploy the latest commit. Set `DEEPGRAM_TTS_MODEL=flux-hannah-en` for the server's English fallback. Nova-3 is selected in code, so no STT model env variable is required. Semantic checks reuse `GROQ_API_KEY` and the existing Groq model setting. `VOICE_TURN_MODEL` optionally overrides that Groq model; it is not required. If Groq is absent, the existing `MISTRAL_API_KEY`/`MISTRAL_MODEL` configuration is used. No database migration or new dependency is required. Do not place the permanent key in Vercel or browser configuration.

## Verification

Automated tests cover auth and sanitized provider failures, credential lifetime/no-store response, interim/final merging, audio flush ordering, cancellation, draft preservation, language changes, Urdu, automatic voice selection, and recovery from streaming failure without truncating a question.

Current suite results: **139 frontend tests and 436 backend tests passed**, with 105 existing backend dependency deprecation warnings. [Original streaming browser evidence](deepgram-live-input-browser.json) records the initial release; [record-first correction evidence](composer-record-first-browser.json) verifies that the composer sends no audio or token requests before confirmation, then uploads a nonempty 16 kHz mono WAV and appends text afterward. Tests also cover selector removal, pause-based recovery, waiting beyond the old eight-second cutoff, a second spoken question without tapping, incidental sound with no recognized words, canceling a scheduled microphone restart, and a stopped take being superseded by a typed question.

[Continuous-call browser evidence](voice-call-browser.json) verifies two actual capture/playback rounds without tapping, a ten-second thinking pause between questions, microphone cleanup, and the 88 px Auto selector with 14 px arrow inset. Mobile theme captures: [light](voice-call-mobile.png), [dark](voice-call-mobile-dark.png).

Historical [noisy-room automatic submission evidence](voice-auto-send-noise-browser.json) repeats two questions over persistent synthetic background audio. The mocked provider emits no `speech_final` event, so both submissions must come from the local four-second detector. It verifies automatic listening restart and microphone cleanup. Unit regressions also cover provider endpoints over noise, sustained speech, speech beginning during calibration, softer continued speech with new words, and startup gain ramp.

[Semantic completion browser evidence](voice-semantic-browser.json) exercises an unfinished phrase remaining open past the old four-second cutoff, a completed question submitting without `speech_final`, and a second question without tapping. It preserves the composer confirmation flow, 88 px Auto selector, orange orb, and releases all microphone tracks on close. The measured completion timing is for the client with mocked provider/model replies; it does not measure real semantic model latency. Automated regressions additionally cover stale positive verdicts after resumed speech/new words/close, cleared hypotheses, one check per revision, unresponsive service timeout, malformed model output, missing live captions and recorded-audio recovery.

Semantic completion is probabilistic: a grammatically complete clause can still be followed by more speech. The short quiet gate and cancellation reduce accidental interruption but do not prove perfect conversational judgment. Nova-3/Flux remain the selected STT/TTS providers; Deepgram Flux STT was not substituted because its current ten-language coverage would lose languages in the existing catalog, including Urdu.

Chromium smoke testing uses real AudioContext/AudioWorklet PCM capture and real MediaRecorder capture/conversion with a synthetic microphone. Deepgram credential/transcript and semantic verdict responses are mocked. Local Deepgram/Groq/Mistral API keys are unavailable, so live-provider recognition accuracy, semantic accuracy/latency, pronunciation across all languages, and physical-phone behavior remain unverified.

## Authoritative references

- [Nova-3 languages](https://developers.deepgram.com/docs/models-languages-overview)
- [Nova-3 streaming protocol](https://developers.deepgram.com/reference/speech-to-text/listen-streaming)
- [Temporary token authentication and Member permission requirement](https://developers.deepgram.com/guides/fundamentals/token-based-authentication)
- [CloseStream finalization](https://developers.deepgram.com/docs/close-stream)
- [Flux voice catalog](https://developers.deepgram.com/docs/flux-tts/voices)
- [Flux streaming lifecycle](https://developers.deepgram.com/docs/flux-tts/quickstart)
- [Flux expressivity](https://developers.deepgram.com/docs/tts-expressivity)

- [Flux STT language coverage](https://developers.deepgram.com/docs/flux/language-prompting)
- [Groq structured JSON outputs](https://console.groq.com/docs/structured-outputs)
- [Groq reasoning controls](https://console.groq.com/docs/reasoning)
