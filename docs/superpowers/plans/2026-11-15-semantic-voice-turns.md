# Semantic Voice turns

Keep Nova-3 transcription, all existing language choices, Flux TTS, and composer record-first input. Replace the normal four-second turn-submission rule with a semantic completion verdict from the existing fast Groq model. A short microphone quiet confirmation only schedules evaluation; elapsed silence does not authorize a normal submission.

Add an authenticated, rate-limited `/voice/turn` endpoint. Bound transcript/context sizes and provider time, disable retries/reasoning, validate a boolean JSON verdict, and return an unavailable verdict on provider/configuration failures without logging speech or credentials. Reuse existing clients and credentials; no new dependency.

Add a small frontend turn detector that debounces stable captions while audio is quiet, cancels stale checks on new words/resumed speech/close, and evaluates each revision once. Only a current positive verdict closes capture and submits its finalized transcript. Negative verdicts wait for continued speech. Keep conservative pause-based recovery only if semantic evaluation is unavailable, clearly distinguishable in tests/documentation.

Verify complete requests, unfinished phrases, thinking pauses, new speech while a verdict is pending, duplicate responses, lifecycle cleanup, authentication, malformed provider output and timeouts. Run real-provider sentence checks if a local key exists; otherwise report the limitation. Review and push focused changes after frontend/backend/browser checks.
