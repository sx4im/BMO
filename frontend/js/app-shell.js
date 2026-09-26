import { $, el, clear } from "./utils.js?v=30";
import { icon } from "./icons.js?v=69";
import { renderSidebar } from "./components/sidebar.js?v=62";
import { openChatSearch } from "./components/chat-search.js?v=31";
import { toast } from "./components/toast.js?v=58";
import * as api from "./api.js?v=30";
import { getAuth, signOut } from "./auth.js?v=31";
import { navigate } from "./router.js?v=31";
import { applyTheme } from "./prefs.js?v=32";

/**
 * Persistent app shell shared between Chat / Analytics / Settings pages.
 * The router calls `mountAppShell(pageHandler)` and the handler is given a
 * content host to render its page into.
 */

let state = {
  conversations: null,
  activeId: null,
  pageRefresh: null,
  usage: null,
};

let nodes = null;

export function getShellState() {
  return state;
}

export async function loadConversations() {
  const { auth } = getAuth();
  if (!auth) return;
  try {
    state.conversations = await api.listConversations(auth.token);
    if (nodes) renderSidebars();
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("bmo:conversations-updated", { detail: state.conversations })
      );
    }
  } catch (err) {
    toast(err.message || "Couldn't load chats", { tone: "error" });
  }
}

export async function loadUsage() {
  const { auth } = getAuth();
  if (!auth) return;
  try {
    state.usage = await api.getUsage(auth.token);
  } catch (err) {
    // Silently fail if metering is off or throws
  }
}

function renderSidebars() {
  const { auth } = getAuth();
  const props = {
    user: auth?.user,
    conversations: state.conversations,
    activeId: state.activeId,
    onNewChat: () => navigate("#/app/chat"),
    onSelectConversation: (id) => navigate(`#/app/chat/${id}`),
    onDeleteConversation: handleDelete,
    onRenameConversation: handleRename,
    onPinConversation: handlePin,
    onLogout: handleLogout,
    onCloseMobile: closeMobile,
    onOpenSearch: () => openChatSearch({
      conversations: state.conversations,
      onSelect: (id) => navigate(`#/app/chat/${id}`),
      onNewChat: () => navigate("#/app/chat"),
    }),
  };
  renderSidebar(nodes.sidebarDesktop, props);
  renderSidebar(nodes.sidebarMobile, props);
}

async function handleRename(id, title) {
  if (!title) return;
  const { auth } = getAuth();
  try {
    await api.updateConversation(auth.token, id, { title });
    toast("Renamed", { tone: "success" });
    await loadConversations();
  } catch (err) {
    toast(err.message || "Couldn't rename", { tone: "error" });
  }
}

async function handlePin(id, pinned) {
  const { auth } = getAuth();
  try {
    await api.updateConversation(auth.token, id, { pinned });
    toast(pinned ? "Pinned" : "Unpinned", { tone: "success" });
    await loadConversations();
  } catch (err) {
    toast(err.message || "Couldn't update pin", { tone: "error" });
  }
}

async function handleDelete(id) {
  const { auth } = getAuth();
  try {
    await api.deleteConversation(auth.token, id);
    // Exclamation only — never a green success tick for delete.
    toast("Chat deleted", { tone: "warning" });
    if (state.activeId === id) {
      state.activeId = null;
      navigate("#/app/chat");
    }
    await loadConversations();
  } catch (err) {
    toast(err.message || "Couldn't delete", { tone: "error" });
  }
}

async function handleLogout() {
  await signOut();
  navigate("#/", { replace: true });
}

function openMobile() {
  nodes?.sidebarMobile.classList.add("open");
  nodes?.backdrop.classList.add("open");
}

function closeMobile() {
  nodes?.sidebarMobile.classList.remove("open");
  nodes?.backdrop.classList.remove("open");
}

/**
 * Mounts the shell into the #app root if not already mounted.
 * Returns { content: HTMLElement, setActiveConversation, refresh }.
 */
