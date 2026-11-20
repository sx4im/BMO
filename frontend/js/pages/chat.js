/**
 * Chat page controller for Bmo.
 * Coordinates the message feed, composer, stream handler, voice assistant, and image generation.
 */

import { el, clear, formatTitle } from "../utils.js?v=30";
import { icon } from "../icons.js?v=73";
import { getAuth } from "../auth.js";
import { navigate } from "../router.js";
import { mountAppShell } from "../app-shell.js?v=3";
import { toast } from "../components/toast.js?v=58";
import { openConfirmModal, openPromptModal } from "../components/confirm-modal.js?v=58";
import { openShareModal } from "../components/share-modal.js?v=3";
import { openMoveChatModal } from "./projects.js?v=3";
import { whenMarkdownReady, renderMarkdown } from "../components/markdown.js?v=35";
import { openVoiceOverlay } from "../components/voice-overlay.js?v=69";
import * as api from "../api.js?v=69";

import { Composer, DEFAULT_AVAILABLE_MODELS, extractUrls } from "../chat/composer.js?v=44";
import { MessageFeed } from "../chat/message-feed.js?v=50";
import { StreamHandler, getRandomPhrase } from "../chat/stream-handler.js?v=16";
import {
  detectExportIntent,
  buildCanonicalMarkdown,
  formatExportFilename,
  downloadBlob,
  buildClientDocxBlob,
  printDocumentToPdf,
} from "../export.js?v=5";



function uid(prefix = "tmp") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildScrapeContext(scrapedItems, originalMessage) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const now = new Date().toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

  const docs = scrapedItems.map((item) => {
    const titlePart = item.title ? `"${item.title}" ` : "";
    const header = `=== Webpage Content: ${titlePart}(${item.url}) ===`;
    const content = (item.markdown || "").slice(0, 30000);
    return `${header}\n${content}`;
  }).join("\n\n");

  return (
    `The current date and time is ${now} (today is ${today}). The webpage content ` +
    `below was fetched live for the requested URL(s). It is authoritative ` +
    `and reflects the live page.\n\n` +
    `${docs}\n\n` +
    `User message: ${originalMessage}`
  );
}

