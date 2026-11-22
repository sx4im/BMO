# BMO project context

Updated 2026-11-22. Use this as an entry point; confirm implementation details
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

- Customize ships Caveman, No AI Slop, and Humanizer as read-only built-in
  Markdown skills. Migration `0010_builtin_skills.sql` saves explicit
  per-account opt-ins. Enabled skills remain per-message selections.
  Postgres 16 verified tenant isolation and migration reapplication.
  Chromium checked desktop and 375px layouts with a simulated API. The
  release passed 239 frontend and 635 backend tests. See `docs/CUSTOMIZE.md`
  for pinned sources and deployment order.
  Production Supabase recorded migration `0010_builtin_skills` as version
  `20261122150700`. The table has row-level security, gateway-only access,
  and zero opt-ins after migration. It was applied ahead of the app rollout.
- Iris uses the bundled img-fx 0.5.1 `pixels-mechanic` WebGL engine while
  generating. It loads on demand, pauses offscreen, and uses a still orb
  with reduced motion. Successful results can appear from 10 seconds after
  the request starts. At 12 seconds the tile stops moving and shows a
  continued waiting status until the provider returns. Errors appear as
  soon as reported. Tests covered early results and cancellation while the
  tile is visible. Chromium exercised the WebGL preset with simulated results.
- Voice calls use Deepgram Nova-3 for live transcription and recorded
  recovery through `/voice/transcribe`. Only finalized user text appears
  in the call. Auto uses Nova's multilingual mode. Urdu requires an
  explicit selection. Capture closes after a 350ms quiet window on desktop
  and touch devices. An 85 Hz high-pass filter reduces rumble in the detector.
  Spoken cues require a search event.
  Firefox verified the language label and released a synthetic microphone
  384ms after silence. Provider responses were simulated. Recorded recovery
  requires the updated API. The release passed 238 frontend and 634 backend
  tests.
- The voice call header and assistant use the name Bmo. The voice prompt
  identifies Bmo 6.0 when asked about the version. Only speech synthesis
  receives the letter-by-letter pronunciation. Tests verified the English
  speech payload, with live synthesis outside the test.
- The Impeccable cleanup removed unused pulsing dots, colored shadows, and
  timed image-generation stages. Skill uploads fill to 100% before showing the
  validation status, and the CSS voice fallback uses a single gradient.
  The frontend entry page scan passed with no suppressions. Chromium
  checked the image loading and download flow at desktop and mobile widths
  with simulated image output. All 240 frontend and 632 backend tests passed.
- The desktop compact chat composer centers its placeholder line in the
  36px input alongside the controls. In an active chat it stays compact on
  focus and while a draft fits beside the controls, then expands for
  multiline drafts, attachments, or skill chips. The model and action
  columns keep the fit measurement stable while the editor is expanded.
  Chromium verified the width threshold, resizing, URL highlighting, image
  upload and removal, the expanded new-chat composer, and mobile text growth.
- The dark composer uses a `#333333` surface and brighter placeholders
  for both the greeting and active chats.
- A chat open in the browser queues one message when the browser reports it
  is offline. The message shows its status under the bubble and sends once
  on reconnection. Stop cancels a queued turn. Unconfirmed writes are kept
  editable and are not automatically replayed. Queue state lives in the
  open chat view. Recent-chat and chat-history reads use a 15-second deadline
  and retry when connectivity returns. On November 21, an exact direct
  Supabase conversation query returned 200 in 0.63 seconds while the same
  authenticated read through Render returned 502 after about 10 seconds.
  Subsequent Render reads timed out intermittently even after redeploy.
  Evidence isolates the observed slowdown to the gateway path and leaves
  its precise cause unconfirmed.
- Nexos 3.0 (`deep`) now uses Groq `openai/gpt-oss-120b`. It retains
  streamed reasoning, bounded continuation, and the existing first-output
  fallback to Stanza. The chat route pins reasoning effort to `medium`,
  including requests from older clients. The composer model menu selects
  models with a 30px-tall, rounded rectangular button. `GROQ_NEXOS_MODEL`
  sets the upstream model.
- Chat attachment turns and background image descriptions use Mistral
  `ministral-8b-2512` via `MISTRAL_VISION_MODEL`. Existing file extraction,
  PDF page rendering and batching, and saved attachment context are reused.
  Regular chat follow-ups use saved text and the selected chat model once
  descriptions are available. Unsupported or oversized chat images are
  converted to a bounded PNG for inference, with the original kept in storage.
- A chat message accepts up to six uploaded images. The composer counts ready
  and in-flight images across selections, and both chat endpoints enforce the
  limit. Documents keep their own upload limits. Mixed image/PDF turns batch
  rendered pages around the uploaded images to stay within eight image parts
  per model request. Verified with 631 backend and 234 frontend tests.
- Composer image previews replace same-size loading tiles in selection order.
  The image strip scrolls horizontally once it overflows, while document
  tiles retain their file labels. The chat composer surfaces a retryable
  error after 90 seconds without model output. Background image descriptions
  honor the provider retry delay within a bounded window and get one final
  minute-scale retry on rate limits. Verified with 632 backend and 236
  frontend tests plus Chromium attachment geometry and interaction checks.
- NVIDIA serves Iris image generation only. The chat transport, diagnostic
  route, and Riva dependency were removed. Verification covered 629
  backend and 233 frontend tests, including mixed image/PDF batching,
  Mistral context persistence, a Groq follow-up with no image bytes, and
  locally simulated provider HTTP streams. Live inference requires provider
  credentials and was not exercised.
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
- Live language selection uses the provider's dominant language or word counts.
  Language names, regional tags, and aliases normalize to supported voices.
  Manually selected languages stay pinned, including during recorded recovery.
- Final UI/Voice/search pass: 634 backend and 219 frontend tests passed.
  Jump-to-latest is CSS-anchored to the composer wrapper, with a 44px target,
  orange hover and visible keyboard focus; growing/clearing drafts cannot strand
  it. Send-arrow animation runs only while pressed. The creator footer link
  inherits the footer color and uses a dotted underline.
- Brief shared creator context is sourced from https://saimshafique.com
  (verified 2026-11-17): AI systems engineer/open-source contributor in
  Hafizabad, Pakistan, focused on Bmo and AI-agent verification/evaluation/testing.
  It appears only when asked about Saim; old WhatsApp age/job claims were removed.
- Voice offers local acknowledgments in all 42 languages after search starts.
  Stalled cue synthesis cannot block real output. Urdu/Indic sentence
  punctuation starts speech before completion;
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
  the temporary Groq/Qwen experiment. `MISTRAL_MODEL` selects its upstream model.
  WhatsApp Aeon, search classification,
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
