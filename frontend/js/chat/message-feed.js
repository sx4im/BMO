/**
 * Message feed component for BMO chat.
 * Renders empty stream states, message bubbles, reasoning/thinking blocks,
 * streaming indicators, and auto-scrolls with smooth locked pinning.
 *
 * Streaming updates go through StreamingRenderer (stream-renderer.js):
 * tokens are batched per animation frame and only the open markdown block
 * is re-parsed — completed blocks freeze their DOM.
 *
 * Scroll-followership (pin-to-bottom / free scroll / jump button) is owned
 * by ScrollFollower (scroll-follower.js) for the feed's WHOLE lifetime —
 * it works while a response streams AND when the user just scrolls a long
 * finished conversation.
 */

import { el, clear } from "../utils.js?v=30";
import { icon } from "../icons.js?v=48";
import { readingOrb } from "../components/orb.js?v=3";
import { searchCard } from "../components/search-card.js?v=3";
import { renderMarkdown, whenMarkdownReady } from "../components/markdown.js?v=33";
import { messageBubble, reasoningDetails } from "../components/message.js?v=73";
import { EXPORT_FORMATS, downloadBlob } from "../export.js?v=4";
import { StreamingRenderer } from "./stream-renderer.js?v=13";
import { stripStrayCursors } from "./caret.js?v=1";
import { ScrollFollower } from "./scroll-follower.js?v=5";
import { getGreeting, getRandomGreetingTemplate, getPageGreetingTemplate, getFirstName } from "./greetings.js?v=4";

export function emptyStreamView({ incognito, user, template } = {}) {
  if (incognito) {
    return el("div", { class: "empty-stream incognito" }, [
      el("h2", { html: '<span class="accent">Incognito</span> chat' }),
      el("p", { text: "Messages here aren't saved to your history." }),
    ]);
  }
  return el("div", { class: "empty-stream" }, [
    el("h2", { class: "empty-stream-title", text: getGreeting(user?.name, new Date(), template) }),
  ]);
}

export function imageGeneratingNode() {
  const label = "Creating your image";
  return el("article", { class: "message assistant searching" }, [
    el("div", { class: "body" }, [
      el("div", { class: "meta" }, [
        el("span", { class: "author", text: "Bmo" }),
        el("span", { text: "·" }),
        el("span", { class: "status-text", text: label }),
      ]),
      el("div", { class: "image-gen-placeholder" }, [
        el("div", { class: "image-gen-caption" }, [
          el("span", { html: icon("imageSparkles", { width: 15, height: 15 }) }),
          el("span", { text: `${label}…` }),
        ]),
      ]),
    ]),
  ]);
}

// Status row for a pasted link being fetched. A web search gets the richer
// search card instead (searchCardRow below).
export function readingBubbleNode(label = "Reading webpage…") {
  return el("article", { class: "message assistant searching" }, [
    el("div", { class: "body" }, [
      el("div", { class: "bubble search-bubble" }, [
        el("span", { class: "orb-slot" }, [readingOrb(16)]),
        el("span", { class: "search-label", text: label }),
      ]),
    ]),
  ]);
}

export function searchCardRow(data) {
  return el("article", { class: "message assistant search-card-row" }, [
    el("div", { class: "body" }, [searchCard(data)]),
  ]);
}

// The spoken line BMO shows before the search animation ("Let me check the
// latest on that."). Transient: it belongs to the live turn, not to history.
export function searchPreambleNode(text) {
  return el("article", { class: "message assistant search-preamble-row" }, [
    el("div", { class: "body" }, [
      el("div", { class: "bubble search-preamble", text }),
    ]),
  ]);
}

