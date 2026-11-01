import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./modules.mjs";

const catalog = [
  { id: "one", name: "code-review", description: "Review code", enabled: true },
  { id: "two", name: "write-tests", description: "Test a feature", enabled: true },
  { id: "three", name: "summarize", description: "Summarize text", enabled: true },
  { id: "off", name: "disabled", description: "Hidden", enabled: false },
];

async function picker(options) {
  const app = moduleLoader();
  const { SkillPicker } = await app.load("js/chat/skill-picker.js");
  const textarea = app.dom.window.document.createElement("textarea");
  const picker = new SkillPicker(textarea, options);
  app.dom.window.document.body.append(textarea, picker.popup, picker.chips);
  picker.setCatalog(catalog);
  const type = value => { textarea.value = value; textarea.setSelectionRange(value.length, value.length); textarea.dispatchEvent(new app.dom.window.Event("input", { bubbles: true })); };
  const key = value => picker.handleKey(new app.dom.window.KeyboardEvent("keydown", { key: value, cancelable: true }));
  return { ...app, picker, textarea, type, key };
}

test("slash listbox supports filtering, arrows, Enter, Tab, Escape and removable chips", async t => {
  const app = await picker();
  t.after(() => app.picker.destroy());
  app.type("Please /");
  assert.equal(app.picker.popup.hidden, false);
  assert.equal(app.picker.popup.getAttribute("role"), "listbox");
  assert.equal(app.picker.popup.querySelectorAll('[role="option"]').length, 3);
  const textarea = app.textarea;
  app.key("ArrowDown");
  assert.equal(textarea.getAttribute("aria-activedescendant"), app.picker.popup.querySelectorAll('[role="option"]')[1].id);
  app.key("Enter");
  assert.equal(textarea.value, "Please ");
  assert.equal(app.picker.selected[0].name, "write-tests");
  assert.equal(app.picker.popup.hidden, true);
  assert.equal(app.dom.window.document.querySelector("textarea"), textarea);
  app.type("/code");
  assert.equal(app.picker.popup.querySelectorAll('[role="option"]').length, 1);
  app.key("Tab");
  assert.deepEqual(Array.from(app.picker.selectedIds), ["two", "one"]);
  app.type("/sum");
  app.key("Escape");
  assert.equal(app.picker.popup.hidden, true);
  assert.equal(textarea.value, "/sum");
  assert.equal(textarea.hasAttribute("aria-activedescendant"), false);
  app.picker.chips.querySelector('button[aria-label="Remove write-tests"]').click();
  assert.deepEqual(Array.from(app.picker.selectedIds), ["one"]);
});

test("touch selection, selection cap, URL slashes and untrusted labels stay safe", async t => {
  const app = await picker();
  t.after(() => app.picker.destroy());
  app.type("/");
  const option = app.picker.popup.querySelector('[role="option"]');
  const pointer = new app.dom.window.Event("pointerdown", { bubbles: true, cancelable: true });
  Object.defineProperty(pointer, "pointerType", { value: "touch" });
  option.dispatchEvent(pointer);
  assert.equal(pointer.defaultPrevented, true);
  option.click();
  assert.equal(app.picker.selected[0].id, "one");
  app.picker.setSelected(["one", "two", "three"]);
  app.type("/");
  assert.match(app.picker.popup.textContent, /Up to 3/);
  assert.equal(app.picker.popup.querySelector('[role="option"]'), null);
  app.type("https://example.com/");
  assert.equal(app.picker.popup.hidden, true);
  app.picker.setCatalog([{ id: "evil", name: "<img src=x onerror=alert(1)>", description: "<script>bad</script>", enabled: true }]);
  app.picker.setSelected([]);
  app.type("/");
  assert.equal(app.picker.popup.querySelector("img,script"), null);
  app.picker.popup.querySelector('[role="option"]').click();
  assert.equal(app.picker.chips.querySelector("img,script"), null);
  app.picker.destroy();
  app.type("/");
  assert.equal(app.picker.popup.hidden, true);
});

