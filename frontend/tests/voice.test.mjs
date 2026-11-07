import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(condition) {
  for (let i=0;i<150;i++) { if (condition()) return; await new Promise(resolve=>setTimeout(resolve,5)); }
  assert.fail('Voice state did not settle');
}

async function voicePage(sendTurn, language='en', options={}) {
  const sockets=[], commands=[], notices=[], tickets=[];
  class Socket {
    static CONNECTING=0; static OPEN=1;
    readyState=0;
    constructor(url) { this.url=url; sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.onopen?.();}); }
    send(raw) {
      const command=JSON.parse(raw);commands.push({...command,url:this.url});
      if(command.type==='Speak' && options.speechError) {
        queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:'Error',status:429,message:options.speechError})}));return;
      }
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
    'api.js':{health:async()=>({tts:'configured'}),
      createTtsTicket:async (_token,settings)=>{
        const ticket='fixture-'+tickets.length;
        tickets.push({ticket,settings});
        if(options.ticket) await options.ticket(settings);
        return {ticket,expires_in:30};
      },
      ttsStreamUrl:ticket=>'wss://voice.invalid/?'+new URLSearchParams(tickets.find(t=>t.ticket===ticket).settings),
      transcribeAudio: async (...args)=>options.transcribe?.(...args) || {text:''}},
    ...(options.convert ? {'audio-wav.js':{blobToWav16kMono:options.convert}} : {}),
    'toast.js':{toast:message=>notices.push(message)},
  },{globals:{WebSocket:Socket,Blob,performance:{now:options.now || (()=>Date.now())},
    setTimeout:(fn,ms)=>setTimeout(fn,ms).unref(),
    requestAnimationFrame:fn=>setTimeout(fn,10).unref(),cancelAnimationFrame:clearTimeout,
  }});
  app.dom.window.localStorage.setItem('bimo-voice-lang',language);
  app.dom.window.AudioContext=Audio;
  app.dom.window.SpeechRecognition=class {start(){this.onstart?.();}stop(){};};
  app.dom.window.HTMLMediaElement.prototype.play=()=>Promise.resolve();
  options.configure?.(app);
  const {openVoiceOverlay,voiceDelivery}=await app.load('js/components/voice-overlay.js');
  let interrupted=0;
  const overlay=openVoiceOverlay({token:'test',sendTurn,onInterrupt:()=>interrupted++});
  await tick();
  return {...app,sockets,commands,notices,tickets,overlay,voiceDelivery,interrupted:()=>interrupted,
    submit(text){const input=app.dom.window.document.querySelector('.voice-type');input.value=text;input.dispatchEvent(new app.dom.window.KeyboardEvent('keydown',{key:'Enter'}));}};
}

test('closing voice discards a late ticket response without opening a socket',async t=>{
  let resolve;
  const page=await voicePage(async()=>'', 'en', {ticket:()=>new Promise(r=>{resolve=r;})});
  t.after(()=>{page.overlay.close();page.dom.window.close();});
  assert.ok(resolve);
  page.overlay.close();resolve();await tick();
  assert.equal(page.sockets.length,0);
  assert.equal(page.tickets[0].settings.signal.aborted,true);
});

test('speech and Flush queue while a ticket is pending and reconnect obtains a new ticket',async t=>{
  let resolve;
  const page=await voicePage(async(_text,handlers)=>{handlers.onDelta('Hello there.');return 'Hello there.';},'en',
    {ticket:()=>new Promise(r=>{resolve=r;})});
  t.after(()=>{page.overlay.close();page.dom.window.close();});
  page.submit('Hello');await tick();
  assert.equal(page.commands.length,0);
  resolve();
  await until(()=>page.commands.some(c=>c.type==='Flush'));
  await until(()=>page.dom.window.document.querySelector('.voice-overlay').dataset.state==='idle');
  assert.equal(page.commands.filter(c=>c.type==='Speak').map(c=>c.text).join('').trim(),'Hello there.');
  page.sockets.at(-1).close();
  const count=page.tickets.length;
  page.submit('Again');await until(()=>page.tickets.length>count);
  resolve();await until(()=>page.sockets.length===2);
  assert.notEqual(page.tickets[0].ticket,page.tickets.at(-1).ticket);
});

