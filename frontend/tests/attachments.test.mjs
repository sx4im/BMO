import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { FileIcon } from "../js/components/file-icon.js";
import { moduleLoader } from "./modules.mjs";

async function composerWithUpload(uploadAttachment) {
  const notifications = [];
  const stubs = {
    "api.js": { uploadAttachment },
    "auth.js": { getAuth: () => ({ auth: { token: "test" } }) },
    "toast.js": { toast: (message) => notifications.push(message) },
    "image-modal.js": { openImageModal() {} },
    "audio-wav.js": { blobToWav16kMono() {} },
  };
  const app = moduleLoader(stubs);
  const { Composer } = await app.load("js/chat/composer.js");
  const { dom } = app;
  const composer = Object.create(Composer.prototype);
  Object.assign(composer, {
    uploadingFiles: [], pendingAttachments: [],
    attachmentsBar: dom.window.document.createElement("div"),
    getAuthToken: () => "test", syncSendEnabled() {},
  });
  dom.window.document.body.append(composer.attachmentsBar);
  return { composer, notifications, dom };
}

test("all six document types transition from Uploading to their ready icon", async () => {
  let finishUpload;
  const { composer } = await composerWithUpload((_token, file, signal) => {
    assert.equal(signal.aborted, false);
    return new Promise(resolve => { finishUpload = () => resolve({ filename: file.name, content_type: file.type }); });
  });
  for (const ext of ["pdf", "pptx", "json", "md", "docx", "txt"]) {
    const file = { name: `reference.${ext}`, type: "application/octet-stream", size: 200 };
    const pending = composer.uploadAndAttach(file);
    const tile = composer.attachmentsBar.querySelector(".loading");
    assert.equal(tile.getAttribute("aria-busy"), "true");
    assert.equal(tile.querySelector(".name").textContent, file.name);
    assert.match(tile.querySelector("[role=status]").textContent, /Uploading/);
    assert.equal(tile.querySelector("svg.file-icon").getAttribute("aria-label"), `${ext.toUpperCase()} file`);
    finishUpload();
    await pending;
    assert.equal(composer.uploadingFiles.length, 0);
    assert.equal(composer.attachmentsBar.querySelector(".loading"), null);
    assert.match(composer.attachmentsBar.lastElementChild.textContent, /Ready/);
  }
  assert.equal(composer.pendingAttachments.length, 6);
});

test("cancelled uploads abort the request and cannot reappear after it resolves", async () => {
  let finishUpload, signal;
  const { composer, notifications } = await composerWithUpload((_token, file, uploadSignal) => {
    signal = uploadSignal;
    return new Promise(resolve => { finishUpload = () => resolve({ filename: file.name }); });
  });
  const upload = composer.uploadAndAttach({ name: "cancel.pdf", size: 200 });
  composer.attachmentsBar.querySelector("[aria-label='Cancel upload']").click();
  assert.equal(signal.aborted, true);
  finishUpload();
  await upload;
  assert.equal(composer.pendingAttachments.length, 0);
  assert.equal(composer.attachmentsBar.children.length, 0);
  assert.equal(notifications.length, 0);
});

test("failed uploads clear the loading tile and display an error", async () => {
  const { composer, notifications } = await composerWithUpload(async () => { throw Error("Upload unavailable"); });
  await composer.uploadAndAttach({ name: "error.docx", size: 200 });
  assert.equal(composer.attachmentsBar.children.length, 0);
  assert.equal(composer.pendingAttachments.length, 0);
  assert.deepEqual(notifications, ["Upload unavailable"]);
});

test("flat icons stay identical in both themes, with safe accessible labels", () => {
  const dom = new JSDOM();
  const colors = new Set();
  for (const ext of ["pdf", "pptx", "json", "md", "docx", "txt"]) {
    const light = FileIcon(ext, 36);
    dom.window.document.documentElement.dataset.theme = "dark";
    assert.equal(FileIcon(ext, 36), light);
    dom.window.document.body.innerHTML = light;
    const svg = dom.window.document.querySelector("svg");
    assert.equal(svg.getAttribute("aria-label"), `${ext.toUpperCase()} file`);
    assert.equal(svg.querySelector("text"), null);
    assert.equal(svg.querySelector("linearGradient, [id]"), null);
    const fill = svg.querySelector("path").getAttribute("fill");
    colors.add(fill);
    const rgb = fill.match(/[a-f0-9]{2}/gi).map(c => parseInt(c, 16) / 255);
    const [r, g, b] = rgb.map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    assert.ok(1.05 / (.2126 * r + .7152 * g + .0722 * b + .05) >= 4.5, `${ext} label contrast`);
  }
  assert.equal(colors.size, 6);
  dom.window.document.body.innerHTML = FileIcon('<img src=x onerror="alert(1)">');
  assert.equal(dom.window.document.querySelector("img, [onerror]"), null);
  assert.match(FileIcon(".PDF"), /PDF file/);
});
