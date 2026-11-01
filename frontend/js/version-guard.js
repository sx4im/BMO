/* Build-version guard.
 *
 * Problem this solves: Bmo is a fully client-side SPA. Once index.html +
 * the module graph are loaded, the app runs from memory forever — a user
 * who leaves the tab (or an iOS PWA) open across a deploy keeps executing
 * the OLD build indefinitely, seeing bugs that were already fixed and
 * blaming the (correct) new deploy.
 *
 * Mechanism: index.html carries its build timestamp in
 * <meta name="bmo-build" content="..."> (a meta tag, not an inline
 * script — CSP forbids inline JS). Because index.html is served
 * no-store, every cold load sees the freshest id. This module remembers
 * the id it booted with, periodically re-fetches "/" with caching
 * disabled, and if the served id is NEWER, reloads the page — but only
 * when the app is idle (tab visible AND no stream painting), so a
 * response is never interrupted mid-generation.
 */

const CHECK_INTERVAL_MS = 90 * 1000;
const FIRST_CHECK_DELAY_MS = 45 * 1000;

// Capture the build id THIS module-graph instance booted from, at import
// time — before anything can navigate or rewrite the head.
const BOOT_BUILD_ID = readServedBuildId();

function readServedBuildId() {
  if (typeof document === "undefined") return null; // non-browser (tests)
  const meta = document.querySelector('meta[name="bmo-build"], meta[name="bimo-build"]');
  const raw = meta && meta.content ? String(meta.content).trim() : "";
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** Extract the build id from fetched index.html text. Exported for tests. */
export function parseBuildId(html) {
  const m = /<meta\s+name=["'](?:bmo|bimo)-build["']\s+content=["'](\d+)["']/i.exec(html || "");
  return m ? Number.parseInt(m[1], 10) : null;
}

function streamInProgress() {
  // A live streaming bubble means tokens are painting right now.
  return Boolean(document.querySelector('.streaming-bubble[data-streaming="true"]'));
}

async function checkForNewerBuild() {
  try {
    const res = await fetch(`/?nocache=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!res.ok) return;
    const served = parseBuildId(await res.text());
    if (!served || !BOOT_BUILD_ID) return;
    if (served <= BOOT_BUILD_ID) return;

    if (document.hidden || streamInProgress()) {
      // Busy — defer; the next tick retries until the app is quiet.
      console.info(`[version-guard] build ${served} available; waiting for idle to reload`);
      return;
    }
    console.info(`[version-guard] build ${served} > booted ${BOOT_BUILD_ID} — reloading`);
    location.reload();
  } catch {
    /* offline or transient network issue — silently retry next tick */
  }
}

/** Start the periodic guard. Safe to call once per app boot. */
export function bootVersionGuard() {
  if (!BOOT_BUILD_ID) {
    console.warn("[version-guard] no bimo-build meta tag — guard disabled");
    return;
  }
  setTimeout(() => {
    checkForNewerBuild();
    setInterval(checkForNewerBuild, CHECK_INTERVAL_MS);
  }, FIRST_CHECK_DELAY_MS);
}
