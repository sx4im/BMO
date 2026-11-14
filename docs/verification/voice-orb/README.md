# Search review and procedural voice verification

The voice overlay now renders blue and white fog with native WebGL2. The renderer, shader source and audio meter are separate modules; the existing overlay owns transcription, VAD, TTS and their cleanup. No rendering library or new dependency was added.

The November 14 brief also requested removal of the retired tutoring tool. Its composer state, menu entry, dedicated prompt module, submission/retry/voice fields, backend capability descriptions, dormant quiz rendering callbacks, icon and CSS have been removed. No dedicated table, migration, backend endpoint or standalone asset existed for that tool. Shared conversation prompts, normal educational answers and existing conversation records remain supported. Source scans found no remaining retired feature references in `frontend`, `backend` or the local Graft cards. The Graft CLI was unavailable, so those cards were consulted directly and their obsolete entries removed.

The voice lifecycle review found two additional races. Closing the overlay, typing a replacement question or restarting listening now aborts pending transcription; checks after audio conversion and the provider response prevent stale results and errors from changing the current interaction. Recognition callbacks also check instance ownership, so an old start event cannot replace the current voice state. The transcription API's optional cancellation signal preserves existing callers.

## Search root causes reviewed

Freshness and explicit search requests are considered before generic short-message and coding bypasses. Tests cover short live questions, mixed intents, attachments, contextual follow-ups, current articles, conceptual explanations and malformed classifier responses. Classifier verdicts require JSON booleans. Classifier retries are disabled and attempts share a 1.5-second budget; retrieval attempts share an 8-second budget.

The backend sends a search decision status before routing. Retrieval distinguishes results, empty results and unavailable search; failed retrieval does not become evidence for an answer. Source URLs reach the answer context. Cancellation checks prevent later retrieval or generation, and search runs inside the stream's cleanup boundary. Frontend URL prefetch respects the web toggle and cancellation.

These changes target routing, evidence and early feedback. They do not establish perfect classification or measured production response latency. HTTP timeouts apply to request phases rather than a strict total deadline; cancellation cannot immediately interrupt an already running synchronous provider call.

## Requested audits

Ponytail Audit was applied to the changed search and voice paths. The complexity review removed random status phrase rotation and its timer, used one shared playback analyser across queued chunks, and retained native browser APIs. The renderer's separate shader and meter modules have distinct resource and testing responsibilities. This review does not claim a whole-repository complexity audit.

- `delete:` random status phrase lists and rotation. Use factual event-driven status text. [stream-handler.js](../../../frontend/js/chat/stream-handler.js), [voice-overlay.js](../../../frontend/js/components/voice-overlay.js).
- `native:` replace the prerecorded voice animation with the requested WebGL2 renderer and Web Audio analyser. No framework dependency added. [voice-orb.js](../../../frontend/js/components/voice-orb.js).

The stream handler changed by 17 additions and 69 deletions; the obsolete video removed 618,405 bytes. No further complexity cuts were identified in the reviewed implementation.

No AI Slop was applied to the changed status copy and these notes. Random claims such as “Adjudicating…” and “Metabolizing…” were replaced with “Preparing response…”. Search and transcription states use labels tied to actual events.

The mechanical design detector reported legacy CSS findings outside the voice section. It reported no findings in the new voice section or the reviewed JavaScript. Those legacy styles were left outside this change.

## Evidence against the voice brief

