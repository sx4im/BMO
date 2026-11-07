import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./modules.mjs";

async function routerFixture(t) {
  const app = moduleLoader();
  t.after(() => app.dom.window.close());
  const router = await app.load("js/router.js");
  const go = async hash => { app.dom.window.history.replaceState(null, "", hash); await router.dispatch(); };
  return { app, router, go };
}

test("unknown routes reach the fallback without compiling the wildcard", async t => {
  const { app, router, go } = await routerFixture(t);
  router.defineRoute("#/app/chat", () => {});
  router.defineRoute("*", () => { app.dom.window.document.querySelector("#app").textContent = "Not found"; });
  await go("#/unknown");
  assert.equal(app.dom.window.document.querySelector("#app").textContent, "Not found");
});

test("route parameters exclude query strings and static route characters are literal", async t => {
  const { router, go } = await routerFixture(t);
  const found = [];
  router.defineRoute("#/chat/:id", params => found.push(params.id));
  router.defineRoute("#/version/1.0", () => found.push("version"));
  router.defineRoute("*", () => found.push("missing"));
  await go("#/chat/saved/?project_id=one");
  await go("#/chat/saved?project_id=one");
  await go("#/version/1x0");
  assert.deepEqual(found, ["saved", "saved", "missing"]);
});

test("a late route completion cannot lose the current page's cleanup", async t => {
  const { router, go } = await routerFixture(t);
  let resolve;
  const wait = new Promise(r => { resolve = r; });
  const cleaned = [];
  router.defineRoute("#/slow", async () => { await wait; return () => cleaned.push("slow"); });
  router.defineRoute("#/fast", () => () => cleaned.push("fast"));
  router.defineRoute("#/next", () => {});
  const slow = go("#/slow");
  await go("#/fast");
  resolve(); await slow;
  await go("#/next");
  assert.deepEqual(cleaned, ["slow", "fast"]);
});

test("page ownership is aborted on navigation and early cleanup runs once", async t => {
  const { router, go } = await routerFixture(t);
  let context, cleaned = 0;
  const cleanup = () => cleaned++;
  router.defineRoute("#/one", (_params, navigation) => { context = navigation; navigation?.onCleanup(cleanup); return cleanup; });
  router.defineRoute("#/two", () => {});
  await go("#/one");
  assert.ok(context?.signal, "Mounts need a navigation signal");
  assert.equal(context.isCurrent(), true);
  await go("#/two");
  assert.equal(context.signal.aborted, true);
  assert.equal(context.isCurrent(), false);
  assert.equal(cleaned, 1);
});

test("failed mounts have a recoverable page error instead of an unhandled rejection", async t => {
  const { app, router, go } = await routerFixture(t);
  let attempts = 0;
  router.defineRoute("#/page", () => { if (++attempts === 1) throw Error("Fixture failure"); app.dom.window.document.querySelector("#app").textContent = "Loaded"; });
  await go("#/page");
  assert.ok(app.dom.window.document.querySelector('[role="alert"]'));
  [...app.dom.window.document.querySelectorAll("button")].find(button => button.textContent === "Retry").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.dom.window.document.querySelector("#app").textContent, "Loaded");
});

test("a Projects mount that loses ownership while awaiting the shell cannot overwrite another page", async t => {
  let app, resolve;
  const shell = new Promise(r => { resolve = r; });
  app = moduleLoader({
    "auth.js": { getAuth: () => ({ auth: { token: "test", user: { id: "owner" } } }) },
    "api.js": { listProjects: async () => [] }, "router.js": { navigate() {} },
    "app-shell.js": { mountAppShell: () => shell, loadConversations() {} },
    "toast.js": { toast() {} },
  });
  t.after(() => app.dom.window.close());
  const root = app.dom.window.document.querySelector("#app");
  const page = await app.load("js/pages/projects.js");
  const controller = new AbortController();
  const mounting = page.renderProjects({}, { signal: controller.signal, isCurrent: () => !controller.signal.aborted });
  root.textContent = "Newer route"; controller.abort();
  resolve({ content: root, setActiveConversation() {}, setIncognitoActive() {} });
  await mounting;
  assert.equal(root.textContent, "Newer route");
});