test("slash menu lists Add files first and keeps attachment selection available at the skill limit", async t => {
  let opened = 0;
  const app = await picker({ onAddFiles: () => opened++ });
  t.after(() => app.picker.destroy());
  app.type("/");
  const rows = app.picker.popup.querySelectorAll('[role="option"]');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].textContent, "Add files");
  assert.ok(rows[0].querySelector(".icon-attachFile"));
  assert.equal(rows[1].textContent, "code-review");
  assert.ok(rows[1].querySelector(".icon-filePenLine"));
  assert.equal(rows[1].getAttribute("aria-description"), "Review code");
  app.key("Enter");
  assert.equal(opened, 1);
  assert.equal(app.textarea.value, "");
  assert.equal(app.picker.selected.length, 0);
  app.picker.setSelected(["one", "two", "three"]);
  app.type("/");
  assert.equal(app.picker.popup.querySelectorAll('[role="option"]').length, 1);
  app.key("Tab");
  assert.equal(opened, 2);
  assert.equal(app.picker.selected.length, 3);
  app.type("/review");
  assert.equal(app.picker.popup.querySelector('[role="option"]'), null);
});

test("Customize tabs, instructions save races, skill editor and toggles update incrementally", async t => {
  let app, finishSave;
  const toggles = [], savedSkills = [], uploads = [], downloads = [];
  let exportType = "text/markdown";
  const api = {
    getInstructions: async () => ({ instructions: "Old preference" }),
    saveInstructions: (_token, text) => new Promise(resolve => { finishSave = () => resolve({ instructions: text }); }),
    listSkills: async () => catalog,
    setSkillEnabled: async (_token, id, enabled) => { toggles.push({ id, enabled }); return { ...catalog.find(s => s.id === id), enabled }; },
    createSkill: async (_token, value) => { savedSkills.push(value); return { ...value, enabled: true, id: "new" }; },
    uploadSkill: async (_token, file) => { uploads.push(file); return { id: "uploaded", name: "uploaded", description: "Valid skill", enabled: true }; },
    exportSkill: async () => ({ type: exportType }),
  };
  app = moduleLoader({
    "api.js": api,
    "auth.js": { getAuth: () => ({ auth: { token: "test", user: { id: "owner" } } }) },
    "app-shell.js": { mountAppShell: async () => ({ content: app.dom.window.document.querySelector("#app"), setActiveConversation() {}, setIncognitoActive() {} }) },
    "toast.js": { toast() {} }, "confirm-modal.js": { openConfirmModal() {} }, "export.js": { downloadBlob: (blob, filename) => downloads.push(filename) },
  });
  app.dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  app.dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const { renderCustomize } = await app.load("js/pages/customize.js");
  const cleanup = await renderCustomize();
  t.after(cleanup);
  await new Promise(resolve => setImmediate(resolve));
  const doc = app.dom.window.document;
  assert.equal(doc.querySelector(".customize-empty svg"), null);
  const textarea = doc.querySelector("#global-instructions");
  assert.equal(textarea.value, "Old preference");
  textarea.value = "First edit";
  textarea.dispatchEvent(new app.dom.window.Event("input"));
  const save = doc.querySelector(".customize-save-row button");
  save.click();
  textarea.value = "Second edit";
  textarea.dispatchEvent(new app.dom.window.Event("input"));
  finishSave();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(save.disabled, false);
  assert.match(doc.querySelector(".customize-status").textContent, /Unsaved/);
  doc.querySelector("#tab-skills").click();
  assert.ok(doc.querySelector(".skills-add summary .icon-plus"));
  assert.ok(doc.querySelector(".skills-add-menu button:first-child .icon-feather"));
  assert.ok(doc.querySelector(".skills-add-menu button:last-child .skill-upload-arrow"));
  assert.equal(doc.querySelector("#customize-instructions").hidden, true);
  assert.equal(doc.querySelector("#tab-skills").getAttribute("aria-selected"), "true");
  const preserved = doc.querySelectorAll(".skill-card")[1];
  doc.querySelector('[role="switch"]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(toggles, [{ id: "one", enabled: false }]);
  assert.equal(doc.querySelectorAll(".skill-card")[1], preserved);
  assert.equal(doc.querySelector("#global-instructions"), textarea);
  doc.querySelector(".skills-add-menu button").click();
  const dialog = doc.querySelector("dialog");
  const fields = dialog.querySelectorAll("input,textarea");
  fields[0].value = "new-skill"; fields[1].value = "Help with writing"; fields[2].value = "<script>text only</script>";
  dialog.querySelector("form").dispatchEvent(new app.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(savedSkills[0].instructions, "<script>text only</script>");
  assert.equal(doc.querySelector("dialog"), null);
  assert.equal(doc.querySelectorAll(".skill-card").length, 5);
  const upload = doc.querySelector('input[type="file"]');
  assert.equal(upload.accept, ".md");
  Object.defineProperty(upload, "files", { configurable: true, value: [{ name: "invalid.zip" }] });
  upload.dispatchEvent(new app.dom.window.Event("change"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(uploads.length, 0);
  assert.match(doc.querySelector(".skills-feedback.error").textContent, /Markdown \(\.md\)/);
  Object.defineProperty(upload, "files", { configurable: true, value: [{ name: "review.md" }] });
  upload.dispatchEvent(new app.dom.window.Event("change"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(uploads.length, 1);
  const exportButton = doc.querySelectorAll(".skill-card-actions button")[1];
  exportButton.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(downloads[0], "SKILL.md");
  exportType = "application/zip";
  exportButton.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(downloads[1], "code-review.zip");
});

test("sent messages render skill labels safely and use compact document icons", async () => {
  const app = moduleLoader({ "markdown.js": { renderMarkdown: text => text },
    "orb.js": { thoughtOrb() {}, searchOrb() {} } });
  const { messageBubble } = await app.load("js/components/message.js");
  const bubble = messageBubble({ message: { role: "user", content: "Review this", skills: [{ id: "one", name: "<img src=x>" }], attachments: [{ filename: "test.pptx" }] } });
  assert.equal(bubble.querySelector(".message-skill-chips").textContent, "/<img src=x>");
  assert.equal(bubble.querySelector("img"), null);
  assert.equal(bubble.querySelector(".file-chip svg").getAttribute("width"), "24");
  assert.equal(bubble.querySelector(".file-chip-name").textContent, "test.pptx");
});

test("editing a skill prefills both textareas and preserves references", async () => {
  let saved;
  const app = moduleLoader({ "api.js": { updateSkill: async (_token, _id, values) => { saved = values; return values; } },
    "auth.js": { getAuth() {} }, "app-shell.js": { mountAppShell() {} }, "toast.js": { toast() {} },
    "confirm-modal.js": { openConfirmModal() {} }, "export.js": { downloadBlob() {} } });
  app.dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  app.dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const { openSkillEditor } = await app.load("js/pages/customize.js");
  const close = openSkillEditor({ auth: { token: "test" }, skill: { id: "s", name: "review", description: "Existing description", instructions: "Existing instructions", files: [{ filename: "references/guide.md" }] }, onSaved() {} });
  const dialog = app.dom.window.document.querySelector("dialog");
  assert.equal(dialog.querySelectorAll("textarea")[0].value, "Existing description");
  assert.equal(dialog.querySelectorAll("textarea")[1].value, "Existing instructions");
  assert.match(dialog.textContent, /references\/guide.md/);
  dialog.querySelector("form").dispatchEvent(new app.dom.window.Event("submit", { cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved.instructions, "Existing instructions");
  assert.equal(saved.description, "Existing description");
  close();
});

test("skill upload keeps multipart headers and reports validation errors after token refresh", async () => {
  const calls = [];
  let currentToken = "old";
  const app = moduleLoader({ "config.js": { config: { apiUrl: "https://api.test" } },
    "auth.js": { getAuth: () => ({ auth: { token: currentToken } }), refreshSession: async () => ({ token: currentToken = "new" }) },
    "supabaseClient.js": { isSupabaseConfigured: () => false, supabaseClient() {} },
  });
  app.context.FormData = class { fields = []; append(...args) { this.fields.push(args); } };
  app.context.XMLHttpRequest = class {
    upload = {}; headers = {};
    open(method, url) { this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) {
      calls.push({ url: this.url, headers: this.headers, body });
      this.status = calls.length === 1 ? 401 : 422;
      this.responseText = JSON.stringify({ detail: calls.length === 1 ? "expired" : "Invalid YAML" });
      queueMicrotask(() => this.onload());
    }
  };
  const api = await app.load("js/api.js");
  await assert.rejects(api.uploadSkill("old", {}), error => error.status === 422 && error.message === "Invalid YAML");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers["Content-Type"], undefined);
  assert.equal(calls[1].headers.Authorization, "Bearer new");
  assert.deepEqual(calls[0].body.fields, calls[1].body.fields);
});

async function customizePage(api) {
  let app;
  app = moduleLoader({
    "api.js": { getInstructions: async () => ({ instructions: "" }), listSkills: async () => [], ...api },
    "auth.js": { getAuth: () => ({ auth: { token: "test", user: { id: "owner" } } }) },
    "app-shell.js": { mountAppShell: async () => ({ content: app.dom.window.document.querySelector("#app"), setActiveConversation() {}, setIncognitoActive() {} }) },
    "confirm-modal.js": { openConfirmModal() {} }, "export.js": { downloadBlob() {} },
    "toast.js": { toast() { assert.fail("Customize errors must stay inline"); } },
  });
  const page = await app.load("js/pages/customize.js");
  const cleanup = await page.renderCustomize();
  const doc = app.dom.window.document;
  return { ...app, doc, cleanup, selectFile(file) {
    const input = doc.querySelector('input[type="file"]');
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new app.dom.window.Event("change"));
  } };
}

test("skill uploads show real progress, preserve inline errors across list loading, and use metadata names", async t => {
  const requests = [];
  let finishList;
  const page = await customizePage({
    listSkills: () => new Promise(resolve => { finishList = resolve; }),
    uploadSkill: (_token, file, progress) => new Promise((resolve, reject) => requests.push({ file, progress, resolve, reject })),
  });
  t.after(page.cleanup);
  const { doc } = page;
  assert.equal(doc.body.textContent.includes("Upload .md skills with name and description"), false);
  page.selectFile({ name: "arbitrary-filename.md", size: 1024 });
  const progress = doc.querySelector(".skill-upload-progress");
  const track = progress.querySelector('[role="progressbar"]');
  assert.equal(progress.hidden, false);
  assert.equal(doc.querySelector(".skill-upload-name").textContent, "arbitrary-filename.md");
  requests[0].progress(0.42);
  assert.equal(track.getAttribute("aria-valuenow"), "42");
  assert.equal(doc.querySelector(".skill-upload-fill").style.width, "42%");
  requests[0].progress(1);
  assert.equal(track.hasAttribute("aria-valuenow"), false);
  assert.match(doc.querySelector(".skill-upload-stage").textContent, /Checking skill/);
  requests[0].reject(Error("description is required"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(progress.hidden, true);
  assert.equal(doc.querySelector(".skills-feedback.error").getAttribute("role"), "alert");
  assert.equal(doc.querySelector(".skills-feedback.error").textContent, "description is required");
  finishList([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.querySelector(".skills-feedback.error").textContent, "description is required");
  page.selectFile({ name: "renamed-download.md", size: 1024 });
  requests[1].resolve({ id: "new-id", name: "no-ai-slop", description: "Edit drafts with clear examples and preserve the writer's voice.", enabled: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.querySelector(".skill-card h3").textContent, "no-ai-slop");
  assert.equal(doc.querySelector(".skill-description").title, "Edit drafts with clear examples and preserve the writer's voice.");
  assert.equal(doc.querySelector(".skills-feedback.error"), null);
  assert.equal(doc.querySelector(".skills-feedback a").getAttribute("href"), "#/app/chat?skill_id=new-id");
  assert.equal(doc.querySelector(".skill-use-link").getAttribute("href"), "#/app/chat?skill_id=new-id");
});

test("instruction save errors persist and skill action errors render inside the card", async t => {
  const page = await customizePage({
    listSkills: async () => catalog,
    saveInstructions: async () => { throw Error("Save unavailable"); },
    setSkillEnabled: async () => { throw Error("Could not disable this skill"); },
  });
  t.after(page.cleanup);
  await new Promise(resolve => setImmediate(resolve));
  const input = page.doc.querySelector("#global-instructions");
  input.value = "Be concise";
  input.dispatchEvent(new page.dom.window.Event("input"));
  page.doc.querySelector(".customize-save-row button").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.doc.querySelector(".customize-status.error").textContent, "Save unavailable");
  assert.equal(page.doc.querySelector(".customize-status.error").getAttribute("role"), "alert");
  page.doc.querySelector('[role="switch"]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.doc.querySelector(".skill-card-error:not([hidden])").textContent, "Could not disable this skill");
  assert.equal(page.doc.querySelector('[role="switch"]').disabled, false);
});

test("skill upload transport reports bytes and the server-processing stage", async () => {
  let xhr;
  const progress = [];
  const app = moduleLoader({ "config.js": { config: { apiUrl: "https://api.test" } },
    "auth.js": { getAuth: () => ({ auth: { token: "test" } }), refreshSession() {} },
    "supabaseClient.js": { isSupabaseConfigured: () => false, supabaseClient() {} },
  });
  app.context.XMLHttpRequest = class {
    upload = {}; status = 201; responseText = '{"id":"s","name":"review"}';
    constructor() { xhr = this; }
    open(method, url) { assert.equal(url, "https://api.test/skills/upload"); }
    setRequestHeader() {} send() {}
  };
  const api = await app.load("js/api.js");
  const result = api.uploadSkill("test", {}, value => progress.push(value));
  xhr.upload.onprogress({ lengthComputable: true, loaded: 25, total: 100 });
  xhr.upload.onload();
  assert.deepEqual(progress, [0, 0.25, 1]);
  xhr.onload();
  assert.equal((await result).name, "review");
});

test("expired images refresh once in place and failures show a readable fallback", async () => {
  let renewals = 0;
  const app = moduleLoader({ "markdown.js": { renderMarkdown: text => text }, "orb.js": { thoughtOrb() {}, searchOrb() {} } });
  const { messageBubble } = await app.load("js/components/message.js");
  const attachment = { filename: "179170251214873170996683.png", path: "owner/photo", url: "https://old.invalid/image", content_type: "image/png" };
  const bubble = messageBubble({ message: { role: "user", content: "Explain this", attachments: [attachment] },
    onRefreshAttachment: async () => { renewals++; return "https://fresh.invalid/image"; } });
  app.dom.window.document.body.append(bubble);
  const img = bubble.querySelector("img");
  assert.equal(img.alt, "Attached image");
  img.dispatchEvent(new app.dom.window.Event("error"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(renewals, 1);
  assert.equal(bubble.querySelector("img"), img);
  assert.equal(img.src, "https://fresh.invalid/image");
  img.dispatchEvent(new app.dom.window.Event("error"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(renewals, 1);
  assert.equal(bubble.querySelector("img"), null);
  assert.match(bubble.querySelector(".image-unavailable").textContent, /Image unavailable/);
  assert.equal(bubble.textContent.includes("179170251214873170996683"), false);
});

test("Customize panels expose independent busy states and loading indicators", async t => {
  let finishInstructions, finishSkills;
  const page = await customizePage({
    getInstructions: () => new Promise(resolve => { finishInstructions = resolve; }),
    listSkills: () => new Promise(resolve => { finishSkills = resolve; }),
  });
  t.after(page.cleanup);
  assert.equal(page.doc.querySelector('#customize-instructions').getAttribute('aria-busy'), 'true');
  assert.equal(page.doc.querySelectorAll('.customize-loading .spinner-blade').length, 24);
  assert.equal(page.doc.querySelector('#customize-skills').getAttribute('aria-busy'), 'true');
  finishInstructions({ instructions: 'Read carefully' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.doc.querySelector('#customize-instructions').getAttribute('aria-busy'), 'false');
  assert.equal(page.doc.querySelector('#customize-instructions .customize-loading').hidden, true);
  assert.equal(page.doc.querySelector('#customize-skills').getAttribute('aria-busy'), 'true');
  finishSkills([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.doc.querySelector('#customize-skills').getAttribute('aria-busy'), 'false');
  assert.equal(page.doc.querySelector('.skills-load-status').textContent, '');
});
