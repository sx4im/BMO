# Voice auto-send and waiting phrases — 2026-11-16

## Cause and change

The semantic completion integration deliberately prevented both the local pause
fallback and Nova speech endpoints from ending a turn while a semantic detector
was available. A valid `complete: false` response was evaluated only once for the
current text, leaving the microphone open until new words or a manual stop.
The fallback pause was four seconds.

Voice now ends after two seconds of adaptive microphone quiet, independently of
semantic verdicts, and still allows a positive semantic verdict to finish sooner.
Speech and new transcript text reset the quiet window. Nova requests use
`endpointing=2000`; provider endpoints cannot be vetoed by semantic detection.
Recorded takes use the adaptive VAD rather than a one-shot caption timer with an
absolute volume threshold. Recognized words followed by near-silence can finish
soft speech that never crossed the local speech-entry threshold. A finalized
browser caption can avoid a second transcription request; streaming input still
flushes final words and retains full recorded-audio recovery on failure.

The original 30 chat waiting words were removed in commit `1f0bdbd`. They are
restored in a shared module for chat and Voice, change every three seconds, and
avoid immediate repetition. Actual search/transcription labels take priority.
Timers stop on output, completion, cancellation, errors, and closing Voice.
Frontend import/entry cache versions are bumped.

## Verification

- Reproduced failing regressions before the fix: the two-second local endpoint,
  incomplete/stalled semantic verdicts, blocked provider endpoints, and the fixed
  waiting label/no rotation timer.
- `npm run test:run` in `frontend/`: **160 passed, 0 failed**.
- Coverage includes quiet and steady-noise endpoints, speech during calibration,
  resumed speech resetting the pause, continuous/softer speech remaining open,
  stalled semantic cancellation, finalized stream/recorded recovery, browser
  captions, automatic listening after replies, and microphone cleanup.
- Phrase tests exercise start/rotation, real search status priority, resuming after
  search, and cleanup on first answer token/completion/cancel/error. The Voice DOM
  check observes real timed label changes, playback stopping rotation, and close.
- Node emits its existing experimental VM modules warning. Export service and GPU
  failure diagnostics are intentional fallback fixtures in the regression suite.

## Limits

Tests execute real frontend modules in Node/JSDOM with simulated microphone,
recorder, transcription/provider, and network boundaries. No physical microphone,
live Deepgram/model accuracy, mobile browser run, or production deployment was
verified in this change. Two seconds is the quiet detection window; final
transcription and network time may add delay before the message reaches chat.