| Requirement | Evidence |
| --- | --- |
| Procedural spherical fog, blue/periwinkle/white palette, soft silhouette | GLSL volume sampling with warped 3D noise; actual browser images inspected: [orb](orb.png), [desktop](desktop.png), [mobile](mobile.png) |
| Four smooth states and real audio analysis | Renderer tests; RMS, frequency band, gate and attack/release tests; real Web Audio synthetic microphone and PCM playback checks |
| Streamed speech, interruption and existing input paths | Voice integration tests exercise queued chunks, late replies after interruption, Web Speech capture, MediaRecorder/VAD capture, cancelled transcription, late errors and successful recording submission |
| Responsive black surface and functional pill | Desktop 96px orb, mobile 92px orb, short landscape check; keyboard language action, focus containment/restoration and background scroll locking |
| Resource and rendering lifecycle | Tests cover one RAF, DPR cap, destroy, hidden/offscreen pause, context loss/restoration, fallback and reduced motion; browser close/reopen stops tracks and draws |
| Bounded rendering cost | 30fps cap, DPR capped at 2, adaptive internal resolution after sustained slow frames, no textures or media downloads |
| Remove old media without changing hero | Obsolete orb asset deleted, frontend references removed, service worker cache version updated; hero media diff is empty |
| Existing suite regression checks | 414 backend tests and 78 frontend tests passed on November 14 |
| Comparison to supplied screenshot | Screenshot received November 14; static appearance and desktop/mobile renders compared, palette/cloud distribution and layout refined in two bounded passes; [comparison](reference-comparison.json) |

Commands run from the repository root:

```sh
backend/.venv/bin/python -m pytest -c backend/pytest.ini backend/tests -q
npm --prefix frontend run test:run
git diff --check
git diff --exit-code -- frontend/assets/hero.mp4
```

Backend tests emitted 105 warnings, including dependency deprecations and short test JWT keys. No tests were skipped or weakened to obtain these results. The obsolete mode-specific assertion was removed as part of deleting the feature; web-toggle behavior remains covered. The voice fixture shares the ArrayBuffer realm so synthetic PCM messages exercise the actual audio queue. The new Tools menu test failed on the removed entry before implementation; cancellation and recognition tests likewise failed before the lifecycle fixes.

Browser checks used Chromium with SwiftShader. [browser-check.json](browser-check.json) records layout, audio RMS, interruption, context recovery, reduced motion and cleanup. [render-check.json](render-check.json) records shader uniforms, envelope release and GL error checks. Rendered state captures: [listening](listening.png), [thinking](thinking.png), [speaking](speaking.png), [fallback](fallback.png).

The final [layout check](layout-check.json) verified current styles and module imports, desktop/mobile dimensions, scroll locking and restoration, Escape dismissal and focus restoration. It recorded no page errors.

The November 14 [browser check](current-browser-check.json) exercised the actual overlay v59 and styles v242 with WebGL2 and Web Audio. A microphone oscillator raised the rendered audio envelope above 0.2; silence reduced it below 0.025. PCM playback raised it above 0.2, then a silent portion of the playing buffer reduced it below 0.025. Interruption during speech and thinking, late replies, 92px mobile and 80px short-landscape orbs, reduced motion, context recovery, close/reopen, stopped tracks and stopped rendering all passed without page errors. The desktop, mobile, orb and state screenshots were refreshed and visually inspected. These are synthetic signals, not a physical microphone or live TTS provider.

The isolated software-rendered sample achieved about 23fps while adapting resolution under a 30fps cap. This is a test-environment observation, not a production performance guarantee. Browser service calls were stubbed and audio was synthetic. Physical microphone behavior, live transcription/TTS providers, Safari/Firefox, mobile hardware performance and deployment were not verified. The supplied screenshot was inspected and used to refine the final appearance. The recreation remains approximate; a still cannot establish the original motion or shader.

## Supplied reference and REA investigation

The reference has a saturated blue upper atmosphere and a broad soft white lower cloud, rather than small white clouds across the full sphere. The final shader retains 16 volume samples, warped 3D noise and audio-driven evolution, with palette and cloud-bank constants grouped in the shader module. The bar now measures 768×52px on desktop, with a 28px canvas gap and approximately 93px painted orb. Existing 44px control targets and the Bimo language control remain. The overlay stays centered in Bimo rather than copying the browser/sidebar offset in the supplied image. [Reference measurements and sampled colors](reference-comparison.json) document the comparison without claiming identical pixels.

REA was used to navigate a temporary Chromium instance to ChatGPT. Its capture reached the Cloudflare verification page, so it supplied no evidence of the original voice shader or its behavior. No existing authenticated CDP target was available. The owned browser was terminated. [REA finding ledger](rea-investigation.json) records the Evidence ID, observed boundary and limitations; the recreation is based on the supplied screenshot, not recovered ChatGPT code.
