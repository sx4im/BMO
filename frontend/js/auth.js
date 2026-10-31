// BMO auth — Supabase session wrapper.
//
// All authentication goes through Supabase Google OAuth. Supabase persists the
// session itself (storageKey "bimo-auth"), so this module just normalises the
// session into the shape the rest of the app expects (`{ token, user }`).

import { supabaseClient, isSupabaseConfigured } from "./supabaseClient.js";
import { getDisplayName, setDisplayName } from "./prefs.js";

const listeners = new Set();

let state = {
  auth: null,            // { token, user }
  bootstrapping: true,
  configured: isSupabaseConfigured(),
};

function emit() {
  for (const fn of listeners) fn(state);
}

function set(partial) {
  state = { ...state, ...partial };
  emit();
}

function userFromSession(session) {
  if (!session) return null;
  const u = session.user || {};
  const meta = u.user_metadata || {};
  const idData = (Array.isArray(u.identities) && u.identities[0]?.identity_data) || {};

  // base_name is the OAuth-derived name; `name` applies the local override (if
  // any) so the whole app shows the user's chosen name. Clearing the override
  // reverts to base_name.
  let baseName =
    meta.full_name ||
    meta.name ||
    idData.full_name ||
    idData.name ||
    meta.user_name ||
    idData.user_name ||
    meta.preferred_username ||
    idData.preferred_username ||
    meta.nickname ||
    idData.nickname ||
    meta.given_name ||
    idData.given_name ||
    "";

  if (!baseName && u.email) {
    let emailPrefix = u.email.split("@")[0];
    if (emailPrefix.includes("+")) {
      emailPrefix = emailPrefix.split("+")[1] || emailPrefix;
    }
    baseName = emailPrefix;
  }

  const avatarUrl =
    meta.avatar_url ||
    meta.picture ||
    idData.avatar_url ||
    idData.picture ||
    null;

  const provider =
    u.app_metadata?.provider ||
    (Array.isArray(u.identities) && u.identities[0]?.provider) ||
    "google";

  return {
    token: session.access_token,
    expires_at: session.expires_at,
    user: {
      id: u.id,
      email: u.email,
      name: getDisplayName() || baseName,
      base_name: baseName,
      avatar_url: avatarUrl,
      provider: provider,
    },
  };
}

// Persist a local display-name override and re-emit so the sidebar, settings,
// and avatar update immediately. Client-only (localStorage). Pass "" to clear.
export function setUserDisplayName(name) {
  const value = setDisplayName(name);
  if (state.auth?.user) {
    const user = { ...state.auth.user, name: value || state.auth.user.base_name };
    set({ auth: { ...state.auth, user } });
  }
  return value;
}

// Fast-path read of the session Supabase persists in localStorage. Used as the
// fallback when getSession() stalls (its navigator lock can hang when a request
// in another tab never releases it) so a logged-in user still mounts the app
// instead of being trapped on the boot splash.
function persistedSession() {
  try {
    const raw = localStorage.getItem("bimo-auth");
    if (!raw) return null;
    const p = JSON.parse(raw);
    const s = p?.access_token ? p : p?.currentSession || p?.session || null;
    return s?.access_token ? s : null;
  } catch {
    return null;
  }
}

export function onAuthChange(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export function getAuth() {
  return state;
}

export function isConfigured() {
  return isSupabaseConfigured();
}

export async function bootstrap() {
  if (!isSupabaseConfigured()) {
    set({ auth: null, bootstrapping: false, configured: false });
    return;
  }
  let supabase;
  try {
    supabase = supabaseClient();
  } catch {
    set({ auth: null, bootstrapping: false, configured: false });
    return;
  }
  try {
    // getSession() can hang indefinitely on Supabase's navigator lock (a stuck
    // request in another tab never releases it), which would trap the boot
    // splash forever. Cap it: if it doesn't answer in 5s, fall back to the
    // session persisted in localStorage so the app still mounts.
    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve({ data: { session: persistedSession() } }), 5000)
    );
    const { data } = await Promise.race([supabase.auth.getSession(), timeout]);
    set({
      auth: userFromSession(data.session),
      bootstrapping: false,
      configured: true,
    });
  } catch {
    set({ auth: null, bootstrapping: false, configured: true });
  }
  supabase.auth.onAuthStateChange((_event, session) => {
    set({ auth: userFromSession(session) });
  });
  setupTabFocusRefresh();
}

let lastRefreshAttempt = 0;

let refreshPromise = null;

export async function refreshSession() {
  if (!isSupabaseConfigured()) return null;
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const supabase = supabaseClient();
      const { data, error } = await supabase.auth.refreshSession();
      if (error) {
        console.error("[bimo-auth] refreshSession failed:", error);
        set({ auth: null });
        throw error;
      }
      const authState = userFromSession(data.session);
      set({ auth: authState });
      return authState;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

function setupTabFocusRefresh() {
  const handleFocusOrVisibility = async () => {
    const now = Date.now();
    if (now - lastRefreshAttempt < 2000) return;

    if (document.visibilityState === "visible") {
      const authState = state.auth;
      if (!authState || !authState.expires_at) return;

      const currentSeconds = Math.floor(now / 1000);
      if (currentSeconds >= authState.expires_at - 300) {
        lastRefreshAttempt = now;
        console.info("[bimo-auth] Tab visible/focused and token near expiry. Refreshing session...");
        try {
          await refreshSession();
          console.info("[bimo-auth] Tab focus session refresh succeeded.");
        } catch (err) {
          console.warn("[bimo-auth] Tab focus session refresh failed:", err);
        }
      }
    }
  };

  window.addEventListener("visibilitychange", handleFocusOrVisibility);
  window.addEventListener("focus", handleFocusOrVisibility);
}

export async function signInWithGoogle() {
  const supabase = supabaseClient();
  const redirectTo = `${window.location.origin}${window.location.pathname}#/app/chat`;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo,
      queryParams: { access_type: "offline", prompt: "consent" },
    },
  });
  if (error) throw error;
  return data;
}

export async function signInWithGithub() {
  const supabase = supabaseClient();
  const redirectTo = `${window.location.origin}${window.location.pathname}#/app/chat`;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: {
      redirectTo,
    },
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  try {
    if (isSupabaseConfigured()) {
      const supabase = supabaseClient();
      await supabase.auth.signOut();
    }
  } catch {
    /* ignore */
  }
  set({ auth: null });
}
