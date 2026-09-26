/**
 * Chat page controller for BMO.
 * Coordinates the message feed, composer, stream handler, voice assistant, and image generation.
 */

import { el, clear, formatTitle } from "../utils.js?v=30";
import { icon } from "../icons.js?v=71";
import { getAuth } from "../auth.js?v=31";
import { navigate } from "../router.js?v=31";
import { mountAppShell } from "../app-shell.js?v=73";
import { toast } from "../components/toast.js?v=58";
import { openConfirmModal, openPromptModal } from "../components/confirm-modal.js?v=58";
import { openShareModal } from "../components/share-modal.js?v=2";
import { whenMarkdownReady } from "../components/markdown.js?v=33";
import { openVoiceOverlay } from "../components/voice-overlay.js?v=54";
import * as api from "../api.js?v=61";

import { Composer, DEFAULT_AVAILABLE_MODELS, extractUrls } from "../chat/composer.js?v=25";
import { MessageFeed } from "../chat/message-feed.js?v=36";
import { StreamHandler, getRandomPhrase } from "../chat/stream-handler.js?v=8";
import { STUDY_SYSTEM_PROMPT } from "../chat/study-mode.js?v=2";
import {
  detectExportIntent,
  buildCanonicalMarkdown,
  formatExportFilename,
  downloadBlob,
  buildClientDocxBlob,
  printDocumentToPdf,
} from "../export.js?v=4";



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

