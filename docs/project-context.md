# BMO project context

Updated 2026-11-24. Use this as an entry point; confirm implementation details
through Graft and the current source before editing.

## Architecture and deployment

- Flask backend in `backend/`, vanilla JavaScript frontend in `frontend/`,
  Supabase for authentication and persistence.
- Frontend: Vercel, `https://bimo.qzz.io`. Backend: Render,
  `https://bimo-backend-4a4g.onrender.com`; see `render.yaml`.
- Frontend modules and styles use query-string cache versions. Bump affected
  imports and entry-point versions when shipping frontend changes. Keep all
  imports of each module on the same version so they share one browser instance.
- Never commit environment variables, API keys, or generated Graft caches.

## Recent behavior and decisions

- A synthetic gateway request with a 32-character lowercase hex `bmo_trace`
  query value logs its route template, HTTP method and validated `CF-Ray` as
  soon as it reaches Flask. This works for CORS preflights and logs neither
  the request body nor credentials. On November 24, clean Brave, Chrome and
  Firefox sessions all reproduced intermittent public API timeouts. Two
  Chrome HTTP/2 streams sent headers while sibling streams on the same
  connection received responses. Both routes reached the same Render
  revision on successful probes. The precise failing hop remains unverified.

- Production chat history, model catalog, chat streams, and voice setup use
  the same-origin `/bmo-api` Vercel rewrite to Render. This removes browser
  CORS preflights from those requests. The Vercel project uses `frontend/` as
  its root, so `frontend/vercel.json` declares the rewrite and private cache policy.
  Voice WebSockets, media uploads, custom API overrides, and local development
  use their direct gateway URLs. Live verification exercised a complete Aeon
  chat stream through the rewrite with a temporary test account.
- A disconnected Supabase read gets one retry on chat setup and history paths.
  A voice overlay opens its synthesis WebSocket when text is ready to speak
  and closes it when playback ends or is canceled, freeing its Gunicorn thread.
  A browser trace caught two history preflights that never appeared in Render
  application logs. A separate local Gunicorn check showed that eight idle
  voice sockets could block an eight-thread worker. Conversation list,
  history, and model catalog reads retry once through the direct gateway
  within a 21-second budget.

- Chat math shows native MathML until KaTeX's stylesheet loads, including
  when the stylesheet request fails. Once loaded, KaTeX typesets the same
  equations and keeps MathML available to assistive technology. Chromium
  reproduced the duplicate `log 0` and `sin 0` before the fix and verified
  one visible copy with delayed, loaded, and blocked CSS. The browser check
  used fixture replies rather than a live model turn.

- Attachment upload and signed-URL creation retry transient storage
  disconnects independently. An upload retry reuses the same scoped object
  path and bytes, including when the first request wrote the object before
  disconnecting. Render returned two upload errors during a concurrent
  image batch before this change. A regression test verifies recovery with
  one stored object. The composer queues at most two active attachment transfers
  across selections, while preserving all previews and attachment order.

- Vision chats keep the six-image upload cap. Oversized inference copies are
  bounded to 1.5 MiB each and the stored originals are retained. Mistral vision
  requests use up to 4,096 output tokens per completion window, and background
  descriptions use one batch for the images on a message. Vision usage applies
  the same quota weight for either selected chat model and sums provider token
  totals across completion windows and PDF batches. When totals are unavailable,
  the meter estimates text tokens and adds 1,024 per image part. Background
  descriptions and pre-output rejected retries do not add to the user's quota.
  The Mistral account's provider limits stay separate from the app's quota.

- Retry on the latest saved chat turn reuses the conversation, question, and
  attachments. A successful regeneration updates the existing reply, and an
  interrupted regeneration preserves the previous reply. Retrying earlier
  turns still branches so later messages are preserved. A stream that closes
  before any output now reports an error. Render logs on November 23 confirmed
  repeated Mistral HTTP 429 responses and zero answer characters on the
  original conversation. Vision turns now allow one additional rate-limit
  retry within the first-output window and show a waiting status for longer
  delays. The final retry without a provider delay hint uses the remaining
  response budget after attachment preparation. The recovery path was
  exercised with simulated provider responses.

- WhatsApp Bmo defaults to casual, direct replies. Simple questions usually
  get one to three sentences, with room for details or steps when needed.
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
  explicit selection. Desktop and touch devices wait through 650 ms of
  quiet before arming the semantic check, then give new speech another
  300 ms to cancel it. The browser and Nova use a 1,800 ms quiet fallback.
  Delayed provider endpoints cannot close a take during or directly after
  resumed speech. An 85 Hz high-pass filter reduces rumble in the detector.
  Spoken cues require a search event.
  REA in Chromium and a Firefox check kept one synthetic mic recording
  through a 600 ms pause and ignored stale endpoints. Mic release measured
  1,028 ms in Chromium and 978 ms in Firefox with a positive semantic
  verdict, and 1,823 ms in Firefox on recorded recovery. Provider responses
  were simulated. Recorded recovery requires the updated API. All 241
  frontend and 635 backend tests passed.
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
  `ministral-14b-2512` via `MISTRAL_VISION_MODEL`. Existing file extraction,
  PDF page rendering and batching, and saved attachment context are reused.
  Regular chat follow-ups use saved text and the selected chat model once
  descriptions are available. Unsupported or oversized chat images are
  converted to a bounded PNG for inference, with the original kept in storage.
  Simulated Mistral requests verified the model for new image turns,
  follow-ups awaiting descriptions, mixed PDF batches, and background descriptions.
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
