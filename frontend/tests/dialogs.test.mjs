import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./modules.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));

for (const component of ["image", "search", "onboarding", "model"]) {
  test(`${component} overlay contains focus, restores its invoker and closes on navigation`, async t => {
    const app = moduleLoader({
      "prefs.js": { resolveTheme: () => "dark", setThemePref() {} },
      "api.js": { saveOnboarding: async () => ({}) },
    });
    t.after(() => app.dom.window.close());
    app.dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    const doc = app.dom.window.document;
    const invoker = doc.createElement("button"); doc.querySelector("#app").append(invoker); invoker.focus();
    if (component === "image") (await app.load("js/components/image-modal.js")).openImageModal("https://test.invalid/image.png", "Photo");
    if (component === "search") (await app.load("js/components/chat-search.js")).openChatSearch();
    if (component === "onboarding") (await app.load("js/components/onboarding.js")).showOnboarding({ token: "fixture" });
    if (component === "model") (await app.load("js/components/model-picker.js")).openModelPicker({ models: [{ id: "thinking" }] });
    const dialog = doc.querySelector('[role="dialog"]');
    assert.ok(dialog.contains(doc.activeElement));
    assert.ok(doc.querySelector("#app").hasAttribute("inert"));
    const labelled = dialog.getAttribute("aria-label") || doc.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent;
    assert.ok(labelled);
    (await app.load("js/components/dialog.js")).closeDialogs();
    assert.equal(doc.activeElement, invoker);
    assert.equal(doc.querySelector("#app").hasAttribute("inert"), false);
  });
}

function fixture(t, getShare = async () => ({ shared: false })) {
  const publications = [];
  const api = {
    getConversationShare: (...args) => getShare(...args),
    shareConversation: async (_token, id) => { publications.push(id); return { share_id: `share-${id}` }; },
    deleteConversationShare: async () => ({}),
  };
  const app = moduleLoader({ "api.js": api, "toast.js": { toast() {} } });
  t.after(() => app.dom.window.close());
  return { app, api, publications };
}

test("opening Share requires explicit publication and publishes once", async t => {
  const { app, publications } = fixture(t);
  const share = await app.load("js/components/share-modal.js");
  await share.openShareModal({ conversation: { id: "chat" }, token: "test" });
  assert.deepEqual(publications, []);
  const create = [...app.dom.window.document.querySelectorAll("button")].find(b => b.textContent === "Create public link");
  assert.ok(create, "Sharing must have an explicit Create public link action");
  create.focus();
  create.click(); create.click();
  await tick();
  assert.deepEqual(publications, ["chat"]);
  assert.match(app.dom.window.document.querySelector(".share-modal-input").value, /share-chat/);
  assert.equal(app.dom.window.document.activeElement, app.dom.window.document.querySelector(".share-modal-copy-btn"));
});

test("dismissing Share while metadata loads never publishes after dismissal", async t => {
  let resolve;
  const { app, publications } = fixture(t, () => new Promise(r => { resolve = r; }));
  const share = await app.load("js/components/share-modal.js");
  const pending = share.openShareModal({ conversation: { id: "chat" }, token: "test" });
  app.dom.window.document.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  resolve({ shared: false }); await pending;
  assert.deepEqual(publications, []);
});

test("share dialog has a name, contains focus, and restores its invoker", async t => {
  const { app } = fixture(t, async () => ({ shared: true, share_id: "shared" }));
  const doc = app.dom.window.document;
  const invoker = doc.createElement("button"); invoker.textContent = "Share";
  doc.querySelector("#app").append(invoker); invoker.focus();
  const share = await app.load("js/components/share-modal.js");
  await share.openShareModal({ conversation: { id: "chat" }, token: "test" });
  const dialog = doc.querySelector('[role="dialog"]');
  assert.equal(doc.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent, "Share link to chat");
  assert.equal(dialog.contains(doc.activeElement), true);
  assert.equal(doc.querySelector("#app").hasAttribute("inert"), true);
  const close = dialog.querySelector('[aria-label="Close"]');
  const last = dialog.querySelector(".share-modal-update-btn");
  last.focus();
  doc.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  assert.equal(doc.activeElement, close);
  close.focus();
  doc.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(doc.activeElement, last);
  doc.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(doc.querySelector("#app").hasAttribute("inert"), false);
  assert.equal(doc.activeElement, invoker);
});

test("an older revoke response cannot close a newer Share dialog", async t => {
  const { app, api } = fixture(t, async (_token, id) => ({ shared: true, share_id: `share-${id}` }));
  let resolve;
  api.deleteConversationShare = () => new Promise(r => { resolve = r; });
  const share = await app.load("js/components/share-modal.js");
  await share.openShareModal({ conversation: { id: "first" }, token: "test" });
  app.dom.window.document.querySelector(".share-modal-delete-btn").click();
  app.dom.window.document.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await share.openShareModal({ conversation: { id: "second" }, token: "test" });
  const second = [...app.dom.window.document.querySelectorAll(".share-modal-card")].at(-1);
  resolve({}); await tick();
  assert.equal(second.closest(".confirm-modal-overlay").classList.contains("open"), true);
});

test("sharing status failure has a retry without assuming the chat is unshared", async t => {
  let attempts = 0;
  const { app, publications } = fixture(t, async () => { if (++attempts === 1) throw Error("Temporarily unavailable"); return { shared: false }; });
  const share = await app.load("js/components/share-modal.js");
  await share.openShareModal({ conversation: { id: "chat" }, token: "test" });
  const retry = [...app.dom.window.document.querySelectorAll("button")].find(b => b.textContent === "Retry");
  assert.ok(retry);
  retry.click(); await tick();
  assert.equal(attempts, 2);
  assert.deepEqual(publications, []);
});

test("destructive confirm starts on Cancel and restores focus on Escape", async t => {
  const { app } = fixture(t);
  const doc = app.dom.window.document;
  const invoker = doc.createElement("button"); doc.querySelector("#app").append(invoker); invoker.focus();
  const confirm = await app.load("js/components/confirm-modal.js");
  confirm.openConfirmModal({ title: "Remove file", message: "Remove this file?", onConfirm() {} });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(doc.activeElement.textContent, "Cancel");
  doc.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(doc.activeElement, invoker);
});

test("project edit, move, and preview dialogs have names and keyboard dismissal", async t => {
  const app = moduleLoader({
    "api.js": { listProjects: async () => [], getProjectFilePreview: async () => ({ preview: "Text" }) },
    "auth.js": { getAuth() {} }, "router.js": { navigate() {} },
    "app-shell.js": { mountAppShell() {}, loadConversations() {} }, "toast.js": { toast() {} },
  }, { append: { "projects.js": "\nexport { openFilePreviewModal };" } });
  t.after(() => app.dom.window.close());
  const doc = app.dom.window.document;
  const invoker = doc.createElement("button"); doc.body.append(invoker);
  const projects = await app.load("js/pages/projects.js");
  const openings = [
    () => projects.openProjectModal({ auth: { token: "test" } }),
    () => projects.openMoveChatModal({ auth: { token: "test" }, conversation: { id: "chat", title: "Chat" } }),
    () => projects.openFilePreviewModal({ id: "project" }, { token: "test" }, { id: "file", filename: "notes.txt" }),
  ];
  for (const open of openings) {
    invoker.focus(); await open();
    const dialog = [...doc.querySelectorAll('[role="dialog"]')].at(-1);
    assert.ok(doc.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent);
    assert.equal(dialog.contains(doc.activeElement), true);
    doc.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(doc.activeElement, invoker);
    assert.equal(dialog.classList.contains("open"), false);
  }
});