export async function renderChat({ id, incognito }) {
  const { auth } = getAuth();
  if (!auth) {
    navigate("#/", { replace: true });
    return;
  }
  const shell = await mountAppShell();
  shell.setActiveConversation(id || null);

  const host = shell.content;
  clear(host);

  // State
  let conversation = null;
  let messages = [];
  let loading = false;
  let availableModels = DEFAULT_AVAILABLE_MODELS;
  let defaultModel = "thinking";
  let searchingLabel = "Reading webpage…";
  let searchVariant = "search"; // "search" (web search) | "reading" (pasted link)

  let enteringId = null;
  let searching = false;
  let searchPreamble = "";
  // The live turn's search card: null, then in-flight, then filled with
  // results. Handed to the assistant message once the answer lands.
  let searchCardData = null;
  let imageGenerating = false;
  let imagePollTimer = null;
  let voiceHandle = null;
  let activeVoiceOnDelta = null;
  let unmounted = false;
  let reconciling = false;

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
    html: icon(incognito ? "x" : "incognito", { width: 26, height: 24 }),
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
        toast(nextPinned ? "Pinned" : "Unpinned", { tone: "success" });
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
          toast("Chat deleted", { tone: "warning" });
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

  const convoMenu = el("div", { class: "chat-topbar-menu", role: "menu" }, [
    shareItem,
    pinItem,
    renameItem,
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

  const titleWrap = el("div", { class: "chat-topbar-title-wrap", style: "display: none;" }, [
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

  function updateTopBarTitle() {
    syncTopBarActions();
    if (incognito) {
      convoTitleText.textContent = "Incognito chat";
      menuAnchor.style.display = "none";
      titleWrap.style.display = "inline-flex";
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
      titleWrap,
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
      toast("Your document is ready", { tone: "success" });
      return;
    }

    try {
      const blob = await api.exportDocument(auth.token, {
        title: docTitle,
        markdown: content,
        format,
      });
      downloadBlob(blob, filename);
      toast("Your document is ready", { tone: "success" });
    } catch (err) {
      console.warn("Backend export failed, using instant client export:", err);
      if (format === "docx") {
        const htmlContent = renderMarkdown(content);
        const docxBlob = buildClientDocxBlob({ title: docTitle, htmlContent });
        downloadBlob(docxBlob, filename);
        toast("Your document is ready", { tone: "success" });
      } else if (format === "pdf") {
        const htmlContent = renderMarkdown(content);
        printDocumentToPdf({ title: docTitle, htmlContent });
        toast("Your document is ready", { tone: "success" });
      } else {
        toast(err.message || `Failed to download ${format.toUpperCase()}`, { tone: "error" });
      }
    }
  }




  // Message Feed
  const messageFeed = new MessageFeed({
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
      messages.push(m);
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
      searching = true;
      searchPreamble = preamble || "";
      searchVariant = "search";
      searchCardData = { query: query || "", results: [], elapsedMs: null, searching: true };
      renderUI();
      messageFeed.follower.attach();
      messageFeed.scrollToBottom();
    },
    onSearchComplete: ({ results, elapsedMs }) => {
      searching = false;
      searchCardData = {
        query: searchCardData?.query || "",
        results: Array.isArray(results) ? results : [],
        elapsedMs: elapsedMs ?? null,
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
      enteringId = m.id;
      composer.isGenerating = false;
      composer.syncSendEnabled();
      renderUI();
      loadConversations();
    },
    onError: (err) => {
      toast(err.message || "Couldn't connect", { tone: "error" });
      composer.isGenerating = false;
      composer.syncSendEnabled();
      renderUI();
    },
  });


  // Composer
  const composer = new Composer({
    onSubmit: (turn) => handleComposerSubmit(turn),
    onStop: () => streamHandler.cancel(),
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
    onToolsChange: ({ autoSearch, studyMode, model }) => {
      if (id && conversation && model !== conversation.model) {
        api.updateConversation(auth.token, id, { model }).catch(() => {});
      }
    },
    getAuthToken: () => auth.token,
  });

  page.append(header, messageFeed.element, composer.element, ...composer.dropdownElements);
  host.append(page);
  messageFeed.mountScrollFollower(); // permanent pin/free-scroll + jump button

  // Auto-focus composer textarea so it is always active and hungry for input
  const attemptFocus = () => {
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

  // On touch/mobile devices, tapping anywhere outside interactive controls immediately focuses composer & raises keyboard
  const handleUniversalFocus = (e) => {
    if (e.target?.closest?.("button, a, input, select, textarea, [role='menu'], [role='option'], .model-dropdown, .tools-menu, .attachment-menu")) {
      return;
    }
    attemptFocus();
  };
  window.addEventListener("focus", attemptFocus);
  window.addEventListener("pageshow", attemptFocus);
  page.addEventListener("click", handleUniversalFocus);
  document.addEventListener("touchstart", handleUniversalFocus, { passive: true });
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

    messageFeed.stream.style.display = "";
    composer.element.style.display = "";
    header.style.display = "";
    updateTopBarTitle();
    const spinner = page.querySelector(".blade-spinner");
    if (spinner) spinner.remove();
    const isEmpty = messages.length === 0 && !composer.isGenerating && !searching && !imageGenerating && !streamHandler.isStreaming;
    page.classList.toggle("is-empty", isEmpty);

    if (isEmpty || initial) {
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

  async function loadConversations() {
    try {
      const list = await api.listConversations(auth.token);
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
      composer.renderModelBadge(incognito);
      composer.renderModelDropdown();
    }
  }

  async function loadMessages() {
    if (incognito || !id) {
      messages = [];
      return;
    }
    try {
      const data = await api.getMessages(auth.token, id);
      conversation = data?.conversation || null;
      messages = Array.isArray(data?.messages) ? data.messages : [];
      if (conversation?.model) {
        composer.currentModel = conversation.model;
      }
      updateTopBarTitle();
      if (lastMessageIsPendingImagePrompt()) {
        pollForImageResult();
      }
    } catch (err) {
      if (err?.status === 404) {
        toast("Conversation not found", { tone: "error" });
        navigate("#/app/chat", { replace: true });
        return;
      }
      throw err;
    }
  }

  async function handleComposerSubmit(turn) {
    const { text, attachments, model, reasoningEffort, studyMode, autoSearch = true, systemPrompt } = turn;

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
      attachments: attachments.length ? attachments : null,
      created_at: new Date().toISOString(),
      conversation_id: id || "pending",
    };
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

    const urls = extractUrls(text);
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
            const res = await api.scrapeUrl(auth.token, u);
            if (res?.markdown) {
              return { url: u, title: res.title || u, description: res.description, markdown: res.markdown };
            }
          } catch (err) {
            console.warn(`Scrape failed for ${u}:`, err.message);
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
        searching = false;
        searchVariant = "search";
      }
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
          attachments,
          model: activeModel,
          system_prompt: studyMode ? STUDY_SYSTEM_PROMPT : (conversation?.system_prompt || undefined),
          reasoning_effort: reasoningEffort || composer.getReasoningEffort(activeModel),
          auto_search: autoSearch && !studyMode,
          incognito,
        },
        streamId,
      });
    } catch (err) {
      if (err?.name !== "AbortError") {
        messages = messages.filter((x) => x.id !== optimisticUser.id);
      }
    } finally {
      // The preamble belongs to the live turn only. The card has normally been
      // handed to the assistant message by now; this clears it after a turn
      // that ended without one (error or abort).
      searchPreamble = "";
      searchCardData = null;
      composer.isGenerating = false;
      composer.syncSendEnabled();
      renderUI();
      loadConversations();
      if (isFirstTurn) {
        setTimeout(loadConversations, 1200);
        setTimeout(loadConversations, 2500);
        setTimeout(loadConversations, 4500);
      }
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
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const res = await api.generateImage(auth.token, {
        prompt: text,
        conversation_id: id || undefined,
        attachments,
      }, controller.signal);

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
      if (res?.assistant_message) messages.push(res.assistant_message);
    } catch (err) {
      messages = messages.filter((x) => x.id !== optimisticUser.id);
      toast(err.message || "Couldn't create image.", { tone: "error" });
    } finally {
      clearTimeout(timeoutId);
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
    if (!id || imagePollTimer || unmounted) return;
    imageGenerating = true;
    composer.isImageGenerating = true;
    composer.syncSendEnabled();
    renderUI();

    const started = Date.now();
    imagePollTimer = setInterval(async () => {
      if (Date.now() - started > 120000) {
        clearInterval(imagePollTimer);
        imagePollTimer = null;
        imageGenerating = false;
        composer.isImageGenerating = false;
        composer.syncSendEnabled();
        renderUI();
        return;
      }
      try {
        const data = await api.getMessages(auth.token, id);
        const msgs = Array.isArray(data?.messages) ? data.messages : [];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant") {
          clearInterval(imagePollTimer);
          imagePollTimer = null;
          conversation = data.conversation || conversation;
          messages = msgs;
          imageGenerating = false;
          composer.isImageGenerating = false;
          composer.renderModelBadge(incognito);
          composer.syncSendEnabled();
          renderUI();
          loadConversations();
        }
      } catch {}
    }, 3000);
  }

  function editMessage(message) {
    if (streamHandler.isStreaming || imageGenerating) return;
    const idx = messages.findIndex((x) => x.id === message.id);
    if (idx === -1) return;
    messages = messages.slice(0, idx);
    composer.setText(message.content);
    renderUI();
    composer.focus();
  }

  function retryMessage(message) {
    if (streamHandler.isStreaming || imageGenerating) return;
    const idx = messages.findIndex((x) => x.id === message.id);
    if (idx === -1) return;
    messages = messages.slice(0, idx);
    renderUI();
    if (composer.isImageMode()) {
      sendImageMessage(message.content);
    } else {
      handleComposerSubmit({
        text: message.content,
        attachments: [],
        model: composer.currentModel,
        reasoningEffort: composer.getReasoningEffort(),
        autoSearch: composer.autoSearch,
        studyMode: composer.studyMode,
      });
    }
  }

  function retryAssistantMessage(assistantMsg) {
    if (streamHandler.isStreaming || imageGenerating) return;
    const idx = messages.findIndex((x) => x.id === assistantMsg.id);
    if (idx === -1) return;
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "user") { userIdx = i; break; }
    }
    if (userIdx === -1) return;
    const userMsg = messages[userIdx];
    messages = messages.slice(0, userIdx);
    renderUI();
    if (composer.isImageMode()) {
      sendImageMessage(userMsg.content, userMsg.attachments || []);
    } else {
      handleComposerSubmit({
        text: userMsg.content,
        attachments: userMsg.attachments || [],
        model: composer.currentModel,
        reasoningEffort: composer.getReasoningEffort(),
        autoSearch: composer.autoSearch,
        studyMode: composer.studyMode,
      });
    }
  }

  async function handleMessageFeedback(message, sentiment) {
    const payload = sentiment === "up"
      ? { message_id: message.id, rating: 5, correctness: "correct", length: "ideal" }
      : { message_id: message.id, rating: 1, correctness: "incorrect", length: "ideal" };
    try {
      const feedback = await api.submitFeedback(auth.token, payload);
      const idx = messages.findIndex((m) => m.id === message.id);
      if (idx !== -1) {
        messages[idx] = { ...messages[idx], feedback: feedback || payload };
        renderUI();
      }
      toast("Thanks!", { tone: "success" });
    } catch (err) {
      toast(err.message || "Couldn't send feedback", { tone: "error" });
    }
  }

  function resetToNewConversation() {
    id = null;
    conversation = null;
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
      sendTurn: async (text, opts) => {
        activeVoiceOnDelta = opts?.onDelta || null;
        const langInstruction = opts?.language && opts.language !== "en"
          ? `Selected conversation language: ${opts.languageName}. Respond fluently and naturally in ${opts.languageName}.`
          : undefined;
        try {
          await handleComposerSubmit({
            text,
            attachments: [],
            model: "aeon",
            reasoningEffort: "low",
            autoSearch: false,
            studyMode: false,
            systemPrompt: langInstruction,
          });
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "assistant") return messages[i].content || "";
          }
          return "";
        } finally {
          activeVoiceOnDelta = null;
        }
      },
      onClose: () => {
        activeVoiceOnDelta = null;
        voiceHandle = null;
        loadConversations();
      },
    });
  }

  const onVisibilityChange = async () => {
    if (document.hidden) return;
    if (streamHandler.isStreaming && streamHandler.hiddenBuffer.length) {
      streamHandler.hiddenBuffer = [];
      messageFeed.updateStreamingBubble(streamHandler.streamingText, streamHandler.streamingReasoning);
    }
    if (streamHandler.isStreaming && id && streamHandler.controller?.signal.aborted) {
      if (reconciling || !id) return;
      reconciling = true;
      try {
        const data = await api.getMessages(auth.token, id);
        const serverMsgs = Array.isArray(data?.messages) ? data.messages : null;
        if (serverMsgs && serverMsgs.length) {
          const lastServer = serverMsgs[serverMsgs.length - 1];
          if (lastServer.role === "assistant") {
            conversation = data.conversation || conversation;
            messages = serverMsgs;
            streamHandler.cleanup();
            composer.isGenerating = false;
            composer.syncSendEnabled();
            renderUI();
          }
        }
      } finally {
        reconciling = false;
      }
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Initial load
  loading = Boolean(id);
  renderUI({ initial: true });

  Promise.all([loadModels(), loadMessages()]).then(() => {
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
    if (imagePollTimer) { clearInterval(imagePollTimer); imagePollTimer = null; }
    messageFeed.unmountScrollFollower();
    streamHandler.cancel();
    composer.destroy();
    if (voiceHandle) { try { voiceHandle.close(); } catch {} voiceHandle = null; }
    window.removeEventListener("focus", attemptFocus);
    window.removeEventListener("pageshow", attemptFocus);
    document.removeEventListener("click", onDocClickConvoMenu);
    document.removeEventListener("touchstart", handleUniversalFocus);
    document.removeEventListener("pointerdown", handleUniversalFocus);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("bmo:conversations-updated", onConversationsUpdated);
  };
}
