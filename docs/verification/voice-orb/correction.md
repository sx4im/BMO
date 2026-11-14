# Orb-only correction

The user clarified that the surrounding interface should retain its original background and controls, with the procedural orb centered and colored Bimo orange. This direction supersedes the earlier black-screen screenshot reconstruction.

## Changes

- Restored theme-based background, title, visible status text, input and original 48px controls from commit `1b4b6d8`. No speech controls were added or removed.
- Centered the orb in the viewport, retaining the original 220px desktop and 170px mobile sizes; short landscape uses 96px to leave space for the controls.
- Used the existing `#d97757` brand color with cream fog. Increased the internal flow speed and density variation because the earlier field evolved too slowly to look alive.
- Capped the larger orb at 256 internal pixels before adaptive scaling, retaining the existing frame cap, audio envelopes, visibility handling and reduced-motion still frame.
- Added bounded recovery from browser recognition that never starts (3 seconds) or never returns words (6 seconds). It switches to the existing recorder/transcription path; a valid browser result cancels recovery. Stop/close cancels both timers.
- Updated the module cache chain and build ID so existing tabs can receive the corrected build.

## Evidence

The two recovery tests failed before the fix and passed afterward. A third test verifies native browser transcription submits the recognized question and starts assistant playback. The full frontend suite passed **81 tests**. No backend source changed in this correction; its preceding full run passed 414 tests.

The actual Chromium/SwiftShader shader changed by a mean of 1.08 RGB values over a two-second interval without audio, compared with 0.15 before the speed correction. [Motion check](motion-check.json) records the result. This is a bounded visual-motion check, not a hardware performance guarantee.

[Layout checks](layout-check.json) verify exact viewport centering on desktop/mobile, original theme/control dimensions, visible status text, focus and Escape cleanup. [Audio/lifecycle checks](current-browser-check.json) verify microphone/playback energy, silence release, interruption, resizing, reduced motion, context recovery and cleanup using real Web Audio with synthetic inputs. Current [desktop](desktop.png), [mobile](mobile.png) and [orb](orb.png) captures were inspected.

The production backend health endpoint responded successfully with TTS configured, and the previous deployed renderer module was available. Authenticated live transcription/TTS and the user's physical microphone were not accessible for verification. The reproduced recognition hang is a confirmed missing recovery path; it is not proof of the exact browser/provider failure on the user's device.
