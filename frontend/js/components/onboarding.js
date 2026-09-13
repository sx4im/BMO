// "What's new in BMO 5" — a one-time, blocking onboarding modal.
//
// Shown once per user (tracked by profiles.onboarding_seen in Supabase, with a
// localStorage backstop). The overlay covers the whole app so the background
// isn't usable until the user finishes or picks "Not now". Survey answers
// (birthday, role) are saved to Supabase; the theme choice is local (prefs.js).

import { el, clear } from "../utils.js?v=30";
import { icon } from "../icons.js?v=30";
import { resolveTheme, setThemePref } from "../prefs.js?v=32";
import { saveOnboarding } from "../api.js?v=30";

// Bump the version suffix to re-show the onboarding to everyone (no DB reset).
const SEEN_KEY = "bimo-onboarded-v6";
const ROLES = ["Developer", "Designer", "Student", "Researcher", "Writer", "Marketer"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function hasSeenOnboarding() {
  // Gated on the versioned localStorage key only, so bumping SEEN_KEY restarts
  // the flow for everyone regardless of the (v1) DB onboarding_seen flag.
  return localStorage.getItem(SEEN_KEY) === "1";
}

const pad2 = (n) => String(n).padStart(2, "0");
const daysInMonth = (y, m) => new Date(y, m, 0).getDate(); // m is 1-12

// One endless scroll-snap wheel column (alarm-picker feel). The value list is
// rendered repeated REPS times so it reads as a loop (December above January,
// January below December, etc.); after the user stops scrolling we silently
// jump back to the middle copy — invisible because every copy is identical.
// Calls onPick(value) when the centered item settles.
const ITEM_H = 40;
function wheelColumn(values, label, initialIndex, onPick, onInteract) {
  const L = values.length;
  const REPS = Math.max(7, Math.ceil(600 / L)); // ~600 items → fling can't reach the ends
  const MID = Math.floor(REPS / 2);

  const col = el("div", { class: `ob-wheel-col ob-col-${label.toLowerCase()}`, role: "listbox", "aria-label": label });
  col.append(el("div", { class: "ob-wheel-pad" }));
  const items = [];
  for (let r = 0; r < REPS; r++) {
    for (let i = 0; i < L; i++) {
      const it = el("div", { class: "ob-wheel-item", text: String(values[i]) });
      items.push(it);
      col.append(it);
    }
  }
  col.append(el("div", { class: "ob-wheel-pad" }));

  let ready = false, snapping = false, lastAbs = -1;
  const absNow = () => Math.round(col.scrollTop / ITEM_H);
  const valIndex = () => ((absNow() % L) + L) % L;
  // only the single centered item is emphasized (O(1) per scroll, no per-frame
  // loop over every copy)
  const highlight = () => {
    const abs = absNow();
    if (abs === lastAbs) return;
    items[lastAbs]?.classList.remove("sel");
    items[abs]?.classList.add("sel");
    lastAbs = abs;
  };
  const recenter = () => {
    const targetAbs = MID * L + valIndex();
    if (absNow() === targetAbs) return;
    snapping = true;                       // mute the scroll event the jump fires
    col.scrollTop = targetAbs * ITEM_H;
    items[lastAbs]?.classList.remove("sel");
    items[targetAbs]?.classList.add("sel");
    lastAbs = targetAbs;
    setTimeout(() => { snapping = false; }, 60);
  };

  let t;
  col.addEventListener("scroll", () => {
    if (snapping) return;
    highlight();
    if (!ready) return;
    onInteract();
    clearTimeout(t);
    t = setTimeout(() => { onPick(values[valIndex()]); recenter(); }, 120);
  });

  // Slow, deliberate mouse-wheel/trackpad stepping: one eased row per notch,
  // throttled so a fast flick can't blur through years. Touch keeps native
  // momentum (it already feels right on mobile).
  let wheelLock = false;
  col.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (wheelLock) return;
    wheelLock = true;
    col.scrollBy({ top: (e.deltaY > 0 ? 1 : -1) * ITEM_H, behavior: "smooth" });
    setTimeout(() => { wheelLock = false; }, 220); // slower, deliberate stepping
  }, { passive: false });

  // Jump to a value index (used by the typed date field to drive the wheel).
  col.setTo = (index) => {
    const targetAbs = MID * L + (((index % L) + L) % L);
    snapping = true;
    col.scrollTop = targetAbs * ITEM_H;
    items[lastAbs]?.classList.remove("sel");
    items[targetAbs]?.classList.add("sel");
    lastAbs = targetAbs;
    setTimeout(() => { snapping = false; }, 60);
  };

  requestAnimationFrame(() => {
    col.scrollTop = (MID * L + initialIndex) * ITEM_H;
    highlight();
    setTimeout(() => { ready = true; }, 150);
  });
  return col;
}

