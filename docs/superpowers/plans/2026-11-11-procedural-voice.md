# Procedural voice orb implementation plan

Goal: replace the prerecorded voice orb with live blue/white procedural fog, preserving Bimo's transcription, VAD, language selection, TTS streaming, interruption and authentication.

Spec: `/home/saim/.codex/attachments/92a87ba2-e4cf-498c-88b3-7d46d6872f53/pasted-text-1.txt`. The reference screenshot was supplied November 14. The final comparison and subsequent shader/layout refinements are recorded in the verification note.

Design: black fullscreen surface; 96px cornflower/periwinkle/white cloud sphere near lower centre; 768×52px dark control pill, 28px below the canvas, with existing input, language, mic and close actions. State announcements remain accessible. Transcripts remain available without introducing decorative controls.

Architecture: native WebGL2 fullscreen primitive and separate GLSL module, bounded sphere-volume fog sampling with layered warped 3D noise. Small renderer API for state, normalized audio levels, resize and destroy. Separate waveform/band analysis and lifecycle ownership in the existing voice overlay. Static fallback and reduced-motion still frame; pause hidden/offscreen rendering.

- [x] Audit search fixes with Ponytail Audit and No AI Slop; reproduce and fix remaining root-cause gaps.
- [x] Implement/test GPU resources, rendering lifecycle, states, visibility, resize, context loss and reduced motion.
- [x] Implement/test waveform RMS, low/mid bands, gate and attack/release; connect microphone capture and shared playback analyser.
- [x] Integrate black responsive layout and preserve functional/accessibility controls; remove obsolete video references and asset, retaining hero media.
- [x] Inspect actual WebGL2 output in browser on desktop/mobile; verify state/audio changes, interruption/reopen, resize, reduced motion and context fallback using synthetic audio and stubbed services.
- [x] Run full backend/frontend suites, final complexity/correctness review, and mechanical design detector.
- [x] Compare the rendered interface against the supplied screenshot; refine broad lower fog bank, saturated upper blue and bar spacing; record approximate measurements and REA limitations.

Review focus: analyser must meter playing audio across queued chunks; pending mic permission cannot revive a closed overlay; no duplicate RAFs or live tracks after close; Web Speech and recorder paths both feed real levels; GPU failure cannot break voice; no claims of exact screenshot matching without the screenshot.

Evidence and limits: [verification note](../../verification/voice-orb/README.md). The November 14 follow-up removed the retired tutoring tool and fixed late transcription/recognition callbacks. Backend: 414 tests passed. Frontend: 78 tests passed. Browser evidence covers Chromium with SwiftShader and Web Audio using synthetic microphone/TTS signals; live services, physical microphones and production device performance remain unverified. See the [follow-up plan](2026-11-14-voice-and-tools-cleanup.md).
