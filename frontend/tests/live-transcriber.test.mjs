import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

async function fixture(grant) {
  const sockets = [], nodes = [], updates = [];
  let contextClosed = 0;
  class Socket {
    readyState = 0; bufferedAmount = 0; sent = [];
    constructor(url, protocols) { this.url = url; this.protocols = protocols; sockets.push(this); }
    send(data) { this.sent.push(data); }
    open() { this.readyState = 1; this.onopen?.(); }
    result(text, final = false, start = 0) {
      this.onmessage?.({data: JSON.stringify({type:'Results', start, duration:1,
        is_final:final, channel:{alternatives:[{transcript:text}]}})});
    }
    close() { this.readyState = 3; this.onclose?.({code:1000}); }
  }
  class Audio {
    sampleRate = 48000; state = 'running'; destination = {};
    audioWorklet = {addModule: async () => {}};
    createMediaStreamSource() { return {connect(){},disconnect(){}}; }
    resume() { return Promise.resolve(); }
    close() { contextClosed++; return Promise.resolve(); }
  }
  class Worklet {
    constructor() {
      nodes.push(this);
      this.port = {onmessage:null, postMessage: () => {
        // Flush the last PCM frame before acknowledging capture shutdown.
        this.port.onmessage({data:new ArrayBuffer(6)});
        this.port.onmessage({data:{type:'flushed'}});
      }, close(){}};
    }
    connect() {} disconnect() {}
  }
  const app = moduleLoader({'api.js':{createTranscriptionToken: grant || (async () => ({access_token:'short-lived',model:'nova-3',language:'multi'}))}},
    {globals:{WebSocket:Socket,AudioWorkletNode:Worklet,ArrayBuffer}});
  app.dom.window.AudioContext = Audio;
  const { LiveTranscriber } = await app.load('js/chat/live-transcriber.js');
  const client = new LiveTranscriber({token:'session',onTranscript:text=>updates.push(text)});
  return {client,sockets,nodes,updates,closed:()=>contextClosed};
}

test('streams buffered first audio and live revisions without duplicating final segments', async () => {
  const f = await fixture();
  const started = f.client.start({});
  await new Promise(setImmediate);
  f.nodes[0].port.onmessage({data:new ArrayBuffer(8)});
  f.sockets[0].open();
  await started;
  assert.equal(f.sockets[0].sent[0].byteLength, 8);
  assert.deepEqual([...f.sockets[0].protocols], ['bearer','short-lived']);
  assert.match(f.sockets[0].url, /model=nova-3/);
  assert.match(f.sockets[0].url, /sample_rate=48000/);
  assert.match(f.sockets[0].url, /endpointing=2000/);
  f.sockets[0].result('What');
  f.sockets[0].result('What is this?');
  f.sockets[0].result('What is this?',true);
  f.sockets[0].result('What is this?',true);
  f.sockets[0].result('Please explain',false,1);
  assert.deepEqual(f.updates.slice(-1), ['What is this? Please explain']);
  const finished = f.client.finish();
  await new Promise(setImmediate);
  assert.equal(f.sockets[0].sent.at(-2).byteLength,6);
  assert.deepEqual(JSON.parse(f.sockets[0].sent.at(-1)),{type:'CloseStream'});
  f.sockets[0].result('Please explain.',true,1);
  f.sockets[0].onmessage({data:JSON.stringify({type:'Metadata'})});
  assert.equal(await finished,'What is this? Please explain.');
  assert.equal(f.closed(),1);
});

test('cancel during credential request aborts and cannot create a late socket', async () => {
  let resolve, signal;
  const f = await fixture((_token,options) => {signal=options.signal;return new Promise(r=>resolve=r);});
  const started=f.client.start({});
  await new Promise(setImmediate);
  f.client.cancel();
  resolve({access_token:'late'});
  await started.catch(()=>{});
  assert.equal(signal.aborted,true);
  assert.equal(f.sockets.length,0);
  assert.equal(f.closed(),1);
});

test('a provider disconnect rejects finalization instead of submitting partial words', async () => {
  const f=await fixture();
  const started=f.client.start({});
  await new Promise(setImmediate);f.sockets[0].open();await started;
  f.sockets[0].result('incomplete');
  f.sockets[0].close();
  await assert.rejects(f.client.finish(), /disconnect|connection/i);
  assert.equal(f.closed(),1);
});

test('finalization waits through setup, flushes buffered PCM, and never loses the opening words', async () => {
  let grant;
  const f=await fixture(()=>new Promise(resolve=>grant=resolve));
  const started=f.client.start({});await new Promise(setImmediate);
  f.nodes[0].port.onmessage({data:new ArrayBuffer(8)});
  const finish=f.client.finish();
  grant({access_token:'temporary',model:'nova-3',language:'multi'});
  await started;
  f.sockets[0].open();
  assert.equal(f.sockets[0].sent[0].byteLength,8);
  assert.equal(f.sockets[0].sent[1].byteLength,6);
  assert.equal(JSON.parse(f.sockets[0].sent[2]).type,'CloseStream');
  f.sockets[0].result('Opening words.',true);
  f.sockets[0].onmessage({data:JSON.stringify({type:'Metadata'})});
  assert.equal(await finish,'Opening words.');
});

test('connection setup buffering is bounded and closes capture on an excessive backlog', async()=>{
  const f=await fixture();await f.client.start({});
  f.nodes[0].port.onmessage({data:new ArrayBuffer(48000*2*6)});
  await assert.rejects(f.client.finish(),/taking too long/);
  assert.equal(f.closed(),1);
});

test('metadata cannot silently commit an unfinished interim hypothesis',async()=>{
  const f=await fixture();await f.client.start({});f.sockets[0].open();
  f.sockets[0].result('Partial question');const finished=f.client.finish();
  f.sockets[0].onmessage({data:JSON.stringify({type:'Metadata'})});
  await assert.rejects(finished,/incomplete/);
});

test('final word timing and microphone level inform delivery without classifying emotion',async()=>{
  const f=await fixture();await f.client.start({});f.sockets[0].open();
  const languages=[];f.client.onLanguage=language=>languages.push(language);
  f.nodes[0].port.onmessage({data:{audio:new ArrayBuffer(10),rms:0.012,duration:0.08}});
  f.sockets[0].onmessage({data:JSON.stringify({type:'Results',start:0,is_final:true,
    channel:{alternatives:[{transcript:'Bonjour comment allez vous',languages:['fr'],
      words:[{start:0,end:0.5,language:'fr'},{start:0.5,end:1,language:'fr'},
        {start:1,end:2,language:'fr'},{start:2,end:3,language:'fr'}]}]}})});
  assert.equal(f.client.delivery,'gentle');
  assert.equal(f.client.detectedLanguage,'fr');
  assert.deepEqual(languages,['fr']);
  f.client.cancel();
});
