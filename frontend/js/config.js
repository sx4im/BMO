// Bmo runtime configuration.
//
// Hard-code production defaults below before deploying. During development or
// when pointing at a different Render / Supabase project, every value can be
// overridden at runtime via Settings → Environment (stored in localStorage).
//
// `apiUrl`          — Render Flask gateway URL (Bmo backend).
// `supabaseUrl`     — Supabase project URL.
// `supabaseAnonKey` — Supabase anon (public) key — safe to ship to the browser.

const STORAGE_KEY = "bimo-config";

function isLocalhost() {
  try {
    const host = window.location.hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

const DEFAULTS = {
  apiUrl: isLocalhost() ? "http://localhost:8000" : "https://bimo-backend-4a4g.onrender.com",
  supabaseUrl: "https://wrrxalkctbixtvjndptk.supabase.co",
  supabaseAnonKey: "sb_publishable_9bZYYsAy0L6bQb2PG83mJg_PNwDJXIw",
};

function loadOverrides() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    if (data.apiUrl && typeof data.apiUrl === "string" && data.apiUrl.includes("modal.run")) {
      delete data.apiUrl;
      save(data);
    }
    return data;
  } catch {
    return {};
  }
}


function save(overrides) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

function trimUrl(value) {
  return value ? value.trim().replace(/\/+$/, "") : value;
}

export const config = {
  get apiUrl() {
    return loadOverrides().apiUrl || DEFAULTS.apiUrl;
  },
  get supabaseUrl() {
    return loadOverrides().supabaseUrl || DEFAULTS.supabaseUrl;
  },
  get supabaseAnonKey() {
    return loadOverrides().supabaseAnonKey || DEFAULTS.supabaseAnonKey;
  },
  isSupabaseConfigured() {
    const url = this.supabaseUrl;
    const key = this.supabaseAnonKey;
    return Boolean(url && key && !url.includes("YOUR-") && !key.includes("YOUR_"));
  },
  setApiUrl(url) {
    const next = loadOverrides();
    if (url) next.apiUrl = trimUrl(url);
    else delete next.apiUrl;
    save(next);
  },
  setSupabase({ url, anonKey } = {}) {
    const next = loadOverrides();
    if (url !== undefined) {
      if (url) next.supabaseUrl = trimUrl(url);
      else delete next.supabaseUrl;
    }
    if (anonKey !== undefined) {
      if (anonKey) next.supabaseAnonKey = anonKey.trim();
      else delete next.supabaseAnonKey;
    }
    save(next);
  },
  reset() {
    localStorage.removeItem(STORAGE_KEY);
  },
  defaults: DEFAULTS,
};
