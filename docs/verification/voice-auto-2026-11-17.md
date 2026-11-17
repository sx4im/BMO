# Voice Auto language recovery

Date: 2026-11-17.

## Root causes and behavior

- The recorder recovery path sent the last fixed locale (English on a fresh
  session), even while the UI said Auto, and discarded detected-language metadata.
- Live detection selected the final word's language. An English word at the end
  of a French utterance could select English for the whole reply and voice.
- Nova-3 multilingual currently omits Urdu even though explicit Urdu recognition
  is supported. Its language detection feature is not a universal streaming fix.

Auto now keeps live captions for feedback and verifies the complete recorded
turn with the existing configured Whisper transcription provider. The request
omits a fixed language, requests verbose JSON, and returns the detected language
alongside the transcript. Whisper language names and regional codes normalize to
Bmo's supported voices before sending the question and starting spoken output.
The provisional live finalization is canceled instead of adding its timeout to
the recorded detection call. Audio and credentials are not saved by this change.

Manual language selections stay pinned and retain the direct live path. A valid
empty manual transcript still returns to listening instead of retranscribing
noise. Auto can recover its recording when the live stream produced no words.
No-provider and missing-language responses explain that a manual selection is
needed; they never silently force automatic speech into English.

The frontend sends `language=multi` plus `auto_language=1`. Older backends safely
ignore that flag during a staggered deploy. New backends accept both this form
and `language=auto`. Other callers retain their existing transcription behavior.

## Verification

Targeted regressions cover dominant-language selection, absent language lists,
Urdu correction after provisional Hindi captions, empty Auto transcripts, regional
locale normalization, manual pinning, missing detection metadata/configuration,
and frontend/backend rollout compatibility. Existing microphone noise, two-second
endpoint, cancellation and interrupt tests are retained.

Final verification: backend **639 passed** (135 existing warnings, 29.25s);
frontend **227 passed**, zero failures (36.02s). Graft build/check and
`git diff --check` passed for the final source state.

## Sources and limits

- [Nova-3 language prompting](https://developers.deepgram.com/docs/nova-3-language-prompting):
  multilingual language list and dominant-language response fields.
- [Models and languages](https://developers.deepgram.com/docs/models-languages-overview):
  Urdu is listed as monolingual, separately from the multilingual list.
- [Language detection](https://developers.deepgram.com/docs/language-detection):
  recorded detection limitations and streaming alternatives.
- [Groq speech to text](https://console.groq.com/docs/speech-to-text):
  Whisper transcription, optional language parameter, verbose JSON.

Auto requires a configured Whisper provider (custom TRANSCRIBE settings, Groq,
or the existing OpenAI fallback) and adds one recorded transcription call per
spoken turn. Exact latency and language-recognition accuracy remain provider-
and recording-dependent. Tests use controlled audio/WebSocket/provider doubles;
no physical microphone or live Urdu recognition accuracy was measured.