export async function mountAppShell() {
  applyTheme();
  const root = $("#app");
  if (nodes && nodes.content && nodes.content.isConnected) {
    return shellApi();
  }

  clear(root);
  root.className = "app-root";

  const sidebarDesktop = el("aside", { class: "sidebar", "aria-label": "Navigation" });
  const sidebarMobile = el("aside", { class: "sidebar mobile", "aria-label": "Navigation (mobile)" });
  const backdrop = el("div", { class: "sidebar-backdrop", onclick: closeMobile, "aria-hidden": "true" });

  const mobileShareBtn = el("button", {
    type: "button",
    class: "chat-topbar-share-btn mobile-share-btn",
    title: "Share chat",
    "aria-label": "Share chat",
    style: "display: none;",
    onclick: () => {
      if (typeof state.onShare === "function") {
        state.onShare();
      }
    },
    text: "Share",
  });

  const mobileIncognitoBtn = el("button", {
    type: "button",
    class: "mobile-bar-incognito",
    title: "Incognito chat",
    "aria-label": "Start incognito",
    "aria-pressed": "false",
    onclick: () => {
      const active = mobileIncognitoBtn.classList.contains("active");
      navigate(active ? "#/app/chat" : "#/app/chat/incognito");
    },
    html: icon("incognito", { width: 26, height: 24 }),
  });

  const mobileBar = el("header", { class: "mobile-bar" }, [
    el("button", {
      type: "button",
      class: "menu",
      "aria-label": "Open menu",
      onclick: openMobile,
      html: icon("menu", { width: 24, height: 24 }),
    }),
    el("span", { class: "mobile-bar-spacer", "aria-hidden": "true" }),
    mobileShareBtn,
    mobileIncognitoBtn,
  ]);

  const content = el("main", { class: "app-main" });

  const footer = el("footer", {
    class: "app-footer",
  }, [
    el("span", { text: "Built by " }),
    el("a", {
      href: "https://saimshafique.com",
      target: "_blank",
      rel: "noopener noreferrer",
      style: "color:var(--primary);text-decoration:none;",
      text: "Saim Shafique",
    }),
  ]);

  const layout = el("div", { class: "app-shell" }, [
    sidebarDesktop,
    backdrop,
    sidebarMobile,
    el("div", { class: "app-main" }, [
      mobileBar,
      content,
      footer,
    ]),
  ]);

  root.append(layout);

  nodes = { sidebarDesktop, sidebarMobile, backdrop, content, mobileIncognitoBtn, mobileShareBtn };

  renderSidebars();
  // Fire off background fetch for usage stats so they're ready for Settings
  loadUsage();
  loadConversations();
  return shellApi();
}

function shellApi() {
  return {
    content: nodes.content,
    setActiveConversation(id) {
      state.activeId = id || null;
      renderSidebars();
    },
    setConversations(list) {
      state.conversations = Array.isArray(list) ? list : [];
      renderSidebars();
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("bmo:conversations-updated", { detail: state.conversations })
        );
      }
    },
    setShareActive(canShare, onShareHandler) {
      const shareBtn = nodes?.mobileShareBtn;
      const incogBtn = nodes?.mobileIncognitoBtn;
      state.onShare = onShareHandler || null;
      if (!shareBtn || !incogBtn) return;
      if (canShare) {
        shareBtn.style.display = "inline-flex";
        incogBtn.style.display = "none";
      } else {
        shareBtn.style.display = "none";
        incogBtn.style.display = "grid";
      }
    },
    setIncognitoActive(active) {
      const btn = nodes?.mobileIncognitoBtn;
      if (!btn) return;
      const on = !!active;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.title = on ? "Exit incognito" : "Incognito chat";
      btn.setAttribute("aria-label", on ? "Exit incognito" : "Start incognito");
      // Ghost to enter; clear X while active so quitting is obvious.
      btn.innerHTML = on
        ? icon("x", { width: 22, height: 22 })
        : icon("incognito", { width: 26, height: 24 });
    },
    refresh: loadConversations,
  };
}


/**
 * Hard reset: called when the user logs out or jumps to a public route so
 * the shell rebuilds cleanly on the next mount.
 */
export function tearDownShell() {
  nodes = null;
  state = { conversations: null, activeId: null, pageRefresh: null, usage: null };
}
