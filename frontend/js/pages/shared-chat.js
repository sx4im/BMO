/**
 * Public shared chat page view for BMO.
 * Displays a clean, read-only snapshot of a shared conversation without requiring authentication.
 */

import { el, clear, formatTitle } from "../utils.js?v=51";
import { icon } from "../icons.js?v=72";
import { brandMark, logo } from "../components/logo.js?v=32";
import { messageBubble } from "../components/message.js?v=36";
import { whenMarkdownReady } from "../components/markdown.js?v=33";
import { navigate } from "../router.js?v=31";
import * as api from "../api.js?v=62";

export async function renderSharedChat({ shareId } = {}) {
  const root = document.getElementById("app");
  if (!root) return;
  clear(root);

  const page = el("div", { class: "shared-chat-page" });
  root.appendChild(page);

  // Top header bar
  const logoBtn = el(
    "button",
    {
      type: "button",
      class: "shared-header-logo-btn",
      onclick: () => navigate("#/"),
      title: "BMO Home",
    },
    [el("span", { class: "mark", html: brandMark() })]
  );

  const titleText = el("h1", { class: "shared-header-title", text: "Loading shared chat…" });

  const ctaBtn = el(
    "button",
    {
      type: "button",
      class: "shared-header-cta-btn",
      onclick: () => navigate("#/app/chat"),
    },
    ["Start chatting", el("span", { html: icon("arrowRight", { width: 14, height: 14 }) })]
  );

  const topbar = el("header", { class: "shared-chat-topbar" }, [
    el("div", { class: "shared-topbar-inner" }, [
      el("div", { class: "shared-topbar-left" }, [
        logoBtn,
        titleText,
      ]),
      el("div", { class: "shared-topbar-right" }, [ctaBtn]),
    ]),
  ]);

  const feedContainer = el("div", { class: "shared-chat-feed" });
  const scrollWrap = el("div", { class: "shared-chat-scroll" }, [feedContainer]);

  page.appendChild(topbar);
  page.appendChild(scrollWrap);

  if (!shareId) {
    titleText.textContent = "Conversation not found";
    feedContainer.appendChild(
      el("div", { class: "shared-chat-empty" }, [
        el("p", { text: "This shared link is invalid or has been revoked." }),
        el("button", {
          type: "button",
          class: "confirm-modal-btn primary",
          text: "Go to BMO",
          onclick: () => navigate("#/"),
        }),
      ])
    );
    return;
  }

  try {
    const data = await api.getPublicShare(shareId);
    if (!data || !Array.isArray(data.messages)) {
      throw new Error("Shared conversation not found");
    }

    titleText.textContent = formatTitle(data.title || "Shared conversation");

    const renderMessages = () => {
      clear(feedContainer);
      for (const msg of data.messages) {
        const bubbleNode = messageBubble({
          message: msg,
          userName: "User",
          userAvatarUrl: null,
          onEdit: null,
          onRetry: null,
          onFeedback: null,
          onRetryAssistant: null,
          onRenderQuiz: null,
          onExport: null,
        });
        feedContainer.appendChild(bubbleNode);
      }
    };
    renderMessages();
    whenMarkdownReady(renderMessages);

    // Footer removed per user design specifications

  } catch (err) {
    titleText.textContent = "Chat not found";
    feedContainer.appendChild(
      el("div", { class: "shared-chat-empty" }, [
        el("p", { text: err.message || "This shared conversation does not exist or was removed by its author." }),
        el("button", {
          type: "button",
          class: "confirm-modal-btn primary",
          text: "Start a new chat",
          onclick: () => navigate("#/app/chat"),
        }),
      ])
    );
  }
}
