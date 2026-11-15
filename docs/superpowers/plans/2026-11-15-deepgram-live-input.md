# Deepgram live input

Use Nova-3 streaming transcription for the composer microphone and Voice assistant. Preserve the existing orb, controls, draft text, Voice language selection, and text-only captions.

An authenticated, rate-limited Flask endpoint grants a 30-second Deepgram token. The permanent key remains server-side. Browser AudioWorklet capture sends mono PCM in 80 ms chunks at the actual AudioContext sample rate; early audio is buffered during connection setup. A shared client replaces interim hypotheses, accumulates final segments, flushes capture before CloseStream, and releases resources on cancellation, errors, and navigation. Composer defaults to multilingual recognition. Voice requests its selected language and retains recorded-audio recovery if streaming fails.

Implementation and verification:
1. Test token auth, provider failures, and response confidentiality; implement the token endpoint and configuration.
2. Test live results, audio ordering, final flush, cancellation, and bounded buffering; implement the shared streaming client and PCM worklet.
3. Connect composer dictation with live text and draft restoration on cancel. Connect Voice on its existing owned microphone stream and retain its audio recovery path.
4. Run frontend/backend suites and a real Chromium audio-capture smoke test with mocked provider events. Review the focused diff, commit, and push. Document Render variables and the remaining need for a real-phone/provider accuracy check.
