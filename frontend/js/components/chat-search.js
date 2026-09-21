// Command-palette style chat search (ChatGPT-like). Opens over the app with a
// search box, a "New chat" action, and past conversations grouped by recency.
// Dismiss with the X, a backdrop click, or Escape; navigate rows with the
// arrow keys and Enter.

import { el, clear, formatTitle } from "../utils.js?v=30";
import { icon } from "../icons.js?v=69";

let activeOverlay = null;
let keyHandler = null;

function close() {
  if (!activeOverlay) return;
  const overlay = activeOverlay;
  activeOverlay = null;
  if (keyHandler) document.removeEventListener("keydown", keyHandler);
  keyHandler = null;
  overlay.classList.remove("open");
  setTimeout(() => overlay.remove(), 160);
}

function startOfDay(value) {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Recency bucket for a conversation timestamp, relative to today.
function bucketFor(ts) {
  const diffDays = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays <= 7) return "Previous 7 Days";
  if (diffDays <= 30) return "Previous 30 Days";
  return "Older";
}

const BUCKET_ORDER = ["Today", "Yesterday", "Previous 7 Days", "Previous 30 Days", "Older"];

/**
 * @param {{ conversations?: Array, onSelect?: (id: string) => void, onNewChat?: () => void }} opts
 */
export function openChatSearch({ conversations = [], onSelect, onNewChat } = {}) {
  if (activeOverlay) close();

  const input = el("input", {
    type: "text",
    class: "chat-search-input",
    placeholder: "Search chats...",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "Search chats",
  });

  const list = el("div", { class: "chat-search-list" });

  // Keyboard-navigable rows (New chat + each conversation). Each row carries a
  // __run() that performs its action.
  let rows = [];
  let activeIdx = 0;

  function setActive(idx) {
    if (!rows.length) return;
    activeIdx = (idx + rows.length) % rows.length;
    rows.forEach((r, i) => r.classList.toggle("active", i === activeIdx));
    rows[activeIdx].scrollIntoView({ block: "nearest" });
  }

  function makeRow({ iconName, title, extraClass, run }) {
    const row = el("button", {
      type: "button",
      class: `chat-search-row${extraClass ? ` ${extraClass}` : ""}`,
      onclick: run,
    }, [
      el("span", { class: "cs-ic", html: icon(iconName, { width: 15, height: 15 }) }),
      el("span", { class: "cs-title", text: title }),
    ]);
    row.__run = run;
    return row;
  }

  function render(query) {
    const q = query.trim().toLowerCase();
    clear(list);
    rows = [];

    const newChat = makeRow({
      iconName: "squarePen",
      title: "New chat",
      extraClass: "chat-search-new",
      run: () => { close(); onNewChat && onNewChat(); },
    });
    list.append(newChat);
    rows.push(newChat);

    const matches = (conversations || []).filter(
      (c) => !q || (c.title || "").toLowerCase().includes(q)
    );

    if (!matches.length) {
      list.append(el("div", {
        class: "chat-search-empty",
        text: q ? "No matching chats" : "No conversations yet",
      }));
    } else {
      const groups = new Map();
      for (const c of matches) {
        const bucket = bucketFor(c.updated_at || c.created_at);
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket).push(c);
      }
      for (const bucket of BUCKET_ORDER) {
        const items = groups.get(bucket);
        if (!items || !items.length) continue;
        list.append(el("div", { class: "chat-search-group", text: bucket }));
        for (const c of items) {
          const row = makeRow({
            iconName: "messageSquare",
            title: formatTitle(c.title) || "Untitled chat",
            run: () => { close(); onSelect && onSelect(c.id); },
          });
          list.append(row);
          rows.push(row);
        }
      }
    }
    setActive(0);
  }

  input.addEventListener("input", () => render(input.value));

  const card = el("div", {
    class: "chat-search-card",
    onclick: (e) => e.stopPropagation(),
  }, [
    el("div", { class: "chat-search-head" }, [
      input,
      el("button", {
        type: "button",
        class: "chat-search-close",
        "aria-label": "Close",
        title: "Close",
        onclick: close,
        html: icon("x", { width: 18, height: 18 }),
      }),
    ]),
    list,
  ]);

  const overlay = el("div", {
    class: "chat-search-overlay",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "Search chats",
    onclick: close,
  }, [card]);

  keyHandler = (e) => {
    if (e.key === "Escape") { close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive(activeIdx + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(activeIdx - 1); }
    else if (e.key === "Enter") { e.preventDefault(); rows[activeIdx]?.__run(); }
  };

  document.body.append(overlay);
  activeOverlay = overlay;
  document.addEventListener("keydown", keyHandler);
  render("");
  requestAnimationFrame(() => {
    overlay.classList.add("open");
    input.focus();
  });
}
