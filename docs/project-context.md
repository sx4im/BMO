# BMO project context

Updated 2026-11-17. Use this as an entry point; confirm implementation details
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

- Stability release verified with610 backend and210 frontend tests; Graft
  build/check passed. Provider finish reasons are preserved; Qwen3.8 requests
  an explicit 16,384-token completion budget (`GROQ_MAX_TOKENS` can lower it).
  Length-limited answers continue in bounded windows on the same upstream model.
  Broken streams and provider errors are not saved as successful busy replies.
- Chat inserts use stable server-owned IDs and scoped reconciliation before safe
  transient retries. Committed content acknowledgment no longer waits on sidebar
  timestamp updates or usage recording. Stop/reconnect preserve received content.
- Router, stream, submit, and image requests have ownership/cancellation guards;
  image polling has no overlap and retains a strict wall-clock timeout. Advance
  `bmo-build` as well as import versions on every frontend release.
- Source cleanup strips only balanced proven highlight.js wrappers. Real HTML
  spans/IDs and unrelated entity strings survive storage, rendering, copy/export.
- Image generation omits `seed`: the deployed FLUX3 endpoint rejects that field.
- Supabase uses an initialized process-local admin client and bounded separate
  transports; analytics imports are lazy. Render configuration selects one worker
  with eight threads. Boot does not perform model inference by default.
- Authenticated chat SSE exposes `inference` metadata from actual upstream chunks;
  `/health.backend_revision` reports Render's source revision. Neither model
  self-identification nor a configured health flag proves upstream model use.
- State-machine inventory: `docs/verification/state-machines-2026-11-17.md`.
  Stability evidence and limits: `docs/verification/stability-2026-11-17.md`.
- Stanza 2.5 (`thinking`) is back on Mistral `ministral-8b-2512`, ending
  the temporary Groq/Qwen experiment. `MISTRAL_MODEL` selects its upstream model;
  legacy `NVIDIA_STANZA_MODEL` is ignored. WhatsApp Aeon, search classification,
  and semantic Voice checks retain their existing Groq routing. Titles use the
  Stanza provider with the existing independent eight-second budget. Mistral
  streams now retain finish reasons, usage, upstream inference metadata, and
  cancellation cleanup so bounded continuation and incomplete-stream detection
  remain active. Restore `MISTRAL_API_KEY` on Render if it was removed; the
  blueprint declares it without storing credentials. Verification: 619 backend
  tests passed (135 existing warnings); no live Mistral call was possible because
  no Mistral credential is available locally.
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
