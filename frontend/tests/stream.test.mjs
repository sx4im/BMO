import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./modules.mjs";

const event = (type, data) => `data: ${JSON.stringify({ type, data })}\n\n`;
async function client(t, source) {
  const app = moduleLoader({
    "config.js": { config: { apiUrl: "https://test.invalid" } },
    "auth.js": { getAuth: () => ({ auth: { token: "fixture" } }), refreshSession: async () => null },
  }, { globals: { TextDecoder } });
  t.after(() => app.dom.window.close());
  let released = 0, cancelled = 0;
  const chunks = [...source];
  app.context.fetch = async () => ({ ok: true, body: { getReader: () => ({
    read: async () => {
      const next = chunks.shift();
      if (next instanceof Error) throw next;
      return next === undefined ? { done: true } : { value: new TextEncoder().encode(next), done: false };
    },
    cancel: async () => { cancelled++; }, releaseLock: () => { released++; },
  }) } });
  return { ...(await app.load("js/api.js")), released: () => released, cancelled: () => cancelled };
}

for (const [name, chunks] of [
  ["empty", []], ["tokens only", [event("token", { delta: "Partial" })]],
  ["completion before persistence", [event("complete")]],
  ["reader error", [event("token", { delta: "Partial" }), Error("Connection lost")]],
]) {
  test(`saved stream rejects ${name} and releases its reader`, async t => {
    const api = await client(t, chunks);
    const errors = [];
    await assert.rejects(api.streamChat("fixture", {}, { onError: error => errors.push(error) }));
    assert.equal(errors.length, 1);
    assert.equal(api.cancelled(), 1);
    assert.equal(api.released(), 1);
  });
}

test("saved completion requires an assistant acknowledgement; incognito completion does not", async t => {
  const api = await client(t, [event("complete"), event("assistant_message", { id: "saved", content: "Answer" })]);
  assert.equal((await api.streamChat("fixture", {})).id, "saved");
  assert.equal(api.released(), 1);
  const incognito = await client(t, [event("token", { delta: "Private" }), event("complete")]);
  await incognito.streamChat("fixture", { incognito: true });
  assert.equal(incognito.released(), 1);
});

test("stream cancellation cannot deliver buffered late events", async t => {
  const api = await client(t, [event("token", { delta: "Late" }), event("complete")]);
  const controller = new AbortController(); controller.abort();
  let tokens = 0;
  await assert.rejects(api.streamChat("fixture", { incognito: true }, { signal: controller.signal, onToken: () => tokens++ }), { name: "AbortError" });
  assert.equal(tokens, 0);
});

test("streaming admission errors preserve their retry status", async t => {
  const api = await client(t, ['data: {"type":"error","status":429,"detail":"Allowance reached"}\n\n']);
  await assert.rejects(api.streamChat("fixture", {}), { status: 429, message: "Allowance reached" });
  assert.equal(api.cancelled(), 1);
  assert.equal(api.released(), 1);
});
