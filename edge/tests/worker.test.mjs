import assert from 'node:assert/strict';
import test from 'node:test';
import { proxyRequest } from '../worker.js';

const env = {RENDER_ORIGIN:'https://fixture.onrender.com', EDGE_TOKEN:'fixture-edge-origin-secret-at-least-32-bytes'};

test('gateway fixes the upstream, replaces forged credentials and strips untrusted IP headers',async()=>{
  let received, options;
  const incoming=new Request('https://api.example.invalid/path?q=fixture',{method:'POST',headers:{
    Authorization:'Bearer fixture-user', 'X-Bimo-Edge-Token':'forged', 'X-Bimo-Client-IP':'forged',
    'CF-Connecting-IP':'203.0.113.8','X-Forwarded-For':'198.51.100.9',Forwarded:'for=forged',
  },body:'fixture body'});
  const response=await proxyRequest(incoming,env,async(request,init)=>{received=request;options=init;return new Response('ok');});
  assert.equal(received.url,'https://fixture.onrender.com/path?q=fixture');
  assert.equal(received.headers.get('X-Bimo-Edge-Token'),env.EDGE_TOKEN);
  assert.equal(received.headers.get('X-Bimo-Client-IP'),'203.0.113.8');
  assert.equal(received.headers.has('X-Forwarded-For'),false);
  assert.equal(received.headers.has('Forwarded'),false);
  assert.equal(received.headers.get('Authorization'),'Bearer fixture-user');
  assert.equal(await received.text(),'fixture body');
  assert.equal(options.redirect,'manual');
  assert.equal(response.headers.get('Cache-Control'),'no-store');
});

test('misconfigured origins and secrets never receive a secret-bearing fetch',async()=>{
  for(const invalid of ['http://fixture.onrender.com','https://attacker.invalid','https://fixture.onrender.com/path','https://user:pass@fixture.onrender.com','https://fixture.onrender.com#fragment']) {
    const response=await proxyRequest(new Request('https://api.example.invalid/'),{...env,RENDER_ORIGIN:invalid},()=>assert.fail('Unsafe origin fetched'));
    assert.equal(response.status,503);
  }
  assert.equal((await proxyRequest(new Request('https://api.example.invalid/'),{...env,EDGE_TOKEN:''},()=>assert.fail())).status,503);
});

test('redirects never forward the secret to a different origin',async()=>{
  const request=new Request('https://api.example.invalid/path');
  const blocked=await proxyRequest(request,env,async()=>new Response(null,{status:302,headers:{Location:'https://attacker.invalid/steal'}}));
  assert.equal(blocked.status,502);
  const local=await proxyRequest(request,env,async()=>new Response(null,{status:308,headers:{Location:'https://fixture.onrender.com/path/'}}));
  assert.equal(local.headers.get('Location'),'https://api.example.invalid/path/');
});

test('SSE and a 50 MB upload remain streamed',async()=>{
  const chunk=new Uint8Array(512*1024).fill(7);
  let produced=0;
  const upload=new ReadableStream({pull(controller){if(produced===100){controller.close();return;}produced++;controller.enqueue(chunk);}});
  const input=new Request('https://api.example.invalid/attachments',{method:'POST',body:upload,duplex:'half'});
  let received;
  const events=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: fixture\n\n'));}});
  const response=await proxyRequest(input,env,async request=>{received=request;return new Response(events,{headers:{'Content-Type':'text/event-stream'}});});
  assert.ok(produced<100,'Gateway buffered the complete upload');
  assert.equal(response.body,events);
  let total=0;
  for await(const value of received.body)total+=value.byteLength;
  assert.equal(total,50*1024*1024);
  const reader=response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value),'data: fixture\n\n');
  await reader.cancel();
});

test('WebSocket upgrades preserve the provider response socket',async()=>{
  const socket={fixture:true},upgraded={status:101,webSocket:socket};
  const response=await proxyRequest(new Request('https://api.example.invalid/tts/stream?ticket=fixture',{headers:{Upgrade:'websocket'}}),env,async request=>{
    assert.equal(request.headers.get('Upgrade'),'websocket');return upgraded;
  });
  assert.equal(response,upgraded);
  assert.equal(response.webSocket,socket);
});

test('provider fetch failures return a safe message with no secret or request URL',async()=>{
  const response=await proxyRequest(new Request('https://api.example.invalid/tts/stream?ticket=private-fixture'),env,async()=>{throw new Error(env.EDGE_TOKEN);});
  assert.equal(response.status,502);
  const text=await response.text();
  assert.equal(text.includes(env.EDGE_TOKEN),false);
  assert.equal(text.includes('private-fixture'),false);
});