export function showOnboarding(auth) {
  if (document.getElementById("onboarding")) return; // never double-mount

  const state = { birthday: "", role: "", roleOther: "" };
  let step = 0;

  const card = el("div", { class: "ob-card" });
  const overlay = el("div", { id: "onboarding", class: "ob-overlay", role: "dialog", "aria-modal": "true" }, [card]);

  document.body.append(overlay);
  const prevOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = "hidden";

  function close() {
    document.documentElement.style.overflow = prevOverflow;
    overlay.remove();
  }

  async function finish() {
    // ponytail: localStorage flag is a client backstop so a backend hiccup
    // (or a not-yet-applied migration) can't re-nag the user on this device.
    localStorage.setItem(SEEN_KEY, "1");
    close();
    try {
      await saveOnboarding(auth.token, {
        birthday: state.birthday || "",
        role: state.role === "Other" ? state.roleOther.trim() || "Other" : state.role,
      });
    } catch {
      /* best-effort; the flag above already prevents a re-nag */
    }
  }

  const go = (n) => { step = n; render(); };

  // ---- steps ----

  function intro() {
    return [
      el("img", { class: "ob-confetti", src: "/assets/celebration.png", alt: "", "aria-hidden": "true" }),
      el("h2", { class: "ob-title", text: "Bmo 5 is here" }),
      el("p", { class: "ob-sub", text: "A few new things to show you, plus two quick questions. About 30 seconds." }),
      el("div", { class: "ob-actions" }, [
        el("button", { type: "button", class: "btn ghost", text: "Not now", onclick: finish }),
        el("button", { type: "button", class: "btn primary", text: "Yes, show me", onclick: () => go(1) }),
      ]),
    ];
  }

  function birthday() {
    const now = new Date();
    const years = [];
    for (let y = 1970; y <= now.getFullYear(); y++) years.push(y); // start at 1970, ascending
    const days = Array.from({ length: 31 }, (_, i) => i + 1);

    // seed from a prior value or a neutral default; only written once touched.
    let [yy, mm, dd] = (state.birthday || "2005-01-01").split("-").map(Number);
    let touched = Boolean(state.birthday);
    const clampedDay = () => Math.min(dd, daysInMonth(yy, mm));
    const asISO = () => `${yy}-${pad2(mm)}-${pad2(clampedDay())}`;
    const commit = () => { if (touched) state.birthday = asISO(); };
    // Continue is disabled until the user actually picks a date (wheel or typed).
    const continueBtn = el("button", { type: "button", class: "btn primary", text: "Continue", onclick: () => go(2) });
    const interact = () => { touched = true; continueBtn.disabled = false; };
    continueBtn.disabled = !touched;

    // Manual entry: a native date field above the wheel (precise typing, as in v1).
    const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const dateInput = el("input", {
      class: "settings-input ob-birthday-input", type: "date",
      min: "1970-01-01", max: today, value: state.birthday || "",
      "aria-label": "Date of birth",
    });
    const syncInput = () => { if (touched) dateInput.value = asISO(); };

    const monthCol = wheelColumn(MONTHS, "Month", mm - 1, (v) => { mm = MONTHS.indexOf(v) + 1; commit(); syncInput(); }, interact);
    const dayCol = wheelColumn(days, "Day", dd - 1, (v) => { dd = v; commit(); syncInput(); }, interact);
    const yearCol = wheelColumn(years, "Year", Math.max(0, years.indexOf(yy)), (v) => { yy = v; commit(); syncInput(); }, interact);

    // Typed date drives the wheels so the two never disagree.
    dateInput.addEventListener("change", () => {
      if (!dateInput.value) return;
      const [ny, nm, nd] = dateInput.value.split("-").map(Number);
      yy = ny; mm = nm; dd = nd; touched = true; commit();
      continueBtn.disabled = false;
      monthCol.setTo(mm - 1);
      dayCol.setTo(dd - 1);
      yearCol.setTo(years.indexOf(yy));
    });

    return [
      el("h2", { class: "ob-title", text: "When's your birthday?" }),
      el("p", { class: "ob-sub", text: "Type it in or spin the wheel to continue." }),
      el("div", { class: "ob-birthday-field" }, [dateInput]),
      el("div", { class: "ob-wheel" }, [
        el("div", { class: "ob-wheel-band", "aria-hidden": "true" }),
        monthCol, dayCol, yearCol,
      ]),
      el("div", { class: "ob-actions" }, [
        el("button", { type: "button", class: "btn ghost", text: "Back", onclick: () => go(0) }),
        continueBtn,
      ]),
    ];
  }

  function role() {
    // Continue is disabled until a role is chosen (and the "Other" text is filled).
    const continueBtn = el("button", { type: "button", class: "btn primary", text: "Continue", onclick: () => go(3) });
    const valid = () => Boolean(state.role) && (state.role !== "Other" || state.roleOther.trim().length > 0);
    const sync = () => { continueBtn.disabled = !valid(); };

    const otherInput = el("input", {
      class: "settings-input", type: "text", placeholder: "Tell us what you do", maxlength: "40",
      value: state.roleOther, style: state.role === "Other" ? "margin-top:10px" : "display:none",
    });
    otherInput.addEventListener("input", () => { state.roleOther = otherInput.value; sync(); });

    const grid = el("div", { class: "ob-roles" });
    const btns = {};
    for (const r of [...ROLES, "Other"]) {
      const b = el("button", {
        type: "button",
        class: `ob-chip ${state.role === r ? "active" : ""}`,
        text: r,
        onclick: () => {
          state.role = r;
          for (const [k, node] of Object.entries(btns)) node.classList.toggle("active", k === r);
          otherInput.style.display = r === "Other" ? "block" : "none";
          if (r === "Other") otherInput.focus();
          sync();
        },
      });
      btns[r] = b;
      grid.append(b);
    }
    sync();

    return [
      el("h2", { class: "ob-title", text: "What do you do?" }),
      el("p", { class: "ob-sub", text: "Pick the one closest to how you'll use Bmo." }),
      el("div", { class: "ob-field" }, [grid, otherInput]),
      el("div", { class: "ob-actions" }, [
        el("button", { type: "button", class: "btn ghost", text: "Back", onclick: () => go(1) }),
        continueBtn,
      ]),
    ];
  }

  function feedbackNote() {
    return [
      el("div", { class: "ob-icon", html: icon("bug", { width: 26, height: 26 }) }),
      el("h2", { class: "ob-title", text: "Found a bug?" }),
      el("p", { class: "ob-sub", text: "If something looks off, open Support in the sidebar and send a quick report. A screenshot helps, and it reaches the team directly." }),
      el("div", { class: "ob-actions" }, [
        el("button", { type: "button", class: "btn ghost", text: "Back", onclick: () => go(2) }),
        el("button", { type: "button", class: "btn primary", text: "Got it", onclick: () => go(4) }),
      ]),
    ];
  }

  function theme() {
    let current = resolveTheme(); // resolved light/dark, so "system" highlights the real theme
    const tiles = {};
    function pick(id) {
      current = id;
      setThemePref(id); // live preview
      for (const [k, node] of Object.entries(tiles)) node.classList.toggle("active", k === id);
    }
    const tile = (id, lbl, ic) =>
      (tiles[id] = el("button", {
        type: "button", class: `ob-theme-tile ${current === id ? "active" : ""}`,
        onclick: () => pick(id),
        html: `<span class="ic">${icon(ic, { width: 22, height: 22 })}</span><span>${lbl}</span>`,
      }));

    return [
      el("h2", { class: "ob-title", text: "Pick your look" }),
      el("p", { class: "ob-sub", text: "You can switch this anytime in Settings." }),
      el("div", { class: "ob-themes" }, [tile("light", "Light", "sun"), tile("dark", "Dark", "moon")]),
      el("div", { class: "ob-actions" }, [
        el("button", { type: "button", class: "btn ghost", text: "Back", onclick: () => go(3) }),
        el("button", { type: "button", class: "btn primary", text: "Continue", onclick: () => go(5) }),
      ]),
    ];
  }

  function whatsNew() {
    const feature = (ic, title, desc) =>
      el("div", { class: "ob-feature" }, [
        el("div", { class: "ob-feature-ic", html: icon(ic, { width: 20, height: 20 }) }),
        el("div", {}, [
          el("div", { class: "ob-feature-title", text: title }),
          el("div", { class: "ob-feature-desc", text: desc }),
        ]),
      ]);
    return [
      el("h2", { class: "ob-title", text: "What's new in Bmo 5" }),
      el("div", { class: "ob-features" }, [
        feature("image", "Image generation", "Describe an image and Bmo creates it, right inside the chat."),
        feature("globe", "Web search", "Bmo automatically searches the live web whenever an answer needs fresh information."),
        feature("mic", "Voice assistant", "Speak to Bmo and hear it answer back, fully hands-free."),
      ]),
      el("div", { class: "ob-note" }, [
        el("span", { class: "ic", html: icon("info", { width: 16, height: 16 }) }),
        el("span", { text: "To keep Bmo fast on limited server compute, we've added usage limits. You'll find them under Settings, Plan usage." }),
      ]),
      el("div", { class: "ob-actions" }, [
        el("button", { type: "button", class: "btn primary wide", text: "Start using Bmo", onclick: finish }),
      ]),
    ];
  }

  const STEPS = [intro, birthday, role, feedbackNote, theme, whatsNew];

  function render() {
    clear(card);
    if (step > 0) {
      const dots = el("div", { class: "ob-dots" });
      for (let i = 1; i < STEPS.length; i++) {
        dots.append(el("span", { class: `ob-dot ${i === step ? "active" : i < step ? "done" : ""}` }));
      }
      card.append(dots);
    }
    card.append(...STEPS[step]());
    card.classList.remove("ob-in");
    void card.offsetWidth; // restart the entrance animation
    card.classList.add("ob-in");
  }

  render();
}