test("session loss clears private views while token renewal preserves the current view", async t => {
  let app, listener;
  let state = { bootstrapping: true, auth: null };
  let renders = 0;
  const render = () => { renders++; app.dom.window.document.querySelector("#app").textContent = state.auth ? `Private ${state.auth.user.id}` : "Signed out"; };
  app = moduleLoader({
    "auth.js": {
      getAuth: () => state,
      onAuthChange: fn => { listener = fn; fn(state); },
      bootstrap: () => { state = { bootstrapping: false, auth: { token: "first", user: { id: "a" } } }; listener(state); },
    },
    "prefs.js": { initThemeSync() {} }, "api.js": { me: async () => ({}) },
    "app-shell.js": { tearDownShell() {} },
    "landing.js": { renderLanding: render }, "chat.js": { renderChat: render },
    "settings.js": { renderSettings: render }, "projects.js": { renderProjects: render },
    "customize.js": { renderCustomize: render }, "shared-chat.js": { renderSharedChat: render },
    "not-found.js": { renderNotFound: render }, "version-guard.js": { bootVersionGuard() {} },
  });
  t.after(() => app.dom.window.close());
  app.dom.window.matchMedia = () => ({ matches: false });
  app.dom.window.localStorage.setItem("bimo-onboarded-v6", "1");
  app.dom.window.history.replaceState(null, "", "#/app/chat");
  await app.load("js/main.js");
  await new Promise(resolve => setImmediate(resolve));
  assert.match(app.dom.window.document.querySelector("#app").textContent, /Private a/);
  const beforeRefresh = renders;
  state = { ...state, auth: { ...state.auth, token: "renewed" } }; await listener(state);
  assert.equal(renders, beforeRefresh);
  state = { bootstrapping: false, auth: null }; await listener(state);
  await new Promise(resolve => app.dom.window.setTimeout(resolve, 0));
  assert.equal(app.dom.window.document.querySelector("#app").textContent, "Signed out");
});

test("stale shell loads cannot replace newer data or repopulate a reset shell", async t => {
  const requests = [];
  const app = moduleLoader({
    "icons.js": { icon: () => "" }, "sidebar.js": { renderSidebar() {} },
    "chat-search.js": { openChatSearch() {} }, "toast.js": { toast() {} },
    "api.js": { listConversations: () => new Promise(resolve => requests.push(resolve)) },
    "auth.js": { getAuth: () => ({ auth: { token: "test", user: { id: "owner" } } }), signOut() {} },
    "router.js": { navigate() {} }, "prefs.js": { applyTheme() {} },
  });
  t.after(() => app.dom.window.close());
  const shell = await app.load("js/app-shell.js");
  const first = shell.loadConversations(), second = shell.loadConversations();
  requests[1]([{ id: "new" }]); await second;
  requests[0]([{ id: "old" }]); await first;
  assert.equal(shell.getShellState().conversations[0].id, "new");
  const pending = shell.loadConversations();
  shell.tearDownShell(); requests[2]([{ id: "previous-session" }]); await pending;
  assert.equal(shell.getShellState().conversations, null);
});

for (const [file, name] of [["settings", "renderSettings"], ["customize", "renderCustomize"]]) {
  test(`an obsolete ${file} mount cannot replace the current view`, async t => {
    let app;
    const controller = new AbortController();
    const state = {};
    app = moduleLoader({
      "auth.js": { getAuth: () => ({ auth: { token: "test", user: { id: "owner", name: "Owner" } } }), signOut() {}, setUserDisplayName() {} },
      "app-shell.js": {
        mountAppShell: async () => {
          const root = app.dom.window.document.querySelector("#app"); root.textContent = "Latest route"; controller.abort();
          return { content: root, setActiveConversation() {}, setIncognitoActive() {} };
        }, tearDownShell() {}, getShellState: () => state,
      },
      "prefs.js": { getThemePref: () => "dark", setThemePref() {} },
      "api.js": { getUsage: async () => ({ session: {}, weekly: {} }), getInstructions: async () => ({ instructions: "" }), listSkills: async () => [] },
      "toast.js": { toast() {} },
      "markdown.js": { whenMarkdownReady() {}, renderMarkdown: value => value, stripLeakedHighlightSpans: value => value },
    });
    t.after(() => app.dom.window.close());
    const page = await app.load(`js/pages/${file}.js`);
    await page[name]({}, { signal: controller.signal, isCurrent: () => !controller.signal.aborted });
    assert.equal(app.dom.window.document.querySelector("#app").textContent, "Latest route");
  });
}
