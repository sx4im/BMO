import { el, clear } from "../utils.js?v=30";
import { thoughtOrb } from "./orb.js?v=3";
import { searchCard } from "./search-card.js?v=3";
import { icon } from "../icons.js?v=30";
import { avatar } from "./avatar.js?v=30";
import { renderMarkdown } from "./markdown.js?v=34";
import { openImageModal } from "./image-modal.js?v=30";

export function reasoningDetails({ reasoning, durationText = "", live = false, hasAnswerText = false, open = false }) {
  const mark = el("span", { class: live ? "icon-pulse orb-slot" : "orb-slot" });
  // Composing orb replaces the brain glyph — animated while reasoning is
  // streaming in, frozen on its current frame once the turn completes.
  const orb = thoughtOrb(14);
  if (!live) orb.setAttribute("paused", "");
  mark.append(orb);
  const timer = el("span", {
    class: live ? "reasoning-timer" : "reasoning-duration",
    text: durationText,
  });
  const summary = el("summary", {}, [mark, " Thought Process ", timer]);
  const content = el("div", {
    class: "reasoning-content markdown-body",
    html: reasoning ? renderMarkdown(reasoning) : "",
  });
  if (reasoning) {
    content.dataset.src = content.innerHTML;
  }
  const block = el("details", { class: "reasoning-block", open: open ? "" : null }, [summary, content]);
  return block;
}

