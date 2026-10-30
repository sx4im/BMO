import { el, clear, formatTitle } from "../utils.js?v=51";
import { icon } from "../icons.js?v=72";
import { avatar } from "./avatar.js?v=30";
import { getRoute, navigate } from "../router.js?v=31";
import { openConfirmModal, openPromptModal } from "./confirm-modal.js?v=58";
import { openShareModal } from "./share-modal.js?v=2";
import { openMoveChatModal, openProjectModal } from "../pages/projects.js";
import { getAuth } from "../auth.js?v=31";

const NAV = [
  { hash: "#/app/chat", label: "Search", icon: "search" },
  { hash: "#/app/projects", label: "Projects", icon: "projects" },
  { hash: "#/app/feedback", label: "Support", icon: "circleHelp" },
  { hash: "#/app/settings", label: "Settings", icon: "settings" },
];

let openConvoMenuId = null;
const mountedSidebars = new Set();
let lastProps = null;

function updateSidebar() {
  if (!lastProps) return;
  for (const container of [...mountedSidebars]) {
    if (!container.isConnected) {
      mountedSidebars.delete(container);
      continue;
    }
    renderSidebar(container, lastProps);
  }
}

function closeConvoMenus() {
  openConvoMenuId = null;
  for (const node of document.querySelectorAll(".sidebar-convo-menu.open")) {
    node.classList.remove("open");
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("click", closeConvoMenus);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeConvoMenus();
  });
}

function menuItem({ label, iconName, danger = false, onClick }) {
  return el("button", {
    type: "button",
    class: `sidebar-convo-menu-item${danger ? " danger" : ""}`,
    // Run on mousedown so the action happens before the menu unmounts / click is lost.
    onmousedown: (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeConvoMenus();
      onClick();
    },
    // preventDefault on mousedown suppresses click; eat it anyway.
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
    },
  }, [
    el("span", { class: "sidebar-convo-menu-icon", html: icon(iconName, { width: 16, height: 16 }) }),
    el("span", { class: "sidebar-convo-menu-label", text: label }),
  ]);
}

