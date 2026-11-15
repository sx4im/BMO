import { defineRoute, startRouter, navigate, dispatch } from "./router.js";
import { bootstrap, getAuth, onAuthChange } from "./auth.js";
import { initThemeSync } from "./prefs.js";
import * as api from "./api.js?v=32";
import { renderLanding } from "./pages/landing.js?v=52";
import { renderChat } from "./pages/chat.js?v=200";
import { renderSettings } from "./pages/settings.js?v=78";
import { renderNotFound } from "./pages/not-found.js?v=54";
import { renderSharedChat } from "./pages/shared-chat.js?v=5";
import { renderProjects } from "./pages/projects.js";
import { renderCustomize } from "./pages/customize.js?v=9";
import { bootVersionGuard } from "./version-guard.js?v=1";


// ---------- route guards ----------

function requireAuth(handler) {
  return async (params) => {
    const { auth, bootstrapping } = getAuth();
    if (bootstrapping) return; // wait — onAuthChange will re-dispatch
    if (!auth) {
      navigate("#/", { replace: true });
      return;
    }
    return handler(params);
  };
}

function publicOnly(handler) {
  return async (params) => {
    const { auth, bootstrapping } = getAuth();
    if (bootstrapping) return;
    if (auth) {
      navigate("#/app/chat", { replace: true });
      return;
    }
    return handler(params);
  };
}

// ---------- routes ----------

defineRoute("#/", publicOnly(renderLanding));
defineRoute("#/app/chat", requireAuth(renderChat));
defineRoute("#/app/chat/incognito", requireAuth(() => renderChat({ incognito: true })));
defineRoute("#/app/chat/:id", requireAuth(renderChat));
defineRoute("#/app/projects", requireAuth(renderProjects));
defineRoute("#/app/projects/:id", requireAuth(renderProjects));
defineRoute("#/app/customize", requireAuth(renderCustomize));
defineRoute("#/app/settings", renderSettings);
defineRoute("#/share/:shareId", renderSharedChat);
defineRoute("*", renderNotFound);

// ---------- boot ----------



// Re-dispatch the current route whenever auth state settles so guards
// can resolve from the "bootstrapping" state to the right view. The
// landing URL has no hash, so re-dispatch unconditionally — relying on
// HashChangeEvent here would silently no-op on `localhost:5173/`.
let lastBootstrapping = true;
onAuthChange(async (s) => {
  if (lastBootstrapping && !s.bootstrapping) {
    lastBootstrapping = false;
    try {
      await dispatch();
    } catch {
      // ignore
    }
    const app = document.getElementById("app");
    app?.classList.add("app-enter");
  }
  if (!s.bootstrapping && s.auth) maybeShowOnboarding(s.auth);
});

// Check the release acknowledgment in the background, including after signup.
async function maybeShowOnboarding(auth) {
  try {
    const { hasSeenOnboarding, showOnboarding, syncOnboarding } = await import("./components/onboarding.js?v=32");
    if (hasSeenOnboarding(auth)) { void syncOnboarding(auth); return; }
    const profile = await api.me(auth.token).catch(() => null);
    if (getAuth().auth?.user?.id !== auth.user.id || hasSeenOnboarding(auth, profile)) return;
    showOnboarding(auth);
  } catch {
    /* Release notes must never block the app. */
  }
}

// The installed Android app always launches at "/", so reopen the last app
// screen instead of a blank new chat. Browser tabs keep the landing page.
const LAST_ROUTE_KEY = "bimo-last-route";
if (window.matchMedia("(display-mode: standalone)").matches) {
  const saved = localStorage.getItem(LAST_ROUTE_KEY);
  if ((!location.hash || location.hash === "#/") && saved?.startsWith("#/app/")) {
    history.replaceState(null, "", `${location.pathname}${location.search}${saved}`);
  }
  window.addEventListener("hashchange", () => {
    const { hash } = location;
    if (hash.startsWith("#/app/") && !hash.startsWith("#/app/chat/incognito")) {
      localStorage.setItem(LAST_ROUTE_KEY, hash);
    }
  });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

initThemeSync(); // sync <meta> + react to OS theme changes while on "system"
bootstrap();
startRouter();
bootVersionGuard(); // auto-reload idle tabs when a newer deploy exists