export function streamingBubbleNode(text, reasoning = "", statusPhrase = "") {
  const bubble = el("div", { class: "bubble markdown-body streaming-bubble", "data-streaming": "true" });

  const bodyChildren = [
    el("div", { class: "meta" }, [
      el("span", { class: "status-text", text: statusPhrase || "Thinking…" }),
    ]),
  ];

  if (reasoning.trim()) {
    bodyChildren.push(reasoningDetails({
      reasoning,
      live: true,
      hasAnswerText: Boolean(text),
    }));
  }

  bodyChildren.push(bubble);

  const article = el("article", { class: "message assistant streaming" }, [
    el("div", { class: "body" }, bodyChildren),
  ]);

  // The incremental renderer owns everything inside the bubble from now on
  // (its constructor seeds it with the current content).
  const renderer = new StreamingRenderer(bubble);
  renderer.buildReasoning = (opts) => reasoningDetails(opts); // manual: collapsed until clicked
  bubble.__streamRenderer = renderer;
  article.__streamRenderer = renderer;

  if (text) {
    renderer.finish(text, reasoning);
    renderer.done = false; // the stream continues — allow further frames
  }
  return article;
}

export class MessageFeed {
  constructor({
    onEditMessage,
    onRetryMessage,
    onFeedback,
    onRetryAssistantMessage,
    onExport,
  }) {
    this.onEditMessage = onEditMessage;
    this.onRetryMessage = onRetryMessage;
    this.onFeedback = onFeedback;
    this.onRetryAssistantMessage = onRetryAssistantMessage;
    this.onExport = onExport;

    this.stream = el("div", { class: "chat-stream" });
    this.streamInner = el("div", { class: "inner" });
    this.stream.append(this.streamInner);

    // Track existing message DOM nodes across renders so unchanged bubbles
    // are never torn down or re-parsed.
    this._messageNodes = new Map();
    this._emptyNode = null;
    this._emptyGreetingTemplate = null;
    this._searchingNode = null;
    this._searchCardNode = null;
    this._searchCardKey = null;
    this._preambleNode = null;
    this._imageGeneratingNode = null;
    this._streamingNode = null;

    // Permanent scroll-followership for this feed's lifetime. The page mounts
    // it once its DOM is attached (see mountScrollFollower()).
    this.follower = new ScrollFollower(this.stream);
  }

  get element() {
    return this.stream;
  }

  /** Call once the feed's element is in the document (chat page mount). */
  mountScrollFollower() {
    if (!this.stream.isConnected) return;
    // Self-healing: if the stream element was swapped after construction,
    // rebuild the follower against the live one.
    if (this.follower.scroller !== this.stream) {
      this.follower.unmount();
      this.follower = new ScrollFollower(this.stream);
    }
    this.follower.mount();
  }

  /** Called by the chat page teardown. */
  unmountScrollFollower() {
    this.follower.unmount();
  }

  reset() {
    this.follower.unmount();
    clear(this.streamInner);
    this._messageNodes.clear();
    this._emptyNode = null;
    this._emptyGreetingTemplate = null;
    this._searchingNode = null;
    this._searchCardNode = null;
    this._searchCardKey = null;
    this._preambleNode = null;
    this._imageGeneratingNode = null;
    this._streamingNode = null;
  }

  scrollToBottom() {
    this.follower.jumpToBottom();
  }

  // Live streaming update. Called per SSE token with the ACCUMULATED strings
  // (same contract as before); all DOM work is deferred + batched inside
  // StreamingRenderer, so this stays cheap even at high token rates.
  updateStreamingBubble(text, reasoning = "") {
    const bubble = this.streamInner.querySelector(".streaming-bubble[data-streaming='true']");
    if (!bubble) return false;
    let renderer = bubble.__streamRenderer || bubble.closest(".message.streaming")?.__streamRenderer;
    if (!renderer) {
      // Bubble existed without its renderer (e.g. restored mid-stream).
      renderer = new StreamingRenderer(bubble);
      renderer.buildReasoning = (opts) => reasoningDetails(opts); // manual: collapsed until clicked
      bubble.__streamRenderer = renderer;
    } else {
      renderer.done = false; // an explicit update means the stream is live
    }
    renderer.feed = this;
    return renderer.update(text, reasoning);
  }

