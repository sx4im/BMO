# Chat and voice update phases

## 1. Interface consistency

- [x] Matching icon-and-text Edit/Delete actions in Projects and Customize; static download icon for Export.
- [x] Blue `/skill-name` selections with accessible removal, preserving skill IDs and the existing composer.
- [x] Same compact menu dimensions, typography and hover states in the sidebar and chat header.
- [x] Loading indicators for Instructions and Skills; full “Incognito chat” desktop header label.
- [x] Routine success toasts removed for pin/unpin, rename, move, deletion, downloads and share-link actions; existing inline feedback and errors remain.
- [x] Visible branding standardized to Bmo, including exported style names and prompt text. Existing domain names, repository URLs and compatibility identifiers retain their technical spelling.

Verify with the frontend suite and Chrome on desktop/mobile, both themes, keyboard and touch.

## 2. Reliable files and images

- [x] Accept and read CSV in chat and PPTX in project knowledge, using existing parsers.
- [x] Renew signed attachment URLs on authorized history/share reads; refresh a failed image without rebuilding chat.
- [x] Keep ownership checks and safe paths, including shared snapshots.

Verify extracted slide text, tables, notes and CSV rows in model context. Test expired signatures, storage failures and foreign paths.

## 3. Responsive voice with search

- [x] Allow Aeon to use the existing selective search router, without fetching arbitrary pasted URLs in voice mode.
- [x] Speak a short search announcement only when retrieval actually starts; speak Aeon's answer rather than search snippets.
- [x] Request useful replies of about three or four sentences, with brevity for acknowledgements or when requested.
- [x] Reduce avoidable silence and buffering; preserve interruption, language changes and completion handling.
- [x] Select restrained delivery appropriate to the conversation using documented Flux controls; retain Aura compatibility.

Verify routing, streaming text boundaries, ordered audio, interruption, search announcements, tone controls and errors with deterministic tests. Real call timing and pronunciation require microphone/listening checks.

Research: [Deepgram client messages](https://developers.deepgram.com/docs/flux-tts/client-messages), [expression](https://developers.deepgram.com/docs/tts-expressivity), [speed](https://developers.deepgram.com/docs/tts-voice-controls), [latency](https://developers.deepgram.com/docs/text-to-speech-latency). Flux expression is a per-connection beta register control, not a named emotion or an SSML tag. Aura does not support it. Use moderate values and document listening checks.

## 4. Natural replies and release

- [x] Distill the requested [Humanizer skill](https://github.com/blader/humanizer/blob/main/SKILL.md) into short writing rules in the main prompt: concrete wording, varied cadence, no filler, invented claims or repetitive closers.
- [x] Default to no emojis and no long dashes. Explicit user style requests can override writing preferences while safety rules retain precedence.
- [x] Run backend/frontend suites and browser checks; review the final diff.
- [x] Commit completed phases and push to main.

No new dependencies or database migration were needed. Keep the existing authentication, escaping, retrieval and incremental rendering architecture.

## Verification and release notes

- Full backend suite: 323 passed, with 95 existing dependency/test-key warnings. Focused final document, image and voice regressions also pass.
- Frontend suite: 42 passed. Tests cover real voice overlay logic with simulated PCM and WebSocket events, Aura completion, Flux delivery parameters, search announcement order, cancellation, SSE delivery metadata, image retry and independent loading states.
- Chrome checks: matching 36px workspace buttons, 175px menus with matching rows/shadows, blue skill tokens, stable composer nodes, busy/error/retry states, renewed image loading, no pin toasts, keyboard focus and desktop/mobile layouts in both themes. No JavaScript exceptions or CSP violations.
- No new dependencies or database migration. Deploy frontend and backend from the same revision.
- No local Deepgram credentials were available. Live microphone timing, pronunciation and subjective expression have not been auditioned.

PPTX parsing reads slide text, tables and speaker notes. Chat retains its existing first-ten-slides cap; project knowledge reads all slides within the knowledge budget. CSV chat uploads accept UTF-8, including a BOM.

Flux English uses the existing Sienna voice, speed 1.05 at neutral, 1.0 for gentle and 1.1 for lively delivery; expression is 0, -1 and 1 respectively. Aeon chooses the register in a short metadata prefix, removed before tokens are shown or stored. The client reconnects only when delivery/language changes because expression is fixed per connection. Existing Aura language voices retain their protocol and receive no unsupported expression parameter; wording still follows the conversation's tone.

The spoken search announcement is a separate short synthesis turn. Once it drains, only Aeon's answer is spoken. Search results feed the existing prompt architecture, and pasted links are not scraped by the voice frontend. Normal text chat keeps its existing URL-reading behavior.

Input silence is 750ms after a finalized browser result or 1100ms for interim/VAD input; microphone cooldown is 250ms. These remove fixed waiting but are not a measured end-to-end latency guarantee. First-audio timing logs contain milliseconds, without transcript text.

## Manual listening and account checklist

- [ ] In a deployed account, import a PPTX with tables/notes and a CSV; ask questions whose answers depend on their contents.
- [ ] Reopen a conversation with an older uploaded image and a public shared snapshot. Confirm the picture loads, and revoked/foreign access is still refused.
- [ ] Save and reload Instructions and Skills; test retry on an offline connection.
- [ ] In voice, greet Bmo (no search), ask for current weather (one search announcement), then ask a follow-up. Confirm snippets and website URLs are not narrated.
- [ ] Try a sad topic, a joke and a neutral question. Listen for accurate wording, sensible pacing and restrained register changes, especially since Flux expression is beta.
- [ ] Interrupt during search and speech, switch language, and close/reopen voice. Check no old response restarts playback.
- [ ] Check normal replies default to no emojis/long dashes; explicitly request a different style and confirm it is honored.
