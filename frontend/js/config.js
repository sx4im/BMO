// Bmo runtime configuration.
//
// Set the verified production gateway in deployment.js before publishing.
// Local development can override values in localStorage; production ignores
// browser overrides so stale settings cannot bypass the gateway.
//
// `apiUrl`          — Public Cloudflare API gateway URL.
// `supabaseUrl`     — Supabase project URL.
// `supabaseAnonKey` — Supabase anon (public) key — safe to ship to the browser.

import { deployment } from "./deployment.js";

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
  apiUrl: isLocalhost() ? "http://localhost:8000" : deployment.apiUrl,
  supabaseUrl: deployment.supabaseUrl,
  supabaseAnonKey: deployment.supabaseAnonKey,
};

function loadOverrides() {
  if (!isLocalhost()) return {};
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
    const value = loadOverrides().apiUrl || DEFAULTS.apiUrl;
    if (!isLocalhost()) {
      let url;
      try { url = new URL(value); } catch { throw new Error("Service is temporarily unavailable."); }
      if (url.protocol !== "https:" || url.hostname.endsWith(".onrender.com") || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
        throw new Error("Service is temporarily unavailable.");
      }
    }
    return trimUrl(value);
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
