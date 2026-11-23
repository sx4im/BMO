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
    activeAttachmentUploads: 0, attachmentUploadQueue: [],
    attachmentOrder: new WeakMap(), nextAttachmentOrder: 0,
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

test("a draft accepts six images across pending selections and keeps document slots separate", async () => {
  const inFlight = [];
  const { composer, notifications } = await composerWithUpload((_token, file) => new Promise(resolve => {
    inFlight.push({ file, finish: () => resolve({ filename: file.name, content_type: file.type }) });
  }));
  const images = Array.from({ length: 7 }, (_, i) => ({
    name: `image-${i}.bmp`, type: "application/octet-stream", size: 20,
  }));
  const first = composer.uploadFiles(images.slice(0, 4));
  const second = composer.uploadFiles([...images.slice(4), { name: "notes.pdf", size: 20 }]);
  assert.deepEqual(inFlight.map(({ file }) => file.name), images.slice(0, 2).map(file => file.name));
  assert.equal(composer.uploadingFiles.length, 7);
  assert.deepEqual(notifications, ["You can attach up to 6 images per message"]);
  for (let start = 0; start < 7; start += 2) {
    assert.equal(inFlight.length, Math.min(start + 2, 7));
    inFlight.slice(start).reverse().forEach(({ finish }) => finish());
    await new Promise(setImmediate);
  }
  await Promise.all([first, second]);
  assert.deepEqual(Array.from(composer.pendingAttachments, a => a.filename),
    [...images.slice(0, 6).map(file => file.name), "notes.pdf"]);

  await composer.uploadFiles(images.slice(6));
  assert.equal(inFlight.length, 7);
  composer.attachmentsBar.querySelector("[aria-label='Remove attachment']").click();
  const replacement = composer.uploadFiles(images.slice(6));
  inFlight.at(-1).finish();
  await replacement;
  assert.equal(composer.pendingAttachments.length, 7);
});

test("image uploads use a square loading tile and an accessible preview without document labels", async () => {
  let finishUpload;
  const { composer } = await composerWithUpload(() => new Promise(resolve => { finishUpload = resolve; }));
  const upload = composer.uploadAndAttach({ name: "diagram.png", type: "image/png", size: 20 });
  const loading = composer.attachmentsBar.firstElementChild;
  assert.equal(loading.matches(".composer-image-attachment.loading[aria-busy=true]"), true);
  assert.equal(loading.querySelector(".attachment-info"), null);
  assert.match(loading.querySelector("[role=status]").textContent, /Uploading diagram.png/);
  finishUpload({ filename: "diagram.png", content_type: "image/png", url: "https://example.invalid/diagram.png" });
  await upload;
  const ready = composer.attachmentsBar.firstElementChild;
  assert.equal(ready.matches(".composer-image-attachment:not(.loading)"), true);
  assert.equal(ready.querySelector(".attachment-info"), null);
  assert.equal(ready.querySelector("button[aria-label='Preview diagram.png'] img").alt, "diagram.png");
  ready.querySelector("[aria-label='Remove attachment']").click();
  assert.equal(composer.attachmentsBar.childElementCount, 0);
});

test("canceling a queued image prevents its network upload", async () => {
  const requests = [];
  const { composer } = await composerWithUpload((_token, file) => new Promise(resolve => {
    requests.push({ filename: file.name, resolve });
  }));
  const pending = composer.uploadFiles(["one", "two", "three"].map(name => ({
    name: `${name}.png`, type: "image/png", size: 20,
  })));
  composer.attachmentsBar.querySelectorAll("[aria-label='Cancel upload']")[2].click();
  for (const { filename, resolve } of requests) resolve({ filename });
  await pending;
  assert.deepEqual(requests.map(request => request.filename), ["one.png", "two.png"]);
  assert.equal(composer.uploadingFiles.length, 0);
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
