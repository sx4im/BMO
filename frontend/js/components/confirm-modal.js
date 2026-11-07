import { el } from "../utils.js?v=51";

import { mountDialog } from "./dialog.js";

let activeDialog = null;
function close() { activeDialog?.close(); }

/**
 * Claude-style confirm dialog. Layout: title + message (+ optional type-to-
 * confirm field), then Cancel / Confirm.
 *
 * Pass `confirmPhrase` (e.g. "DELETE") to require the user to type that
 * exact string before Confirm is enabled — used for destructive account wipe.
 */
export function openConfirmModal({
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  confirmPhrase = null,
  confirmPhraseLabel = null,
  danger = true,
  onConfirm,
}) {
  if (activeDialog) close();

  const needsPhrase = typeof confirmPhrase === "string" && confirmPhrase.length > 0;
  const expected = needsPhrase ? confirmPhrase : "";

  const cancelBtn = el(
    "button",
    {
      type: "button",
      class: "confirm-modal-btn cancel",
      onclick: close,
    },
    [cancelText]
  );

  const confirmBtn = el(
    "button",
    {
      type: "button",
      class: `confirm-modal-btn ${danger ? "danger" : "primary"}`,
      disabled: needsPhrase ? true : undefined,
      onclick: () => {
        if (needsPhrase && input.value.trim() !== expected) return;
        close();
        onConfirm();
      },
    },
    [confirmText]
  );

  let input = null;
  const children = [
    el("h3", { class: "confirm-modal-title", text: title }),
    el("p", { class: "confirm-modal-message", text: message }),
  ];

  if (needsPhrase) {
    const label = confirmPhraseLabel || `Type ${expected} to confirm`;
    input = el("input", {
      type: "text",
      class: "confirm-modal-input",
      autocomplete: "off",
      spellcheck: "false",
      autocapitalize: "characters",
      placeholder: expected,
      "aria-label": label,
      oninput: () => {
        const ok = input.value.trim() === expected;
        confirmBtn.disabled = !ok;
      },
      onkeydown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (!confirmBtn.disabled) confirmBtn.click();
        }
      },
    });
    children.push(
      el("label", { class: "confirm-modal-field" }, [
        el("span", { class: "confirm-modal-field-label", text: label }),
        input,
      ])
    );
  }

  children.push(el("div", { class: "confirm-modal-actions" }, [cancelBtn, confirmBtn]));

  const card = el(
    "div",
    {
      class: "confirm-modal-card",
      onclick: (e) => e.stopPropagation(),
    },
    children
  );

  const overlay = el(
    "div",
    {
      class: "confirm-modal-overlay",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "confirm-modal-title",
      onclick: close,
    },
    [card]
  );

  const dialog = mountDialog(overlay, {
    title: card.querySelector(".confirm-modal-title"),
    initialFocus: input || cancelBtn,
    closeDelay: 160,
    onClose: () => { if (activeDialog === dialog) activeDialog = null; },
  });
  activeDialog = dialog;
}

export function openPromptModal({
  title,
  initialValue = "",
  confirmText = "Save",
  cancelText = "Cancel",
  onConfirm,
}) {
  if (activeDialog) close();

  const cancelBtn = el(
    "button",
    {
      type: "button",
      class: "confirm-modal-btn cancel",
      onclick: close,
    },
    [cancelText]
  );

  const confirmBtn = el(
    "button",
    {
      type: "button",
      class: "confirm-modal-btn primary",
      onclick: () => {
        const val = input.value.trim();
        if (!val) return; // don't submit empty
        close();
        onConfirm(val);
      },
    },
    [confirmText]
  );

  const input = el("input", {
    type: "text",
    class: "confirm-modal-input",
    autocomplete: "off",
    spellcheck: "false",
    value: initialValue,
    oninput: () => {
      confirmBtn.disabled = !input.value.trim();
    },
    onkeydown: (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!confirmBtn.disabled) confirmBtn.click();
      }
    },
  });

  // Ensure initial button state matches initial value
  confirmBtn.disabled = !initialValue.trim();

  const children = [
    el("h3", { class: "confirm-modal-title", text: title }),
    el("div", { class: "confirm-modal-field", style: "margin-top: 16px;" }, [input]),
    el("div", { class: "confirm-modal-actions" }, [cancelBtn, confirmBtn])
  ];

  const card = el(
    "div",
    {
      class: "confirm-modal-card",
      onclick: (e) => e.stopPropagation(),
    },
    children
  );

  const overlay = el(
    "div",
    {
      class: "confirm-modal-overlay",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "confirm-modal-title",
      onclick: close,
    },
    [card]
  );

  const dialog = mountDialog(overlay, {
    title: card.querySelector(".confirm-modal-title"), initialFocus: input, closeDelay: 160,
    onClose: () => { if (activeDialog === dialog) activeDialog = null; },
  });
  activeDialog = dialog;
  input.setSelectionRange(0, input.value.length);
}
