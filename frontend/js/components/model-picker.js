// Modal dialog for picking the AI mode per conversation.
// Returns a Promise that resolves with the chosen mode id, or null on cancel.

import { el, clear } from "../utils.js?v=30";
import { icon } from "../icons.js?v=30";
import { mountDialog } from "./dialog.js";

export function openModelPicker({ models = [], defaultModel = null, currentModel = null } = {}) {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "modal-overlay" });
    let selected = currentModel || defaultModel || models[0]?.id || null;
    let result = null;
    let dialog;

    const close = (value) => {
      result = value;
      dialog.close();
    };

    const list = el("div", { class: "model-list" });

    function renderList() {
      clear(list);
      if (!models.length) {
        list.append(
          el("p", { class: "muted", style: "padding:16px;text-align:center", text: "No modes available. Check API_KEY on the backend." })
        );
        return;
      }
      for (const m of models) {
        const active = m.id === selected;
        list.append(
          el(
            "button",
            {
              type: "button",
              class: `model-row ${active ? "active" : ""}`,
              onclick: () => {
                selected = m.id;
                renderList();
              },
            },
            [
              el("div", { class: "row-head" }, [
                el("span", { class: "label", text: m.label || m.id }),
                m.id === defaultModel ? el("span", { class: "tag", text: "Default" }) : null,
              ].filter(Boolean)),
              m.note ? el("div", { class: "row-meta", text: m.note }) : null,
            ]
          )
        );
      }
    }
    renderList();

    const modal = el(
      "div",
      {
        class: "modal modal-wide",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "bimo-model-picker-title",
      },
      [
        el(
          "div",
          { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:12px" },
          [
            el("h2", {
              id: "bimo-model-picker-title",
              style:
                "margin:0;font-family:var(--font-display);font-weight:400;font-size:22px;color:var(--ink);letter-spacing:-0.01em",
              text: "Choose mode",
            }),
            el("button", {
              type: "button",
              class: "btn ghost icon",
              "aria-label": "Close",
              onclick: () => close(null),
              html: icon("x"),
            }),
          ]
        ),
        el("p", {
          class: "muted",
          style: "margin:0 0 14px;font-size:13px;font-family:var(--font-sans)",
          text: "Pick a mode for this conversation. Each option is tuned for a different kind of task.",
        }),
        list,
        el(
          "div",
          { style: "display:flex;justify-content:flex-end;gap:8px;margin-top:16px" },
          [
            el("button", { type: "button", class: "btn ghost", onclick: () => close(null), text: "Cancel" }),
            el("button", {
              type: "button",
              class: "btn primary",
              onclick: () => close(selected),
              text: "Use this mode",
            }),
          ]
        ),
      ]
    );

    overlay.append(modal);
    dialog = mountDialog(overlay, { title: modal.querySelector("h2"), onClose: () => resolve(result) });
  });
}