function positionConvoMenu(menu, trigger) {
  const rect = trigger.getBoundingClientRect();
  const shell = menu.closest(".sidebar") || document.body;
  const bounds = shell.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || 196;
  const menuHeight = menu.offsetHeight || 188;
  let top = rect.bottom - bounds.top + 8;
  let left = rect.right - bounds.left - menuWidth;
  if (left < 8) left = 8;
  if (left + menuWidth > bounds.width - 8) left = Math.max(8, bounds.width - menuWidth - 8);
  if (top + menuHeight > bounds.height - 8) {
    top = Math.max(8, rect.top - bounds.top - menuHeight - 8);
  }
  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(left)}px`;
}

function toggleConvoMenu(id, menu, trigger) {
  const opening = openConvoMenuId !== id;
  closeConvoMenus();
  if (!opening) return;
  openConvoMenuId = id;
  menu.classList.add("open");
  positionConvoMenu(menu, trigger);
}

function buildConvoItem(c, { activeId, onSelectConversation, onCloseMobile, onPinConversation, onRenameConversation, onDeleteConversation, onRefreshConversations }) {


  const menu = el("div", { class: "sidebar-convo-menu", role: "menu" }, [
    menuItem({
      label: "Share",
      iconName: "share",
      onClick: () => {
        const { auth } = getAuth();
        if (auth?.token) {
          openShareModal({ conversation: c, token: auth.token });
        }
      },
    }),
    menuItem({
      label: c.pinned ? "Unpin" : "Pin",
      iconName: c.pinned ? "pinOff" : "pin",
      onClick: () => onPinConversation(c.id, !c.pinned),
    }),
    menuItem({
      label: "Rename",
      iconName: "pencil",
      onClick: () => {
        openPromptModal({
          title: "Rename chat",
          initialValue: c.title,
          confirmText: "Save",
          onConfirm: async (val) => {
            if (val !== c.title) await onRenameConversation(c.id, val);
          }
        });
      },
    }),
    menuItem({
      label: "Move to project",
      iconName: "galleryVerticalEnd",
      onClick: () => {
        const { auth } = getAuth();
        if (auth?.token) {
          openMoveChatModal({
            auth,
            conversation: c,
            onMoved: () => {
              onRefreshConversations && onRefreshConversations();
            },
          });
        }
      },
    }),
    menuItem({
      label: "Delete",
      iconName: "trash",
      danger: true,
      onClick: () => {
        openConfirmModal({
          title: "Delete chat",
          message: "Are you sure you want to delete this chat?",
          confirmText: "Delete",
          cancelText: "Cancel",
          danger: true,
          onConfirm: () => onDeleteConversation(c.id),
        });
      },
    }),
  ]);

  const menuBtn = el("button", {
    type: "button",
    class: "item-menu",
    "aria-label": "Conversation options",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    html: icon("moreVertical", { width: 16, height: 16 }),
    onclick: (e) => {
      e.stopPropagation();
      toggleConvoMenu(c.id, menu, menuBtn);
      menuBtn.setAttribute("aria-expanded", openConvoMenuId === c.id ? "true" : "false");
    },
  });

  return el("li", { class: `item${c.id === activeId ? " active" : ""}` }, [
    el(
      "button",
      {
        type: "button",
        class: "entry",
        onclick: () => {
          closeConvoMenus();
          onSelectConversation(c.id);
          onCloseMobile && onCloseMobile();
        },
      },
      [el("span", { class: "title", text: formatTitle(c.title) })]
    ),
    menuBtn,
    menu,
  ]);
}

export function renderSidebar(container, props) {
  mountedSidebars.add(container);
  lastProps = props;
  const {
    user,
    conversations,
    projects,
    activeId,
    onNewChat,
    onSelectConversation,
    onDeleteConversation,
    onRenameConversation,
    onPinConversation,
    onRefreshConversations,
    onRefreshProjects,
    onLogout,
    onCloseMobile,
    onOpenSearch,
  } = props;

  clear(container);

  const itemProps = {
    activeId,
    onSelectConversation,
    onCloseMobile,
    onPinConversation,
    onRenameConversation,
    onDeleteConversation,
    onRefreshConversations,
  };

  const pinned = conversations ? conversations.filter((c) => c.pinned) : [];
  const recents = conversations ? conversations.filter((c) => !c.pinned) : [];

  const currentHash = getRoute().hash;
  const isNewChatActive =
    !activeId &&
    (currentHash === "#/app/chat" ||
      currentHash === "#/app/chat/" ||
      currentHash === "#/app/chat/incognito");
  const nav = el("nav", { class: "sidebar-nav", "aria-label": "Primary" });
  nav.append(
    el(
      "button",
      {
        type: "button",
        class: `sidebar-nav-new${isNewChatActive ? " active" : ""}`,
        "aria-current": isNewChatActive ? "page" : null,
        onclick: () => {
          onNewChat();
          onCloseMobile && onCloseMobile();
        },
      },
      [
        el("span", { class: "sidebar-nav-icon", html: icon("squarePen", { width: 18, height: 18 }) }),
        el("span", { class: "sidebar-nav-label", text: "New" }),
      ]
    )
  );
  for (const { hash, label, icon: iconName } of NAV) {
    const isSearch = hash === "#/app/chat";
    // "Search" opens the search overlay — it's an ACTION, not a page, so it
    // never gets the active highlight (previously it lit up on every /app/chat
    // route, which is the whole app). Support/Settings stay path-active.
    const isActive = isSearch ? false : currentHash.startsWith(hash);
    nav.append(
      el(
        "a",
        {
          href: hash,
          class: isActive ? "active" : "",
          onclick: (e) => {
            if (isSearch && onOpenSearch) {
              e.preventDefault();
              onOpenSearch();
            } else {
              e.preventDefault();
              navigate(hash);
            }
            onCloseMobile && onCloseMobile();
          },
        },
        [
          el("span", { class: "sidebar-nav-icon", html: icon(iconName, { width: 18, height: 18 }) }),
          el("span", { class: "sidebar-nav-label", text: label }),
        ]
      )
    );
  }

  const listsWrap = el("div", { class: "sidebar-convo-lists" });

  if (projects && projects.length > 0) {
    const projectList = el("ul", { class: "sidebar-project-list" });
    for (const p of projects) {
      const isProjActive = currentHash === `#/app/projects/${p.id}`;
      projectList.append(
        el("li", { class: `item${isProjActive ? " active" : ""}` }, [
          el(
            "button",
            {
              type: "button",
              class: "entry project-entry",
              onclick: () => {
                navigate(`#/app/projects/${p.id}`);
                onCloseMobile && onCloseMobile();
              },
            },
            [
              el("span", { class: "project-icon", html: icon("galleryVerticalEnd", { width: 14, height: 14 }) }),
              el("span", { class: "title", text: p.name }),
            ]
          ),
        ])
      );
    }
    listsWrap.append(
      el("div", { class: "sidebar-convo-section projects-section" }, [
        el("div", { class: "sidebar-section-head" }, [
          el("span", { text: "Projects" }),
          el("button", {
            type: "button",
            class: "sidebar-section-action",
            title: "New project",
            "aria-label": "New project",
            onclick: () => {
              const { auth } = getAuth();
              if (auth) {
                openProjectModal({
                  auth,
                  onCreated: () => {
                    onRefreshProjects && onRefreshProjects();
                  },
                });
              }
            },
            html: icon("plus", { width: 14, height: 14 }),
          }),
        ]),
        projectList,
      ])
    );
  }

  if (pinned.length) {
    const pinnedList = el("ul", {});
    for (const c of pinned) pinnedList.append(buildConvoItem(c, itemProps));
    listsWrap.append(
      el("div", { class: "sidebar-convo-section pinned-section" }, [
        el("div", { class: "sidebar-section-head" }, [
          el("span", { text: "Pinned" }),
        ]),
        pinnedList,
      ])
    );
  }

  const recentList = el("ul", {});
  if (!conversations) {
    // empty while loading
  } else if (!conversations.length) {
    recentList.append(el("li", { class: "empty", text: "No conversations yet" }));
  } else {
    for (const c of recents) recentList.append(buildConvoItem(c, itemProps));
  }

  listsWrap.append(
    el("div", { class: "sidebar-convo-section recents-section" }, [
      el("div", { class: "sidebar-section-head" }, [
        el("span", { text: "Recents" }),
        el("span", { class: "tabular", text: conversations ? String(recents.length) : "" }),
      ]),
      recentList,
    ])
  );

  container.append(
    el("div", { class: "sidebar-head" }, [
      el("a", {
        href: "#/",
        class: "sidebar-brand",
        "aria-label": "Bmo home",
        text: "Bmo.",
      }),
      el("button", {
        type: "button",
        class: "close-mobile",
        "aria-label": "Close menu",
        onclick: () => onCloseMobile && onCloseMobile(),
        html: icon("x"),
      }),
    ]),
    nav,
    listsWrap,
    el("div", { class: "sidebar-foot" }, [
      el("div", { class: "sidebar-profile" }, [
        avatar(user?.name, "md", user?.avatar_url || null),
        el("div", { class: "who" }, [
          el("div", { class: "name", text: user?.name || "Guest" }),
          el("div", { class: "email", text: user?.email || "" }),
        ]),
        el("button", {
          type: "button",
          class: "signout",
          title: "Sign out",
          "aria-label": "Sign out",
          onclick: () => onLogout(),
          html: icon("logOut", { width: 18, height: 18 }),
        }),
      ]),
    ].filter(Boolean))
  );
}