export async function renderChat({ id, incognito }, { signal } = {}) {
  const { auth } = getAuth();
  if (!auth) {
    navigate("#/", { replace: true });
    return;
  }
  const shell = await mountAppShell();
  if (signal?.aborted) return;
  shell.setActiveConversation(id || null);

  const host = shell.content;
  clear(host);

  // State
  let conversation = null;
  let messages = [];
  let loading = Boolean(id);
  let availableModels = DEFAULT_AVAILABLE_MODELS;
  let defaultModel = "thinking";
  let searchingLabel = "Reading webpage…";
  let searchVariant = "search"; // "search" (web search) | "reading" (pasted link)

  let enteringId = null;
  let searching = false;
  let pageFetchController = null;
  let searchPreamble = "";
  // The live turn's search card: null, then in-flight, then filled with
  // results. Handed to the assistant message once the answer lands.
  let searchCardData = null;
  let imageGenerating = false;
  let imagePollTimer = null;
  let imageRequest = null;
  let imagePoll = null;
  let submitRevision = 0;
  let voiceHandle = null;
  let activeVoiceOnDelta = null;
  let activeVoiceOnSearch = null;
  let activeVoiceOnStyle = null;
  let unmounted = false;
  const titleRefreshTimers = new Set();
  let conversationListRequest = 0;
  let reconciling = false;
  let branching = false;
  let skillCatalogRequest = 0;
  let requestedSkillIds = [];

  let activeProjectId = null;
  const hashParts = (location.hash || "").split("?");
  if (hashParts.length > 1) {
    const params = new URLSearchParams(hashParts[1]);
    activeProjectId = params.get("project_id") || null;
    if (!id) requestedSkillIds = params.getAll("skill_id").slice(0, 3);
  }
  let projectMeta = null;

  const page = el("div", { class: `chat-page${incognito ? " incognito-mode" : ""}` });

  // Topbar
  const incognitoBtn = el("button", {
    type: "button",
    class: `chat-topbar-incognito${incognito ? " active" : ""}`,
    title: incognito ? "Exit incognito" : "Incognito chat",
    "aria-label": incognito ? "Exit incognito" : "Start incognito",
    "aria-pressed": incognito ? "true" : "false",
    onclick: () => {
      navigate(incognito ? "#/app/chat" : "#/app/chat/incognito");
    },
    html: icon(incognito ? "x" : "incognito", { width: 21, height: 21 }),
  });

  const convoTitleText = el("span", {
    class: "chat-topbar-title-text",
    text: "",
  });

  const convoPinIcon = el("span", {
    class: "menu-icon",
    html: icon("pin", { width: 15, height: 15 }),
  });
  const convoPinLabel = el("span", { class: "menu-label", text: "Pin" });

  const pinItem = el("button", {
    type: "button",
    class: "chat-topbar-menu-item",
    onclick: async (e) => {
      e.stopPropagation();
      closeConvoMenu();
      if (!conversation?.id) return;
      const nextPinned = !conversation.pinned;
      try {
        await api.updateConversation(auth.token, conversation.id, { pinned: nextPinned });
        conversation.pinned = nextPinned;
        updateTopBarTitle();
        loadConversations();
      } catch (err) {
        toast(err?.message || "Couldn't update pin", { tone: "error" });
      }
    },
  }, [
    convoPinIcon,
    convoPinLabel,
  ]);

  const renameItem = el("button", {
    type: "button",
    class: "chat-topbar-menu-item",
    onclick: (e) => {
      e.stopPropagation();
      closeConvoMenu();
      if (!conversation?.id) return;
      openPromptModal({
        title: "Rename chat",
        initialValue: conversation.title,
        confirmText: "Save",
        onConfirm: async (val) => {
          if (val && val !== conversation.title) {
            await api.updateConversation(auth.token, conversation.id, { title: val });
            clearTitleRefreshes();
            conversation.title = val;
            updateTopBarTitle();
            loadConversations();
          }
        },
      });
    },
  }, [
    el("span", { class: "menu-icon", html: icon("pencil", { width: 15, height: 15 }) }),
    el("span", { class: "menu-label", text: "Rename" }),
  ]);

  const deleteItem = el("button", {
    type: "button",
    class: "chat-topbar-menu-item danger",
    onclick: (e) => {
      e.stopPropagation();
      closeConvoMenu();
      if (!conversation?.id) return;
      openConfirmModal({
        title: "Delete chat",
        message: "Are you sure you want to delete this chat?",
        confirmText: "Delete",
        cancelText: "Cancel",
        danger: true,
        onConfirm: async () => {
          await api.deleteConversation(auth.token, conversation.id);
          loadConversations();
          navigate("#/app/chat");
        },
      });
    },
  }, [
    el("span", { class: "menu-icon", html: icon("trash", { width: 15, height: 15 }) }),
    el("span", { class: "menu-label", text: "Delete" }),
  ]);

  const shareItem = el("button", {
    type: "button",
    class: "chat-topbar-menu-item",
    onclick: (e) => {
      e.stopPropagation();
      closeConvoMenu();
      if (!conversation?.id) return;
      openShareModal({
        conversation,
        token: auth.token,
        onShared: () => syncTopBarActions(),
        onUnshared: () => syncTopBarActions(),
      });
    },
  }, [
    el("span", { class: "menu-icon", html: icon("share", { width: 15, height: 15 }) }),
    el("span", { class: "menu-label", text: "Share" }),
  ]);

  const moveItem = el("button", {
    type: "button",
    class: "chat-topbar-menu-item",
    onclick: (e) => {
      e.stopPropagation();
      closeConvoMenu();
      if (!conversation?.id) return;
      openMoveChatModal({
        auth,
        conversation,
        onMoved: async (newProjId) => {
          activeProjectId = newProjId;
          projectMeta = null;
          updateTopBarTitle();
          loadConversations();
        },
      });
    },
  }, [
    el("span", { class: "menu-icon", html: icon("galleryVerticalEnd", { width: 15, height: 15 }) }),
    el("span", { class: "menu-label", text: "Move to project" }),
  ]);

  const convoMenu = el("div", { class: "chat-topbar-menu", role: "menu" }, [
    shareItem,
    pinItem,
    renameItem,
    moveItem,
    deleteItem,
  ]);

  const chevronBtn = el("button", {
    type: "button",
    class: "chat-topbar-chevron-btn",
    "aria-label": "Chat options",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    title: "Chat options",
    onclick: (e) => {
      e.stopPropagation();
      toggleConvoMenu();
    },
    html: icon("chevronDown", { width: 18, height: 18 }),
  });

  const menuAnchor = el("div", { class: "chat-topbar-menu-anchor" }, [
    chevronBtn,
    convoMenu,
  ]);

  const titleWrap = el("div", { class: `chat-topbar-title-wrap${incognito ? " is-incognito" : ""}`, style: "display: none;" }, [
    convoTitleText,
    menuAnchor,
  ]);

  let isConvoMenuOpen = false;
  function closeConvoMenu() {
    isConvoMenuOpen = false;
    convoMenu.classList.remove("open");
    chevronBtn.setAttribute("aria-expanded", "false");
  }

  function toggleConvoMenu() {
    if (incognito || !conversation?.id) return;
    isConvoMenuOpen = !isConvoMenuOpen;
    convoMenu.classList.toggle("open", isConvoMenuOpen);
    chevronBtn.setAttribute("aria-expanded", isConvoMenuOpen ? "true" : "false");
  }

  const onDocClickConvoMenu = (e) => {
    if (!menuAnchor.contains(e.target)) {
      closeConvoMenu();
    }
  };
  document.addEventListener("click", onDocClickConvoMenu);

  const projectBadgeIcon = el("span", {
    class: "project-badge-icon",
    html: icon("galleryVerticalEnd", { width: 13, height: 13 }),
  });
  const projectBadgeText = el("span", { class: "project-badge-name", text: "Project" });
  const projectBadgeLink = el(
    "a",
    {
      class: "chat-topbar-project-badge",
      href: "#/app/projects",
      style: "display: none;",
      title: "Go to project workspace",
    },
    [projectBadgeIcon, projectBadgeText]
  );

  function updateTopBarTitle() {
    syncTopBarActions();
    if (activeProjectId && !incognito) {
      projectBadgeLink.href = `#/app/projects/${activeProjectId}`;
      projectBadgeLink.style.display = "inline-flex";
      if (!projectMeta) {
        api
          .getProject(auth.token, activeProjectId)
          .then((p) => {
            if (p && p.name) {
              projectMeta = p;
              projectBadgeText.textContent = p.name;
            }
          })
          .catch(() => {
            projectBadgeText.textContent = "Project";
          });
      } else {
        projectBadgeText.textContent = projectMeta.name;
      }
    } else {
      projectBadgeLink.style.display = "none";
    }

    if (incognito) {
      convoTitleText.textContent = "";
      menuAnchor.style.display = "none";
      titleWrap.style.display = "none";
      return;
    }
    if (conversation?.title) {
      convoTitleText.textContent = formatTitle(conversation.title);
      convoPinIcon.innerHTML = icon(conversation.pinned ? "pinOff" : "pin", { width: 15, height: 15 });
      convoPinLabel.textContent = conversation.pinned ? "Unpin" : "Pin";
      menuAnchor.style.display = "inline-flex";
      titleWrap.style.display = "inline-flex";
    } else if (id) {
      convoTitleText.textContent = "Chat";
      menuAnchor.style.display = "inline-flex";
      titleWrap.style.display = "inline-flex";
    } else {
      titleWrap.style.display = "none";
    }
  }

  const shareBtn = el("button", {
    type: "button",
    class: "chat-topbar-share-btn",
    title: "Share chat",
    "aria-label": "Share chat",
    style: "display: none;",
    onclick: () => {
      if (conversation?.id) {
        openShareModal({
          conversation,
          token: auth.token,
          onShared: () => syncTopBarActions(),
          onUnshared: () => syncTopBarActions(),
        });
      }
    },
    text: "Share",
  });

  function syncTopBarActions() {
    if (unmounted || !page.isConnected) return;
    const isSavedChat = Boolean(id && !incognito && (messages.length > 0 || (conversation && !conversation._new)));
    if (isSavedChat) {
      incognitoBtn.style.display = "none";
      shareBtn.style.display = "inline-flex";
      shell.setShareActive?.(true, () => {
        if (conversation?.id) {
          openShareModal({
            conversation,
            token: auth.token,
            onShared: () => syncTopBarActions(),
            onUnshared: () => syncTopBarActions(),
          });
        }
      });
    } else {
      incognitoBtn.style.display = "inline-flex";
      shareBtn.style.display = "none";
      shell.setShareActive?.(false);
    }
  }

  const header = el("header", { class: "chat-topbar" }, [
    el("div", { class: "inner" }, [
      el("div", { class: "chat-topbar-left" }, [
        projectBadgeLink,
        titleWrap,
      ]),
      el("div", { class: "chat-topbar-actions" }, [shareBtn, incognitoBtn]),
    ]),
  ]);

  async function handleDirectDownload({ title, content, format }) {
    if (!content || !format) return;
    const docTitle = (title || conversation?.title || "Bmo AI Document").trim();
    const filename = formatExportFilename(docTitle, format);

    if (format === "md") {
      const canonical = buildCanonicalMarkdown({
        title: docTitle,
        content,
        date: new Date(),
      });
      const blob = new Blob([canonical], { type: "text/markdown;charset=utf-8" });
      downloadBlob(blob, filename);
      return;
    }

    try {
      const blob = await api.exportDocument(auth.token, {
        title: docTitle,
        markdown: content,
        format,
      });
      downloadBlob(blob, filename);
    } catch (err) {
      console.warn("Backend export failed, using instant client export:", err);
      if (format === "docx") {
        const htmlContent = renderMarkdown(content);
        const docxBlob = buildClientDocxBlob({ title: docTitle, htmlContent });
        downloadBlob(docxBlob, filename);
      } else if (format === "pdf") {
        const htmlContent = renderMarkdown(content);
        printDocumentToPdf({ title: docTitle, htmlContent });
      } else {
        toast(err.message || `Failed to download ${format.toUpperCase()}`, { tone: "error" });
      }
    }
  }




  // Message Feed
  let attachmentRefresh = null;
  const messageFeed = new MessageFeed({
    onRefreshAttachment: async attachment => {
      const conversationId = conversation?.id || id;
      if (!conversationId || incognito || unmounted || getAuth().auth?.user?.id !== auth.user?.id) return null;
      if (!attachmentRefresh) {
        attachmentRefresh = api.getMessages(auth.token, conversationId).finally(() => { attachmentRefresh = null; });
      }
      const data = await attachmentRefresh;
      return data.messages?.flatMap(message => message.attachments || []).find(a => a.path === attachment.path)?.url;
    },
    onEditMessage: (message) => editMessage(message),
    onRetryMessage: (message) => retryMessage(message),
    onFeedback: (message, sentiment) => handleMessageFeedback(message, sentiment),
    onRetryAssistantMessage: (assistantMsg) => retryAssistantMessage(assistantMsg),
    onExport: ({ message, format, title, content }) => {
      handleDirectDownload({
        title: title || conversation?.title,
        content: content || message?.content,
        format: format === "all" ? "pdf" : format,
      });
    },
  });



  // Stream Handler
  const streamHandler = new StreamHandler({
    getAuthToken: () => auth.token,
    onConversation: (convo) => {
      conversation = convo;
      if (convo?.project_id) {
        activeProjectId = convo.project_id;
      }
      const cid = convo?.id ? String(convo.id) : "";
      const isRealId = cid && !cid.startsWith("pending_") && !cid.startsWith("incognito_");
      if (!incognito && !id && isRealId) {
        id = convo.id;
        history.replaceState(null, "", `#/app/chat/${id}`);
        shell.setActiveConversation(id);
        loadConversations();
      }
      composer.renderModelBadge(incognito);
      updateTopBarTitle();
    },

    onUserMessage: (m) => {
      const mid = m?.id ? String(m.id) : "";
      if (mid.startsWith("msg_pending_")) return;
      messages = messages.filter((x) => !String(x.id).startsWith("tmp_"));
      // A saved row can arrive before the reply, then be refreshed after
      // attachment processing. Reconcile it in place without duplicating or
      // moving the user's question below the assistant's answer.
      const existing = messages.findIndex((x) => String(x.id) === mid);
      if (existing >= 0) messages[existing] = m;
      else messages.push(m);
      renderUI();
    },
    onToken: ({ delta, streamingText, streamingReasoning }) => {
      if (activeVoiceOnDelta) {
        try { activeVoiceOnDelta(streamingText); } catch {}
      }
      if (!document.hidden) {
        messageFeed.updateStreamingBubble(streamingText, streamingReasoning);
      }
    },
    onReasoningToken: ({ delta, streamingText, streamingReasoning }) => {
      if (!document.hidden) {
        messageFeed.updateStreamingBubble(streamingText, streamingReasoning);
      }
    },
    onSearching: ({ query, preamble }) => {
      activeVoiceOnSearch?.();
      searching = true;
      searchPreamble = preamble || "";
      searchVariant = "search";
      searchCardData = { query: query || "", results: [], elapsedMs: null, searching: true };
      renderUI();
      messageFeed.follower.attach();
      messageFeed.scrollToBottom();
    },
    onSearchComplete: ({ results, elapsedMs, status }) => {
      searching = false;
      searchCardData = {
        query: searchCardData?.query || "",
        results: Array.isArray(results) ? results : [],
        elapsedMs: elapsedMs ?? null,
        status,
        searching: false,
      };
      renderUI();
    },
    onStatusChange: ({ phrase, reasoningElapsed, reasoningDone }) => {
      if (phrase) messageFeed.setStatusText(phrase);
      if (reasoningElapsed != null) {
        messageFeed.setStreamingReasoningTimer(`· ${reasoningElapsed}s`);
      }
      // NOTE: reasoningDone no longer collapses the block — users read the
      // thought process while/after the answer streams (Claude behavior).
    },
    onComplete: () => {
      messageFeed.finishStreamingBubble(streamHandler.streamingText, streamHandler.streamingReasoning);
      messageFeed.setStatusText("Done");
    },
    onAssistantMessage: (m) => {
      // Hand the card to the reply it produced so it stays above the answer
      // instead of trailing below it once the message lands.
      if (searchCardData && !searchCardData.searching) {
        m.search = searchCardData;
        searchCardData = null;
      }
      messages.push(m);
      // The answer is already visible; a save acknowledgment is not an entrance.
      enteringId = null;
      composer.isGenerating = false;
      composer.syncSendEnabled();
      renderUI();
      loadConversations();
    },
    onError: (err, partial) => {
      if (unmounted) return;
      if (partial?.content?.trim() || partial?.reasoning?.trim()) {
        messages.push({ id: `unsaved_${uid()}`, role: "assistant", ...partial, unsaved: true });
      }
      if (err?.name !== "AbortError") toast(err.message || "Couldn't connect", { tone: "error" });
      composer.isGenerating = false;
      composer.syncSendEnabled();
      renderUI();
    },
  });


  // Composer
  const composer = new Composer({
    onSubmit: (turn) => handleComposerSubmit(turn),
    onStop: () => {
      ++submitRevision;
      pageFetchController?.abort();
      streamHandler.cancel();
      composer.isGenerating = false;
      searching = false;
      searchPreamble = "";
      searchCardData = null;
      composer.syncSendEnabled();
      renderUI();
    },
    onOpenVoiceAssistant: () => openVoiceMode(),
    onModelChange: async (model) => {
      conversation = { ...(conversation || {}), model };

      if (!id) return;
      try {
        const updated = await api.updateConversation(auth.token, id, { model });
        conversation = updated || conversation;
      } catch (err) {
        toast(err.message || "Couldn't switch model", { tone: "error" });
      }
    },
    onToolsChange: ({ model }) => {
      if (id && conversation && model !== conversation.model) {
        api.updateConversation(auth.token, id, { model }).catch(() => {});
      }
    },
    getAuthToken: () => auth.token,
  });

  page.append(header, messageFeed.element, composer.element, ...composer.dropdownElements);
  host.append(page);
  messageFeed.mountScrollFollower(); // permanent pin/free-scroll + jump button

  // Focus the composer only while the user is not selecting text or using
  // another editable control. Startup retries and window focus obey this too.
  const attemptFocus = () => {
    if (unmounted || loading || messages.length > 0 || window.getSelection()?.isCollapsed === false) return;
    const active = document.activeElement;
    if (active === composer.textarea || active?.matches("input, textarea, select, [contenteditable='true']")) return;
    try {
      if (composer?.textarea) {
        composer.textarea.focus({ preventScroll: true });
        const len = composer.textarea.value.length;
        composer.textarea.setSelectionRange(len, len);
      }
    } catch {
      /* ignore if not attached yet */
    }
  };
  attemptFocus();
  requestAnimationFrame(attemptFocus);
  setTimeout(attemptFocus, 50);
  setTimeout(attemptFocus, 150);
  setTimeout(attemptFocus, 300);
  setTimeout(attemptFocus, 600);
  setTimeout(attemptFocus, 1000);

  // Mouse clicks on empty space keep the caret in the composer. Touch and pen
  // taps must not, because focusing a textarea raises the on-screen keyboard.
  let lastPointerType = "mouse";
  const handleUniversalFocus = (e) => {
    if (e.type === "pointerdown") {
      lastPointerType = e.pointerType || "mouse";
      return;
    }
    if (lastPointerType !== "mouse" || messageFeed.element.contains(e.target)) return;
    if (e.target?.closest?.("button, a, input, select, textarea, [role='menu'], [role='option'], .model-dropdown, .attachment-menu")) {
      return;
    }
    attemptFocus();
  };
  window.addEventListener("focus", attemptFocus);
  window.addEventListener("pageshow", attemptFocus);
  page.addEventListener("click", handleUniversalFocus);
  document.addEventListener("pointerdown", handleUniversalFocus, { passive: true });

  shell.setIncognitoActive?.(Boolean(incognito));

  function renderUI(opts = {}) {
    syncTopBarActions();
    const initial = Boolean(opts?.initial);

    if (loading) {
      messageFeed.stream.style.display = "none";
      composer.element.style.display = "none";
      header.style.display = "none";
      if (!page.querySelector(".blade-spinner")) {
        page.append(
          el("div", { class: "blade-spinner center" }, [
            el("div", { class: "spinner-blade" }),
            el("div", { class: "spinner-blade" }),
            el("div", { class: "spinner-blade" }),
            el("div", { class: "spinner-blade" }),
            el("div", { class: "spinner-blade" }),
            el("div", { class: "spinner-blade" }),
            el("div", { class: "spinner-blade" }),
            el("div", { class: "spinner-blade" }),
            el("div", { class: "spinner-blade" }),
            el("div", { class: "spinner-blade" }),
            el("div", { class: "spinner-blade" }),
            el("div", { class: "spinner-blade" }),
          ])
        );
      }
      return;
    }

    const isEmpty = messages.length === 0 && !composer.isGenerating && !searching && !imageGenerating && !streamHandler.isStreaming;
    page.classList.toggle("is-empty", isEmpty);
    composer.setConversationActive(!isEmpty);

    messageFeed.stream.style.display = "";
    composer.element.style.display = "";
    header.style.display = "";
    updateTopBarTitle();
    const spinner = page.querySelector(".blade-spinner");
    if (spinner) spinner.remove();

    if (isEmpty) {
      attemptFocus();
    }

    messageFeed.render({
      messages,
      user: getAuth().auth?.user || auth.user,
      generating: composer.isGenerating,
      searching,
      searchingLabel,
      searchVariant,
      searchCardData,
      searchPreamble,
      imageGenerating,
      streamingText: streamHandler.streamingText,
      streamingReasoning: streamHandler.streamingReasoning,
      statusPhrase: streamHandler.currentPhrase,
      enteringId,
      incognito,
      initial,
    });
    enteringId = null;
  }

  function syncCurrentConversationFromList(list) {
    if (!id || !Array.isArray(list) || !conversation) return;
    const found = list.find((c) => String(c.id) === String(id));
    if (found) {
      let changed = false;
      if (found.title && found.title !== conversation.title) {
        clearTitleRefreshes();
        conversation.title = found.title;
        changed = true;
      }
      if (found.pinned !== undefined && found.pinned !== conversation.pinned) {
        conversation.pinned = found.pinned;
        changed = true;
      }
      if (changed) {
        updateTopBarTitle();
      }
    }
  }

  function clearTitleRefreshes() {
    for (const timer of titleRefreshTimers) clearTimeout(timer);
    titleRefreshTimers.clear();
  }

  function refreshGeneratedTitle(conversationId) {
    clearTitleRefreshes();
    // The title request has its own eight-second budget. Cover it and a slow
    // database update; stop as soon as a changed title is observed.
    for (const delay of [1200, 2500, 4500, 8000, 12000, 20000]) {
      const timer = setTimeout(() => {
        titleRefreshTimers.delete(timer);
        if (!unmounted && id === conversationId) return loadConversations();
      }, delay);
      titleRefreshTimers.add(timer);
    }
  }

  async function loadConversations() {
    if (unmounted) return;
    const request = ++conversationListRequest;
    try {
      const list = await api.listConversations(auth.token);
      if (unmounted || request !== conversationListRequest) return;
      shell.setConversations(list);
      syncCurrentConversationFromList(list);
    } catch {
      /* non-blocking sidebar sync */
    }
  }

  const onConversationsUpdated = (e) => {
    syncCurrentConversationFromList(e.detail);
  };
  window.addEventListener("bmo:conversations-updated", onConversationsUpdated);

  async function loadModels() {
    try {
      const data = await api.listModels(auth.token);
      if (unmounted) return;
      if (Array.isArray(data?.models)) {
        availableModels = data.models.filter((m) => m.id !== "image");
        defaultModel = data.default || defaultModel;
        composer.availableModels = availableModels;
        composer.defaultModel = defaultModel;
        if (!conversation?.model) {
          composer.currentModel = defaultModel;
        }
      }
    } catch (err) {
      console.warn("Could not load model catalog", err);
    } finally {
      if (!unmounted) {
        composer.renderModelBadge(incognito);
        composer.renderModelDropdown();
      }
    }
  }

  async function loadMessages() {
    if (incognito || !id) {
      messages = [];
      return;
    }
    const conversationId = id;
    try {
      const data = await api.getMessages(auth.token, conversationId);
      if (unmounted || id !== conversationId) return;
      conversation = data?.conversation || null;
      if (conversation?.project_id) {
        activeProjectId = conversation.project_id;
      }
      messages = Array.isArray(data?.messages) ? data.messages : [];
      if (conversation?.model) {
        composer.currentModel = conversation.model;
      }
      updateTopBarTitle();
      if (lastMessageIsPendingImagePrompt()) {
        pollForImageResult();
      }
    } catch (err) {
      if (unmounted || id !== conversationId) return;
      if (err?.status === 404) {
        toast("Conversation not found", { tone: "error" });
        navigate("#/app/chat", { replace: true });
        return;
      }
      throw err;
    }
  }

  async function handleComposerSubmit(turn) {
    const revision = ++submitRevision;
    const ownsSubmit = () => !unmounted && revision === submitRevision;
    const { text, attachments, model, reasoningEffort, autoSearch = true, systemPrompt } = turn;
    const skills = turn.skills || composer.skillPicker.selected;
    composer.skillPicker.setSelected([]);

    if (model === "image") {
      await sendImageMessage(text, attachments);
      return;
    }

    // Detect export intent on completed turn
    const exportIntent = detectExportIntent(text);
    if (exportIntent.exportOnly && !attachments.length) {
      const latestAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.content?.trim());
      if (!latestAssistant) {
        toast("There is no completed response to export yet", { tone: "error" });
        return;
      }
      handleDirectDownload({
        title: conversation?.title,
        content: latestAssistant.content,
        format: exportIntent.formats[0] || "pdf",
      });
      return;
    }


    const isFirstTurn = !id || messages.filter((m) => m.role === "user").length <= 1;

    const optimisticUser = {
      id: uid(),
      role: "user",
      content: text,
      skills,
      attachments: attachments.length ? attachments : null,
      created_at: new Date().toISOString(),
      conversation_id: id || "pending",
    };
    const incognitoHistory = incognito
      ? messages.slice(-24).map(({ role, content, attachments }) => ({ role, content: content || "", attachments }))
      : undefined;
    while (incognitoHistory?.length && JSON.stringify(incognitoHistory).length > 200000) incognitoHistory.shift();
    messages.push(optimisticUser);
    enteringId = optimisticUser.id;
    searchPreamble = "";
    streamHandler.streamingText = "";
    streamHandler.streamingReasoning = "";
    streamHandler.currentPhrase = getRandomPhrase();

    composer.isGenerating = true;
    composer.syncSendEnabled();
    renderUI();
    messageFeed.follower.attach();
    messageFeed.scrollToBottom();

    const streamId = uid("stream");
    let llmMessage = text;

    const urls = model === "aeon" || !autoSearch ? [] : extractUrls(text);
    const fetchController = new AbortController();
    pageFetchController = fetchController;
    if (urls.length > 0) {
      searching = true;
      searchVariant = "reading";
      searchingLabel = urls.length === 1 ? "Reading webpage…" : "Reading links…";
      renderUI();
      messageFeed.follower.attach();
      messageFeed.scrollToBottom();
      try {
        const scrapePromises = urls.slice(0, 3).map(async (u) => {
          try {
            const res = await api.scrapeUrl(auth.token, u, fetchController.signal);
            if (res?.markdown) {
              return { url: u, title: res.title || u, description: res.description, markdown: res.markdown };
            }
          } catch (err) {
            if (err?.name !== "AbortError") console.warn(`Scrape failed for ${u}:`, err.message);
          }
          return null;
        });
        const scraped = (await Promise.allSettled(scrapePromises))
          .map((r) => (r.status === "fulfilled" ? r.value : null))
          .filter(Boolean);

        if (scraped.length > 0) {
          llmMessage = buildScrapeContext(scraped, text);
        }
        // Nothing scraped leaves llmMessage untouched, so the backend is free
        // to fall back to its own web search for this turn.
      } catch (err) {
        console.warn("web scraping failed:", err.message);
      } finally {
        if (ownsSubmit()) {
          searching = false;
          searchVariant = "search";
        }
      }
    }

    if (pageFetchController === fetchController) pageFetchController = null;
    if (!ownsSubmit()) return;
    if (fetchController.signal.aborted) {
      composer.isGenerating = false;
      composer.syncSendEnabled();
      if (!unmounted) renderUI();
      return;
    }
    renderUI();
    messageFeed.follower.attach();
    messageFeed.scrollToBottom();

    const activeModel = model || conversation?.model || defaultModel;
    try {
      await streamHandler.executeStream({
        payload: {
          message: text,
          augmented_message: llmMessage !== text ? llmMessage : undefined,
          conversation_id: (!incognito && id) ? id : undefined,
          project_id: (!incognito && activeProjectId) ? activeProjectId : undefined,
          attachments,
          history: incognitoHistory,
          skill_ids: skills.map(skill => skill.id),
          model: activeModel,
          system_prompt: [conversation?.system_prompt, systemPrompt].filter(Boolean).join("\n\n") || undefined,
          reasoning_effort: reasoningEffort || composer.getReasoningEffort(activeModel),
          auto_search: autoSearch,
          incognito,
        },
        streamId,
        onVoiceStyle: data => activeVoiceOnStyle?.(data?.tone),
      });
    } catch (err) {
      if (!ownsSubmit()) return;
      if (err?.name !== "AbortError" && !messages.at(-1)?.unsaved) {
        messages = messages.filter((x) => x.id !== optimisticUser.id);
      }
    } finally {
      if (!ownsSubmit()) return;
      // The preamble belongs to the live turn only. The card has normally been
      // handed to the assistant message by now; this clears it after a turn
      // that ended without one (error or abort).
      searchPreamble = "";
      searchCardData = null;
      composer.isGenerating = false;
      composer.syncSendEnabled();
      renderUI();
      loadConversations();
      if (isFirstTurn && !incognito && id && !unmounted) refreshGeneratedTitle(id);
    }
  }

  async function sendImageMessage(text, attachments = []) {
    const optimisticUser = {
      id: uid(),
      role: "user",
      content: text,
      attachments: attachments.length ? attachments : null,
      created_at: new Date().toISOString(),
      conversation_id: id || "pending",
    };
    messages.push(optimisticUser);
    imageGenerating = true;
    composer.isImageGenerating = true;
    composer.syncSendEnabled();
    renderUI();
    messageFeed.follower.attach();
    messageFeed.scrollToBottom();

    const controller = new AbortController();
    imageRequest?.abort();
    imageRequest = controller;
    const conversationId = id;
    const ownsImage = () => !unmounted && imageRequest === controller && id === conversationId;
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const res = await api.generateImage(auth.token, {
        prompt: text,
        conversation_id: id || undefined,
        project_id: (!incognito && activeProjectId) ? activeProjectId : undefined,
        attachments,
      }, controller.signal);

      if (!ownsImage()) return;
      if (res?.conversation) {
        conversation = res.conversation;
        if (!id) {
          id = conversation.id;
          history.replaceState(null, "", `#/app/chat/${id}`);
          shell.setActiveConversation(id);
        }
        composer.renderModelBadge(incognito);
      }
      messages = messages.filter((x) => x.id !== optimisticUser.id);
      messages.push(res?.user_message || optimisticUser);
      if (res?.assistant_message) {
        messages.push(res.assistant_message);
        enteringId = res.assistant_message.id;
      }
    } catch (err) {
      if (!ownsImage()) return;
      messages = messages.filter((x) => x.id !== optimisticUser.id);
      toast(err.message || "Couldn't create image.", { tone: "error" });
    } finally {
      clearTimeout(timeoutId);
      if (unmounted || imageRequest !== controller) return;
      imageRequest = null;
      imageGenerating = false;
      composer.isImageGenerating = false;
      composer.syncSendEnabled();
      renderUI();
      loadConversations();
    }
  }

  function lastMessageIsPendingImagePrompt() {
    if (composer.currentModel !== "image" || !messages.length) return false;
    const last = messages[messages.length - 1];
    if (last.role !== "user") return false;
    const age = Date.now() - new Date(last.created_at).getTime();
    return age >= 0 && age < 3 * 60 * 1000;
  }

  function pollForImageResult() {
    if (!id || imagePoll || unmounted) return;
    const poll = { conversationId: id, controller: new AbortController(), deadline: null };
    imagePoll = poll;
    const ownsPoll = () => !unmounted && imagePoll === poll && id === poll.conversationId;
    imageGenerating = true;
    composer.isImageGenerating = true;
    composer.syncSendEnabled();
    renderUI();
    const finish = () => {
      if (!ownsPoll()) return;
      clearTimeout(poll.deadline);
      clearTimeout(imagePollTimer);
      poll.controller.abort();
      imagePoll = null;
      imagePollTimer = null;
      imageGenerating = false;
      composer.isImageGenerating = false;
      composer.syncSendEnabled();
      renderUI();
    };
    const tick = async () => {
      if (!ownsPoll()) return;
      try {
        const data = await api.getMessages(auth.token, poll.conversationId, poll.controller.signal);
        if (!ownsPoll()) return;
        const msgs = Array.isArray(data?.messages) ? data.messages : [];
        const last = msgs[msgs.length - 1];
        if (last?.role === "assistant") {
          conversation = data.conversation || conversation;
          messages = msgs;
          enteringId = last.id;
          composer.renderModelBadge(incognito);
          finish();
          loadConversations();
          return;
        }
      } catch {}
      if (ownsPoll()) imagePollTimer = setTimeout(tick, 3000);
    };
    poll.deadline = setTimeout(finish, 120000);
    imagePollTimer = setTimeout(tick, 3000);
  }

  async function branchBeforeMessage(message) {
    if (incognito || !id) return true;
    branching = true;
    composer.isGenerating = true;
    composer.syncSendEnabled();
    try {
      const branch = await api.branchConversation(auth.token, id, message.id);
      conversation = branch.conversation;
      id = conversation.id;
      messages = branch.messages;
      history.replaceState(null, "", `#/app/chat/${id}`);
      shell.setActiveConversation(id);
      loadConversations();
      return true;
    } catch (err) {
      toast(err.message || "Couldn't branch this conversation", { tone: "error" });
      return false;
    } finally {
      branching = false;
      composer.isGenerating = false;
      composer.syncSendEnabled();
    }
  }

  async function editMessage(message) {
    if (streamHandler.isStreaming || imageGenerating || branching) return;
    const idx = messages.findIndex((x) => x.id === message.id);
    if (idx === -1) return;
    if (!await branchBeforeMessage(message)) return;
    messages = messages.slice(0, idx);
    composer.pendingAttachments = [...(message.attachments || [])];
    composer.skillPicker.setSelected((message.skills || []).map(skill => skill.id));
    composer.renderAttachmentsBar();
    composer.setText(message.content);
    renderUI();
    composer.focus();
  }

  async function retryMessage(message) {
    if (streamHandler.isStreaming || imageGenerating || branching) return;
    const idx = messages.findIndex((x) => x.id === message.id);
    if (idx === -1) return;
    if (!await branchBeforeMessage(message)) return;
    messages = messages.slice(0, idx);
    renderUI();
    composer.skillPicker.setSelected((message.skills || []).map(skill => skill.id));
    if (composer.isImageMode()) {
      sendImageMessage(message.content, message.attachments || []);
    } else {
      handleComposerSubmit({
        text: message.content,
        attachments: message.attachments || [],
        model: composer.currentModel,
        reasoningEffort: composer.getReasoningEffort(),
        autoSearch: composer.autoSearch,
      });
    }
  }

  async function retryAssistantMessage(assistantMsg) {
    if (streamHandler.isStreaming || imageGenerating || branching) return;
    const idx = messages.findIndex((x) => x.id === assistantMsg.id);
    if (idx === -1) return;
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "user") { userIdx = i; break; }
    }
    if (userIdx === -1) return;
    const userMsg = messages[userIdx];
    if (!await branchBeforeMessage(userMsg)) return;
    messages = messages.slice(0, userIdx);
    renderUI();
    composer.skillPicker.setSelected((userMsg.skills || []).map(skill => skill.id));
    if (composer.isImageMode()) {
      sendImageMessage(userMsg.content, userMsg.attachments || []);
    } else {
      handleComposerSubmit({
        text: userMsg.content,
        attachments: userMsg.attachments || [],
        model: composer.currentModel,
        reasoningEffort: composer.getReasoningEffort(),
        autoSearch: composer.autoSearch,
      });
    }
  }

  function findSavedReply(message, stored) {
    const index = messages.findIndex(m => m.id === message.id);
    if (index < 0) return null;
    const question = messages.slice(0, index).findLast(m => m.role === "user");
    const questionIndex = stored.findIndex(m => m.id === question?.id);
    const reply = questionIndex >= 0 ? stored[questionIndex + 1] : null;
    return reply?.id && reply.role === "assistant" && reply.content?.trim() === message.content?.trim() ? reply : null;
  }

  async function reconcileUnsavedReplies() {
    const pending = messages.filter(m => m.unsaved);
    if (reconciling || unmounted || incognito || !id || !pending.length) return;
    const conversationId = id;
    reconciling = true;
    try {
      const data = await api.getMessages(auth.token, conversationId);
      if (unmounted || id !== conversationId || getAuth().auth?.user?.id !== auth.user?.id) return;
      const stored = Array.isArray(data?.messages) ? data.messages : [];
      let changed = false;
      for (const message of pending) {
        const index = messages.indexOf(message);
        if (index < 0) continue;
        const reply = findSavedReply(message, stored);
        if (!reply) continue;
        if (messages.some(m => m.id === reply.id)) messages.splice(index, 1);
        else messages[index] = { ...message, ...reply, unsaved: false };
        changed = true;
      }
      if (changed) renderUI();
    } catch (err) {
      console.warn("Could not confirm saved replies:", err.message);
    } finally {
      reconciling = false;
    }
  }

  async function handleMessageFeedback(message, sentiment) {
    try {
      if (message.unsaved) {
        const conversationId = id;
        const index = messages.findIndex(m => m.id === message.id);
        const question = messages.slice(0, index).findLast(m => m.role === "user");
        const data = conversationId && question ? await api.getMessages(auth.token, conversationId) : null;
        if (unmounted || id !== conversationId || messages[index]?.id !== message.id) return;
        const stored = Array.isArray(data?.messages) ? data.messages : [];
        const reply = findSavedReply(message, stored);
        if (!reply) {
          toast("This reply is still saving. Please try again in a moment.");
          return;
        }
        message = { ...message, ...reply, unsaved: false };
        messages[index] = message;
        renderUI();
      }
      const payload = sentiment === "up"
        ? { message_id: message.id, rating: 5, correctness: "correct", length: "ideal" }
        : { message_id: message.id, rating: 1, correctness: "incorrect", length: "ideal" };
      const feedback = await api.submitFeedback(auth.token, payload);
      const idx = messages.findIndex((m) => m.id === message.id);
      if (idx !== -1) {
        messages[idx] = { ...messages[idx], feedback: feedback || payload };
        renderUI();
      }
    } catch (err) {
      toast(err.message || "Couldn't send feedback", { tone: "error" });
    }
  }

  function resetToNewConversation() {
    imageRequest?.abort();
    imageRequest = null;
    clearTimeout(imagePoll?.deadline);
    imagePoll?.controller.abort();
    imagePoll = null;
    clearTimeout(imagePollTimer);
    imagePollTimer = null;
    imageGenerating = false;
    composer.isImageGenerating = false;
    composer.syncSendEnabled();
    clearTitleRefreshes();
    id = null;
    conversation = null;
    composer.skillPicker.setSelected([]);
    messages = [];
    history.replaceState(null, "", "#/app/chat");
    shell.setActiveConversation(null);
    composer.renderModelBadge(incognito);
    renderUI({ initial: true });
    composer.focus();
  }



  function openVoiceMode() {
    if (voiceHandle || streamHandler.isStreaming) return;
    resetToNewConversation();
    voiceHandle = openVoiceOverlay({
      token: auth.token,
      onInterrupt: () => { if (streamHandler.isStreaming) streamHandler.cancel(); },
      sendTurn: async (text, opts) => {
        const previousAssistantId = messages.findLast(message => message.role === "assistant")?.id;
        activeVoiceOnDelta = opts?.onDelta || null;
        activeVoiceOnSearch = opts?.onSearching || null;
        activeVoiceOnStyle = opts?.onVoiceStyle || null;
        const languageName = opts?.languageName;
        const delivery = ["gentle", "lively"].includes(opts?.delivery) ? opts.delivery : "neutral";
        const langInstruction = [
          languageName ? `Current conversation language: ${languageName}. Respond fluently and naturally in ${languageName}.` : "",
          `Microphone delivery cue: ${delivery}. Adapt your spoken pace and register subtly, with the conversation's meaning taking priority. This is a weak pace/volume cue, not an emotion classification.`,
        ].filter(Boolean).join("\n");
        try {
          await handleComposerSubmit({
            text,
            attachments: [],
            model: "aeon",
            reasoningEffort: "low",
            autoSearch: true,
            systemPrompt: langInstruction,
          });
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "assistant") return messages[i].id === previousAssistantId ? "" : messages[i].content || "";
          }
          return "";
        } finally {
          if (activeVoiceOnDelta === opts?.onDelta) activeVoiceOnDelta = null;
          if (activeVoiceOnSearch === opts?.onSearching) activeVoiceOnSearch = null;
          if (activeVoiceOnStyle === opts?.onVoiceStyle) activeVoiceOnStyle = null;
        }
      },
      onClose: () => {
        activeVoiceOnDelta = null;
        activeVoiceOnSearch = null;
        activeVoiceOnStyle = null;
        voiceHandle = null;
        loadConversations();
      },
    });
  }

  const onVisibilityChange = async () => {
    if (document.hidden) return;
    loadSkills();
    if (streamHandler.isStreaming && streamHandler.hiddenBuffer.length) {
      streamHandler.hiddenBuffer = [];
      messageFeed.updateStreamingBubble(streamHandler.streamingText, streamHandler.streamingReasoning);
    }
    await reconcileUnsavedReplies();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("online", reconcileUnsavedReplies);

  // The deploy guard asks the mounted page before discarding local work.
  const beforeReload = event => {
    if (voiceHandle || branching || imageGenerating || streamHandler.isStreaming ||
        composer.isGenerating || composer.isImageGenerating || composer.dictation || composer.isRecording ||
        composer.textarea.value.trim() || composer.pendingAttachments.length || composer.uploadingFiles.length ||
        messages.some(message => message.unsaved)) event.preventDefault();
  };
  window.addEventListener("bmo:before-reload", beforeReload);

  // Initial load
  async function loadSkills() {
    const request = ++skillCatalogRequest;
    try {
      const skills = await api.listSkills(auth.token);
      if (unmounted || request !== skillCatalogRequest || getAuth().auth?.user?.id !== auth.user?.id) return;
      composer.skillPicker.setCatalog(skills);
      if (requestedSkillIds.length) {
        composer.skillPicker.setSelected(requestedSkillIds);
        requestedSkillIds = [];
      }
    } catch (error) {
      if (!unmounted && request === skillCatalogRequest) {
        composer.skillPicker.setLoadError();
        console.warn("Could not load skills", error);
      }
    }
  }
  window.addEventListener("focus", loadSkills);
  loadSkills();
  loading = Boolean(id);
  renderUI({ initial: true });

  loadModels();
  loadMessages().then(() => {
    if (unmounted) return;
    loading = false;
    renderUI({ initial: true });
  }).catch((err) => {
    if (unmounted) return;
    loading = false;
    renderUI();
    toast(err.message || "Failed to load chat", { tone: "error" });
  });

  whenMarkdownReady(() => { if (!unmounted) renderUI(); });

  return () => {
    unmounted = true;
    window.removeEventListener("bmo:before-reload", beforeReload);
    clearTitleRefreshes();
    ++submitRevision;
    imageRequest?.abort();
    imageRequest = null;
    clearTimeout(imagePoll?.deadline);
    imagePoll?.controller.abort();
    imagePoll = null;
    if (imagePollTimer) { clearTimeout(imagePollTimer); imagePollTimer = null; }
    messageFeed.unmountScrollFollower();
    pageFetchController?.abort();
    streamHandler.cancel();
    composer.destroy();
    if (voiceHandle) { try { voiceHandle.close(); } catch {} voiceHandle = null; }
    window.removeEventListener("focus", attemptFocus);
    window.removeEventListener("focus", loadSkills);
    window.removeEventListener("pageshow", attemptFocus);
    document.removeEventListener("click", onDocClickConvoMenu);
    document.removeEventListener("pointerdown", handleUniversalFocus);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("online", reconcileUnsavedReplies);
    window.removeEventListener("bmo:conversations-updated", onConversationsUpdated);
  };
}
