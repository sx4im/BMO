import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('cancelled stream callbacks and finalizer cannot touch a newer run', async () => {
  const runs = [], tokens = [], errors = [];
  const app = moduleLoader({ 'api.js': { cancelChat: async () => {}, streamChat: async (_t, _p, cb) => {
    const done = deferred(); runs.push({ cb, done }); await done.promise;
  } } }, { globals: { setInterval: () => 1, clearInterval() {} } });
  const { StreamHandler } = await app.load('js/chat/stream-handler.js');
  const handler = new StreamHandler({ getAuthToken: () => 'token', onToken: v => tokens.push(v.streamingText), onError: e => errors.push(e) });
  const first = handler.executeStream({ payload: {}, streamId: 'old' });
  handler.cancel();
  const second = handler.executeStream({ payload: {}, streamId: 'new' });
  runs[1].cb.onToken({ delta: 'New' });
  runs[0].cb.onToken({ delta: 'OLD' });
  runs[0].cb.onError(new Error('Late'));
  runs[0].cb.onAssistantMessage({ content: 'OLD' });
  runs[0].done.resolve(); await first;
  assert.equal(handler.currentStreamId, 'new');
  assert.equal(handler.isStreaming, true);
  assert.equal(handler.streamingText, 'New');
  assert.deepEqual(tokens, ['New']); assert.equal(errors.length, 0);
  runs[1].cb.onAssistantMessage({ content: 'New' }); runs[1].done.resolve(); await second;
});

test('a new route mounts while the old async handler is still pending', async () => {
  const app = moduleLoader(); const router = await app.load('js/router.js');
  const gate = deferred(), events = [];
  router.defineRoute('#/old', async (_params, { signal } = {}) => {
    await gate.promise;
    if (!signal?.aborted) events.push('old mounted');
    return () => events.push('old cleaned');
  });
  router.defineRoute('#/new', () => { events.push('new mounted'); return () => events.push('new cleaned'); });
  app.dom.window.history.replaceState(null, '', '#/old'); const old = router.dispatch();
  await new Promise(setImmediate);
  app.dom.window.history.replaceState(null, '', '#/new'); await router.dispatch();
  assert.deepEqual(events, ['new mounted']);
  gate.resolve(); await old;
  assert.deepEqual(events, ['new mounted', 'old cleaned']);
  await router.dispatch();
  assert.deepEqual(events.slice(-2), ['new cleaned', 'new mounted']);
});

test('a newer build defers reload while the active page vetoes interruption', async () => {
  let tick, reloads = 0;
  const app = moduleLoader({}, { globals: { location: { reload: () => reloads++ }, fetch: async () => ({ ok: true, text: async () => '<meta name="bmo-build" content="2">' }), setTimeout: fn => { tick = fn; }, setInterval() {} } });
  const meta = app.dom.window.document.createElement('meta'); meta.name = 'bmo-build'; meta.content = '1'; app.dom.window.document.head.append(meta);
  Object.defineProperty(app.dom.window.document, 'hidden', { value: false });
  const guard = await app.load('js/version-guard.js');
  app.dom.window.addEventListener('bmo:before-reload', e => e.preventDefault());
  guard.bootVersionGuard(); tick(); await new Promise(setImmediate);
  assert.equal(reloads, 0);
});


test('a saved incomplete reply still surfaces its following generation error once', async () => {
  const errors = [], saved = [];
  const app = moduleLoader({ 'api.js': { streamChat: async (_t, _p, cb) => {
    cb.onToken({ delta: 'Partial' });
    cb.onAssistantMessage({ id: 'saved', content: 'Partial', generation_status: 'incomplete' });
    cb.onError(new Error('Generation interrupted'));
  } } }, { globals: { setInterval: () => 1, clearInterval() {} } });
  const { StreamHandler } = await app.load('js/chat/stream-handler.js');
  const handler = new StreamHandler({ getAuthToken: () => 'token', onAssistantMessage: m => saved.push(m), onError: (err, partial) => errors.push({ err, partial }) });
  await handler.executeStream({ payload: {}, streamId: 'one' });
  assert.equal(saved.length, 1); assert.equal(errors.length, 1);
  assert.equal(errors[0].partial.content, '');
});

test('rapid navigation through the fallback route preserves cleanup ownership', async () => {
  const app = moduleLoader(); const router = await app.load('js/router.js');
  const gate = deferred(), events = [];
  router.defineRoute('#/new', () => { events.push('new mounted'); return () => events.push('new cleaned'); });
  router.defineRoute('*', async () => { await gate.promise; return () => events.push('fallback cleaned'); });
  app.dom.window.history.replaceState(null, '', '#/unknown');
  const old = router.dispatch();
  app.dom.window.history.replaceState(null, '', '#/new'); await router.dispatch();
  gate.resolve(); await old;
  assert.deepEqual(events, ['new mounted', 'fallback cleaned']);
});
