import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { moduleLoader } from "./modules.mjs";

function apiApp() {
  let auth = { token: "original" };
  let refreshes = 0;
  const app = moduleLoader({
    "config.js": { config: { apiUrl: "https://test.invalid" } },
    "auth.js": { getAuth: () => ({ auth }), refreshSession: async () => { refreshes++; return auth = { token: "refreshed" }; } },
    "supabaseClient.js": { isSupabaseConfigured: () => false, supabaseClient() { throw Error("No network"); } },
  });
  return { ...app, refreshes: () => refreshes };
}

test("deployment CSP permits the actual Supabase import", async () => {
  const config = JSON.parse(await readFile(new URL("../../vercel.json", import.meta.url), "utf8"));
  const csp = config.headers.flatMap(row => row.headers).find(header => header.key === "Content-Security-Policy").value;
  const sources = csp.split(";").map(value => value.trim()).find(value => value.startsWith("script-src ")).split(/\s+/).slice(1);
  const source = await readFile(new URL("../js/supabaseClient.js", import.meta.url), "utf8");
  const sdk = source.match(/from "(https:[^"]+)"/)[1];
  assert.ok(sources.includes(new URL(sdk).origin));
});

test("all pages use one canonical URL for each stateful module", async () => {
  const urls = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) await visit(url);
      else if (entry.name.endsWith(".js")) {
        const text = await readFile(url, "utf8");
        for (const match of text.matchAll(/from\s+["']([^"']*(?:app-shell|auth|router|prefs|supabaseClient)\.js[^"']*)["']/g)) {
          const target = new URL(match[1], url);
          if (!urls.has(target.pathname)) urls.set(target.pathname, new Set());
          urls.get(target.pathname).add(target.href);
        }
      }
    }
  }
  await visit(new URL("../js/", import.meta.url));
  assert.equal(urls.size, 5);
  for (const [module, imports] of urls) assert.equal(imports.size, 1, `${module} has multiple instances`);
});

test("Chat and Projects reuse the same shell and teardown clears projects", async () => {
  const app = moduleLoader({
    "icons.js": { icon: () => "" }, "sidebar.js": { renderSidebar() {} },
    "chat-search.js": { openChatSearch() {} }, "toast.js": { toast() {} },
    "api.js": { listConversations: async () => [], listProjects: async () => [{ id: "p" }], getUsage: async () => ({}) },
    "auth.js": { getAuth: () => ({ auth: { token: "test", user: { id: "owner" } } }), signOut() {} },
    "router.js": { navigate() {} }, "prefs.js": { applyTheme() {} },
  });
  const paths = [];
  for (const file of ["chat", "projects"]) {
    const url = new URL(`../js/pages/${file}.js`, import.meta.url);
    const source = await readFile(url, "utf8");
    paths.push(new URL(source.match(/from "([^"]*app-shell\.js[^"]*)"/)[1], url).href);
  }
  const firstModule = await app.load(paths[0]);
  const first = await firstModule.mountAppShell();
  first.setShareActive(true, () => assert.fail("Stale chat share handler"));
  assert.equal(app.dom.window.document.querySelector(".mobile-share-btn").style.display, "inline-flex");
  const secondModule = await app.load(paths[1]);
  const second = await secondModule.mountAppShell();
  assert.equal(first.content, second.content);
  assert.equal(app.dom.window.document.querySelector(".mobile-share-btn").style.display, "none");
  app.dom.window.document.querySelector(".mobile-share-btn").click();
  assert.equal(app.dom.window.document.querySelector(".app-footer").textContent.trim(), "Built by Saim Shafique");
  await firstModule.loadProjects();
  assert.equal(firstModule.getShellState().projects.length, 1);
  firstModule.tearDownShell();
  assert.equal(secondModule.getShellState().projects, null);
});

