import { el, clear } from "../utils.js?v=30";
import { icon } from "../icons.js?v=69";
import { mountAppShell, tearDownShell, getShellState } from "../app-shell.js?v=72";
import { getAuth, signOut, setUserDisplayName } from "../auth.js?v=31";
import { getThemePref, setThemePref } from "../prefs.js?v=32";
import { avatar } from "../components/avatar.js?v=30";
import { toast } from "../components/toast.js?v=58";
import { openConfirmModal } from "../components/confirm-modal.js?v=58";
import * as api from "../api.js?v=30";

// Segmented System / Light / Dark control (mirrors the reference Appearance row).
function appearanceControl() {
  const options = [
    { id: "system", label: "System", ic: "user" },
    { id: "light", label: "Light", ic: "sun" },
    { id: "dark", label: "Dark", ic: "moon" },
  ];
  let current = getThemePref();
  const buttons = {};
  const seg = el("div", { class: "seg-control", role: "group", "aria-label": "Appearance" });
  for (const o of options) {
    const btn = el("button", {
      type: "button",
      class: `seg-btn ${current === o.id ? "active" : ""}`,
      "aria-pressed": String(current === o.id),
      title: o.label,
      onclick: () => {
        if (current === o.id) return;
        current = o.id;
        setThemePref(o.id);
        for (const [id, b] of Object.entries(buttons)) {
          const on = id === o.id;
          b.classList.toggle("active", on);
          b.setAttribute("aria-pressed", String(on));
        }
      },
      html: `${icon(o.ic, { width: 15, height: 15 })}<span>${o.label}</span>`,
    });
    buttons[o.id] = btn;
    seg.append(btn);
  }
  return seg;
}

