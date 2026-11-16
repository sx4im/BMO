# BMO project context

Updated 2026-11-16. Use this as an entry point; confirm implementation details
through Graft and the current source before editing.

## Architecture and deployment

- Flask backend in `backend/`, vanilla JavaScript frontend in `frontend/`,
  Supabase for authentication and persistence.
- Frontend: Vercel, `https://bimo.qzz.io`. Backend: Render,
  `https://bimo-backend-4a4g.onrender.com`; see `render.yaml`.
- Frontend modules and styles use query-string cache versions. Bump affected
  imports and entry-point versions when shipping frontend changes.
- Never commit environment variables, API keys, or generated Graft caches.

## Recent behavior and decisions

- Temporary provider experiment: Stanza (`thinking`, Stanza 2.5) now resolves
  exactly the same Groq/Qwen model as WhatsApp Aeon, including Groq model overrides
  and the existing legacy Aeon override. The Groq adapter shares that resolver.
  Old Mistral/Stanza-specific settings no longer select Stanza. Mistral has no
  production imports, inference, fallback, key lookup, or startup logging; its
  dormant adapter and isolated tests remain for reversal. Known raw Mistral IDs
  are rejected. Groq failures propagate; search uses rules and semantic Voice
  checks report unavailable when Groq is unavailable. Titles use authenticated
  Groq with the existing eight-second budget and Qwen reasoning disabled.
  Extended thinking appears only for Nexos, with frontend cache versions bumped.
  Keep this experiment in its own commit so reverting it preserves the earlier
  Voice and save/title/mobile fixes. Verification: 508 backend tests (117 existing
  warnings), 164 frontend tests, Render YAML validation, and Graft build/check
  pass; no live model calls. See
  `docs/verification/stanza-groq-experiment-2026-11-16.md` for rollback and limits.
- The product release is Bmo 6.0. Existing and new users receive a features-only
  release card once per account. Its durable marker is Supabase Auth user
  metadata `bmo_release_seen`; retain other user metadata when updating it.
- Final chat save confirmation waits up to 30 seconds after generation completes,
  instead of reporting failure after two seconds. Usage-recording errors are
  logged independently and cannot discard a saved-message acknowledgment.
  Verification: 495 backend and 163 frontend tests pass; see
  `docs/verification/chat-save-titles-2026-11-16.md` for scope and limits.
- Generated conversation titles have an independent eight-second provider request
  budget, update only an unchanged seed title, and cannot overwrite manual renames.
  The frontend refreshes first-turn titles through 20 seconds, discards stale list
  responses, and clears refresh timers when a title arrives or the page closes.
- Mobile message actions use 32×44px targets and a 2px gap below 768px;
  desktop spacing is unchanged. Chromium geometry evidence is in
  `docs/verification/mobile-message-actions-2026-11-16.json`.
- Chat persistence acknowledges durable IDs during streaming. Saving must not
  remount the active answer, duplicate messages, or block initial response output.
  Streaming and saved answers should retain the same formatting.
- Mobile assistant actions include Copy, thumbs up/down, and Retry. Pending saves
  must retain controls; feedback resolves the durable message ID before posting.
- The landing hero keeps compact desktop text/buttons/video. Its heading's left
  edge aligns with the navbar logo, and the video's right edge aligns with
  Try Bmo. Preserve the existing mobile layout.
- Voice automatically ends a turn after two seconds of microphone quiet, even
  when semantic completion says incomplete or is pending. Positive semantic
  verdicts can still finish sooner; resumed speech resets the quiet window.
  Nova's speech endpoint also uses two seconds. Final streaming text is flushed
  before sending, with recorded-audio recovery preserved.
- Chat and Voice again show the original randomized waiting vocabulary, rotating
  every three seconds. Search/transcription status labels take priority. Rotation
  stops on answer output, completion, cancellation, error, or closing Voice.
  Verification: 160 frontend tests pass; see
  `docs/verification/voice-auto-send-2026-11-16.md` for scope and hardware limits.
- Voice, search relevance, and persistence work have verification records under
  `docs/verification/`. Read the relevant record and inspect current code before
  changing these flows; do not assume live provider credentials or hardware were
  exercised by a simulated browser test.

## Research and deferred work

- Claude-style artifact/file creation is research only. Do not implement the
  proposed parser, version storage, document renderers, or side panel without a
  new implementation request.
- Chat skill recommendations are research only; see
  `docs/bimo-chat-skills-research-2026-11-15.md`.
- The Ponytail audit records cleanup candidates, not approval to refactor them:
  `docs/verification/ponytail-audit-2026-11-15.md`.

## Context maintenance and verification

- Graft MCP is registered locally in Codex as `graft`, running `graft mcp` against
  this repository. A new Codex session loads the registered server. The CLI is
  the fallback in the current session.
- At task completion, run `graft build` then `graft check`. Update this note for
  material changes. A fresh checkout rebuilds its own ignored `graft/` directory.
- Frontend regression suite: `npm run test:run` from `frontend/`.
- Existing release, persistence, streaming-layout, search, and voice evidence lives
  in `docs/verification/`; record the scope and limits of new checks there when useful.
