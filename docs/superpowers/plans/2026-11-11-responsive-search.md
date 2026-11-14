# Responsive search implementation plan

Goal: improve automatic search correctness and early feedback without adding a multi-step agent loop.

Architecture: preserve Python rules followed by a bounded classifier, TinyFish retrieval, and existing answer SSE. Use strict verdict parsing and one decision deadline with SDK retries disabled. Keep search source URLs, explicit outcome states, and cancellation checks.

Constraints: no new dependencies, no Artifacts implementation, no live credentials in tests, preserve current streaming and provider fallback for answer generation.

- [x] Router: reproduce short live prompts, mixed coding/writing with current facts, rankings, attachments, contextual follow-ups, malformed classifier verdicts, retry amplification, and retrieval budget. Fix with targeted tests.
- [x] Route: regress immediate decision status, distinct empty/unavailable search, qualified fallback context, source URLs and stop before retrieval/generation. Keep search within generator cleanup.
- [x] Frontend: handle status and failure states, preserve source card behavior, respect search toggle during URL prefetch, cancel prefetch before starting chat. Verify using existing Node tests.
- [x] Verification: run backend suite and frontend suite, inspect final diff and baseline failures; run a bounded local routing benchmark. No claim of live-provider or production latency without measurement.

Review focus: mixed intents must not mask freshness; follow-ups must carry context; failed retrieval must not masquerade as evidence; search must not multiply request retries; cancellation must not initiate additional work.


Verification: final backend suite 407 passed; frontend suite 51 passed. New regressions were observed failing before fixes. Final whitespace/diff checks pass. Existing dependency deprecation and test-key warnings remain.

Local-only routing benchmark (five batches of 10,000 mixed prompts, classifier stubbed): median per-decision time 0.0085 ms before, 0.0141 ms after. This measures Python routing only, not provider time or browser first-paint latency.

Limits: 1.5-second classifier and 8-second retrieval budgets share remaining time between attempts, with classifier SDK retries disabled. HTTP connect/read timeouts are phase-based, so these are not strict wall-clock guarantees. Already-running synchronous provider calls finish or time out after cancellation, but no subsequent retrieval/generation starts. Live-provider quality, production network latency, and deployment are not verified here.
