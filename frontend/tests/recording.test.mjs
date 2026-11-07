import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./modules.mjs";

async function recording(t, { convert, permission } = {}) {
  const calls = [], recorders = [], timers = new Map();
  let stopped = 0, now = 0;
  const stream = { getTracks: () => [{ stop: () => stopped++ }] };
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(_stream, options) { this.mimeType = options?.mimeType; this.handlers = {}; this.state = "inactive"; recorders.push(this); }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.handlers.dataavailable({ data: new Blob(["fixture audio"]) });
      this.pending = this.handlers.stop();
    }
  }
  const app = moduleLoader({
    "auth.js": { getAuth: () => ({ auth: { token: "fixture", user: { id: "owner" } } }) },
    "api.js": { transcribeAudio: async (...args) => { calls.push(args); return { text: "Late transcription" }; } },
    "audio-wav.js": { blobToWav16kMono: convert || (async blob => blob) },
    "toast.js": { toast() {} },
  }, { globals: { Blob, MediaRecorder: Recorder,
    Date: class extends Date { static now() { return now; } },
    setInterval: callback => { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearInterval: id => timers.delete(id),
  } });
  Object.defineProperty(app.dom.window.navigator, "mediaDevices", { value: { getUserMedia: permission || (async () => stream) }, configurable: true });
  const { Composer } = await app.load("js/chat/composer.js");
  const composer = new Composer({ getAuthToken: () => "fixture" });
  app.dom.window.document.querySelector("#app").append(composer.element);
  t.after(() => { composer.destroy(); app.dom.window.close(); });
  return { composer, app, calls, recorders, stream, stopped: () => stopped,
    advance: milliseconds => { now += milliseconds; for (const callback of [...timers.values()]) callback(); } };
}

test("leaving the page while microphone permission is pending cannot start recording", async t => {
  let allow;
  const page = await recording(t, { permission: () => new Promise(resolve => { allow = resolve; }) });
  const pending = page.composer.startVoiceRecording();
  page.composer.destroy(); allow(page.stream); await pending;
  assert.equal(page.recorders.length, 0);
  assert.equal(page.stopped(), 1);
});

test("leaving the page while audio conversion is pending cannot start transcription", async t => {
  let finish;
  const page = await recording(t, { convert: () => new Promise(resolve => { finish = resolve; }) });
  await page.composer.startVoiceRecording();
  const recorder = page.recorders[0]; recorder.stop();
  page.composer.destroy(); finish(new Blob(["fixture wav"], { type: "audio/wav" })); await recorder.pending;
  assert.equal(page.calls.length, 0);
});

test("destroying a recording discards it instead of uploading it", async t => {
  const page = await recording(t);
  await page.composer.startVoiceRecording();
  const recorder = page.recorders[0]; page.composer.destroy(); await recorder.pending;
  assert.equal(page.calls.length, 0);
});

test("voice notes stop before the server's sixty-second duration ceiling", async t => {
  const page = await recording(t);
  await page.composer.startVoiceRecording();
  page.advance(59000);
  assert.equal(page.recorders[0].state, "inactive");
  await page.recorders[0].pending;
});
