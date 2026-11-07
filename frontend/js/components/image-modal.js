// Full-screen image preview. Click any attached image (in a message or in the
// composer attachment chips) to open it here; dismiss with the X button, a
// click on the backdrop, or Escape.

import { el } from "../utils.js?v=30";
import { icon } from "../icons.js?v=30";
import { mountDialog } from "./dialog.js";

let activeDialog = null;

function close() {
  activeDialog?.close();
}

export function openImageModal(url, filename) {
  if (!url) return;
  // Only one preview at a time.
  close();

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

  const dialog = mountDialog(overlay, { initialFocus: closeBtn, closeDelay: 160,
    onClose: () => { if (activeDialog === dialog) activeDialog = null; } });
  activeDialog = dialog;
}
