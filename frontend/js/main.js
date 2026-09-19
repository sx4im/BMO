import { defineRoute, startRouter, navigate, dispatch } from "./router.js?v=31";
import { bootstrap, getAuth, onAuthChange } from "./auth.js?v=31";
import { initThemeSync } from "./prefs.js?v=32";
import * as api from "./api.js?v=32";
import { renderLanding } from "./pages/landing.js?v=50";
import { renderChat } from "./pages/chat.js?v=161";
import { renderFeedback } from "./pages/feedback.js?v=70";
import { renderSettings } from "./pages/settings.js?v=73";
import { renderNotFound } from "./pages/not-found.js?v=54";
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
defineRoute("#/app/feedback", requireAuth(renderFeedback));
defineRoute("#/app/settings", renderSettings);
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
    if (s.auth) maybeShowOnboarding(s.auth); // one-time "What's new in BMO 5"
  }
});

// Show the onboarding / "What's new" modal once per onboarding version. The
// key carries a version (bimo-onboarded-vN) so bumping it re-shows the updated
// flow to EVERYONE — existing and new — with no DB reset. We still call /me so
// the profile row exists before any survey answers are saved. Lazy-loaded so it
// never weighs on the critical boot path.
async function maybeShowOnboarding(auth) {
  try {
    if (localStorage.getItem("bimo-onboarded-v6") === "1") return;
    await api.me(auth.token).catch(() => {});
    const { showOnboarding } = await import("./components/onboarding.js?v=31");
    showOnboarding(auth);
  } catch {
    /* never block the app if the check fails */
  }
}

initThemeSync(); // sync <meta> + react to OS theme changes while on "system"
bootstrap();
startRouter();
bootVersionGuard(); // auto-reload idle tabs when a newer deploy exists



