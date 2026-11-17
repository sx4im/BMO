# Stability verification — 2026-11-17

## Confirmed failures

The pre-release live calculator request produced unfinished HTML with one open
Markdown fence and no closing HTML tag, yet the server emitted `complete` and a
saved assistant acknowledgment. The source discrepancy was investigated: actual
streamed length6190 and saved length6056 differed because broad span cleanup
removed real calculator display elements/IDs. (The discrepancy is134 characters;
this was source corruption as well as a separate end-of-output defect.) The
isolated test user was deleted; no real customer conversation was modified. See
`calculator-live-before-2026-11-17.json` for timings and sanitized evidence.

A separate authenticated short chat saved and reloaded correctly, and an exact
SDK assistant update succeeded. A follow-up request returned HTTP502 before SSE;
without Render logs its hosting cause is unproven. Earlier assumptions that
merely extending the save timeout established production correctness were not
sufficient.

## Changes and invariants

- Explicit documented Qwen3.8 output budget16,384, configurable lower; proper
  provider finish/usage handling and premature-EOF errors.
- At most two continuation windows; pin the actual model after first output and
  disable cross-provider fallback for continuations. Never restart partial code.
- Provider failures are structured errors rather than a fabricated successful
  busy answer. Confirmed partial saves precede an incomplete-response error.
- Stable IDs, owned insert reconciliation and bounded retry-safe persistence.
  Timestamp touches are secondary; usage logging cannot hide a committed reply.
- SSE heartbeats while awaiting provider/storage, safe Stop and reconnect,
  independent request/navigation ownership and bounded non-overlapping image poll.
- Source preservation in Python and JavaScript using a shared regression corpus,
  including calculator display IDs, encoded entities, rendering and copy.
- FLUX3 request omits unsupported seed, preserving other validated image fields.
- Warm process-local database client with separate SDK transports and bounded
  phase timeouts; deferred analytics imports reduce measured startup peak RSS
  from149.0 to92.6MiB. No unbounded leak or production OOM was established.
- Provider-reported model/request identifiers in SSE and backend deployment SHA in
  health make actual requests verifiable without asking a model to identify itself.

The source-backed state inventory covers52 workflows plus transient UI states.
It is an audit, not proof that every external dependency can never fail. Ownership
and image/reload findings marked pending in the captured inventory are addressed
by this release's corresponding tests; deferred WhatsApp delivery sequencing and
non-chat dirty-form reload refinements were not expanded into this release after
the user requested an early wrap-up.

## Verification and release

Targeted red→green tests cover terminal-state correctness, continuation,
provider pinning, source preservation, image payload schema, ambiguous database
commits, Stop/reconnect, stale callbacks, image deadlines, router wildcard and
startup/resource behavior. **Final full suites:610 backend tests passed (135 existing dependency/test-key
warnings),210 frontend tests passed.** Graft build/check and diff checks passed.
The pushed revision is recorded in the completion handoff. Live post-deployment
verification is recorded separately when the hosting rollout is ready.

## Limits

The official Qwen model output cap is documented at
https://console.groq.com/docs/model/qwen/qwen3.8-27b.md . Free hosting can suspend or
restart, and provider quotas/network errors remain possible. Blocked upstream
reads are bounded by SDK timeouts rather than instant cancellation. Literal code
intentionally using actual `hljs` classes remains ambiguous to the legacy cleanup
feature. No production OOM claim, universal quality guarantee, or suppression of
real persistence/provider failures is made.
