// Bmo local preferences — theme + display-name overrides, stored in
// localStorage (client-only, no backend). The pre-paint <script> in index.html
// reads the same THEME_KEY synchronously to set data-theme before first paint,
// so there's no light->dark flash; this module owns runtime changes.

const THEME_KEY = "bmo-theme";        // "dark" (default) | "system" | "light"
const NAME_KEY = "bmo-display-name";  // string override for the user's name

// ---------- theme ----------

export function getThemePref() {
  try {
    return localStorage.getItem(THEME_KEY) || localStorage.getItem("bimo-theme") || "dark";
  } catch {
    return "dark";
  }
}

function systemPrefersDark() {
  return Boolean(window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
}

// Resolve the user's choice ("system") down to the concrete "light"/"dark".
export function resolveTheme(pref = getThemePref()) {
  if (pref === "dark") return "dark";
  if (pref === "light") return "light";
  return systemPrefersDark() ? "dark" : "light";
}

// Apply to <html data-theme> and keep the address-bar theme-color in sync.
export function applyTheme(pref = getThemePref()) {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#151515" : "#faf9f5");
  return resolved;
}

export function setThemePref(pref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* ignore */
  }
  return applyTheme(pref);
}

// Re-resolve when the OS theme flips, but only while the user is on "system".
export function initThemeSync() {
  applyTheme();
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  mq?.addEventListener?.("change", () => {
    if (getThemePref() === "system") applyTheme("system");
  });
}

// ---------- display name ----------

export function getDisplayName() {
  try {
    return (localStorage.getItem(NAME_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function setDisplayName(name) {
  const value = (name || "").trim();
  try {
    if (value) localStorage.setItem(NAME_KEY, value);
    else localStorage.removeItem(NAME_KEY);
  } catch {
    /* ignore */
  }
  return value;
}