test('long spoken replies are split into bounded commands without losing text',async t=>{
  const reply='A'.repeat(9000);
  const page=await voicePage(async()=>reply);
  t.after(()=>{page.overlay.close();page.dom.window.close();});
  page.submit('Long answer');
  await until(()=>page.commands.some(c=>c.type==='Flush'));
  const spoken=page.commands.filter(c=>c.type==='Speak');
  assert.ok(spoken.every(c=>Array.from(c.text).length<=4000));
  assert.equal(spoken.map(c=>c.text).join('').trim(),reply);
});

test('voice quota errors are visible to the user',async t=>{
  const page=await voicePage(async()=>'Hello.', 'en', {speechError:'Voice usage allowance reached.'});
  t.after(()=>{page.overlay.close();page.dom.window.close();});
  page.submit('Hello');
  await until(()=>page.commands.some(c=>c.type==='Speak'));
  await tick();
  assert.ok(page.notices.includes('Voice usage allowance reached.'));
});

function microphone(app, permission, recorders) {
  app.dom.window.SpeechRecognition=undefined;
  Object.defineProperty(app.dom.window.navigator,'mediaDevices',{value:{getUserMedia:permission},configurable:true});
  app.context.MediaRecorder=class {
    static isTypeSupported(){return true;}
    constructor(_stream,options){this.mimeType=options?.mimeType;this.handlers={};this.state='inactive';recorders.push(this);}
    addEventListener(name,handler){this.handlers[name]=handler;}
    start(){this.state='recording';}
    stop(){this.state='inactive';this.handlers.dataavailable({data:new Blob(['fixture audio'])});this.pending=this.handlers.stop();}
  };
}

test('closing voice while microphone permission is pending stops the granted tracks',async t=>{
  let allow,stopped=0;const recorders=[];
  const stream={getTracks:()=>[{stop:()=>stopped++}]};
  const page=await voicePage(async()=>'', 'en', {configure:app=>microphone(app,()=>new Promise(resolve=>{allow=resolve;}),recorders)});
  t.after(()=>{page.overlay.close();page.dom.window.close();});
  await until(()=>allow);
  page.overlay.close();allow(stream);await tick();
  assert.equal(recorders.length,0);
  assert.equal(stopped,1);
});

test('closing voice during audio conversion prevents a late transcription request',async t=>{
  let now=1000,finish;const recorders=[],transcriptions=[];
  const page=await voicePage(async()=>'', 'en', {
    now:()=>now,configure:app=>microphone(app,async()=>({getTracks:()=>[{stop(){}}]}),recorders),
    convert:()=>new Promise(resolve=>{finish=resolve;}),transcribe:(...args)=>{transcriptions.push(args);return {text:'Late'};},
  });
  t.after(()=>{page.overlay.close();page.dom.window.close();});
  await until(()=>recorders.length);
  now=3000;const recorder=recorders[0];recorder.stop();
  assert.ok(finish);
  page.overlay.close();finish(new Blob(['fixture wav'],{type:'audio/wav'}));await recorder.pending;
  assert.equal(transcriptions.length,0);
});

test('voice uses restrained documented delivery settings',async t=>{
  const page=await voicePage(async()=> '');t.after(()=>page.overlay.close());
  assert.deepEqual({...page.voiceDelivery('gentle')},{speed:1,expressivity:-1});
  assert.deepEqual({...page.voiceDelivery('lively')},{speed:1.1,expressivity:1});
  assert.deepEqual({...page.voiceDelivery('unknown')},{speed:1.05,expressivity:0});
});

test('voice focus is contained and shared dialog dismissal stops its resources',async t=>{
  const page=await voicePage(async()=> '');t.after(()=>{page.overlay.close();page.dom.window.close();});
  const doc=page.dom.window.document, dialog=doc.querySelector('.voice-overlay');
  assert.ok(dialog.contains(doc.activeElement));
  assert.ok(doc.querySelector('#app').hasAttribute('inert'));
  (await page.load('js/components/dialog.js')).closeDialogs();
  assert.equal(doc.querySelector('#app').hasAttribute('inert'),false);
  assert.equal(dialog.classList.contains('open'),false);
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
    {type:'token',data:{delta:'Here is the answer.'}},{type:'complete'},
    {type:'assistant_message',data:{id:'saved',role:'assistant',content:'Here is the answer.'}}];
  app.context.fetch=async()=>new Response(items.map(item=>'data: '+JSON.stringify(item)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
  const {streamChat}=await app.load('js/api.js');
  await streamChat('test',{message:'News?',model:'aeon'},{onVoiceStyle:data=>seen.push(data.tone),onSearching:()=>seen.push('search'),onToken:data=>seen.push(data.delta)});
  assert.deepEqual(seen,['lively','search','Here is the answer.']);
});
