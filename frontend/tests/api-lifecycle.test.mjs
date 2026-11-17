import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

async function apiFixture(fetch) {
  const app = moduleLoader({
    'config.js': { config: { apiUrl: 'https://api.invalid' } },
    'auth.js': { getAuth: () => ({ auth: { token: 'test-session' } }), refreshSession: async () => null },
    'supabaseClient.js': { isSupabaseConfigured: () => false, supabaseClient() {} },
  }, { globals: { fetch, TextDecoder } });
  return app.load('js/api.js');
}

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
