import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./modules.mjs";

async function projectFixture(t) {
  let previews = 0, confirmations = 0;
  const app = moduleLoader({
    "api.js": { getProjectFilePreview: async () => { previews++; return { preview: "Reference text" }; } },
    "auth.js": { getAuth() {} }, "router.js": { navigate() {} },
    "app-shell.js": { mountAppShell() {}, loadConversations() {} }, "toast.js": { toast() {} },
    "confirm-modal.js": { openConfirmModal() { confirmations++; } },
  }, { append: { "projects.js": "\nexport { renderFilesCard, renderChatsCard };" } });
  t.after(() => app.dom.window.close());
  return { app, projects: await app.load("js/pages/projects.js"), previews: () => previews, confirmations: () => confirmations };
}

test("project knowledge has a reachable native upload action", async t => {
  const { projects } = await projectFixture(t);
  const card = projects.renderFilesCard({ id: "project", files: [] }, { token: "test" });
  const upload = card.querySelector('button[aria-label="Add files to project knowledge"]');
  assert.ok(upload, "Keyboard users need a native upload button");
  assert.equal(upload.tabIndex, 0);
  let opened = 0;
  card.querySelector('input[type="file"]').click = () => opened++;
  upload.click();
  assert.equal(opened, 1);
});

test("each existing project chat is a native link that preserves its destination", async t => {
  const { projects } = await projectFixture(t);
  const card = projects.renderChatsCard({ id: "project", conversations: [{ id: "chat", title: "Research" }] });
  const link = card.querySelector('a[href="#/app/chat/chat"]');
  assert.ok(link, "Project conversations must support keyboard and native link actions");
  assert.equal(link.tabIndex, 0);
  assert.match(link.textContent, /Research/);
});

test("Remove file keyboard events cannot activate its Preview action", async t => {
  const { app, projects, previews, confirmations } = await projectFixture(t);
  const card = projects.renderFilesCard({ id: "project", files: [{ id: "file", filename: "notes.txt", size_bytes: 10 }] }, { token: "test" });
  app.dom.window.document.body.append(card);
  const remove = card.querySelector('.file-delete-btn');
  for (const key of ["Enter", " "]) {
    const event = new app.dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    remove.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, "Native Remove activation must not be swallowed by the row");
    assert.equal(previews(), 0);
  }
  remove.click();
  assert.equal(confirmations(), 1);
  assert.equal(previews(), 0);
  const preview = card.querySelector('button[aria-label="Preview notes.txt"]');
  assert.ok(preview);
  preview.click();
  assert.equal(previews(), 1);
});
