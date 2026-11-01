// Bmo wrapper around the vendored thinking-orbs web component
// (https://orbs.jakubantalik.com — canvas orb animations by Jakub Antalik &
// Alex Brinza). The runtime auto-detects theme from ancestor data-theme /
// .dark / .light, pauses offscreen and under prefers-reduced-motion, and
// caps DPR-aware backing stores at 2x.
//
// Sizes are free-form: the library tunes particle density from the nearest
// preset bucket (<=32px -> compact tune) and draws scaled to the box.

import "../vendor/thinking-orbs/web-component.js"; // idempotent customElements.define

/**
 * Create a thinking-orb <thinking-orb> element.
 * @param {object} [opts]
 * @param {"working"|"searching"|"solving"|"listening"|"composing"|"shaping"} [opts.state="working"]
 * @param {number} [opts.size=16] Rendered box in CSS px.
 * @param {string} [opts.ariaLabel]
 * @param {number} [opts.speed] Animation speed multiplier (default 1).
 * @returns {HTMLElement}
 */
export function createOrb({ state = "working", size = 16, ariaLabel, speed } = {}) {
  const orb = document.createElement("thinking-orb");
  orb.setAttribute("state", state);
  orb.setAttribute("size", String(size));
  if (ariaLabel) orb.setAttribute("aria-label", ariaLabel);
  if (speed && speed !== 1) orb.setAttribute("speed", String(speed));
  return orb;
}

/** Thought-process orb (composing — undulating multi-band sash). */
export function thoughtOrb(size = 14) {
  return createOrb({ state: "composing", size, ariaLabel: "Thinking" });
}

/** Web-search orb (searching — scan meridian sweeps a dotted globe). */
export function searchOrb(size = 16) {
  return createOrb({ state: "searching", size, ariaLabel: "Searching the web" });
}

/** Page-reading orb (working — churns while a pasted link is fetched). */
export function readingOrb(size = 16) {
  return createOrb({ state: "working", size, ariaLabel: "Reading the webpage" });
}
