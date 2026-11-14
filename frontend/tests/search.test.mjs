import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

test('SSE exposes checking immediately and distinguishes unavailable retrieval', async () => {
  const seen = [];
  const events = [
    { type: 'search_status', status: 'checking', label: 'Checking sources…' },
    { type: 'searching', query: 'weather' },
    { type: 'search_complete', status: 'unavailable', count: 0, results: [] },
  ];
  const app = moduleLoader({
    'config.js': { config: { apiUrl: 'https://api.invalid' } },
    'auth.js': { getAuth: () => ({ auth: { token: 'test' } }), refreshSession: async () => null },
    'supabaseClient.js': { isSupabaseConfigured: () => false, supabaseClient() {} },
  }, { globals: {
    fetch: async () => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')),
    TextDecoder,
  } });
  const { streamChat } = await app.load('js/api.js');
  await streamChat('test', { message: 'weather' }, {
    onSearchStatus: value => seen.push(value.status),
    onSearching: () => seen.push('searching'),
    onSearchComplete: value => seen.push(value.status),
  });
  assert.deepEqual(seen, ['checking', 'searching', 'unavailable']);
});

test('checking updates status without announcing a search and preserves retrieval failure', async () => {
  const statuses = [], searches = [], completions = [];
  const app = moduleLoader({ 'api.js': {
    cancelChat: async () => {},
    streamChat: async (_token, _payload, callbacks) => {
      callbacks.onSearchStatus({ status: 'checking', label: 'Checking sources…' });
      assert.equal(searches.length, 0);
      assert.equal(handler.currentPhrase, 'Checking sources…');
      callbacks.onSearching({ query: 'weather' });
      callbacks.onSearchComplete({ status: 'unavailable', results: [] });
    },
  } });
  const { StreamHandler } = await app.load('js/chat/stream-handler.js');
  const handler = new StreamHandler({ getAuthToken: () => 'test',
    onStatusChange: value => statuses.push(value.phrase),
    onSearching: value => searches.push(value),
    onSearchComplete: value => {
      assert.equal(handler.currentPhrase, 'Preparing response…');
      completions.push(value);
    },
  });
  await handler.executeStream({ payload: { message: 'weather' }, streamId: 'test' });
  assert.ok(statuses.includes('Checking sources…'));
  assert.equal(completions[0].status, 'unavailable');
});

test('unavailable search card differs from genuine empty results', async () => {
  const app = moduleLoader({ 'orb.js': { thoughtOrb() {}, searchOrb() {} } });
  const { searchCard } = await app.load('js/components/search-card.js');
  assert.match(searchCard({ status: 'unavailable' }).textContent, /unavailable|couldn.t/i);
  assert.match(searchCard({ status: 'empty' }).textContent, /No results/);
});

test('waiting uses one factual status without a rotating animation timer', async () => {
  const statuses = [];
  const app = moduleLoader({ 'api.js': {
    streamChat: async () => {},
  } }, { globals: { setInterval() { assert.fail('Waiting must not start a phrase timer'); } } });
  const { StreamHandler } = await app.load('js/chat/stream-handler.js');
  const handler = new StreamHandler({ getAuthToken: () => 'test',
    onStatusChange: value => statuses.push(value.phrase),
  });
  await handler.executeStream({ payload: { message: 'hello' }, streamId: 'test' });
  assert.deepEqual(statuses, ['Preparing response…']);
});