test("project upload refreshes once and rejects a second 401", async () => {
  const app = apiApp();
  const requests = [];
  app.context.XMLHttpRequest = class {
    upload = {}; status = 401; responseText = '{"detail":"unauthorized"}';
    open() {} setRequestHeader(name, value) { if (name === "Authorization") this.authorization = value; }
    send() { requests.push(this.authorization); if (requests.length > 3) throw Error("Unbounded retries"); queueMicrotask(() => this.onload()); }
  };
  const api = await app.load("js/api.js");
  await assert.rejects(api.uploadProjectFileWithProgress("original", "project", {}, () => {}), { status: 401 });
  assert.deepEqual(requests, ["Bearer original", "Bearer refreshed"]);
  assert.equal(app.refreshes(), 1);
});

test("project upload timeout rejects rather than leaving a pending promise", async () => {
  const app = apiApp();
  app.context.XMLHttpRequest = class {
    upload = {}; open() {} setRequestHeader() {}
    send() { assert.ok(this.timeout > 0); queueMicrotask(() => this.ontimeout()); }
  };
  const api = await app.load("js/api.js");
  await assert.rejects(api.uploadProjectFileWithProgress("original", "project", {}, () => {}), /timed out/);
  assert.equal(app.refreshes(), 0);
});

test("archive option sends the backend's parameter", async () => {
  const app = apiApp();
  let requested;
  app.context.fetch = async url => { requested = url; return { ok: true, json: async () => [] }; };
  const api = await app.load("js/api.js");
  await api.listProjects("test", { includeArchived: true });
  assert.equal(new URL(requested).searchParams.get("archived"), "true");
});

test("gateway failure never publishes a direct fallback snapshot", async () => {
  const messages = Array.from({ length: 1105 }, (_, id) => ({ id: String(id), role: "user", content: `Message ${id}` }));
  const ranges = [];
  let snapshot;
  const client = { from(table) {
    const query = {
      select() { return this; }, eq() { return this; }, order() { return this; },
      range(start, end) { ranges.push([start, end]); return Promise.resolve({ data: messages.slice(start, end + 1) }); },
      upsert(value) { snapshot = value.snapshot; return this; },
      async single() { return { data: table === "conversations" ? { id: "chat", title: "Test", model: "thinking" } : { id: "share" } }; },
    };
    return query;
  } };
  const app = moduleLoader({
    "config.js": { config: { apiUrl: "https://test.invalid" } },
    "auth.js": { getAuth: () => ({ auth: { token: "test", user: { id: "owner" } } }), refreshSession() {} },
    "supabaseClient.js": { isSupabaseConfigured: () => true, supabaseClient: () => client },
  });
  app.context.fetch = async () => ({ ok: false, status: 503, json: async () => ({ detail: "Unavailable" }) });
  const api = await app.load("js/api.js");
  await assert.rejects(api.shareConversation("test", "chat"), { status: 503 });
  assert.equal(snapshot, undefined);
  assert.equal(ranges.length, 0);
  app.dom.window.close();
});

test("edits made during a save stay saveable and stale timers cannot disable them", async () => {
  const requests = [], timers = new Set();
  const app = moduleLoader({
    "icons.js": { icon: () => "" }, "file-icon.js": { FileIcon: () => "" },
    "toast.js": { toast() {} }, "confirm-modal.js": { openConfirmModal() {} },
    "api.js": { updateProject: (_token, _id, patch) => new Promise(resolve => { requests.push({ patch, resolve }); }) },
    "auth.js": { getAuth() {} }, "router.js": { navigate() {} },
    "app-shell.js": { mountAppShell() {}, loadConversations() {} },
  }, {
    append: { "projects.js": "\nexport { renderInstructionsCard };" },
    globals: { setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn) },
  });
  const projects = await app.load("js/pages/projects.js");
  const project = { id: "project", instructions: "" };
  const card = projects.renderInstructionsCard(project, { token: "test" });
  const input = card.querySelector("textarea"), save = card.querySelector("button");
  function edit(text) { input.value = text; input.dispatchEvent(new app.dom.window.Event("input")); }
  edit("First edit"); save.click();
  edit("Second edit");
  assert.equal(requests[0].patch.instructions, "First edit");
  requests[0].resolve({}); await new Promise(resolve => setImmediate(resolve));
  assert.equal(project.instructions, "First edit");
  assert.equal(save.disabled, false);
  save.click();
  for (const timer of [...timers]) timer();
  assert.equal(save.disabled, true);
  requests[1].resolve({}); await new Promise(resolve => setImmediate(resolve));
  assert.equal(project.instructions, "Second edit");
  edit("Third edit during the Saved display");
  for (const timer of [...timers]) timer();
  assert.equal(save.disabled, false);
});

