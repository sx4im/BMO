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

import { closeDialogs } from "./components/dialog.js";

const routes = [];
const listeners = new Set();
let controller = null;
let generation = 0;

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
  const segments = pattern.split("/").map(segment => /^:[A-Za-z_]\w*$/.test(segment)
    ? `(?<${segment.slice(1)}>[^/]+)`
    : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`^${segments.join("/")}$`);
  const match = hash.match(regex);
  if (!match) return null;
  return match.groups || {};
}

function findRoute(hash) {
  const clean = (hash.split("?")[0] || "").replace(/\/+$/, "") || "#/";
  for (const route of routes) {
    if (route.pattern === "*") continue;
    const params = matchPattern(route.pattern, clean);
    if (params != null) return { route, params };
  }
  return null;
}

export async function dispatch() {
  const current = ++generation;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const registered = new Set();
  const navigation = {
    signal,
    isCurrent: () => current === generation && !signal.aborted,
    onCleanup(fn) {
      if (typeof fn !== "function" || registered.has(fn)) return;
      registered.add(fn);
      const cleanup = () => {
        try { fn(); } catch (error) { console.error("Page cleanup failed:", error.name); }
      };
      if (signal.aborted) cleanup();
      else signal.addEventListener("abort", cleanup, { once: true });
    },
  };
  closeDialogs();
  const { hash } = getRoute();
  try {
    for (const fn of listeners) fn({ hash });
    const found = findRoute(hash);
    const route = found?.route || routes.find(r => r.pattern === "*");
    if (route) navigation.onCleanup(await route.handler(found?.params || {}, navigation));
  } catch (error) {
    if (!navigation.isCurrent() || error.name === "AbortError") return;
    console.error("Page mount failed:", error.name);
    const root = document.getElementById("app");
    if (!root) return;
    const message = document.createElement("p");
    message.setAttribute("role", "alert");
    message.textContent = "Could not open this page. Please try again.";
    const retry = document.createElement("button");
    retry.type = "button"; retry.className = "btn secondary"; retry.textContent = "Retry";
    retry.addEventListener("click", () => dispatch());
    root.replaceChildren(message, retry);
  }
}

export function startRouter() {
  window.addEventListener("hashchange", dispatch);
  dispatch();
}
