import { el } from "../utils.js?v=51";
import { icon } from "../icons.js?v=72";
import { mountDialog } from "./dialog.js";
import * as api from "../api.js?v=62";

let activeDialog = null;

export function buildShareUrl(shareId) {
  const path = window.location.pathname.replace(/\/+$/, "");
  return `${window.location.origin}${path}/#/share/${encodeURIComponent(shareId)}`;
}

export async function openShareModal({ conversation, token, onShared, onUnshared }) {
  if (!conversation?.id || !token) return;
  activeDialog?.close();
  let shareData = null;
  let busy = false;
  let dialog;
  const title = el("h3", { class: "confirm-modal-title", text: "Share link to chat" });
  const description = el("p", { class: "confirm-modal-message", text: "Creating a link publishes a snapshot of this chat. Anyone with the link can view it. Later messages stay private unless you update the link." });
  const close = el("button", { type: "button", class: "share-modal-close-btn", "aria-label": "Close", html: icon("x", { width: 18, height: 18 }), onclick: () => dialog.close() });
  const input = el("input", { type: "text", class: "confirm-modal-input share-modal-input", "aria-label": "Public share link", readonly: true, value: "Loading sharing status…", onclick: () => input.select() });
  const status = el("div", { class: "share-modal-status-note", role: "status", "aria-live": "polite" });
  const copy = el("button", { type: "button", class: "confirm-modal-btn primary share-modal-copy-btn", text: "Copy link", disabled: true, onclick: async () => {
    if (!dialog.isOpen || !shareData?.share_id) return;
    try {
      await navigator.clipboard.writeText(buildShareUrl(shareData.share_id));
      if (dialog.isOpen) status.textContent = "Link copied.";
    } catch {
      if (dialog.isOpen) { input.focus(); input.select(); status.textContent = "Select and copy the link above."; }
    }
  } });
  const create = el("button", { type: "button", class: "confirm-modal-btn primary share-modal-create-btn", text: "Create public link", hidden: true, onclick: () => publish(false) });
  const update = el("button", { type: "button", class: "confirm-modal-btn cancel share-modal-update-btn", text: "Update link", onclick: () => publish(true) });
  const revoke = el("button", { type: "button", class: "confirm-modal-btn danger share-modal-delete-btn", text: "Delete link", onclick: async () => {
    if (!dialog.isOpen || busy) return;
    setBusy(true);
    try {
      await api.deleteConversationShare(token, conversation.id);
      onUnshared?.(conversation.id);
      dialog.close();
    } catch (error) { showError(error, "Could not delete the link. Please retry."); }
    finally { setBusy(false); }
  } });
  const actions = el("div", { class: "confirm-modal-actions share-modal-actions", hidden: true }, [revoke, update]);
  const retry = el("button", { type: "button", class: "confirm-modal-btn cancel", text: "Retry", hidden: true, onclick: () => loadStatus() });
  const card = el("div", { class: "confirm-modal-card share-modal-card", role: "dialog" }, [
    el("div", { class: "share-modal-header" }, [title, close]), description,
    el("div", { class: "share-modal-link-row" }, [input, copy]), status, create, retry, actions,
  ]);
  const overlay = el("div", { class: "confirm-modal-overlay" }, [card]);
  dialog = mountDialog(overlay, { title, initialFocus: close, closeDelay: 160, onClose: () => { if (activeDialog === dialog) activeDialog = null; } });
  activeDialog = dialog;

  function setBusy(value) {
    busy = value;
    for (const button of [create, update, revoke, retry]) button.disabled = value;
    card.setAttribute("aria-busy", String(value));
  }
  function showError(error, fallback) {
    if (!dialog.isOpen) return;
    status.setAttribute("role", "alert");
    status.textContent = error.message || fallback;
  }
  function showLink(data) {
    shareData = data;
    input.value = buildShareUrl(data.share_id);
    copy.disabled = false;
    create.hidden = true;
    retry.hidden = true;
    actions.hidden = false;
    status.setAttribute("role", "status");
    status.textContent = "This snapshot is accessible to anyone with the link.";
  }
  async function publish(updating) {
    if (!dialog.isOpen || busy) return;
    setBusy(true);
    try {
      const data = await api.shareConversation(token, conversation.id);
      // A confirmed mutation can finish after dismissal. Report its result to
      // its owner without updating or closing a newer dialog instance.
      onShared?.(data);
      if (dialog.isOpen) {
        showLink(data);
        status.textContent = updating ? "Snapshot updated with the latest messages." : "Public link created.";
        if (!updating) copy.focus();
      }
    } catch (error) { showError(error, "Could not create the link. Please retry."); }
    finally { setBusy(false); }
  }
  async function loadStatus() {
    if (!dialog.isOpen || busy) return;
    setBusy(true);
    retry.hidden = true;
    try {
      const existing = await api.getConversationShare(token, conversation.id);
      if (!dialog.isOpen) return;
      if (existing?.shared && existing.share_id) showLink(existing);
      else {
        input.value = "";
        input.placeholder = "No public link yet";
        create.hidden = false;
        status.setAttribute("role", "status");
        status.textContent = "This chat has not been published. Create a link when you are ready to share.";
      }
    } catch (error) {
      if (dialog.isOpen) { input.value = ""; input.placeholder = "Sharing status unavailable"; retry.hidden = false; showError(error, "Could not load sharing status."); }
    } finally { setBusy(false); }
  }
  await loadStatus();
}
