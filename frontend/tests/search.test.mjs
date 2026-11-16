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

test('internal search checking stays hidden and preserves actual search states', async () => {
  const statuses = [], searches = [], completions = [];
  const app = moduleLoader({ 'api.js': {
    cancelChat: async () => {},
    streamChat: async (_token, _payload, callbacks) => {
      callbacks.onSearchStatus({ status: 'checking', label: 'Checking sources…' });
      assert.equal(searches.length, 0);
      assert.ok(ROTATING_PHRASES.includes(handler.currentPhrase));
      callbacks.onSearching({ query: 'weather' });
      callbacks.onSearchComplete({ status: 'unavailable', results: [] });
    },
  } });
  const { StreamHandler, ROTATING_PHRASES } = await app.load('js/chat/stream-handler.js');
  const handler = new StreamHandler({ getAuthToken: () => 'test',
    onStatusChange: value => statuses.push(value.phrase),
    onSearching: value => searches.push(value),
    onSearchComplete: value => {
      assert.ok(ROTATING_PHRASES.includes(handler.currentPhrase));
      completions.push(value);
    },
  });
  await handler.executeStream({ payload: { message: 'weather' }, streamId: 'test' });
  assert.ok(!statuses.includes('Checking sources…'));
  assert.equal(searches.length,1);
  assert.equal(completions[0].status, 'unavailable');
});

test('unavailable search card differs from genuine empty results', async () => {
  const app = moduleLoader({ 'orb.js': { thoughtOrb() {}, searchOrb() {} } });
  const { searchCard } = await app.load('js/components/search-card.js');
  assert.match(searchCard({ status: 'unavailable' }).textContent, /unavailable|couldn.t/i);
  assert.match(searchCard({ status: 'empty' }).textContent, /No results/);
});

for (const ending of ['complete', 'cancel', 'error']) {
  test(`waiting phrases rotate, pause for search, resume afterwards, and stop on ${ending}`,async t=>{
    const statuses=[],timers=new Map();let callbacks,finish,id=0;
    const app=moduleLoader({'api.js':{
      cancelChat:async()=>{},
      streamChat:async(_token,_payload,events)=>{callbacks=events;await new Promise(resolve=>finish=resolve);},
    }},{globals:{
      setInterval:fn=>{timers.set(++id,fn);return id;},
      clearInterval:key=>timers.delete(key),
    }});
    const {StreamHandler,ROTATING_PHRASES}=await app.load('js/chat/stream-handler.js');
    const handler=new StreamHandler({getAuthToken:()=> 'test',onStatusChange:({phrase})=>{if(phrase)statuses.push(phrase);}});
    t.after(()=>{handler.cancel();finish?.();});
    const running=handler.executeStream({payload:{message:'hello'},streamId:'test'});
    assert.notEqual(statuses[0],'Preparing response…');
    assert.ok(ROTATING_PHRASES.includes(statuses[0]));
    assert.equal(timers.size,1);
    [...timers.values()][0]();assert.notEqual(statuses[0],statuses[1]);
    callbacks.onSearchStatus({status:'searching',label:'Searching the web…'});
    callbacks.onSearching({query:'weather'});
    assert.equal(timers.size,0);assert.equal(statuses.at(-1),'Searching the web…');
    callbacks.onSearchComplete({status:'ok',results:[]});
    assert.ok(ROTATING_PHRASES.includes(statuses.at(-1)));assert.equal(timers.size,1);
    if(ending==='cancel') handler.cancel();
    else if(ending==='error') callbacks.onError(new Error('Disconnected'));
    else callbacks.onComplete();
    assert.equal(timers.size,0);
    finish();await running;
  });
}

test('the first answer token stops waiting phrase rotation',async t=>{
  const timers=new Map();let callbacks,finish;
  const app=moduleLoader({'api.js':{streamChat:async(_token,_payload,events)=>{callbacks=events;await new Promise(resolve=>finish=resolve);}}},
    {globals:{setInterval:fn=>{timers.set(1,fn);return 1;},clearInterval:key=>timers.delete(key)}});
  const {StreamHandler}=await app.load('js/chat/stream-handler.js');
  const handler=new StreamHandler({getAuthToken:()=> 'test'});
  t.after(()=>{handler.cleanup();finish?.();});
  const running=handler.executeStream({payload:{message:'hello'},streamId:'test'});
  assert.equal(timers.size,1);callbacks.onToken({delta:'Hello'});assert.equal(timers.size,0);
  callbacks.onAssistantMessage({content:'Hello'});finish();await running;
});
