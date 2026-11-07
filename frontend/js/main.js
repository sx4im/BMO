import { defineRoute, startRouter, navigate, dispatch } from "./router.js";
import { bootstrap, getAuth, onAuthChange } from "./auth.js";
import { initThemeSync } from "./prefs.js";
import * as api from "./api.js?v=65";
import { renderLanding } from "./pages/landing.js?v=52";
import { renderChat } from "./pages/chat.js?v=185";
import { renderSettings } from "./pages/settings.js?v=79";
import { renderNotFound } from "./pages/not-found.js?v=54";
import { renderSharedChat } from "./pages/shared-chat.js?v=5";
import { renderProjects } from "./pages/projects.js";
import { renderCustomize } from "./pages/customize.js?v=10";
import { bootVersionGuard } from "./version-guard.js?v=1";
import { tearDownShell } from "./app-shell.js";


// ---------- route guards ----------

function requireAuth(handler) {
  return async (params, navigation) => {
    const { auth, bootstrapping } = getAuth();
    if (bootstrapping) return; // wait — onAuthChange will re-dispatch
    if (!auth) {
      navigate("#/", { replace: true });
      return;
    }
    return handler(params, navigation);
  };
}

function publicOnly(handler) {
  return async (params, navigation) => {
    const { auth, bootstrapping } = getAuth();
    if (bootstrapping) return;
    if (auth) {
      navigate("#/app/chat", { replace: true });
      return;
    }
    return handler(params, navigation);
  };
}

// ---------- routes ----------

defineRoute("#/", publicOnly(renderLanding));
defineRoute("#/app/chat", requireAuth(renderChat));
defineRoute("#/app/chat/incognito", requireAuth((_params, navigation) => renderChat({ incognito: true }, navigation)));
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
let lastUserId = null;
onAuthChange(async (s) => {
  const userId = s.auth?.user?.id || null;
  const settled = lastBootstrapping && !s.bootstrapping;
  const identityChanged = !s.bootstrapping && !lastBootstrapping && userId !== lastUserId;
  lastBootstrapping = s.bootstrapping;
  lastUserId = userId;
  if (settled || identityChanged) {
    if (identityChanged) tearDownShell();
    try {
      await dispatch();
    } catch {
      // ignore
    }
    const app = document.getElementById("app");
    app?.classList.add("app-enter");
    if (s.auth) maybeShowOnboarding(s.auth); // one-time "What's new in Bmo 5"
  }
});

// Show the onboarding / "What's new" modal once per onboarding version. The
// key carries a version (bimo-onboarded-vN) so bumping it re-shows the updated
// flow to EVERYONE — existing and new — with no DB reset. We still call /me so
// the profile row exists before any survey answers are saved. Lazy-loaded so it
// never weighs on the critical boot path.
async function maybeShowOnboarding(auth) {
  const isCurrent = () => getAuth().auth?.user?.id === auth.user?.id;
  try {
    if (localStorage.getItem("bimo-onboarded-v6") === "1") return;
    await api.me(auth.token).catch(() => {});
    if (!isCurrent()) return;
    const { showOnboarding } = await import("./components/onboarding.js?v=32");
    if (!isCurrent()) return;
    showOnboarding(auth);
  } catch {
    /* never block the app if the check fails */
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



