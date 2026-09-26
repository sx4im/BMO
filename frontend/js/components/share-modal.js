/**
 * Share modal for BMO conversations.
 * Allows users to generate, copy, update, or revoke a public snapshot link for any chat.
 */

import { el } from "../utils.js?v=51";
import { icon } from "../icons.js?v=72";
import { toast } from "./toast.js?v=58";
import * as api from "../api.js?v=62";

let activeOverlay = null;

function close() {
  if (!activeOverlay) return;
  const overlay = activeOverlay;
  activeOverlay = null;
  document.removeEventListener("keydown", onKey);
  overlay.classList.remove("open");
  setTimeout(() => overlay.remove(), 160);
}

function onKey(e) {
  if (e.key === "Escape") close();
}

export function buildShareUrl(shareId) {
  const origin = window.location.origin;
  const path = window.location.pathname.replace(/\/+$/, "");
  return `${origin}${path}/#/share/${encodeURIComponent(shareId)}`;
}

export async function openShareModal({ conversation, token, onShared, onUnshared }) {
  if (!conversation?.id || !token) return;
  if (activeOverlay) close();

  let shareData = null;
  let loading = true;
  let copied = false;

  const titleEl = el("h3", { class: "confirm-modal-title", text: "Share link to chat" });
  const descEl = el("p", {
    class: "confirm-modal-message",
    text: "Messages you send after sharing won't be shared. Anyone with this link can view the conversation.",
  });

  const closeBtn = el(
    "button",
    {
      type: "button",
      class: "share-modal-close-btn",
      "aria-label": "Close",
      onclick: close,
      html: icon("x", { width: 18, height: 18 }),
    }
  );

  const inputEl = el("input", {
    type: "text",
    class: "confirm-modal-input share-modal-input",
    readonly: true,
    value: "Loading share link…",
    onclick: () => inputEl.select(),
  });

  const copyBtn = el(
    "button",
    {
      type: "button",
      class: "confirm-modal-btn primary share-modal-copy-btn",
      disabled: true,
      onclick: async () => {
        if (!shareData?.share_id) return;
        const url = buildShareUrl(shareData.share_id);
        try {
          await navigator.clipboard.writeText(url);
          copyBtn.innerHTML = `${icon("check", { width: 14, height: 14 })} Copied`;
          toast("Link copied to clipboard!", { tone: "info" });
          setTimeout(() => {
            copyBtn.innerHTML = `${icon("copy", { width: 14, height: 14 })} Copy link`;
          }, 2000);
        } catch {
          inputEl.select();
        }
      },
    },
    [el("span", { html: icon("copy", { width: 14, height: 14 }) }), " Copy link"]
  );

  const linkRow = el("div", { class: "share-modal-link-row" }, [
    inputEl,
    copyBtn,
  ]);

  const statusNote = el("div", { class: "share-modal-status-note", text: "" });

  const updateBtn = el(
    "button",
    {
      type: "button",
      class: "confirm-modal-btn cancel share-modal-update-btn",
      style: "display: none;",
      onclick: async () => {
        updateBtn.disabled = true;
        updateBtn.textContent = "Updating…";
        try {
          const res = await api.shareConversation(token, conversation.id);
          shareData = res;
          inputEl.value = buildShareUrl(res.share_id);
          statusNote.textContent = "Snapshot updated with the latest messages.";
          toast("Public snapshot updated", { tone: "info" });
          onShared?.(res);
        } catch (err) {
          toast(err.message || "Failed to update link", { tone: "error" });
        } finally {
          updateBtn.disabled = false;
          updateBtn.textContent = "Update link";
        }
      },
    },
    ["Update link"]
  );

  const deleteBtn = el(
    "button",
    {
      type: "button",
      class: "confirm-modal-btn danger share-modal-delete-btn",
      style: "display: none;",
      onclick: async () => {
        deleteBtn.disabled = true;
        deleteBtn.textContent = "Deleting…";
        try {
          await api.deleteConversationShare(token, conversation.id);
          toast("Public link deleted", { tone: "warning" });
          onUnshared?.(conversation.id);
          close();
        } catch (err) {
          toast(err.message || "Failed to delete link", { tone: "error" });
          deleteBtn.disabled = false;
          deleteBtn.textContent = "Delete link";
        }
      },
    },
    ["Delete link"]
  );

  const doneBtn = el(
    "button",
    {
      type: "button",
      class: "confirm-modal-btn cancel",
      onclick: close,
    },
    ["Done"]
  );

  const actionsRow = el("div", { class: "confirm-modal-actions share-modal-actions" }, [
    deleteBtn,
    updateBtn,
    doneBtn,
  ]);

  const card = el(
    "div",
    { class: "confirm-modal-card share-modal-card", role: "dialog", "aria-modal": "true" },
    [
      el("div", { class: "share-modal-header" }, [titleEl, closeBtn]),
      descEl,
      linkRow,
      statusNote,
      actionsRow,
    ]
  );

  const overlay = el("div", { class: "confirm-modal-overlay" }, [card]);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  document.body.appendChild(overlay);
  activeOverlay = overlay;
  document.addEventListener("keydown", onKey);

  requestAnimationFrame(() => {
    overlay.classList.add("open");
  });

  // Fetch or create share link
  try {
    const existing = await api.getConversationShare(token, conversation.id);
    if (existing?.shared && existing?.share_id) {
      shareData = existing;
      inputEl.value = buildShareUrl(existing.share_id);
      copyBtn.disabled = false;
      updateBtn.style.display = "inline-block";
      deleteBtn.style.display = "inline-block";
      statusNote.textContent = "This chat is publicly accessible via the link above.";
    } else {
      // Auto-create snapshot upon opening share dialog
      inputEl.value = "Creating public link…";
      const created = await api.shareConversation(token, conversation.id);
      shareData = created;
      inputEl.value = buildShareUrl(created.share_id);
      copyBtn.disabled = false;
      updateBtn.style.display = "inline-block";
      deleteBtn.style.display = "inline-block";
      statusNote.textContent = "Link created! Anyone with this link can view this chat.";
      onShared?.(created);
    }
  } catch (err) {
    inputEl.value = "Could not generate link";
    statusNote.textContent = err.message || "Failed to generate public share link.";
    toast(err.message || "Failed to generate share link", { tone: "error" });
  } finally {
    loading = false;
  }
}
