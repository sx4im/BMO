# Temporary Stanza / Groq experiment — 2026-11-16

## Behavior

Stanza's stable `thinking` ID and Stanza 2.5 label are preserved. Its underlying
model now comes directly from `get_aeon_model()`, exactly matching WhatsApp Aeon.
Selection order remains `GROQ_AEON_MODEL`, `GROQ_MODEL`, legacy `NVIDIA_AEON_MODEL`,
then `qwen/qwen3.8-27b`. The existing WhatsApp model selection is unchanged. The Groq adapter now uses
that same resolver, including a legacy-only custom Qwen override; explicit
`nvidia/` model IDs retain their existing NVIDIA classification.
`MISTRAL_MODEL` and `NVIDIA_STANZA_MODEL` no longer select Stanza.

Production code no longer imports the Mistral adapter or uses it for inference,
key lookup, startup logging, search classification, or semantic Voice checks.
Known raw Mistral model prefixes are rejected before any inference call. A
Mistral key alone does not mark inference configured. The dormant adapter and
its isolated mocked tests remain solely to simplify reversal.

Missing Groq credentials and failures before or after the first token propagate
without a Mistral fallback or retrying Stanza against itself. Search retains its
rules when Groq is unavailable. Semantic Voice checks report unavailable, leaving
the existing two-second silence behavior in control. Nexos's existing first-token
fallback still targets Stanza, now served by Groq.

Conversation titles use the authenticated Groq client for the shared model,
retaining the separate eight-second request timeout, zero retries, and 24-token
cap. Qwen uses the existing repository convention `reasoning_effort="none"` so
reasoning does not consume the small title budget. Existing title normalization,
manual rename protection, and save behavior remain covered by their tests.

The current Groq streaming adapter does not forward reasoning-effort controls.
The composer therefore offers Extended thinking only for Nexos and returns no
reasoning effort for Stanza. Nexos retains its high/low control and saved user
preference. Composer, chat import, main import, and HTML entry cache versions
were bumped. Prompts and Roman Urdu behavior were not changed.

## Verification

The initial focused regression run failed for the expected old behavior:
16 failed, 25 passed. Log: `/tmp/bimo-stanza-groq-red.log`.
The added composer DOM regression first failed because Stanza still displayed
Extended thinking. Log: `/tmp/bimo-stanza-groq-frontend-red.log`.

After implementation, the focused backend suite passed 184 tests (75 existing
warnings), and the composer suite passed 9 tests. Logs:
`/tmp/bimo-stanza-groq-focused.log` and
`/tmp/bimo-stanza-groq-frontend-focused.log`.

A separate legacy-only regression run first failed for actual dispatch and title
client selection (2 failed, 18 passed), then passed all 20 affected tests after
centralizing the Groq model resolver. Logs:
`/tmp/bimo-stanza-groq-legacy-red.log` and
`/tmp/bimo-stanza-groq-legacy-green.log`.

Final full suites after the legacy-resolver correction:

- Backend: `cd backend && venv/bin/python -m pytest -q` — 508 passed,
  117 existing warnings, 77.11 seconds. Log:
  `/tmp/bimo-stanza-groq-backend-final.log`.
- Frontend: `cd frontend && npm run test:run` — 164 passed, zero failures,
  36.50 seconds. Log: `/tmp/bimo-stanza-groq-frontend-final.log`.
- `git diff --check` passed. `graft build` completed, then `graft check` reported
  the wiring graph in sync. Paid deep indexing was not requested or run.

Render YAML parses, contains unique environment keys, selects the existing Groq
Qwen model, and has no Mistral or obsolete NVIDIA Stanza/Aeon declarations.

## Deployment and reversal

Keep this experiment in its own commit after `c16f7fd` (chat save, title, mobile)
and `2b733de` (Voice). Revert only the experiment commit with
`git revert <experiment-commit>` and deploy both frontend and backend; do not
reset to either earlier commit. The final handoff records the experiment hash.
The adapter remains on disk, so reverting restores the previous routing and
setup examples without changing the earlier fixes.

Render still needs its existing `GROQ_API_KEY` and `GROQ_AEON_MODEL`. Stanza now
shares Aeon's Groq quota. No dashboard settings, real `.env` files, credentials,
or production deployments were changed. Existing Mistral dashboard secrets can
remain unused during the experiment; reversal needs the prior provider settings.

## Limits

Provider requests are mocked: no live paid model calls, live quality comparison,
production timing, quota/load test, or deployment was performed. No claims about
Roman Urdu quality or real title output are made from these tests. Browser DOM
checks do not replace a physical mobile-device check. Existing third-party
backend deprecation warnings were not changed or suppressed.
