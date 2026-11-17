# Stable generation and explicit lifecycle ownership

The user's reliability goal includes mid-code truncation, generic busy replies,
output capacity, persistent save warnings, model/deployment proof, and a complete
inventory of implicit state machines. Preserve the separate Stanza experiment
commit and the existing architecture; no new state-machine dependency.

## Acceptance and evidence

1. A normal calculator request produces a complete parseable runnable artifact.
   Explicit provider output budgets respect documented model caps. `length` is
   carried to the route and continued without repeating already emitted code;
   an unbounded or failed continuation cannot be called complete.
2. Provider EOF, quota/configuration errors, transient failures, and cancellation
   have distinct terminal outcomes. Before-content retries are bounded and honor
   supported retry timing; partial answers stay visible and persist. Generic
   busy text is not substituted for an ordinary successful assistant message.
3. Generation completion and save acknowledgment remain distinct. Idempotent
   request-owned IDs permit safe transient persistence recovery. Timestamp touches
   never hold up an acknowledgment of committed message content. No duplicate or
   foreign-row updates; no false saved acknowledgment for failed final content.
4. Stop/reconnect/navigation preserve received answers and reconcile only the
   matching request/conversation. Late asynchronous results cannot remount old UI.
5. Real upstream metadata proves provider/model without asking the model to
   identify itself. Backend revision and frontend build advancement permit deployed
   version checks. No secrets, private prompts, or credential dumps in diagnostics.
6. Inventory all discovered frontend/backend implicit state machines, their states,
   events, ownership/cancellation invariants, tests, and failure/recovery paths.
   Fix confirmed high-impact lifecycle defects and record verification limits.
7. Verify focused regressions, full backend/frontend suites, real calculator
   behavior and isolated authenticated live save/reload/provider paths. Clean up
   all temporary users/data. Review diff, build/check Graft, commit and push the
   authorized fixes, then verify deployed revision and critical behavior.

## Work ownership

- Provider worker: Groq/NVIDIA finish/usage/error contracts, explicit budgets and
  provider-specific options; preserve current inference metadata changes.
- Persistence worker: store ID reconciliation/touch control and serialized writer
  retry/finalization, with tenant-aware regression tests.
- Inventory agent: source-backed whole-app state-machine catalog only.
- Root: route protocol/continuation/error integration, secondary timestamp work,
  frontend ownership review/fixes, live verification, docs, release and integration.
- Existing uncommitted frontend recovery and inference-diagnostic work is retained
  and reviewed, not restarted or discarded.

## Implementation sequence

1. Revalidate prior work and live process handles; capture actual failures before
   changing additional code. Preserve evidence from successful short saves and
   failed follow-up HTTP502 rather than claiming a general database outage.
2. Carry inference metadata and provider terminal reasons through route SSE.
   Add bounded token-limit continuation and structured recoverable errors.
3. Wire stable conversation/user/assistant IDs and nonblocking timestamp updates
   into chat persistence. Test ambiguous commits and partial/final recovery.
4. Review Stop/reconnect/build fixes and implement confirmed navigation/image
   request ownership defects found by the inventory.
5. Run realistic calculator and backend failure scenarios; test parsing/execution,
   terminal event ordering, saved content equality, cancellation, and reconnect.
6. Full suites and independent final review; update project context and evidence.
   Refresh Graft, commit, push, and verify deployment without claiming proof from
   unit tests or a model's self-description.

## Review focus

- Never append a different provider's fresh answer to an existing partial reply.
- Repeated continuation boundaries must not duplicate code fences or identifiers.
- Preserve an unfinished answer on exhaustion/error with a truthful terminal state.
- Retry inserts only under stable IDs and scope every reconciliation by owner.
- Do not let diagnostics count as first content or disable cancellation/deadlines.
- Do not increase provider budgets beyond documented limits or mask quota errors.
- Late events, visibility callbacks, polls, and route handlers must retain ownership.
- Keep model quality, physical microphone accuracy, production credentials, and
  deployment status explicit as verified or unverified; no blanket stability claim.