test("Projects search shares the description row and still filters the list", async () => {
  const app = moduleLoader({
    "icons.js": { icon: () => "" }, "file-icon.js": { FileIcon: () => "" },
    "toast.js": { toast() {} }, "confirm-modal.js": { openConfirmModal() {} },
    "api.js": { listProjects: async () => [{ id: "one", name: "Claude code" }, { id: "two", name: "Research" }] },
    "auth.js": { getAuth() {} }, "router.js": { navigate() {} },
    "app-shell.js": { mountAppShell() {}, loadConversations() {} },
  }, { append: { "projects.js": "\nexport { renderProjectsList };" } });
  const page = await app.load("js/pages/projects.js");
  const host = app.dom.window.document.querySelector("#app");
  await page.renderProjectsList(host, { token: "test" });
  const input = host.querySelector("input[type=search]");
  assert.ok(input.closest(".projects-heading-row").querySelector("p").textContent.startsWith("Curate instructions"));
  input.value = "claude";
  input.dispatchEvent(new app.dom.window.Event("input"));
  assert.equal(host.querySelectorAll(".project-card").length, 1);
  assert.equal(host.querySelector(".project-card-title").textContent, "Claude code");
});

test("knowledge uploads show transfer progress, processing, and settle cleanly", async () => {
  const requests = [], notifications = [];
  const app = moduleLoader({
    "toast.js": { toast: (message) => notifications.push(message) },
    "confirm-modal.js": { openConfirmModal() {} },
    "api.js": { uploadProjectFileWithProgress: (_token, _id, file, progress) => new Promise((resolve, reject) => requests.push({ file, progress, resolve, reject })) },
    "auth.js": { getAuth() {} }, "router.js": { navigate() {} },
    "app-shell.js": { mountAppShell() {}, loadConversations() {} },
  }, { append: { "projects.js": "\nexport { renderFilesCard };" } });
  const page = await app.load("js/pages/projects.js");
  const card = page.renderFilesCard({ id: "project", files: [] }, { token: "test" });
  const input = card.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", { value: [{ name: "reference.pdf", size: 2048 }, { name: "failed.txt", size: 20 }] });
  input.dispatchEvent(new app.dom.window.Event("change"));
  assert.equal(requests.length, 2);
  const row = card.querySelector(".upload-progress-row");
  assert.equal(row.querySelector("svg text"), null);
  assert.equal(row.querySelector(".file-name").textContent, "reference.pdf");
  requests[0].progress(0.42);
  assert.equal(row.querySelector(".upload-progress-percent").textContent, "42%");
  assert.equal(row.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"), "42");
  requests[0].progress(1);
  assert.match(row.querySelector(".file-subtext").textContent, /Preparing knowledge/);
  assert.equal(row.querySelector(".upload-progress-percent").hidden, true);
  assert.equal(row.querySelector('[role="progressbar"]').hasAttribute("aria-valuenow"), false);
  assert.equal(card.querySelectorAll(".upload-progress-row").length, 2);
  requests[0].resolve({ file: { id: "file", filename: "reference.pdf", size_bytes: 2048, token_estimate: 40 }, tokens_used: 40 });
  requests[1].reject(Error("Upload unavailable"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(card.querySelectorAll(".upload-progress-row").length, 0);
  assert.equal(card.querySelectorAll(".project-file-list .project-file-item").length, 1);
  assert.match(card.querySelector(".token-meter-text").textContent, /^40 \/ /);
  assert.ok(notifications.includes("Upload unavailable"));
});

test("sidebar no longer renders Support", async () => {
  const app = moduleLoader({
    "router.js": { getRoute: () => ({ hash: "#/app/projects" }), navigate() {} },
    "auth.js": { getAuth: () => ({ auth: null }) },
    "confirm-modal.js": { openConfirmModal() {}, openPromptModal() {} },
    "share-modal.js": { openShareModal() {} },
    "projects.js": { openMoveChatModal() {}, openProjectModal() {} },
  });
  const sidebar = await app.load("js/components/sidebar.js");
  const host = app.dom.window.document.querySelector("#app");
  sidebar.renderSidebar(host, { conversations: [], projects: [], onNewChat() {}, onSelectConversation() {} });
  assert.equal(host.querySelector('[href="#/app/feedback"]'), null);
  assert.equal(/\bSupport\b/.test(host.textContent), false);
  assert.ok(host.querySelector('[href="#/app/projects"]'));
});

test("onboarding completes without a removed Support step", async () => {
  const saved = [];
  const app = moduleLoader({
    "prefs.js": { resolveTheme: () => "dark", setThemePref() {} },
    "api.js": { saveOnboarding: async (...args) => saved.push(args) },
  }, { globals: {
    setTimeout: (fn, milliseconds) => setTimeout(fn, milliseconds).unref(),
    requestAnimationFrame: fn => setTimeout(fn, 0).unref(),
  } });
  const onboarding = await app.load("js/components/onboarding.js");
  onboarding.showOnboarding({ token: "test" });
  const document = app.dom.window.document;
  const clickPrimary = () => document.querySelector(".ob-actions .btn.primary").click();
  clickPrimary();
  assert.match(document.querySelector(".ob-title").textContent, /birthday/i);
  const birthday = document.querySelector('input[type="date"]');
  birthday.value = "2000-01-01";
  birthday.dispatchEvent(new app.dom.window.Event("change"));
  clickPrimary();
  assert.equal(document.querySelector(".ob-title").textContent, "What do you do?");
  [...document.querySelectorAll("button")].find(button => button.textContent === "Developer").click();
  clickPrimary();
  assert.equal(document.querySelector(".ob-title").textContent, "Pick your look");
  assert.equal(document.querySelectorAll(".ob-dot").length, 4);
  clickPrimary();
  assert.match(document.querySelector(".ob-title").textContent, /What's new/);
  clickPrimary();
  assert.equal(document.querySelector("#onboarding"), null);
  assert.equal(saved.length, 1);
});

test("Settings separates cards and keeps appearance and usage controls", async () => {
  let app;
  const themes = [];
  const usage = { session: { percent: 29, resets_in_seconds: 120 }, weekly: { percent: 10, resets_in_seconds: 240 } };
  const state = { usage };
  app = moduleLoader({
    "icons.js": { icon: () => "" },
    "avatar.js": { avatar: () => app.dom.window.document.createElement("span") },
    "app-shell.js": { mountAppShell: async () => ({ content: app.dom.window.document.querySelector("#app"), setActiveConversation() {}, setIncognitoActive() {} }), tearDownShell() {}, getShellState: () => state },
    "auth.js": { getAuth: () => ({ auth: { token: "test", user: { id: "owner", name: "Saim", email: "user@example.invalid" } } }), signOut() {}, setUserDisplayName() {} },
    "prefs.js": { getThemePref: () => "light", setThemePref: value => themes.push(value) },
    "toast.js": { toast() {} }, "confirm-modal.js": { openConfirmModal() {} }, "api.js": { getUsage: async () => usage },
  });
  const { renderSettings } = await app.load("js/pages/settings.js");
  await renderSettings();
  await new Promise(resolve => setImmediate(resolve));
  const doc = app.dom.window.document;
  assert.equal(doc.querySelectorAll(".settings-card").length, 3);
  assert.deepEqual([...doc.querySelectorAll(".section-title h2")].map(n => n.textContent), ["Profile", "Preferences", "Plan usage"]);
  doc.querySelector('[title="Dark"]').click();
  assert.deepEqual(themes, ["dark"]);
  assert.equal(doc.querySelector('[title="Dark"]').getAttribute('aria-pressed'), 'true');
  assert.match(doc.querySelector('.usage-list').textContent, /29% used/);
});