// Recent messages show a 12-hour clock time ("9:57 AM"); anything older than a
// day shows the date instead. Revealed on hover in the action row.
function formatStamp(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  if (Date.now() - d.getTime() >= 86_400_000) {
    const opts = d.getFullYear() === new Date().getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
    return d.toLocaleDateString([], opts);
  }
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function messageBubble({
  message,
  userName,
  userAvatarUrl,
  onEdit,
  onRetry,
  onFeedback,
  onRetryAssistant,
  onRenderQuiz,
  onExport,
  entering = false,
}) {
  const isAssistant = message.role === "assistant";

  let quizNode = null;
  if (isAssistant && message.quizData && onRenderQuiz) {
    quizNode = onRenderQuiz(message);
  }

  const hasImageAttachment = Array.isArray(message.attachments)
    && message.attachments.some((a) => (a.content_type || "").startsWith("image/"));

  let reasoningNode = null;
  let bubbleNodes = [];

  if (isAssistant) {
    if (message.reasoning && message.reasoning.trim()) {
      const dur = message.reasoning_seconds != null ? `· ${message.reasoning_seconds}s` : "";
      reasoningNode = reasoningDetails({
        reasoning: message.reasoning,
        durationText: dur,
        // Manual by design: collapsed until the user clicks the summary.
        // (open defaults to false in reasoningDetails.)
      });
    }

    if (message.content) {
      bubbleNodes.push(el("div", {
        class: `bubble markdown-body${hasImageAttachment ? " caption" : ""}`,
        html: renderMarkdown(message.content || ""),
      }));
    }
  } else {
    bubbleNodes.push(el("div", { class: "bubble", text: message.content }));
  }


  // Attachments preview. User messages show the files they sent; assistant
  // messages show generated images (Iris). Image URLs are signed and may
  // expire, so fall back gracefully on load failure.
  let attachmentsPreview = null;
  if (Array.isArray(message.attachments) && message.attachments.length) {
    attachmentsPreview = el("div", { class: `message-attachments${isAssistant ? " generated" : ""}` });
    for (const a of message.attachments) {
      const isImage = (a.content_type || "").startsWith("image/");
      if (isImage && a.url) {
        const img = el("img", {
          src: a.url,
          alt: a.filename || "image",
          loading: "lazy",
          title: "Click to view",
          style: "cursor: zoom-in;",
          onclick: () => openImageModal(a.url, a.filename),
        });
        img.addEventListener("error", () => {
          img.style.opacity = "0.35";
          img.style.cursor = "default";
          img.onclick = null;
          img.title = "Image link expired";
        });
        if (isAssistant) {
          // Generated image: larger, with a download action beneath it.
          const dl = el("a", {
            class: "generated-download",
            href: a.url,
            download: a.filename || "bimo-image.png",
            target: "_blank",
            rel: "noopener noreferrer",
            html: `${icon("download", { width: 13, height: 13 })} <span>Download</span>`,
          });
          attachmentsPreview.append(el("figure", { class: "generated-image" }, [img, dl]));
        } else {
          attachmentsPreview.append(img);
        }
      } else if (a.filename && !isAssistant) {
        attachmentsPreview.append(el("span", { class: "file-chip", text: a.filename }));
      }
    }
  }

  // Icon-only action controls (no text labels). Retry + Edit are user-only.
  const ICON = 15;
  const actBtn = (name, title, onclick, { active = false } = {}) =>
    el("button", {
      type: "button",
      class: `msg-act${active ? " active" : ""}`,
      title,
      "aria-label": title,
      "aria-pressed": active ? "true" : "false",
      onclick,
      html: icon(name, { width: ICON, height: ICON }),
    });

  const copyBtn = actBtn("copy", "Copy", async () => {
    try {
      await navigator.clipboard.writeText(message.content || "");
      copyBtn.innerHTML = icon("check", { width: ICON, height: ICON });
      setTimeout(() => { copyBtn.innerHTML = icon("copy", { width: ICON, height: ICON }); }, 1400);
    } catch { /* ignore */ }
  });

  // Timestamp shows under user prompts only (hover-revealed), then the icons.
  const actionButtons = [];
  if (!isAssistant) actionButtons.push(el("span", { class: "msg-time", text: formatStamp(message.created_at) }));
  if (!isAssistant && onRetry) actionButtons.push(actBtn("refresh", "Retry", () => onRetry(message)));
  if (!isAssistant && onEdit)  actionButtons.push(actBtn("pencil", "Edit", () => onEdit(message)));
  if (message.content) actionButtons.push(copyBtn);

  // Assistant replies get feedback (thumbs up/down) + regenerate.
  if (isAssistant) {
    const fb = message.feedback;
    const thumbUpActive = !!fb && fb.rating >= 4;
    const thumbDownActive = !!fb && fb.rating <= 2;
    if (onFeedback && message.content) {
      actionButtons.push(
        actBtn("thumbsUp", "Good response", () => onFeedback(message, "up"), { active: thumbUpActive }),
        actBtn("thumbsDown", "Bad response", () => onFeedback(message, "down"), { active: thumbDownActive }),
      );
    }

    if (onRetryAssistant) {
      actionButtons.push(actBtn("refresh", "Retry", () => onRetryAssistant(message)));
    }
  }



  const bodyChildren = [];
  // The search that produced this answer, kept above it. Set on the live turn
  // only — replies loaded from history have no search to show.
  if (isAssistant && message.search) bodyChildren.push(searchCard(message.search));
  if (reasoningNode) bodyChildren.push(reasoningNode);
  if (bubbleNodes.length) bodyChildren.push(...bubbleNodes);
  if (quizNode) bodyChildren.push(quizNode);

  // Long user prompts collapse behind a "Show more" toggle (assistant replies
  // always render in full).
  if (!isAssistant && bubbleNodes[0] && (message.content || "").length > 260) {
    bubbleNodes[0].classList.add("clamped");
    const showMore = el("button", {
      type: "button", class: "show-more", text: "Show more",
      onclick: () => {
        const collapsed = bubbleNodes[0].classList.toggle("clamped");
        showMore.textContent = collapsed ? "Show more" : "Show less";
      },
    });
    bodyChildren.push(showMore);
  }

  if (attachmentsPreview) bodyChildren.push(attachmentsPreview);
  if (actionButtons.length) bodyChildren.push(el("div", { class: "actions" }, actionButtons));

  const body = el("div", { class: "body" }, bodyChildren);

  return el("article", {
    class: `message ${isAssistant ? "assistant" : "user"}${entering ? " entering" : ""}`,
  }, [body]);
}
