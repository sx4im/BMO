# Final UI, Voice and search verification

Date: 2026-11-17.

## Changes

- The jump-to-latest control is a child of the composer wrapper. Native CSS
  positioning tracks draft growth/shrinkage without stale geometry or resize
  subscriptions. Its target is 44px, hover uses the existing orange token, and
  keyboard focus remains visible. Send-arrow motion is press-only.
- “Saim Shafique” retains the existing portfolio target with inherited footer
  text color and a dotted underline. Footer-module import versions are consistent
  across routes to preserve one shared shell instance.
- A brief public creator profile is shared by chat, vision, WhatsApp and Voice.
  Source: https://saimshafique.com, fetched with TinyFish and checked directly.
  Kept name/handle, role, location, focus and portfolio; omitted changing metrics,
  age, earnings and unverified employment. Prior WhatsApp age/job claims removed.
- All 42 supported Voice locales have 12 distinct acknowledgment variants each
  for thinking and search, composed from 4 localized openings and 3 endings.
  Selection avoids immediate repeats. No translation or extra model call occurs
  on the response path. A 650ms delay allows quick answers to skip filler.
- Search acknowledgments require an actual search event. There is at most one
  cue per turn. A cue with no audio is canceled when actual output arrives;
  failed turns cannot restart buffered speech. Urdu/Indic punctuation is treated
  as a sentence boundary, and the first phrase threshold is 40 characters.
- Whole-turn social closings bypass search keyword rules and the classifier.
  Fresh factual requests with polite prefixes continue to search. The router's
  classifier prompt explicitly distinguishes social closings from new requests.

## Verification

- Backend: `backend/.venv/bin/python -m pytest backend/tests -q`:
  **634 passed**, 135 existing dependency/test warnings, 30.00s.
- Frontend: `npm run test:run`: **219 passed**,0 failed, 36.29s.
- Regressions were observed failing before fixes: composer anchoring, social
  closings after news, Urdu search speech/sentence startup, pending-response
  acknowledgments and buffered speech after a failed searched turn.
- Chromium with real chat/composer/feed code and stubbed auth/API: 1280×800 and
  390×844. Long 30-line draft then short draft retained gaps of 12px desktop and
  8px mobile above the composer, with horizontal centers within 1px. Verified
  orange hover, still send arrow on hover, animation on press, and working jump
  action. Screenshots inspected at both sizes. No live user turns were sent.
- Impeccable mechanical scan ran once. It reported existing stylesheet warnings
  outside this refinement and the retained press-only bounce easing. The orange
  palette, native form behavior and scoped motion follow the requested design.
- `git diff --check` passed. Graft build/check refresh the final source graph.

## Limits

Voice tests use deterministic microphone/audio/WebSocket doubles. Real Deepgram
latency and native-speaker review of all 42 translations were not measured.
Short cues improve feedback; they do not make provider inference/network faster.
Search social rules cover English plus common Urdu/Roman-Urdu closings; other
wording continues through the existing classifier rather than a broad keyword
bypass. This record does not establish the earlier outage's root cause.
