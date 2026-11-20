# BMO project context

Updated 2026-11-20. Use this as an entry point; confirm implementation details
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

- Desktop compact composer (`min-width: 769px`, `.composer.is-compact`) uses
  concentric 6px horizontal/vertical padding, 36×36px edge buttons (`+`, mic,
  voice assistant), and a 2px action gap so `+` sits at the left end and
  mic/voice sit at the right end. Expanding/compacting animates smoothly over
  280ms via `:root { interpolate-size: allow-keywords }` (`block-size: 50px` ↔
  `auto`) inside `@media (prefers-reduced-motion: no-preference)`, with a
  measured `blockSize` fallback for browsers without `interpolate-size` and
  an `autoSize()` guard so `ResizeObserver` layout sync does not abort active
  transitions. Time-of-day greeting placeholders now appear only in empty/new
  chats; once messages exist, the composer switches to `"Write a message..."`.
  Verification: 231 frontend tests passed (`npm run test:run`) and headless
  Chromium verified edge insets (6px/6px/2px), `CSSTransition` on `height`
  (50px → 102px across 280ms), and placeholder switching; Firefox/Safari
  measured fallback was exercised in jsdom rather than native browsers. Frontend
  cache versions (`styles.css?v=256`, `composer.js?v=43`, `chat.js?v=213`,
  `main.js?v=258`, `bmo-build`) bumped.
- Voice Auto now verifies complete recorded turns with the configured Whisper
  transcription provider and applies its detected language to the final transcript,
  reply and TTS voice. Live Nova captions remain provisional. This covers Urdu,
  which Nova-3's multilingual list excludes, and avoids reusing a fixed English
  locale during recorded recovery. Auto adds one recorded transcription step;
  manually selected languages retain the direct live path and stay pinned.
  Empty completed live transcripts retain the existing manual-mode silence path.
- Live language selection uses the provider's dominant language (or word counts),
  not the final word. Language names, regional tags and common aliases normalize
  to supported voices. Auto requests use a backward-compatible multipart flag;
  missing detection configuration/metadata is actionable rather than a hidden
  English fallback. Verification: 639 backend and 227 frontend tests passed,
  with Graft build/check and diff checks clean. See
  `docs/verification/voice-auto-2026-11-17.md`.
- Final UI/Voice/search pass: 634 backend and 219 frontend tests passed.
  Jump-to-latest is CSS-anchored to the composer wrapper, with a 44px target,
  orange hover and visible keyboard focus; growing/clearing drafts cannot strand
  it. Send-arrow animation runs only while pressed. The creator footer link
  inherits the footer color and uses a dotted underline.
- Brief shared creator context is sourced from https://saimshafique.com
  (verified 2026-11-17): AI systems engineer/open-source contributor in
  Hafizabad, Pakistan, focused on Bmo and AI-agent verification/evaluation/testing.
  It appears only when asked about Saim; old WhatsApp age/job claims were removed.
- Voice has twelve local acknowledgment variants per state for all 42 languages.
  Search cues follow real search events; slow turns get at most one cue after
  650ms. Quick answers skip it, and stalled cue synthesis cannot block real
  output. Urdu/Indic sentence punctuation now starts speech before completion;
  first phrase fallback is 40 characters. A failed turn cannot replay buffered
  text from its canceled cue. Live provider/network latency is not benchmarked.
- Search skips complete conversational closings before evaluating news/recency
  keywords. “Thanks for the news, and have a good day” stays local; mixed turns
  that also request current facts still search. See
  `docs/verification/final-ui-voice-search-2026-11-17.md` for evidence and limits.
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
  transports; analytics imports are lazy. Render configuration restores two workers
  with eight threads each. Boot does not perform model inference by default.
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
- Mouse text selection in chat is preserved: document pointer events track input
  type without focusing the composer, message-feed clicks do not steal focus,
  and delayed/window autofocus respects active selections and editable controls.
  Verification: 212 frontend tests pass; Chromium native mouse drag and Ctrl+C
  copied the selected 40-character reply excerpt. Frontend cache versions bumped.
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

## Incident record: 2026-11-17 backend unresponsive

- The frontend returned HTTP200 in0.43s and a direct authenticated database read
  returned HTTP200 in0.82s. Backend `/health`, `/models`, and `/conversations`
  timed out after15s; a separate health probe also timed out after25s.
- Render's public status reported all systems operational. This does not establish
  this service's health. No request logs, worker metrics, or account audit logs
  are available through the current credentials; an attack cannot be confirmed
  or ruled out from endpoint timeouts alone.
- Restore the previous two-worker Gunicorn setting, preserving lazy analytics
  imports and other memory reductions. This removes the recent capacity reduction
  but is mitigation, not a proven incident root cause. Git push requests an
  automatic deployment; a configured Render start-command override may need the
  same setting. Confirm health and authenticated chat after rollout.

- Recovery: `/health` returned HTTP200 in0.51s at revision `1b6bc78`, and the user
  reported chats working again. User-provided earlier logs already showed two
  workers, so the worker-count change is not established as the outage cause.
  Render rate-limit storage is `memory://`. Local preloaded Gunicorn with SDK
  3.52.0 completed16 concurrent authenticated model/conversation requests against
  the real Supabase database; the isolated test account was removed successfully.
  The outage root cause remains unconfirmed. Render MCP OAuth is configured,
  but its tools require a new Codex session to load.
