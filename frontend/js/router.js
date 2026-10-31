/**
 * Hash-based router with regex routes. Keeps the URL bar usable without a
 * server-side rewrite — the whole frontend can be served as static files.
 *
 * Routes:
 *   #/                       — Landing
 *   #/app/chat               — Chat (new conversation)
 *   #/app/chat/:id           — Chat (existing conversation)
 *   #/app/settings           — Settings
 *   *                        — 404
 */

const routes = [];
const listeners = new Set();
let unmount = null;

export function defineRoute(pattern, handler) {
  routes.push({ pattern, handler });
}

export function navigate(hash, { replace = false } = {}) {
  if (!hash.startsWith("#")) hash = `#${hash}`;
  if (location.hash === hash) {
    dispatch();
    return;
  }
  if (replace) location.replace(hash);
  else location.hash = hash;
}

export function getRoute() {
  const hash = location.hash || "#/";
  return { hash };
}

export function onRouteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function matchPattern(pattern, hash) {
  // Convert "#/app/chat/:id" into a regex that captures :params.
  const regex = new RegExp(
    "^" +
      pattern.replace(/:[A-Za-z_][\w]*/g, (m) => `(?<${m.slice(1)}>[^/]+)`).replace(/\//g, "\\/") +
      "$"
  );
  const match = hash.match(regex);
  if (!match) return null;
  return match.groups || {};
}

function findRoute(hash) {
  const clean = (hash.split("?")[0] || "").replace(/\/+$/, "") || "#/";
  for (const route of routes) {
    const params = matchPattern(route.pattern, hash) ?? matchPattern(route.pattern, clean);
    if (params != null) return { route, params };
  }
  return null;
}

export async function dispatch() {
  const { hash } = getRoute();
  for (const fn of listeners) fn({ hash });
  const found = findRoute(hash);
  if (!found) {
    // Fallback to the 404 route (registered last via `*`).
    const wildcard = routes.find((r) => r.pattern === "*");
    if (wildcard) {
      if (typeof unmount === "function") {
        try { unmount(); } catch (err) { console.warn("Router unmount error:", err); }
      }
      unmount = await wildcard.handler({});
    }
    return;
  }
  if (typeof unmount === "function") {
    try { unmount(); } catch (err) { console.warn("Router unmount error:", err); }
  }
  unmount = await found.route.handler(found.params);
}

export function startRouter() {
  window.addEventListener("hashchange", dispatch);
  dispatch();
}
