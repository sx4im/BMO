import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./modules.mjs";

test("share operations surface gateway failure without reading or mutating database tables", async t => {
  let directAccesses = 0;
  const app = moduleLoader({
    "config.js": { config: { apiUrl: "https://test.invalid" } },
    "auth.js": { getAuth: () => ({ auth: { token: "test", user: { id: "owner" } } }), refreshSession: async () => null },
    "supabaseClient.js": { isSupabaseConfigured: () => true, supabaseClient: () => { directAccesses++; throw Error("Direct database access forbidden"); } },
  });
  t.after(() => app.dom.window.close());
  app.context.fetch = async () => ({ ok: false, status: 503, json: async () => ({ detail: "Gateway unavailable" }) });
  const api = await app.load("js/api.js");
  for (const operation of [
    () => api.shareConversation("test", "chat"),
    () => api.getConversationShare("test", "chat"),
    () => api.deleteConversationShare("test", "chat"),
    () => api.getPublicShare("share"),
  ]) {
    await assert.rejects(operation(), { status: 503, message: "Gateway unavailable" });
  }
  assert.equal(directAccesses, 0);
});

test("transcription forwards its owner's cancellation signal to fetch", async t => {
  const app = moduleLoader({
    "config.js": { config: { apiUrl: "https://test.invalid" } },
    "auth.js": { getAuth: () => ({ auth: { token: "fixture" } }), refreshSession: async () => null },
  });
  t.after(() => app.dom.window.close());
  const controller = new AbortController();
  let signal;
  app.context.fetch = async (_url, options) => { signal = options.signal; return { ok: true, json: async () => ({ text: "Fixture" }) }; };
  const api = await app.load("js/api.js");
  await api.transcribeAudio("fixture", { type: "audio/wav" }, { signal: controller.signal });
  assert.equal(signal, controller.signal);
});

test("voice obtains a cancellable bearer-authenticated ticket and puts only that ticket in the socket URL", async t => {
  const app = moduleLoader({
    "config.js": { config: { apiUrl: "https://test.invalid" } },
    "auth.js": { getAuth: () => ({ auth: { token: "login-jwt-secret" } }), refreshSession: async () => null },
  });
  t.after(() => app.dom.window.close());
  const controller = new AbortController();
  let call;
  const ticket = "x".repeat(43);
  app.context.fetch = async (url, options) => { call = {url, ...options}; return {ok:true,json:async()=>({ticket,expires_in:30})}; };
  const api = await app.load("js/api.js");
  assert.equal((await api.createTtsTicket("old-token", {model:"flux-sienna-en", sampleRate:24000, speed:1.1, expressivity:1, signal:controller.signal})).ticket, ticket);
  assert.equal(call.url, "https://test.invalid/tts/ticket");
  assert.equal(call.headers.Authorization, "Bearer login-jwt-secret");
  assert.equal(call.signal.aborted, false);
  assert.equal(JSON.parse(call.body).sample_rate, 24000);
  const url = new URL(api.ttsStreamUrl(ticket));
  assert.equal(url.protocol, "wss:");
  assert.deepEqual([...url.searchParams.keys()], ["ticket"]);
  assert.equal(url.searchParams.get("ticket"), ticket);
  assert.equal(url.href.includes("login-jwt"), false);
  assert.throws(() => api.ttsStreamUrl("login.jwt.credential"));
  const pendingController = new AbortController();
  let activeSignal;
  app.context.fetch = async (_url, options) => {
    activeSignal = options.signal;
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), {once:true}));
  };
  const pending = api.createTtsTicket("old-token", {signal:pendingController.signal});
  await new Promise(resolve => setImmediate(resolve));
  pendingController.abort();
  await assert.rejects(pending, {name:"AbortError"});
  assert.equal(activeSignal.aborted, true);
});

test("paid HTTP requests get session clearance and renew it once when the server expires it",async t=>{
  let proofs=0;
  const app=moduleLoader({
    'config.js':{config:{apiUrl:'https://gateway.invalid'}},
    'auth.js':{getAuth:()=>({auth:{token:'fixture-login'}}),refreshSession:async()=>null},
    'turnstile.js':{hasTurnstile:()=>true,getClearance:async(_token,options)=>{proofs++;return options.force?'fresh':'cached';}},
  });
  t.after(()=>app.dom.window.close());
  const calls=[];
  app.context.fetch=async(_url,options)=>{
    calls.push(options);
    if(calls.length===1)return {status:403,ok:false,clone:()=>({json:async()=>({code:'verification_required'})})};
    return {status:201,ok:true,json:async()=>({ticket:'x'.repeat(43)})};
  };
  const api=await app.load('js/api.js');
  await api.createTtsTicket('fixture-login');
  assert.equal(proofs,2);
  assert.equal(calls[0].headers['X-Bimo-Clearance'],'cached');
  assert.equal(calls[1].headers['X-Bimo-Clearance'],'fresh');
});
