/**
 * Composer component for Bmo chat.
 * Controls prompt textarea, file attachments, model/tools dropdowns,
 * voice recording bar, and submit/stop state.
 */

import { el, clear } from "../utils.js?v=20";
import { icon } from "../icons.js?v=73";
import { FileIcon } from "../components/file-icon.js?v=6";
import { toast } from "../components/toast.js?v=58";
import { openImageModal } from "../components/image-modal.js?v=18";
import { blobToWav16kMono } from "../audio-wav.js?v=30";
import { getAuth } from "../auth.js";
import * as api from "../api.js?v=66";
import { SkillPicker } from "./skill-picker.js?v=6";

const MAX_IMAGES_PER_MESSAGE = 6;
const MAX_CONCURRENT_ATTACHMENT_UPLOADS = 2;

function isImageAttachment(name, mime) {
  return mime?.toLowerCase().startsWith("image/") ||
    ((!mime || mime === "application/octet-stream") && /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(name || ""));
}

export const URL_REGEX = /(?:https?:\/\/|www\.)[^\s()<>]+(?:\([\w\d]+\)|(?:[^\s`!()\[\]{};:\x27".,<>?«»“”‘’]))|\b[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}(?::\d+)?(?:[\/?#][^\s()<>]+(?:\([\w\d]+\)|(?:[^\s`!()\[\]{};:\x27".,<>?«»“”‘’])))?/gi;

export function extractUrls(text) {
  if (!text) return [];
  const regex = new RegExp(URL_REGEX.source, "gi");
  const matches = text.match(regex) || [];
  return [...new Set(matches.map((u) => u.trim()))];
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlightUrlsInText(text) {
  if (!text) return "";
  const regex = new RegExp(URL_REGEX.source, "gi");
  let result = "";
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const start = match.index;
    const url = match[0];
    if (start > lastIndex) {
      result += escapeHtml(text.slice(lastIndex, start));
    }
    result += `<span class="composer-url-highlight">${escapeHtml(url)}</span>`;
    lastIndex = start + url.length;
  }
  if (lastIndex < text.length) {
    result += escapeHtml(text.slice(lastIndex));
  }
  if (text.endsWith("\n")) {
    result += "<br>";
  }
  return result;
}

export const DEFAULT_AVAILABLE_MODELS = [
  { id: "thinking", label: "Stanza 2.5", description: "All-round help" },
  { id: "deep", label: "Nexos 3.0", description: "Deep reasoning", note: "This may take longer than usual." },
];

let _pageGreetingPlaceholder = null;
export function greetingPlaceholder() {
  if (_pageGreetingPlaceholder) return _pageGreetingPlaceholder;
  const h = new Date().getHours();
  // Short, human, Claude-ish greetings — picked at random per time bucket.
  // No dashes anywhere: they read as clutter in a placeholder.
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  if (h >= 5 && h < 12) {
    _pageGreetingPlaceholder = pick([
      "Coffee's on. What are we building?",
      "Morning! What's on your mind?",
      "Fresh day. What do you need?",
    ]);
  } else if (h >= 12 && h < 17) {
    _pageGreetingPlaceholder = pick([
      "Afternoon! What are we working on?",
      "Good afternoon. What do you need?",
      "Middle of the day, ask away.",
    ]);
  } else if (h >= 17 && h < 22) {
    _pageGreetingPlaceholder = pick([
      "Evening! What's on deck?",
      "Good evening. What shall we dig into?",
      "Winding down or digging in?",
    ]);
  } else {
    _pageGreetingPlaceholder = pick([
      "Hey night owl. What keeps you up?",
      "Late shift? I'm up too.",
      "Quiet hours. Perfect for solving something.",
    ]);
  }
  return _pageGreetingPlaceholder;
}

export class Composer {
  constructor({
    onSubmit,
    onStop,
    onOpenVoiceAssistant,
    onModelChange,
    onToolsChange,
    getAuthToken,
  }) {
    this.onSubmit = onSubmit;
    this.onStop = onStop;
    this.onOpenVoiceAssistant = onOpenVoiceAssistant;
    this.onModelChange = onModelChange;
    this.onToolsChange = onToolsChange;
    this.getAuthToken = getAuthToken;

    this.pendingAttachments = [];
    this.uploadingFiles = [];
    this.activeAttachmentUploads = 0;
    this.attachmentUploadQueue = [];
    this.attachmentOrder = new WeakMap();
    this.nextAttachmentOrder = 0;
    this.availableModels = DEFAULT_AVAILABLE_MODELS;
    this.currentModel = "thinking";
    this.defaultModel = "thinking";
    // Web search is on by default and autonomous: Bmo decides per turn
    // whether a question actually needs live results. Switching it off opts
    // the conversation out of searching entirely.
    this.autoSearch = true;
    this.isGenerating = false;
    this.isImageGenerating = false;
    this.isRecording = false;
    this.hasMessages = false;
    this._heightTimer = null;
    this._heightTransitionToken = 0;


    // Menus open state
    this.modelDropdownOpen = false;

    // Voice recording state
    this.dictation = null;
    this.recordTimerId = null;
    this.recordStartedAt = 0;
    this.waveAudioCtx = null;
    this.waveAnalyser = null;
    this.waveRafId = null;

    this._buildDOM();
    this._attachGlobalListeners();
  }

  _buildDOM() {
    // Model badge & dropdown
    this.modelBadgeLabel = el("span", { class: "model-label", text: "Stanza 2.5" });
    this.modelDropdown = el("div", { class: "model-dropdown", role: "listbox", "aria-label": "Select model" });
    this.modelBadge = el("button", {
      type: "button",
      class: "model-badge model-badge-button",
      title: "Choose mode",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      onclick: () => this.modelDropdownOpen ? this.closeModelDropdown() : this.openModelDropdown(),
    }, [
      this.modelBadgeLabel,
      el("span", { class: "caret", html: icon("chevronDown", { width: 14, height: 14 }) }),
    ]);
    this.modelBadgeWrap = el("div", { class: "model-badge-wrap" }, [this.modelBadge]);

    // Attachments & file inputs
    this.attachmentsBar = el("div", { class: "composer-attachments" });
    this.imageInput = el("input", {
      type: "file",
      accept: "image/*",
      multiple: true,
      style: "display:none",
      onchange: async (e) => {
        const files = [...(e.target.files || [])];
        e.target.value = "";
        await this.uploadFiles(files);
      },
    });

    this.documentInput = el("input", {
      type: "file",
      accept: ".pdf,.docx,.zip,.pptx,.xlsx,.txt,.md,.json,.csv",
      multiple: true,
      style: "display:none",
      onchange: async (e) => {
        let files = [...(e.target.files || [])];
        e.target.value = "";
        if (files.length > 3) {
          toast("Max 3 files", { tone: "error" });
          files = files.slice(0, 3);
        }
        for (const file of files) await this.uploadAndAttach(file);
      },
    });

    this.cameraInput = el("input", {
      type: "file",
      accept: "image/*",
      capture: "environment",
      style: "display:none",
      onchange: async (e) => {
        const files = [...(e.target.files || [])];
        e.target.value = "";
        await this.uploadFiles(files);
      },
    });

    // Unified (+) menu: attachments + tools
    this.attachmentMenu = el("div", { class: "attachment-menu", role: "menu" });
    this.attachBtn = el("button", {
      type: "button",
      class: "composer-attach",
      title: "Add files or tools",
      "aria-label": "Add files or tools",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      onclick: () => this.toggleAttachMenu(),
      html: icon("plus", { width: 18, height: 18 }),
    });
    this.attachWrap = el("div", { class: "composer-attach-wrap" }, [this.attachBtn, this.attachmentMenu]);
    this.renderAttachMenu();

    // Voice input button & recording bar
    this.voiceBtn = el("button", {
      type: "button",
      class: "composer-voice",
      title: "Voice input",
      "aria-label": "Start voice input",
      onclick: () => this.toggleVoiceRecording(),
      html: icon("mic", { width: 18, height: 18 }),
    });

    this.recTimer = el("span", { class: "rec-timer tabular", text: "0:00" });
    this.recWave = el("div", { class: "rec-wave", "aria-hidden": "true" });
    for (let i = 0; i < 28; i++) {
      this.recWave.append(el("span"));
    }
    this.waveBars = [...this.recWave.children];

    this.recCancelBtn = el("button", {
      type: "button",
      class: "rec-cancel",
      "aria-label": "Cancel recording",
      title: "Cancel",
      onclick: () => this.discardRecording(),
      html: icon("x", { width: 18, height: 18 }),
    });

    this.recConfirmBtn = el("button", {
      type: "button",
      class: "rec-confirm",
      "aria-label": "Confirm and transcribe",
      title: "Transcribe",
      onclick: () => this.confirmRecording(),
      html: icon("check", { width: 18, height: 18 }),
    });

    this.recSpinner = el("span", { class: "rec-spinner", "aria-hidden": "true", html: icon("loader", { width: 18, height: 18 }) });

    this.recordingBar = el("div", { class: "composer-recording", "aria-hidden": "true" }, [
      this.recCancelBtn,
      el("div", { class: "rec-body" }, [this.recWave, this.recTimer]),
      this.recConfirmBtn,
    ]);

    // Textarea & Action buttons
    this.backdrop = el("div", { class: "composer-backdrop", "aria-hidden": "true" });
    this.textarea = el("textarea", {
      rows: 1,
      placeholder: greetingPlaceholder(),
      "aria-label": "Message",
      oninput: (e) => {
        this.autoSize(e.target);
        this.syncSendEnabled();
        this.syncUrlHighlight();
        this.syncCompactState();
      },
      onscroll: () => {
        this.inputRow.style.setProperty("--composer-scroll-top", `${this.textarea.scrollTop}px`);
        if (this.backdrop) {
          this.backdrop.scrollTop = this.textarea.scrollTop;
          this.backdrop.scrollLeft = this.textarea.scrollLeft;
        }
      },
      onkeydown: (e) => {
        if (this.skillPicker?.handleKey(e) || e.isComposing) return;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this.sendBtn.click();
        }
      },
      onpaste: (e) => {
        const items = [...(e.clipboardData?.items || [])];
        const files = [];
        for (const it of items) {
          if (it.kind === "file") {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        }
        if (!files.length) {
          setTimeout(() => {
            this.autoSize(this.textarea);
            this.syncSendEnabled();
            this.syncUrlHighlight();
            this.syncCompactState();
          }, 0);
          return;
        }
        e.preventDefault();
        this.uploadFiles(files);
      },
    });
    this.skillPicker = new SkillPicker(this.textarea, {
      onAddFiles: () => this.documentInput.click(),
      onSelectionChange: () => { this.updateComposerForMode(); this.syncSkillLayout(); },
    });
    this.inputWrap = el("div", { class: "composer-input-wrap" }, [
      this.backdrop,
      this.textarea,
    ]);
    this.inputRow = el("div", { class: "composer-input-row" }, [this.skillPicker.chips, this.inputWrap]);
    this.lineProbe = el("div", { class: "composer-line-probe", "aria-hidden": "true" });
    if (typeof ResizeObserver !== "undefined") {
      this.skillLayoutObserver = new ResizeObserver(() => this.syncSkillLayout());
      this.skillLayoutObserver.observe(this.inputRow);
      this.skillLayoutObserver.observe(this.skillPicker.chips);
      this.skillLayoutObserver.observe(this.lineProbe);
    }

    this.sendBtn = el("button", {
      type: "submit",
      class: "send",
      "aria-label": "Send message",
      disabled: true,
      style: "display:none",
      html: icon("arrowUp", { width: 16, height: 16 }),
      onclick: (e) => {
        if (this.isGenerating) {
          e.preventDefault();
          this.onStop?.();
        }
      },
    });

    this.voiceAssistantBtn = el("button", {
      type: "button",
      class: "voice-assistant-btn",
      "aria-label": "Start voice assistant",
      title: "Voice assistant",
      html: icon("audioLines", { width: 20, height: 20 }),
      onclick: () => this.onOpenVoiceAssistant?.(),
    });

    this.composerToolbar = el("div", { class: "composer-toolbar" }, [
      el("div", { class: "composer-toolbar-left" }, [this.attachWrap]),
      el("div", { class: "composer-toolbar-actions" }, [
        this.modelBadgeWrap,
        this.voiceBtn,
        this.voiceAssistantBtn,
        this.sendBtn,
      ]),
    ]);

    this.composerBox = el("div", { class: "composer-box glass" }, [
      this.skillPicker.popup,
      this.skillPicker.preview,
      this.attachmentsBar,
      this.inputRow,
      this.lineProbe,
      this.composerToolbar,
    ]);

    this.composerBox.addEventListener("click", (e) => {
      if (e.target.closest("button, a, [role='menu'], [role='menuitem'], [role='option'], .composer-skill-chips, .skill-popup, .skill-description-preview, .composer-attachments")) {
        return;
      }
      if (document.activeElement !== this.textarea) {
        this.textarea.focus();
      }
    });

    this.composerBox.addEventListener("dragover", (e) => {
      e.preventDefault();
      this.composerBox.classList.add("drag-over");
    });
    this.composerBox.addEventListener("dragleave", (e) => {
      if (!this.composerBox.contains(e.relatedTarget)) {
        this.composerBox.classList.remove("drag-over");
      }
    });
    this.composerBox.addEventListener("drop", (e) => {
      e.preventDefault();
      this.composerBox.classList.remove("drag-over");
      const files = [...(e.dataTransfer?.files || [])];
      this.uploadFiles(files);
    });

    this.composer = el("form", {
      class: "composer",
      onsubmit: async (e) => {
        e.preventDefault();
        if (this.isRecording || this.isGenerating || this.isImageGenerating) return;
        const text = this.textarea.value.trim();
        if (this.isImageMode() && !text) {
          toast("Add a prompt", { tone: "error" });
          return;
        }
        if (!text && this.pendingAttachments.length === 0) return;
        this.textarea.value = "";
        this.skillPicker.close();
        this.autoSize(this.textarea);
        this.syncSendEnabled();
        this.syncUrlHighlight();
        this.onSubmit?.({
          text,
          attachments: this.pendingAttachments.slice(),
          model: this.currentModel,
          autoSearch: this.autoSearch,
          skills: this.skillPicker.selected,
        });
        this.pendingAttachments = [];
        this.renderAttachmentsBar();
        this.syncCompactState();
      },
    }, [
      this.imageInput,
      this.documentInput,
      this.cameraInput,
      this.composerBox,
      this.recordingBar,
    ]);

    this.composerWrap = el("div", { class: "composer-wrap" }, [this.composer]);
  }

  get element() {
    return this.composerWrap;
  }

  isImageMode() {
    return this.currentModel === "image";
  }

  _isCompact() {
    if (!this.hasMessages || this.isRecording || this.pendingAttachments.length ||
        this.uploadingFiles.length || this.skillPicker.selectedIds.length ||
        window.matchMedia?.("(min-width: 769px)")?.matches === false) {
      return false;
    }
    const draft = this.textarea.value;
    if (draft.includes("\n")) return false;
    // This element keeps the compact input width even when the editor spans the full row.
    if (this.lineProbe.textContent !== draft) this.lineProbe.textContent = draft;
    return this.lineProbe.scrollWidth <= this.lineProbe.clientWidth;
  }

  _clearHeightTransition() {
    this._heightTransitionToken += 1;
    if (this._heightTimer) {
      clearTimeout(this._heightTimer);
      this._heightTimer = null;
    }
    if (this.composerBox) {
      this.composerBox.classList.remove("is-resizing");
      this.composerBox.style.blockSize = "";
      this.composerBox.style.height = "";
      this.composerBox.style.overflow = "";
    }
  }

  setConversationActive(active) {
    this.hasMessages = Boolean(active);
    this.composer.classList.toggle("has-messages", this.hasMessages);
    this.updateComposerForMode();
    this.syncCompactState();
  }

  syncCompactState() {
    if (!this.composer || !this.composerBox || !this.textarea) return;
    const compact = this._isCompact();
    const wasCompact = this.composer.classList.contains("is-compact");
    if (compact === wasCompact) return;

    const before = this.composerBox.getBoundingClientRect().height;
    this._clearHeightTransition();
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const supportsInterpolate = typeof CSS !== "undefined" && Boolean(CSS.supports?.("interpolate-size", "allow-keywords"));
    this.composer.classList.toggle("is-compact", compact);
    if (compact) this.textarea.style.height = "";
    else this.autoSize(this.textarea);

    if (reduced || before <= 0) return;

    if (supportsInterpolate) {
      this.composerBox.classList.add("is-resizing");
      void this.composerBox.offsetHeight;
      const transitions = typeof this.composerBox.getAnimations === "function"
        ? this.composerBox.getAnimations().filter(
            (a) => typeof CSSTransition !== "undefined" && a instanceof CSSTransition &&
              (a.transitionProperty === "block-size" || a.transitionProperty === "height")
          )
        : [];
      if (!transitions.length) {
        this.composerBox.classList.remove("is-resizing");
        return;
      }
      const token = this._heightTransitionToken;
      this._heightTimer = setTimeout(() => {
        if (token === this._heightTransitionToken) this._clearHeightTransition();
      }, 340);
      Promise.allSettled(transitions.map((t) => t.finished)).then(() => {
        if (token === this._heightTransitionToken) this._clearHeightTransition();
      });
      return;
    }

    const after = this.composerBox.getBoundingClientRect().height;
    if (Math.abs(after - before) > 1) {
      this.composerBox.classList.add("is-resizing");
      this.composerBox.style.blockSize = `${before}px`;
      void this.composerBox.offsetHeight;
      this.composerBox.style.blockSize = `${after}px`;
      const token = this._heightTransitionToken;
      this._heightTimer = setTimeout(() => {
        if (token === this._heightTransitionToken) this._clearHeightTransition();
      }, 310);
    }
  }

  autoSize(node) {
    if (node === this.textarea && this.composer?.classList.contains("is-compact")) {
      node.style.height = "";
      return;
    }
    const prevHeight = node.style.height;
    const prevScrollTop = node.scrollTop;
    node.style.height = "auto";
    const nextHeight = `${node.scrollHeight}px`;
    node.style.height = nextHeight;
    if (node === this.textarea && this._heightTimer && this.composerBox?.style.blockSize && prevHeight && nextHeight !== prevHeight) {
      this._clearHeightTransition();
    }
    if (prevScrollTop && node.scrollTop !== prevScrollTop) {
      node.scrollTop = prevScrollTop;
    }
    if (this.backdrop && node === this.textarea) {
      this.backdrop.scrollTop = node.scrollTop;
      this.backdrop.scrollLeft = node.scrollLeft;
    }
  }

  syncSkillLayout() {
    this.inputRow.classList.remove("skills-stacked");
    const width = this.skillPicker.chips.hidden ? 0 : this.skillPicker.chips.scrollWidth + 4;
    const inline = width < this.inputRow.clientWidth - 80;
    this.inputRow.classList.toggle("skills-stacked", width > 0 && !inline);
    this.inputRow.style.setProperty("--skill-indent", `${inline ? width : 0}px`);
    this.autoSize(this.textarea);
    this.syncCompactState();
  }

  syncUrlHighlight() {
    if (!this.backdrop || !this.textarea) return;
    const val = this.textarea.value;
    const regex = new RegExp(URL_REGEX.source, "i");
    if (regex.test(val)) {
      this.textarea.classList.add("has-url-highlight");
      this.backdrop.innerHTML = highlightUrlsInText(val);
      this.backdrop.scrollTop = this.textarea.scrollTop;
      this.backdrop.scrollLeft = this.textarea.scrollLeft;
    } else {
      this.textarea.classList.remove("has-url-highlight");
      this.backdrop.innerHTML = "";
    }
  }

  setText(text) {
    this.textarea.value = text || "";
    this.autoSize(this.textarea);
    this.syncSendEnabled();
    this.syncUrlHighlight();
    this.syncCompactState();
  }

  focus() {
    this.textarea.focus();
  }

  positionAttachMenu() {
    const rect = this.attachBtn.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(215, window.innerWidth - margin * 2);
    let left = rect.left;
    const maxLeft = window.innerWidth - width - margin;
    if (left > maxLeft) left = Math.max(margin, maxLeft);
    const isPageEmpty = document.querySelector(".chat-page.is-empty") !== null;
    const isMobile = window.innerWidth <= 768;
    const openDown = isPageEmpty && !isMobile;
    this.attachmentMenu.style.position = "fixed";
    if (openDown) {
      this.attachmentMenu.style.top = `${rect.bottom + margin}px`;
      this.attachmentMenu.style.bottom = "auto";
    } else {
      this.attachmentMenu.style.bottom = `${window.innerHeight - rect.top + margin}px`;
      this.attachmentMenu.style.top = "auto";
    }
    this.attachmentMenu.style.left = `${left}px`;
    this.attachmentMenu.style.right = "auto";
    this.attachmentMenu.style.width = `${width}px`;
    this.attachmentMenu.style.minWidth = "auto";
  }

  toggleAttachMenu(show) {
    const next = show ?? !this.attachmentMenu.classList.contains("open");
    if (next) {
      this.renderAttachMenu();
      this.positionAttachMenu();
    }
    this.attachmentMenu.classList.toggle("open", next);
    this.attachBtn.setAttribute("aria-expanded", next ? "true" : "false");
  }

  renderAttachMenu() {
    clear(this.attachmentMenu);
    const attachItems = [
      { ic: "image", label: "Attach image", open: () => this.imageInput.click() },
      { ic: "fileText", label: "Upload file", open: () => this.documentInput.click() },
      { ic: "camera", label: "Take a snap", open: () => this.cameraInput.click() },
    ];
    for (const it of attachItems) {
      this.attachmentMenu.append(
        el("button", {
          type: "button",
          class: "attachment-menu-item",
          role: "menuitem",
          onclick: () => { it.open(); this.toggleAttachMenu(false); },
        }, [
          el("span", { class: "menu-lead", html: icon(it.ic, { width: 18, height: 18 }) }),
          el("span", { class: "menu-text" }, [
            el("span", { class: "menu-title", text: it.label }),
          ]),
        ])
      );
    }
    this.attachmentMenu.append(el("div", { class: "model-dropdown-divider", role: "separator" }));
    const toolItems = [
      { kind: "search", ic: "globe", label: "Web search", active: this.autoSearch && !this.isImageMode() },
      { kind: "generate", ic: "imageSparkles", label: "Create image", active: this.isImageMode() },
    ];
    for (const it of toolItems) {
      this.attachmentMenu.append(
        el("button", {
          type: "button",
          class: `attachment-menu-item${it.active ? " active" : ""}`,
          role: "menuitemradio",
          "aria-checked": it.active ? "true" : "false",
          onclick: () => { this.toggleAttachMenu(false); this.applyTool(it.kind); },
        }, [
          el("span", { class: "menu-lead", html: icon(it.ic, { width: 18, height: 18 }) }),
          el("span", { class: "menu-text" }, [
            el("span", { class: "menu-title", text: it.label }),
          ]),
        ])
      );
    }
  }

  applyTool(kind) {
    if (kind === "search") {
      this.autoSearch = !this.autoSearch;
      if (this.autoSearch && this.isImageMode()) {
        this.currentModel = this.defaultModel || "thinking";
      }
    } else if (kind === "generate") {
      this.currentModel = "image";
    }
    this.updateComposerForMode();
    this.renderModelBadge();
    this.renderAttachMenu();
    this.syncSendEnabled();
    this.onToolsChange?.({ autoSearch: this.autoSearch, model: this.currentModel });
  }

  updateComposerForMode() {
    if (this.skillPicker.selectedIds.length) {
      this.textarea.placeholder = "";
    } else if (this.isImageMode()) {
      this.textarea.placeholder = "Describe an image to create…";
    } else {
      this.textarea.placeholder = this.hasMessages ? "Write a message..." : greetingPlaceholder();
    }
  }

  renderModelDropdown() {
    clear(this.modelDropdown);
    for (const m of this.availableModels) {
      if (m.id === "image") continue;
      const active = this.currentModel === m.id;
      const isStanza = m.id === "thinking";
      const item = el("button", {
        type: "button",
        class: `model-dropdown-item${active ? " active" : ""}`,
        role: "option",
        "aria-selected": active ? "true" : "false",
        onclick: () => this.selectModelFromDropdown(m.id),
      }, [
        el("span", { class: "menu-text" }, [
          el("span", { class: "menu-title" }, [
            el("span", { text: m.label }),
            ...(isStanza ? [el("span", { class: "model-tag-new", text: "New" })] : []),
          ]),
          m.description ? el("span", { class: "menu-sub", text: m.description }) : null,
        ].filter(Boolean)),
      ]);
      this.modelDropdown.append(item);
    }
  }

  positionModelDropdown() {
    const rect = this.modelBadge.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(225, window.innerWidth - margin * 2);
    let left = rect.left;
    const maxLeft = window.innerWidth - width - margin;
    if (left > maxLeft) left = Math.max(margin, maxLeft);
    const isPageEmpty = document.querySelector(".chat-page.is-empty") !== null;
    const isMobile = window.innerWidth <= 768;
    const openDown = isPageEmpty && !isMobile;
    if (openDown) {
      this.modelDropdown.style.top = `${rect.bottom + 8}px`;
      this.modelDropdown.style.bottom = "auto";
    } else {
      this.modelDropdown.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      this.modelDropdown.style.top = "auto";
    }
    this.modelDropdown.style.left = `${left}px`;
    this.modelDropdown.style.right = "auto";
    this.modelDropdown.style.width = `${width}px`;
    this.modelDropdown.style.minWidth = "auto";
  }

  openModelDropdown() {
    if (this.isGenerating) return;
    this.modelDropdownOpen = true;
    this.renderModelDropdown();
    this.positionModelDropdown();
    this.modelDropdown.classList.add("open");
    this.modelBadge.setAttribute("aria-expanded", "true");
  }

  closeModelDropdown() {
    this.modelDropdownOpen = false;
    this.modelDropdown.classList.remove("open");
    this.modelBadge.setAttribute("aria-expanded", "false");
  }

  selectModelFromDropdown(picked) {
    this.closeModelDropdown();
    if (!picked) return;
    this.currentModel = picked;
    this.renderModelBadge();
    this.renderAttachMenu();
    this.updateComposerForMode();
    this.syncSendEnabled();
    this.onModelChange?.(picked);
  }

  renderModelBadge(incognito = false) {
    if (incognito) {
      this.modelBadgeWrap.style.display = "none";
      return;
    }
    this.modelBadgeWrap.style.display = "";
    if (this.isImageMode()) {
      this.modelBadgeLabel.textContent = "Iris 2.0";
    } else {
      const m = this.availableModels.find((x) => x.id === this.currentModel);
      this.modelBadgeLabel.textContent = m ? m.label : "Stanza 2.5";
    }
  }

  renderAttachmentsBar() {
    const scrollLeft = this.attachmentsBar.scrollLeft;
    const tiles = [];
    for (const f of this.uploadingFiles) {
      const isImg = isImageAttachment(f.name, f.file?.type);
      const children = [];
      if (isImg) {
        children.push(el("span", { class: "sr-only", role: "status", text: `Uploading ${f.name}` }));
      } else {
        const uploadExt = (f.name || "").split(".").pop() || "";
        children.push(el("span", { class: "ic", html: FileIcon(uploadExt, 36) }));
        children.push(el("span", { class: "attachment-info" }, [
          el("span", { class: "name", text: f.name || "File", title: f.name || "File" }),
          el("span", { class: "attachment-status", role: "status" }, [
            el("span", { class: "spinner", html: icon("loader", { width: 11, height: 11 }) }),
            "Uploading…",
          ]),
        ]));
      }
      children.push(
        el("button", {
          type: "button",
          class: "x",
          "aria-label": "Cancel upload",
          onclick: () => {
            f.controller.abort();
            this.uploadingFiles = this.uploadingFiles.filter((x) => x !== f);
            this.renderAttachmentsBar();
            this.syncSendEnabled();
          },
          html: icon("x", { width: 12, height: 12 }),
        })
      );
      tiles.push([this.attachmentOrder.get(f) ?? 0,
        el("div", {
          class: `composer-attachment-chip loading${isImg ? " composer-image-attachment" : ""}`,
          "aria-busy": "true",
        }, children)
      ]);
    }

    for (const a of this.pendingAttachments) {
      const isImage = isImageAttachment(a.filename, a.content_type);
      const children = [];
      if (isImage && a.url) {
        const name = a.filename || "image";
        children.push(el("button", {
          type: "button",
          class: "attachment-preview",
          "aria-label": `Preview ${name}`,
          title: name,
          onclick: () => openImageModal(a.url, a.filename),
        }, [el("img", { src: a.url, alt: name })]));
      } else {
        const ext = (a.filename || "").split(".").pop()?.toLowerCase();
        children.push(el("span", { class: "ic", html: FileIcon(ext, 36) }));
      }
      if (!isImage) {
        const fileType = (a.filename || "").split(".").pop()?.toUpperCase() || "FILE";
        children.push(el("span", { class: "attachment-info" }, [
          el("span", { class: "name", text: a.filename || "Attachment", title: a.filename || "Attachment" }),
          el("span", { class: "attachment-status", text: `${fileType} · Ready` }),
        ]));
      }
      children.push(
        el("button", {
          type: "button",
          class: "x",
          "aria-label": "Remove attachment",
          onclick: () => {
            this.pendingAttachments = this.pendingAttachments.filter((x) => x !== a);
            this.renderAttachmentsBar();
            this.syncSendEnabled();
          },
          html: icon("x", { width: 12, height: 12 }),
        })
      );
      tiles.push([this.attachmentOrder.get(a) ?? 0, el("div", {
        class: `composer-attachment-chip${isImage ? " composer-image-attachment" : ""}`,
      }, children)]);
    }
    tiles.sort(([a], [b]) => a - b);
    this.attachmentsBar.replaceChildren(...tiles.map(([, tile]) => tile));
    this.attachmentsBar.scrollLeft = scrollLeft;
    this.syncCompactState?.();
  }

  async uploadFiles(files) {
    let imageCount = this.pendingAttachments.filter(a => isImageAttachment(a.filename, a.content_type)).length;
    imageCount += this.uploadingFiles.filter(({ file }) => isImageAttachment(file.name, file.type)).length;
    let documentCount = 0;
    const accepted = files.filter(file => {
      if (isImageAttachment(file.name, file.type)) return ++imageCount <= MAX_IMAGES_PER_MESSAGE;
      return ++documentCount <= 3;
    });
    if (imageCount > MAX_IMAGES_PER_MESSAGE) {
      toast(`You can attach up to ${MAX_IMAGES_PER_MESSAGE} images per message`, { tone: "error" });
    }
    if (documentCount > 3) toast("Max 3 files", { tone: "error" });
    await Promise.all(accepted.map(file => this.uploadAndAttach(file)));
  }

  async uploadAndAttach(file) {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      toast("Max file size is 50MB", { tone: "error" });
      return;
    }
    const token = this.getAuthToken?.() || getAuth().auth?.token;
    if (!token) {
      toast("Please sign in to attach files", { tone: "error" });
      return;
    }

    const controller = new AbortController();
    const uploadEntry = { file, name: file.name, controller };
    this.attachmentOrder.set(uploadEntry, this.nextAttachmentOrder++);
    this.uploadingFiles.push(uploadEntry);
    this.renderAttachmentsBar();
    this.syncSendEnabled();

    if (this.activeAttachmentUploads >= MAX_CONCURRENT_ATTACHMENT_UPLOADS) {
      await new Promise(resolve => this.attachmentUploadQueue.push(resolve));
    } else {
      this.activeAttachmentUploads++;
    }
    try {
      if (controller.signal.aborted) return;
      const attachment = await api.uploadAttachment(token, file, controller.signal);
      if (!controller.signal.aborted) {
        this.attachmentOrder.set(attachment, this.attachmentOrder.get(uploadEntry));
        this.pendingAttachments.push(attachment);
        this.pendingAttachments.sort((a, b) => (this.attachmentOrder.get(a) ?? 0) - (this.attachmentOrder.get(b) ?? 0));
      }
    } catch (err) {
      if (!controller.signal.aborted) toast(err.message || "Upload failed", { tone: "error" });
    } finally {
      const nextUpload = this.attachmentUploadQueue.shift();
      if (nextUpload) nextUpload();
      else this.activeAttachmentUploads--;
      this.uploadingFiles = this.uploadingFiles.filter((x) => x !== uploadEntry);
      this.renderAttachmentsBar();
      this.syncSendEnabled();
    }
  }

  syncSendEnabled() {
    if (this.isRecording) {
      this.sendBtn.disabled = true;
      this.sendBtn.style.display = "none";
      this.voiceAssistantBtn.style.display = "none";
      return;
    }
    if (this.isImageGenerating) {
      this.voiceAssistantBtn.style.display = "none";
      this.sendBtn.style.display = "";
      this.sendBtn.disabled = true;
      this.sendBtn.classList.remove("stopping");
      this.sendBtn.setAttribute("aria-label", "Generating image");
      this.sendBtn.title = "Generating image";
      this.sendBtn.innerHTML = `<span class="send-spin">${icon("loader", { width: 16, height: 16 })}</span>`;
      return;
    }
    if (this.isGenerating) {
      this.voiceAssistantBtn.style.display = "none";
      this.sendBtn.style.display = "";
      this.sendBtn.disabled = false;
      this.sendBtn.classList.add("stopping");
      this.sendBtn.setAttribute("aria-label", "Stop generating");
      this.sendBtn.title = "Stop generating";
      this.sendBtn.innerHTML = icon("square", { width: 16, height: 16 });
      return;
    }
    this.sendBtn.classList.remove("stopping");

    const hasInput = Boolean(this.textarea.value.trim()) || this.pendingAttachments.length > 0;
    const isUploading = this.uploadingFiles.length > 0;

    if (isUploading) {
      this.voiceAssistantBtn.style.display = "none";
      this.sendBtn.style.display = "";
      this.sendBtn.setAttribute("aria-label", "Uploading attachment");
      this.sendBtn.title = "Uploading attachment...";
      this.sendBtn.innerHTML = `<span class="send-spin">${icon("loader", { width: 16, height: 16 })}</span>`;
      this.sendBtn.disabled = true;
    } else if (hasInput) {
      this.voiceAssistantBtn.style.display = "none";
      this.sendBtn.style.display = "";
      this.sendBtn.setAttribute("aria-label", "Send message");
      this.sendBtn.title = "Send message";
      this.sendBtn.innerHTML = icon("arrowUp", { width: 16, height: 16 });
      this.sendBtn.disabled = false;
    } else if (this.isImageMode()) {
      this.voiceAssistantBtn.style.display = "none";
      this.sendBtn.style.display = "";
      this.sendBtn.disabled = true;
      this.sendBtn.setAttribute("aria-label", "Send message");
      this.sendBtn.title = "Describe an image to create";
      this.sendBtn.innerHTML = icon("arrowUp", { width: 16, height: 16 });
    } else {
      this.sendBtn.style.display = "none";
      this.voiceAssistantBtn.style.display = "";
    }
  }

  // Voice recording methods
  showRecordingBar(on) {
    this.isRecording = on;
    this.composerBox.style.display = on ? "none" : "";
    this.textarea.readOnly = on;
    this.recordingBar.classList.toggle("active", on);
    this.recordingBar.setAttribute("aria-hidden", on ? "false" : "true");
    this.voiceBtn.classList.toggle("recording", on);
    this.voiceBtn.setAttribute("aria-label", on ? "Stop voice input" : "Start voice input");
    this.syncCompactState?.();
  }

  startRecordTimer() {
    this.recordStartedAt = Date.now();
    this.recTimer.textContent = "0:00";
    this.recordTimerId = setInterval(() => {
      const s = Math.floor((Date.now() - this.recordStartedAt) / 1000);
      this.recTimer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 250);
  }

  stopRecordTimer() {
    if (this.recordTimerId) { clearInterval(this.recordTimerId); this.recordTimerId = null; }
  }

  startWaveMeter(stream) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx || !this.waveBars.length) return;
      this.waveAudioCtx = new AudioCtx();
      const source = this.waveAudioCtx.createMediaStreamSource(stream);
      this.waveAnalyser = this.waveAudioCtx.createAnalyser();
      this.waveAnalyser.fftSize = 512;
      this.waveAnalyser.smoothingTimeConstant = 0.6;
      source.connect(this.waveAnalyser);
      const data = new Uint8Array(this.waveAnalyser.fftSize);

      const n = this.waveBars.length;
      const levels = new Array(n).fill(0);
      const STEP_MS = 55;
      let lastStep = 0;

      const tick = (now) => {
        this.waveAnalyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        let level = Math.min(1, rms * 4.5);
        if (level < 0.06) level = 0;

        if (!lastStep) lastStep = now;
        if (now - lastStep >= STEP_MS) {
          lastStep = now;
          levels.push(level);
          levels.shift();
          for (let i = 0; i < n; i++) {
            const h = 8 + levels[i] * 92;
            this.waveBars[i].style.height = `${h}%`;
          }
        }
        this.waveRafId = requestAnimationFrame(tick);
      };
      this.waveRafId = requestAnimationFrame(tick);
    } catch {}
  }

  stopWaveMeter() {
    if (this.waveRafId) { cancelAnimationFrame(this.waveRafId); this.waveRafId = null; }
    this.waveAnalyser = null;
    if (this.waveAudioCtx) { try { this.waveAudioCtx.close(); } catch {} this.waveAudioCtx = null; }
    for (const b of this.waveBars) b.style.height = "";
  }

  setTranscribingUI(on) {
    this.recordingBar.classList.toggle("transcribing", on);
    if (on) {
      this.recConfirmBtn.replaceWith(this.recSpinner);
      this.recCancelBtn.disabled = false;
      this.recTimer.textContent = "Transcribing…";
    } else {
      this.recSpinner.replaceWith(this.recConfirmBtn);
      this.recCancelBtn.disabled = false;
    }
  }

  async toggleVoiceRecording() {
    if (this.isGenerating) return;
    if (this.isRecording) {
      this.confirmRecording();
    } else {
      await this.startVoiceRecording();
    }
  }

  updateDictationText(session, text) {
    if (this.dictation !== session) return;
    const separator = session.draft && !/\s$/.test(session.draft) && text ? " " : "";
    this.textarea.value = session.draft + separator + text;
    this.autoSize(this.textarea);
    this.syncSendEnabled();
    this.syncUrlHighlight();
    this.syncCompactState?.();
  }

  releaseDictation(session) {
    clearTimeout(session.limitTimer);
    session.controller.abort();
    if (session.recorder?.state === "recording") session.recorder.stop();
    session.stream?.getTracks().forEach(track => track.stop());
    if (this.dictation !== session) return;
    this.dictation = null;
    this.stopRecordTimer();
    this.stopWaveMeter();
    this.setTranscribingUI(false);
    this.showRecordingBar(false);
    this.syncSendEnabled();
  }

  discardRecording() {
    const session = this.dictation;
    if (!session) return;
    this.updateDictationText(session, "");
    this.releaseDictation(session);
  }

  async confirmRecording() {
    const session = this.dictation;
    if (!session?.recorder || session.finishing) return;
    session.finishing = true;
    clearTimeout(session.limitTimer);
    this.stopRecordTimer();
    this.stopWaveMeter();
    this.setTranscribingUI(true);
    const isCurrent = () => this.dictation === session && !session.controller.signal.aborted;
    try {
      if (session.recorder.state === "recording") session.recorder.stop();
      const recorded = await session.recorded;
      if (!isCurrent()) return;
      if (!recorded.size) throw Error("No audio recorded. Please try again.");
      const wav = await blobToWav16kMono(recorded);
      if (!isCurrent()) return;
      const result = await api.transcribeAudio(this.getAuthToken(), wav, {
        language: "multi",
        signal: session.controller.signal,
      });
      if (!isCurrent()) return;
      if (result.text?.trim()) this.updateDictationText(session, result.text.trim());
      else toast("No speech detected. Please try again.", { tone: "neutral" });
    } catch (error) {
      if (isCurrent() && error.name !== "AbortError") toast(error.message || "Transcription failed", { tone: "error" });
    } finally {
      if (this.dictation === session) {
        this.releaseDictation(session);
        this.textarea.focus();
      }
    }
  }

  async startVoiceRecording() {
    if (this.dictation || this.isGenerating || this.isImageGenerating) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast("Voice not supported", { tone: "error" });
      return;
    }
    const session = this.dictation = { draft: this.textarea.value, controller: new AbortController() };
    this.showRecordingBar(true);
    this.syncSendEnabled();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      session.stream = stream;
      if (this.dictation !== session) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find(type => MediaRecorder.isTypeSupported?.(type));
      const recorder = session.recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const chunks = [];
      session.recorded = new Promise((resolve, reject) => {
        recorder.addEventListener("dataavailable", event => {
          if (this.dictation === session && event.data.size) chunks.push(event.data);
        });
        recorder.addEventListener("stop", () => {
          stream.getTracks().forEach(track => track.stop());
          resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
        });
        recorder.addEventListener("error", () => {
          const error = Error("Microphone recording failed. Please try again.");
          reject(error);
          if (this.dictation === session && !session.finishing) {
            this.releaseDictation(session);
            toast(error.message, { tone: "error" });
          }
        });
      });
      session.recorded.catch(() => {});
      recorder.start(250);
      this.startRecordTimer();
      this.startWaveMeter(stream);
      session.limitTimer = setTimeout(() => this.confirmRecording(), 10 * 60 * 1000);
    } catch (error) {
      if (this.dictation === session) {
        this.releaseDictation(session);
        toast(error.name === "NotAllowedError" ? "Microphone permission denied" : "Could not start microphone", { tone: "error" });
      }
    }
  }

  _attachGlobalListeners() {
    this._onDocClick = (e) => {
      if (!this.attachWrap.contains(e.target)) this.toggleAttachMenu(false);
    };
    document.addEventListener("click", this._onDocClick);

    this._onGlobalPaste = (e) => {
      if (document.activeElement === this.textarea) return;
      const items = [...(e.clipboardData?.items || [])];
      const files = [];
      for (const it of items) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;
      e.preventDefault();
      this.focus();
      this.uploadFiles(files);
    };
    document.addEventListener("paste", this._onGlobalPaste);

    this._onPointerDown = (e) => {
      if (this.modelDropdownOpen && !this.modelBadge.contains(e.target) && !this.modelDropdown.contains(e.target)) {
        this.closeModelDropdown();
      }
    };
    document.addEventListener("pointerdown", this._onPointerDown, true);
  }

  destroy() {
    for (const upload of this.uploadingFiles) upload.controller.abort();
    this._clearHeightTransition();
    this.skillLayoutObserver?.disconnect();
    this.skillPicker.destroy();
    this.stopRecordTimer();
    this.stopWaveMeter();
    this.discardRecording();
    document.removeEventListener("click", this._onDocClick);
    document.removeEventListener("paste", this._onGlobalPaste);
    document.removeEventListener("pointerdown", this._onPointerDown, true);
  }
}
