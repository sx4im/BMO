# Voice and tools cleanup implementation plan

**Goal:** apply the supplied voice brief to the current worktree, first removing the retired tutoring tool completely, then verifying the integrated procedural voice experience.

**Spec:** `/home/saim/.codex/attachments/29f534ec-b47b-4d94-849c-6ee1d0c2ecd5/pasted-text-1.txt`.

**Architecture:** retain Flask, vanilla JavaScript, the existing conversation stream and speech services. Delete the retired tool rather than leave a feature flag. Retain the WebGL2 renderer, GLSL module and separate audio meter already implemented under the earlier voice plan. No dependencies or framework changes.

## Inspection and design decisions

The retired tool is frontend state plus a dedicated system prompt. It has no dedicated backend routes, tables or migrations. Shared conversation system prompts remain supported. Remove dormant quiz callbacks and CSS as well as the menu entry; do not delete ordinary educational conversation content. Preserve existing search work and unrelated worktree files. The Graft CLI is unavailable; source inspection follows the existing index cards.

## Milestones and acceptance

- [x] Read the full brief and inspect the composer, chat submission, shared messages, backend prompts, migrations, renderer, shaders and audio integration.
- [x] Verify failing coverage for the remaining tools menu, then remove retired state, submission fields, prompt module, quiz hooks, icon and CSS. Adjust the old mode-specific test; retain web-toggle coverage.
- [x] Verify web-toggle/image behavior, submitted prompts, retry/voice paths and full frontend/backend suites. Inspect all tracked source and assets for retired references; update stale index cards and browser cache versions.
- [x] Review voice state transitions, microphone/playback ownership, asynchronous cleanup, context recovery, reduced motion and quality adaptation. Fix reproducible gaps with focused regression tests.
- [x] Render the integrated overlay in Chromium; check layout, synthetic microphone/playback, silence, interruption, close/reopen, mobile, context recovery and resource cleanup. Preserve hero media. Record evidence and limitations.
- [x] Compare against the supplied visual reference. Screenshot received November 14; refined cloud distribution, palette and desktop proportions, inspected final desktop/mobile captures and recorded reference measurements. REA reached a verification page; original voice shader remains unknown.
- [x] Final diff and requirement review; report changed files, actual results and unverified physical microphone/live-service/device behavior. Static reference comparison is recorded; no identical-pixel or original-motion claim.

## Verification

Use `npm --prefix frontend run test:run`, `backend/.venv/bin/python -m pytest -c backend/pytest.ini backend/tests -q`, `git diff --check`, source/asset reference searches and browser evidence in `docs/verification/voice-orb/`. Do not equate a compiling shader or synthetic audio with an exact visual match or verified live service behavior.

Results: 414 backend tests passed (105 warnings), 78 frontend tests passed. Browser checks and their explicit limitations are recorded in [the verification note](../../verification/voice-orb/README.md). No database migration or dependency was added. Reference comparison and the requested REA attempt are recorded in the verification note. Changes are ready for the user-authorized push.
