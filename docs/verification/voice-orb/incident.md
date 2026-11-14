# First-utterance and live-caption hotfix

The previous recovery opened a new recorder only after native recognition stalled, losing audio already spoken. The fix opens an owned recording directly from the opening gesture. That stream feeds VAD and orb analysis while Web Speech supplies display-only interim captions. Native errors or timeouts leave the recording intact. Submitted questions always come from the actual recorded WAV, so incomplete captions cannot truncate a question.

The existing server transcription and chat/TTS APIs are retained. Recorder setup failures release the microphone. WAV conversion errors are surfaced rather than uploading mislabeled compressed bytes. Speech that begins during VAD calibration can end on its first quiet gap.

Visible status labels are clipped. User captions remain visible until the first assistant PCM buffer is queued, then clear. Language changes discard the previous take and restart capture/captions with the selected locale; rapid changes wait for the existing recorder's stop event and use the final selection.

Verification: **87 frontend tests passed**, including failing-before/passing-after checks for first-utterance capture, interim-caption truncation, caption clearing, recorder setup cleanup, conversion failure and rapid language changes. All seven language locales were exercised. No backend source changed.

[Browser evidence](incident-browser-check.json) uses actual Chromium MediaRecorder/WebM, Web Audio, WAV decoding/resampling and authenticated fetch construction. It verifies nonempty 16kHz mono WAV uploads, automatic silence submission, reply audio, mobile interim captions, all language selections and cleanup. [Mobile captions capture](live-captions-mobile.png) shows user words without visible status labels. Native recognition events and ASR/chat/TTS responses were simulated: live providers and physical phone microphones remain outside that verification.
