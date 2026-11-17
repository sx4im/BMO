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
let navigation = null;

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
    if (route.pattern === "*") continue;
    const params = matchPattern(route.pattern, hash) ?? matchPattern(route.pattern, clean);
    if (params != null) return { route, params };
  }
  return null;
}

export async function dispatch() {
  navigation?.abort();
  const owner = new AbortController();
  navigation = owner;
  const previousUnmount = unmount;
  unmount = null;
  if (typeof previousUnmount === "function") {
    try { previousUnmount(); } catch (err) { console.warn("Router unmount error:", err); }
  }
  const { hash } = getRoute();
  for (const fn of listeners) fn({ hash });
  if (owner.signal.aborted) return;
  const found = findRoute(hash);
  const route = found?.route || routes.find(r => r.pattern === "*");
  if (!route) return;
  const cleanup = await route.handler(found?.params || {}, { signal: owner.signal });
  if (owner.signal.aborted) {
    if (typeof cleanup === "function") {
      try { cleanup(); } catch (err) { console.warn("Router unmount error:", err); }
    }
    return;
  }
  unmount = cleanup;
}

export function startRouter() {
  window.addEventListener("hashchange", dispatch);
  dispatch();
}
