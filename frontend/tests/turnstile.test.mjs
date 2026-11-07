import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const jwt=(session='session-one')=>'header.'+Buffer.from(JSON.stringify({sub:'owner',session_id:session})).toString('base64url')+'.signature';

async function fixture(t) {
  let current={auth:{token:jwt(),user:{id:'owner'}}};
  const listeners=new Set(),widgets=[],removed=[],calls=[];
  const app=moduleLoader({
    'deployment.js':{deployment:{turnstileSiteKey:'public-fixture'}},
    'config.js':{config:{apiUrl:'https://gateway.invalid'}},
    'auth.js':{getAuth:()=>current,onAuthChange:fn=>{listeners.add(fn);fn(current);return()=>listeners.delete(fn);}},
  });
  t.after(()=>app.dom.window.close());
  app.dom.window.turnstile={render(node,options){widgets.push(options);node.append(app.dom.window.document.createElement('iframe'));return 'widget-'+widgets.length;},remove:id=>removed.push(id),reset(){}};
  app.context.fetch=async(url,options)=>{calls.push({url,...options});return {ok:true,json:async()=>({clearance:'c'.repeat(43),expires_in:900})};};
  const module=await app.load('js/turnstile.js');
  return {...app,module,widgets,removed,calls,setAuth(value){current=value;for(const fn of listeners)fn(current);},get token(){return current.auth.token;}};
}

test('concurrent verification shares one widget while one caller can cancel independently',async t=>{
  const f=await fixture(t),a=new AbortController(),b=new AbortController();
  const first=f.module.getClearance(f.token,{signal:a.signal});
  const second=f.module.getClearance(f.token,{signal:b.signal});
  await tick();assert.equal(f.widgets.length,1);
  a.abort();await assert.rejects(first,{name:'AbortError'});
  f.widgets[0].callback('fixture-proof');
  assert.equal(await second,'c'.repeat(43));
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].headers.Authorization,'Bearer '+f.token);
  assert.equal(f.calls[0].signal.aborted,false);
  assert.equal(f.removed.length,1);
  assert.equal(await f.module.getClearance(f.token),'c'.repeat(43));
  assert.equal(f.widgets.length,1);
});

test('dismissing verification aborts its work and ignores a late widget proof',async t=>{
  const f=await fixture(t),controller=new AbortController();
  const result=f.module.getClearance(f.token,{signal:controller.signal});
  await tick();
  (await f.load('js/components/dialog.js')).closeDialogs();
  await assert.rejects(result,{name:'AbortError'});
  f.widgets[0].callback('late-proof');await tick();
  assert.equal(f.calls.length,0);
  assert.equal(f.removed.length,1);
});

test('logout during proof exchange prevents a late clearance from being retained',async t=>{
  const f=await fixture(t);let respond;
  f.context.fetch=async(_url,options)=>{f.calls.push(options);return new Promise(resolve=>{respond=resolve;});};
  const result=f.module.getClearance(f.token);
  await tick();f.widgets[0].callback('fixture-proof');await tick();
  f.setAuth({auth:null});
  await assert.rejects(result,{name:'AbortError'});
  assert.equal(f.calls[0].signal.aborted,true);
  respond({ok:true,json:async()=>({clearance:'late',expires_in:900})});await tick();
  assert.equal(f.dom.window.document.querySelector('[role="dialog"]'),null);
});

test('same-session access-token renewal retains clearance; a different login requires a new proof',async t=>{
  const f=await fixture(t);
  const first=f.module.getClearance(f.token);await tick();f.widgets[0].callback('fixture-proof');await first;
  f.setAuth({auth:{token:jwt()+"-renewed",user:{id:'owner'}}});
  assert.equal(await f.module.getClearance(f.token),'c'.repeat(43));
  f.setAuth({auth:{token:jwt('session-two'),user:{id:'owner'}}});
  const next=f.module.getClearance(f.token);await tick();
  assert.equal(f.widgets.length,2);f.widgets[1].callback('fresh-proof');await next;
});

test('verification iframe participates in modal keyboard navigation',async t=>{
  const f=await fixture(t),controller=new AbortController();
  const result=f.module.getClearance(f.token,{signal:controller.signal});
  await tick();
  const doc=f.dom.window.document;
  assert.equal(doc.activeElement.textContent,'Cancel');
  // Wrapping from the last control is implemented by the helper; native Tab
  // movement between controls is left to the browser and is absent in jsdom.
  doc.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
  assert.equal(doc.activeElement.tagName,'IFRAME');
  controller.abort();await assert.rejects(result,{name:'AbortError'});
});


test('incognito chat obtains clearance before its paid request',async t=>{
  const proofs=[],requests=[];
  const app=moduleLoader({
    'config.js':{config:{apiUrl:'https://gateway.invalid'}},
    'auth.js':{getAuth:()=>({auth:{token:'fixture'}}),refreshSession:async()=>null},
    'turnstile.js':{hasTurnstile:()=>true,getClearance:async(...args)=>{proofs.push(args);return 'fixture-clearance';}},
  },{globals:{TextDecoder}});
  t.after(()=>app.dom.window.close());
  app.context.fetch=async(url,options)=>{requests.push({url,...options});return new Response('data: {"type":"complete"}\n\n',{headers:{'Content-Type':'text/event-stream'}});};
  const api=await app.load('js/api.js');
  await api.streamChat('fixture',{incognito:true,message:'Hello'});
  assert.equal(proofs.length,1);
  assert.equal(requests[0].headers['X-Bimo-Clearance'],'fixture-clearance');
  assert.ok(requests[0].url.endsWith('/chat/incognito'));
});

test('ticket transport deadline starts after human verification and aborts a stalled fetch',async t=>{
  const deadlines=[];let verify,transportSignal;
  const app=moduleLoader({
    'config.js':{config:{apiUrl:'https://gateway.invalid'}},
    'auth.js':{getAuth:()=>({auth:{token:'fixture'}}),refreshSession:async()=>null},
    'turnstile.js':{hasTurnstile:()=>true,getClearance:()=>new Promise(resolve=>{verify=resolve;})},
  },{globals:{setTimeout:(fn,ms)=>{deadlines.push({fn,ms});return deadlines.length;},clearTimeout(){}}});
  t.after(()=>app.dom.window.close());
  app.context.fetch=async(_url,options)=>{
    transportSignal=options.signal;
    return new Promise((_,reject)=>options.signal?.addEventListener('abort',()=>reject(new DOMException('Timed out','AbortError')),{once:true}));
  };
  const api=await app.load('js/api.js');
  const result=api.createTtsTicket('fixture');result.catch(()=>{});
  await tick();assert.equal(deadlines.length,0);
  verify('fixture-clearance');await tick();
  assert.equal(deadlines.length,1);
  assert.equal(deadlines[0].ms,10000);
  deadlines[0].fn();
  await assert.rejects(result,{name:'AbortError'});
  assert.equal(transportSignal.aborted,true);
});
