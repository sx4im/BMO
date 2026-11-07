import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./modules.mjs";

test("usage revalidates cached values and offers Retry when the service fails", async t => {
  let app, calls = 0;
  const state = { usage: { session: { percent: 1 }, weekly: { percent: 1 } } };
  app = moduleLoader({
    "auth.js": { getAuth: () => ({ auth: { token: "fixture", user: { id: "owner" } } }), signOut() {}, setUserDisplayName() {} },
    "app-shell.js": { mountAppShell: async () => ({ content: app.dom.window.document.querySelector("#app"), setActiveConversation() {} }), getShellState: () => state, tearDownShell() {} },
    "api.js": { getUsage: async () => { if (++calls === 1) throw Error("Offline"); return { session: { percent: 75 }, weekly: { percent: 50 } }; } },
    "prefs.js": { getThemePref: () => "dark", setThemePref() {} },
  });
  t.after(() => app.dom.window.close());
  const { renderSettings } = await app.load("js/pages/settings.js");
  const cleanup = await renderSettings();
  t.after(() => cleanup?.());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  const retry = [...app.dom.window.document.querySelectorAll("button")].find(button => button.textContent === "Retry");
  assert.ok(retry);
  assert.match(app.dom.window.document.body.textContent, /usage.*unavailable/i);
  retry.click(); await new Promise(resolve => setImmediate(resolve));
  assert.match(app.dom.window.document.body.textContent, /75% used/);
  assert.equal(calls, 2);
});