  // Final synchronous paint when the turn completes: closes every block,
  // cancels pending frames and drops the caret — no flicker before the
  // settled message replaces the streaming bubble.
  finishStreamingBubble(text, reasoning = "") {
    const bubble = this.streamInner.querySelector(".streaming-bubble[data-streaming='true']");
    const renderer = bubble?.__streamRenderer || bubble?.closest(".message.streaming")?.__streamRenderer;
    if (renderer) {
      renderer.feed = this;
      renderer.done = false; // allow the finishing flush
      renderer.finish(text ?? "", reasoning);
      return true;
    }
    if (!bubble) return false;
    // Fallback: legacy bubble without a renderer (single caret policy — none).
    bubble.innerHTML = `<div class="stream-text">${stripStrayCursors(renderMarkdown(text || ""))}</div>`;
    return true;
  }

  setStreamingReasoningTimer(text) {
    this.streamInner
      .querySelectorAll(".message.streaming .reasoning-timer")
      .forEach((span) => { span.textContent = text; });
  }

  setStatusText(text) {
    const st = this.streamInner.querySelector(".message.streaming .status-text");
    if (st) st.textContent = text;
  }

  render({
    messages = [],
    user = null,
    generating = false,
    searching = false,
    searchingLabel = "Reading webpage…",
    searchVariant = "search",
    searchCardData = null,
    searchPreamble = "",
    imageGenerating = false,
    streamingText = "",
    streamingReasoning = "",
    enteringId = null,
    incognito = false,
    statusPhrase = "",
    initial = false,
  }) {
    if (!messages.length && !generating && !searching && !imageGenerating && !searchCardData) {
      for (const [, entry] of this._messageNodes) entry.element.remove();
      this._messageNodes.clear();
      if (this._preambleNode) { this._preambleNode.remove(); this._preambleNode = null; }
      if (this._searchingNode) { this._searchingNode.remove(); this._searchingNode = null; }
      if (this._searchCardNode) { this._searchCardNode.remove(); this._searchCardNode = null; this._searchCardKey = null; }
      if (this._imageGeneratingNode) { this._imageGeneratingNode.remove(); this._imageGeneratingNode = null; }
      if (this._streamingNode) { this._streamingNode.remove(); this._streamingNode = null; }
      if (!this._emptyNode || !this._emptyNode.isConnected) {
        this._emptyGreetingTemplate = getPageGreetingTemplate();
        this._emptyNode = emptyStreamView({ incognito, user, template: this._emptyGreetingTemplate });
        this.streamInner.append(this._emptyNode);
      } else if (!incognito && this._emptyGreetingTemplate) {
        // Keep the stable template without re-rolling, just sync user's first name if auth loaded after mount
        const titleEl = this._emptyNode.querySelector(".empty-stream-title");
        if (titleEl) {
          const expected = this._emptyGreetingTemplate(getFirstName(user?.name));
          if (titleEl.textContent !== expected) {
            titleEl.textContent = expected;
          }
        }
      }
      return;
    }

    if (this._emptyNode) {
      this._emptyNode.remove();
      this._emptyNode = null;
      this._emptyGreetingTemplate = null;
    }

    const currentMsgIds = new Set(messages.map((m) => m.id));

    // Remove obsolete message bubbles
    for (const [id, entry] of this._messageNodes) {
      if (!currentMsgIds.has(id)) {
        entry.element.remove();
        this._messageNodes.delete(id);
      }
    }

    // Reconcile message bubbles in order
    let prevNode = null;
    for (const m of messages) {
      let entry = this._messageNodes.get(m.id);
      if (entry && entry.message !== m) {
        // Message updated (e.g. feedback changed)
        const newNode = messageBubble({
          message: m,
          userName: user?.name,
          userAvatarUrl: user?.avatar_url,
          onEdit: m.role === "user" ? this.onEditMessage : undefined,
          onRetry: m.role === "user" ? this.onRetryMessage : undefined,
          onFeedback: m.role === "assistant" ? this.onFeedback : undefined,
          onRetryAssistant: m.role === "assistant" ? this.onRetryAssistantMessage : undefined,
          onExport: m.role === "assistant" ? this.onExport : undefined,
          entering: enteringId != null && m.id === enteringId,
        });
        entry.element.replaceWith(newNode);
        entry = { element: newNode, message: m };
        this._messageNodes.set(m.id, entry);
      } else if (!entry) {
        // New message bubble
        const newNode = messageBubble({
          message: m,
          userName: user?.name,
          userAvatarUrl: user?.avatar_url,
          onEdit: m.role === "user" ? this.onEditMessage : undefined,
          onRetry: m.role === "user" ? this.onRetryMessage : undefined,
          onFeedback: m.role === "assistant" ? this.onFeedback : undefined,
          onRetryAssistant: m.role === "assistant" ? this.onRetryAssistantMessage : undefined,
          onExport: m.role === "assistant" ? this.onExport : undefined,
          entering: enteringId != null && m.id === enteringId,
        });
        entry = { element: newNode, message: m };
        this._messageNodes.set(m.id, entry);
        if (prevNode) {
          prevNode.after(newNode);
        } else {
          this.streamInner.prepend(newNode);
        }
      } else {
        // Unchanged existing bubble — preserve position
        if (prevNode && prevNode.nextSibling !== entry.element) {
          prevNode.after(entry.element);
        } else if (!prevNode && this.streamInner.firstChild !== entry.element) {
          this.streamInner.prepend(entry.element);
        }
      }
      prevNode = entry.element;
    }

    // Trailing nodes, in visual order: the spoken preamble, then the live
    // search animation, then image gen, then the streaming answer. The
    // preamble survives the search itself so the answer arrives underneath it
    // rather than replacing it.
    if (searchPreamble) {
      if (!this._preambleNode || !this._preambleNode.isConnected) {
        this._preambleNode = searchPreambleNode(searchPreamble);
        this.streamInner.append(this._preambleNode);
      }
    } else if (this._preambleNode) {
      this._preambleNode.remove();
      this._preambleNode = null;
    }

    // A web search renders the search card, which starts as skeleton rows and
    // is rebuilt once — when the results land. Keying on the phase means later
    // renders leave the card alone, so an expanded result list stays expanded.
    if (searchCardData) {
      const key = `${searchCardData.searching ? "live" : "done"}:${searchCardData.query}:${(searchCardData.results || []).length}`;
      if (this._searchCardNode && this._searchCardKey !== key) {
        this._searchCardNode.remove();
        this._searchCardNode = null;
      }
      if (!this._searchCardNode || !this._searchCardNode.isConnected) {
        this._searchCardNode = searchCardRow(searchCardData);
        this._searchCardKey = key;
        this.streamInner.append(this._searchCardNode);
      }
    } else if (this._searchCardNode) {
      this._searchCardNode.remove();
      this._searchCardNode = null;
      this._searchCardKey = null;
    }

    // Reading a pasted link keeps the simple orb row.
    if (searching && searchVariant === "reading") {
      if (!this._searchingNode || !this._searchingNode.isConnected) {
        this._searchingNode = readingBubbleNode(searchingLabel);
        this.streamInner.append(this._searchingNode);
      } else {
        const labelEl = this._searchingNode.querySelector(".search-label");
        if (labelEl && labelEl.textContent !== searchingLabel) {
          labelEl.textContent = searchingLabel;
        }
      }
    } else if (this._searchingNode) {
      this._searchingNode.remove();
      this._searchingNode = null;
    }

    if (imageGenerating) {
      if (!this._imageGeneratingNode || !this._imageGeneratingNode.isConnected) {
        this._imageGeneratingNode = imageGeneratingNode();
        this.streamInner.append(this._imageGeneratingNode);
      }
    } else if (this._imageGeneratingNode) {
      this._imageGeneratingNode.remove();
      this._imageGeneratingNode = null;
    }

    if (generating && !searching) {
      if (!this._streamingNode || !this._streamingNode.isConnected) {
        this._streamingNode = streamingBubbleNode(streamingText, streamingReasoning, statusPhrase);
        this._streamingNode.__streamRenderer.feed = this;
        this.streamInner.append(this._streamingNode);
      }
    } else if (this._streamingNode) {
      this._streamingNode.remove();
      this._streamingNode = null;
    }

    // Growth-aware follow: pinned users stay glued; detached users keep their
    // place and their jump button (repositioned above the composer).
    this.follower.notifyContentAppended();
    if (initial) {
      setTimeout(() => this.scrollToBottom(), 30); // initial-load snap
    }
  }
}
