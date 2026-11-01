import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(condition) {
  for (let i=0;i<150;i++) { if (condition()) return; await new Promise(resolve=>setTimeout(resolve,5)); }
  assert.fail('Voice state did not settle');
}

async function voicePage(sendTurn, language='en') {
  const sockets=[], commands=[], notices=[];
  class Socket {
    static CONNECTING=0; static OPEN=1;
    readyState=0;
    constructor(url) { this.url=url; sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.onopen?.();}); }
    send(raw) {
      const command=JSON.parse(raw);commands.push({...command,url:this.url});
      if(command.type==='Speak') queueMicrotask(()=>this.onmessage?.({data:new Int16Array(240).buffer}));
      if(command.type==='Flush') queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:this.url.includes('aura')?'Flushed':'SpeechMetadata'})}));
    }
    close() {this.readyState=3;this.onclose?.();}
  }
  class Audio {
    constructor(){this.startTime=Date.now();this.state='running';this.destination={};}
    get currentTime(){return (Date.now()-this.startTime)/1000;}
    createBuffer(_,length,rate){return {duration:length/rate,getChannelData:()=>new Float32Array(length)};}
    createAnalyser(){return {fftSize:256,frequencyBinCount:4,connect(){},getByteFrequencyData(){}};}
    createBufferSource(){return {connect(){},start(when){setTimeout(()=>this.onended?.(),Math.max(20,(when||0)*1000+20));},stop(){}};}
    resume(){return Promise.resolve();} close(){return Promise.resolve();}
  }
  const app=moduleLoader({
    'api.js':{health:async()=>({tts:'configured'}),ttsStreamUrl:(_token,options)=>'wss://voice.invalid/?'+new URLSearchParams(options)},
    'toast.js':{toast:message=>notices.push(message)},
  },{globals:{WebSocket:Socket,performance:{now:()=>Date.now()},
    setTimeout:(fn,ms)=>setTimeout(fn,ms).unref(),
    requestAnimationFrame:fn=>setTimeout(fn,10).unref(),cancelAnimationFrame:clearTimeout,
  }});
  app.dom.window.localStorage.setItem('bimo-voice-lang',language);
  app.dom.window.AudioContext=Audio;
  app.dom.window.SpeechRecognition=class {start(){this.onstart?.();}stop(){};};
  app.dom.window.HTMLMediaElement.prototype.play=()=>Promise.resolve();
  const {openVoiceOverlay,voiceDelivery}=await app.load('js/components/voice-overlay.js');
  let interrupted=0;
  const overlay=openVoiceOverlay({token:'test',sendTurn,onInterrupt:()=>interrupted++});
  await tick();
  return {...app,sockets,commands,notices,overlay,voiceDelivery,interrupted:()=>interrupted,
    submit(text){const input=app.dom.window.document.querySelector('.voice-type');input.value=text;input.dispatchEvent(new app.dom.window.KeyboardEvent('keydown',{key:'Enter'}));}};
}

test('voice uses restrained documented delivery settings',async t=>{
  const page=await voicePage(async()=> '');t.after(()=>page.overlay.close());
  assert.deepEqual({...page.voiceDelivery('gentle')},{speed:1,expressivity:-1});
  assert.deepEqual({...page.voiceDelivery('lively')},{speed:1.1,expressivity:1});
  assert.deepEqual({...page.voiceDelivery('unknown')},{speed:1.05,expressivity:0});
});

test('voice announces retrieval once, then speaks only the answer with its chosen register',async t=>{
  const reply='That sounds difficult. Take one small step today. We can work through this together.';
  const page=await voicePage(async(_text,handlers)=>{
    handlers.onSearching();handlers.onSearching();
    handlers.onVoiceStyle('gentle');handlers.onDelta(reply);
    return reply;
  });t.after(()=>page.overlay.close());
  page.submit('What happened today?');
  await until(()=>page.commands.filter(c=>c.type==='Flush').length===2);
  await until(()=>page.dom.window.document.querySelector('.voice-overlay').dataset.state==='idle');
  const spoken=page.commands.filter(c=>c.type==='Speak');
  assert.equal(spoken.filter(c=>c.text.includes("I'm searching")).length,1);
  assert.equal(spoken.slice(1).map(c=>c.text).join('').trim(),reply);
  assert.ok(spoken.slice(1).every(c=>new URL(c.url).searchParams.get('expressivity')==='-1'));
  assert.equal(page.notices.length,0);
});

test('Aura finishes from Flushed without a fixed stall and simple turns do not announce search',async t=>{
  const reply='Bonjour. Voici une réponse complète.';
  const page=await voicePage(async(_text,handlers)=>{handlers.onVoiceStyle('lively');handlers.onDelta(reply);return reply;},'fr');
  t.after(()=>page.overlay.close());
  page.submit('Bonjour');
  await until(()=>page.commands.some(c=>c.type==='Flush'));
  await until(()=>page.dom.window.document.querySelector('.voice-overlay').dataset.state==='idle');
  assert.ok(page.commands.filter(c=>c.type==='Speak').every(c=>!c.text.includes('searching')));
  assert.ok(page.sockets.every(s=>!new URL(s.url).searchParams.has('expressivity')));
  assert.equal(page.notices.length,0);
});

test('interrupting a pending voice turn prevents late tokens from restarting playback',async t=>{
  let finish,callbacks;
  const page=await voicePage(async(_text,handlers)=>{callbacks=handlers;return new Promise(resolve=>{finish=resolve;});});
  t.after(()=>page.overlay.close());
  page.submit('Wait for this');
  await tick();
  page.dom.window.document.querySelector('.voice-mic').click();
  callbacks.onVoiceStyle('lively');callbacks.onDelta('Late answer that should not be spoken.');finish('Late answer that should not be spoken.');
  await tick();
  assert.equal(page.interrupted(),1);
  assert.equal(page.commands.filter(c=>c.type==='Speak').length,0);
});

test('SSE voice metadata reaches its handler before answer text',async()=>{
  const seen=[];
  const app=moduleLoader({
    'config.js':{config:{apiUrl:'https://api.invalid'}},
    'auth.js':{getAuth:()=>({auth:{token:'test'}}),refreshSession:async()=>null},
    'supabaseClient.js':{isSupabaseConfigured:()=>false,supabaseClient(){}},
  },{globals:{TextDecoder}});
  const items=[{type:'voice_style',data:{tone:'lively'}},{type:'searching',query:'latest news'},
    {type:'token',data:{delta:'Here is the answer.'}},{type:'complete'}];
  app.context.fetch=async()=>new Response(items.map(item=>'data: '+JSON.stringify(item)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
  const {streamChat}=await app.load('js/api.js');
  await streamChat('test',{message:'News?',model:'aeon'},{onVoiceStyle:data=>seen.push(data.tone),onSearching:()=>seen.push('search'),onToken:data=>seen.push(data.delta)});
  assert.deepEqual(seen,['lively','search','Here is the answer.']);
});
