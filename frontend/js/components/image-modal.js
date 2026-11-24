// Full-screen image preview. Click any attached image (in a message or in the
// composer attachment chips) to open it here; dismiss with the X button, a
// click on the backdrop, or Escape.

import { el } from "../utils.js?v=52";
import { icon } from "../icons.js?v=77";

let activeOverlay = null;

function close() {
  if (!activeOverlay) return;
  const overlay = activeOverlay;
  activeOverlay = null;
  document.removeEventListener("keydown", onKey);
  overlay.classList.remove("open");
  // Let the fade-out play before removing.
  setTimeout(() => overlay.remove(), 160);
}

function onKey(e) {
  if (e.key === "Escape") close();
}

export function openImageModal(url, filename) {
  if (!url) return;
  // Only one preview at a time.
  if (activeOverlay) close();

  const closeBtn = el("button", {
    type: "button",
    class: "image-modal-close",
    "aria-label": "Close preview",
    title: "Close",
    onclick: close,
    html: icon("x", { width: 22, height: 22 }),
  });

  const img = el("img", {
    src: url,
    alt: filename || "attachment",
    class: "image-modal-img",
  });

  // Clicking the image itself shouldn't close (only the backdrop / X / Esc).
  const figure = el("figure", {
    class: "image-modal-figure",
    onclick: (e) => e.stopPropagation(),
  }, [img]);

  const overlay = el("div", {
    class: "image-modal-overlay",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": filename || "Image preview",
    onclick: close, // backdrop click
  }, [closeBtn, figure]);

  document.body.append(overlay);
  activeOverlay = overlay;
  document.addEventListener("keydown", onKey);
  // Next frame so the open transition runs.
  requestAnimationFrame(() => overlay.classList.add("open"));
}