function humanDuration(seconds) {
  const s = Math.max(0, seconds | 0);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

// Plan-usage panel (moved here from the old Analytics page): a session window +
// a weekly window, each a labelled progress bar with % used and a reset time.
async function renderUsageInto(host, token) {
  clear(host);
  host.append(
    el("div", { class: "section-title" }, [
      el("div", { class: "icon-box", html: icon("planUsage", { width: 16, height: 16 }) }),
      el("h2", { text: "Plan usage" }),
    ])
  );

  let usage = getShellState().usage;
  if (!usage) {
    try {
      usage = await api.getUsage(token);
      getShellState().usage = usage;
    } catch {
      host.remove(); // metering not provisioned yet -> drop the empty card
      return;
    }
  }
  const rows = [
    { label: "Current session", color: "indigo", ...usage.session },
    { label: "Weekly limit", color: "cyan", ...usage.weekly },
  ];
  const list = el("ul", { class: "usage-list" });
  for (const r of rows) {
    const pct = Math.min(100, Math.max(0, r.percent || 0));
    const full = pct >= 100;
    list.append(
      el("li", {}, [
        el("div", { class: "line" }, [
          el("span", { class: "left", text: r.label }),
          el("span", { class: "right", text: `${pct}% used` }),
        ]),
        el("div", { class: "bar-track" }, [
          el("div", { class: `bar-fill ${full ? "rose" : r.color}`, style: `width:${pct}%` }),
        ]),
        el("div", { class: "line", style: "margin-top:6px" }, [
          el("span", {
            class: "right",
            text: full
              ? `Limit reached · resets in ${humanDuration(r.resets_in_seconds)}`
              : `Resets in ${humanDuration(r.resets_in_seconds)}`,
          }),
        ]),
      ])
    );
  }
  clear(host);
  host.append(
    el("div", { class: "section-title" }, [
      el("div", { class: "icon-box", html: icon("planUsage", { width: 16, height: 16 }) }),
      el("h2", { text: "Plan usage" }),
    ]),
    el("p", { class: "field-hint", style: "margin: 4px 0 14px", text: "Shared across all models; deeper models use it faster. No upgrade, capacity restores when each window resets." }),
    list
  );
}

export async function renderSettings() {
  const { auth } = getAuth();

  const shell = await mountAppShell();
  shell.setActiveConversation(null);
  shell.setIncognitoActive?.(false);
  const host = shell.content;
  clear(host);

  const page = el("div", { class: "page-shell" });
  page.append(
    el("header", { class: "page-head" }, [
      el("h1", { html: "<em>Settings</em>" }),
      el("p", { text: "Your account and preferences." }),
    ])
  );

  // ----- Profile -----
  const nameValue = el("div", { class: "name", text: auth?.user?.name || "Guest" });
  const profileRow = el("div", { class: "profile-row" }, [
    avatar(auth?.user?.name, "lg", auth?.user?.avatar_url || null),
    el("div", { class: "who" }, [
      nameValue,
      el("div", { class: "email", text: auth?.user?.email || "Sign in to save your conversations." }),
      auth
        ? el("div", { class: "provider", text: `Signed in with ${auth.user?.provider === "google" ? "Google" : (auth.user?.provider || "OAuth")}` })
        : null,
    ]),
  ]);

  const profileChildren = [
    el("div", { class: "section-title" }, [
      el("div", { class: "icon-box", html: icon("userProfile", { width: 16, height: 16 }) }),
      el("h2", { text: "Profile" }),
    ]),
    profileRow,
  ];

  if (auth) {
    // Editable display name — overrides the OAuth name everywhere (sidebar,
    // avatar, this page). Stored locally; clearing reverts to the OAuth name.
    const nameInput = el("input", {
      class: "settings-input",
      type: "text",
      value: auth.user?.name || "",
      placeholder: auth.user?.base_name || "Your name",
      maxlength: "60",
      "aria-label": "What should we call you?",
    });
    const saveName = () => {
      const applied = setUserDisplayName(nameInput.value);
      const shown = applied || auth.user?.base_name || "";
      nameInput.value = shown;
      nameValue.textContent = shown || "Guest";
      toast("Saved", { tone: "success" });
    };
    nameInput.addEventListener("blur", saveName);
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); nameInput.blur(); }
    });
    profileChildren.push(
      el("div", { class: "settings-field" }, [
        el("label", { class: "field-label", text: "What should we call you?" }),
        nameInput,
        el("p", { class: "field-hint", text: "Shown across Bmo. Leave empty to use your account name." }),
      ])
    );
    profileChildren.push(
      el("div", { class: "settings-actions" }, [
        el("button", {
          type: "button",
          class: "btn ghost",
          onclick: async () => {
            await signOut();
            toast("Signed out", { tone: "success" });
            window.location.hash = "#/";
          },
          html: `${icon("logOut", { width: 14, height: 14 })} <span>Sign out</span>`,
        }),
        el("button", {
          type: "button",
          class: "btn danger",
          onclick: () => {
            openConfirmModal({
              title: "Delete account",
              message:
                "This permanently deletes your account, conversations, messages, and feedback. This cannot be undone.",
              confirmText: "Delete",
              cancelText: "Cancel",
              confirmPhrase: "DELETE",
              confirmPhraseLabel: "Type DELETE to confirm",
              danger: true,
              onConfirm: async () => {
                try {
                  await api.deleteAccount(auth.token);
                  await signOut();
                  tearDownShell();
                  toast("Account deleted", { tone: "warning" });
                  window.location.hash = "#/";
                } catch (err) {
                  toast(err.message || "Couldn't delete account", { tone: "error" });
                }
              },
            });
          },
          html: `${icon("delete", { width: 14, height: 14 })} <span>Delete account</span>`,
        }),
      ])
    );
  } else {
    profileChildren.push(
      el("div", { style: "margin-top:16px" }, [
        el("a", { class: "btn primary", href: "#/" }, [el("span", { text: "Sign in with Google" })]),
      ])
    );
  }

  page.append(el("div", { class: "settings-card glass" }, profileChildren));

  // ----- Preferences -----
  page.append(
    el("div", { class: "settings-card glass" }, [
      el("div", { class: "section-title" }, [
        el("div", { class: "icon-box", html: icon("preferences", { width: 16, height: 16 }) }),
        el("h2", { text: "Preferences" }),
      ]),
      el("div", { class: "settings-row" }, [
        el("div", { class: "row-text" }, [
          el("div", { class: "row-label", text: "Appearance" }),
          el("div", { class: "row-hint", text: "Match your system, or pick light or dark." }),
        ]),
        appearanceControl(),
      ]),
    ])
  );

  // ----- Plan usage (auth only; fills async, removes itself if metering is off) -----
  if (auth) {
    const usageCard = el("div", { class: "settings-card glass" });
    page.append(usageCard);
    renderUsageInto(usageCard, auth.token);
  }

  // ----- About -----
  page.append(
    el("div", { class: "settings-card glass" }, [
      el("div", { class: "section-title" }, [
        el("div", { class: "icon-box", html: icon("about", { width: 16, height: 16 }) }),
        el("h2", { text: "About Bmo" }),
      ]),
      el("p", { class: "footnote", text: "Bmo is a streaming AI chat workspace. Pick from multiple AI modes, attach images and documents, and talk by voice, all in one place." }),
    ])
  );

  host.append(page);
}
