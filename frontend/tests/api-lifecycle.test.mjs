import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

async function apiFixture(fetch, globals = {}) {
  const app = moduleLoader({
    'config.js': { config: { apiUrl: 'https://api.invalid' } },
    'auth.js': { getAuth: () => ({ auth: { token: 'test-session' } }), refreshSession: async () => null },
    'supabaseClient.js': { isSupabaseConfigured: () => false, supabaseClient() {} },
  }, { globals: { fetch, TextDecoder, ...globals } });
  return app.load('js/api.js');
}

test('production reads use same-origin and writes and voice keep their direct routes', async t => {
  const requested = [];
  const app = moduleLoader({
    'auth.js': { getAuth: () => ({ auth: null }), refreshSession: async () => null },
    'supabaseClient.js': { isSupabaseConfigured: () => false, supabaseClient() {} },
  }, { globals: { fetch: async url => {
    requested.push(url);
    if (url.includes('/bmo-api/conversations/') && requested.length === 3) throw new TypeError('Network unavailable');
    return new Response('[]');
  } } });
  t.after(() => app.dom.window.close());
  app.dom.reconfigure({ url: 'https://bimo.qzz.io/#/app/chat' });

  const api = await app.load('js/api.js');
  const { config } = await app.load('js/config.js');
  await api.listConversations('test');
  await api.createTranscriptionToken('test');
  await api.getMessages('test', 'chat');
  await api.listModels('test');
  assert.deepEqual(requested, [
    'https://bimo.qzz.io/bmo-api/conversations',
    'https://bimo-backend-4a4g.onrender.com/transcribe/token',
    'https://bimo.qzz.io/bmo-api/conversations/chat/messages',
    'https://bimo-backend-4a4g.onrender.com/conversations/chat/messages',
    'https://bimo.qzz.io/bmo-api/models',
  ]);
  assert.equal(new URL(api.ttsStreamUrl('test')).host, 'bimo-backend-4a4g.onrender.com');

  config.setApiUrl('https://override.invalid');
  await api.listConversations('test');
  assert.equal(requested.at(-1), 'https://override.invalid/conversations');
  assert.equal(new URL(api.ttsStreamUrl('test')).host, 'override.invalid');
});

test('conversation reads have a deadline and skip the network while offline', async () => {
  const navigator = { onLine: true };
  const requests = [];
  const deadlines = [];
  const api = await apiFixture(async (url, { signal }) => {
    requests.push({ url, signal });
    return new Response("[]");
  }, { navigator, AbortSignal: { timeout: ms => {
    deadlines.push(ms);
    return new AbortController().signal;
  } } });
  await api.listConversations("test");
  await api.getMessages("test", "chat");
  assert.equal(requests.length, 2);
  assert.deepEqual(deadlines, [21_000, 6_000, 21_000, 6_000]);
  assert.ok(requests.every(request => request.signal instanceof AbortSignal));
  navigator.onLine = false;
  await assert.rejects(api.listConversations("test"), /internet connection/);
  assert.equal(requests.length, 2);
});

test('history retries one failed network read within a bounded deadline', async () => {
  const requests = [];
  const overall = new AbortController().signal;
  const first = new AbortController().signal;
  const api = await apiFixture(async (url, { signal }) => {
    requests.push({ url, signal });
    if (requests.length === 1) throw new DOMException('First attempt timed out', 'TimeoutError');
    return new Response('{"messages":[]}');
  }, { AbortSignal: { timeout: ms => ms === 21_000 ? overall : first } });
  assert.deepEqual(await api.getMessages('test', 'chat'), { messages: [] });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, requests[1].url);
  assert.equal(requests[0].signal, first);
  assert.equal(requests[1].signal, overall);
});

test('message recovery and image polling forward their cancellation signal', async () => {
  const controller = new AbortController();
  let received;
  const api = await apiFixture(async (url, options) => {
    received = { url, options };
    return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
  });
  await api.getMessages('test-session', 'conversation-test', controller.signal);
  assert.equal(received.url, 'https://api.invalid/conversations/conversation-test/messages');
  assert.equal(received.options.signal, controller.signal);
});

test('stream errors preserve structured retry state without treating it as answer text', async () => {
  const api = await apiFixture(async () => new Response('data: '+JSON.stringify({
    type: 'error', code: 'rate_limited', detail: 'Please wait briefly.', retryable: true, retry_after: 2,
  })+'\n\n'));
  const errors = [], tokens = [];
  await assert.rejects(api.streamChat('test-session', { message: 'Hello' }, {
    onError: error => errors.push(error), onToken: value => tokens.push(value),
  }), error => error.code === 'rate_limited' && error.retryable === true && error.retryAfter === 2);
  assert.equal(errors.length, 1);
  assert.equal(tokens.length, 0);
});

test('Auto transcription stays compatible while frontend and backend deploy separately', async () => {
  let sent;
  const app=moduleLoader({
    'config.js':{config:{apiUrl:'https://api.invalid'}},
    'auth.js':{getAuth:()=>({auth:{token:'test'}}),refreshSession:async()=>null},
    'supabaseClient.js':{isSupabaseConfigured:()=>false,supabaseClient(){}},
  },{globals:{FormData:class extends Map{append(key,value){this.set(key,value);}},fetch:async(_url,options)=>{
    sent=options.body;return new Response(JSON.stringify({text:'Bonjour',language:'french'}));
  }}});
  const {transcribeAudio}=await app.load('js/api.js');
  await transcribeAudio('test',new Blob(['isolated-test']),{language:'auto'});
  assert.equal(sent.get('language'),'multi');
  assert.equal(sent.get('auto_language'),'1');
});
