import { $, el, clear } from "./utils.js?v=52";
import { icon } from "./icons.js?v=77";
import { renderSidebar } from "./components/sidebar.js?v=71";
import { openChatSearch } from "./components/chat-search.js?v=32";
import { toast } from "./components/toast.js?v=59";
import * as api from "./api.js?v=74";
import { getAuth, signOut } from "./auth.js?v=2";
import { navigate } from "./router.js?v=1";
import { applyTheme } from "./prefs.js?v=1";

/**
 * Persistent app shell shared between Chat / Analytics / Settings pages.
 * The router calls `mountAppShell(pageHandler)` and the handler is given a
 * content host to render its page into.
 */

let state = {
  conversations: null,
  conversationsError: null,
  projects: null,
  activeId: null,
  pageRefresh: null,
  usage: null,
};

let nodes = null;
let conversationRequest = 0;

export function getShellState() {
  return state;
}

export async function loadConversations() {
  const { auth } = getAuth();
  if (!auth) return;
  const request = ++conversationRequest;
  state.conversationsError = null;
  if (!state.conversations && nodes) renderSidebars();
  try {
    const conversations = await api.listConversations(auth.token);
    if (request !== conversationRequest || getAuth().auth?.user?.id !== auth.user?.id) return;
    state.conversations = conversations;
    if (nodes) renderSidebars();
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("bmo:conversations-updated", { detail: state.conversations })
      );
    }
  } catch (err) {
    if (request !== conversationRequest || getAuth().auth?.user?.id !== auth.user?.id) return;
    state.conversationsError = navigator.onLine === false ? "Waiting for connection" : "Couldn't load chats";
    if (nodes) renderSidebars();
  }
}

export async function loadProjects() {
  const { auth } = getAuth();
  if (!auth) return;
  try {
    const projects = await api.listProjects(auth.token);
    if (getAuth().auth?.user?.id !== auth.user?.id) return;
    state.projects = projects;
    if (nodes) renderSidebars();
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("bmo:projects-updated", { detail: state.projects })
      );
    }
  } catch (err) {
    // Non-blocking
  }
}

export async function loadUsage() {
  const { auth } = getAuth();
  if (!auth) return;
  try {
    const usage = await api.getUsage(auth.token);
    if (getAuth().auth?.user?.id !== auth.user?.id) return;
    state.usage = usage;
  } catch (err) {
    // Silently fail if metering is off or throws
  }
}

function renderSidebars() {
  const { auth } = getAuth();
  const props = {
    user: auth?.user,
    conversations: state.conversations,
    conversationsError: state.conversationsError,
    projects: state.projects,
    activeId: state.activeId,
    onNewChat: () => navigate("#/app/chat"),
    onSelectConversation: (id) => navigate(`#/app/chat/${id}`),
    onDeleteConversation: handleDelete,
    onRenameConversation: handleRename,
    onPinConversation: handlePin,
    onRefreshConversations: loadConversations,
    onRefreshProjects: loadProjects,
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
    await loadConversations();
  } catch (err) {
    toast(err.message || "Couldn't rename", { tone: "error" });
  }
}

async function handlePin(id, pinned) {
  const { auth } = getAuth();
  try {
    await api.updateConversation(auth.token, id, { pinned });
    await loadConversations();
  } catch (err) {
    toast(err.message || "Couldn't update pin", { tone: "error" });
  }
}

async function handleDelete(id) {
  const { auth } = getAuth();
  try {
    await api.deleteConversation(auth.token, id);
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
    const shell = shellApi();
    shell.setShareActive(false);
    return shell;
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
    html: icon("incognito", { width: 24, height: 24 }),
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
  // Settings fetches usage when opened; prioritize chats on app startup.
  loadConversations();
  loadProjects();
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
      ++conversationRequest;
      state.conversations = Array.isArray(list) ? list : [];
      state.conversationsError = null;
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
        ? icon("x", { width: 24, height: 24 })
        : icon("incognito", { width: 24, height: 24 });
    },
    refresh: loadConversations,
  };
}


/**
 * Hard reset: called when the user logs out or jumps to a public route so
 * the shell rebuilds cleanly on the next mount.
 */
export function tearDownShell() {
  ++conversationRequest;
  nodes = null;
  state = { conversations: null, conversationsError: null, projects: null, activeId: null, pageRefresh: null, usage: null };
}
