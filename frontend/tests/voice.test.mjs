import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(condition, timeout = 750) {
  for (let i=0;i<timeout/5;i++) { if (condition()) return; await new Promise(resolve=>setTimeout(resolve,5)); }
  assert.fail('Voice state did not settle');
}

async function voicePage(sendTurn, language='en', options = {}) {
  const sockets=[], commands=[], notices=[], orbEvents=[], analysers=[], recorders=[], recognitions=[];
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
    constructor(){this.startTime=Date.now();this.state='running';this.destination={};this.sampleRate=48000;this.playing=0;}
    get currentTime(){return (Date.now()-this.startTime)/1000;}
    createBuffer(_,length,rate){return {duration:length/rate,getChannelData:()=>new Float32Array(length)};}
    createAnalyser(){
      const context = this;
      const analyser = {fftSize:512,frequencyBinCount:256,connect(){},disconnect(){},
        getFloatTimeDomainData(data){
          const configured = typeof options.micLevel === 'function' ? options.micLevel() : options.micLevel;
          const level = configured || (context.playing ? 0.12 : 0);
          for(let i=0;i<data.length;i++) data[i]=level*(i%2?1:-1);
        },
        getByteFrequencyData(data){
          const configured = typeof options.micLevel === 'function' ? options.micLevel() : options.micLevel;
          data.fill(context.playing || configured ? 100 : 0);
        },
      };
      analysers.push(analyser);return analyser;
    }
    createMediaStreamSource(){return {connect(){},disconnect(){}};}
    createBufferSource(){
      const context=this;
      return {connect(){},disconnect(){},start(){
        context.playing++;
        setTimeout(()=>{context.playing--;this.onended?.();},50).unref();
      },stop(){}};
    }
    resume(){return Promise.resolve();} close(){return Promise.resolve();}
  }
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.listeners = {}; recorders.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    start() { if (options.recorderStartFails) throw new Error('Recorder failed'); this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        if (options.recordingData) this.listeners.dataavailable?.({data: new Blob(['recorded audio'])});
        this.listeners.stop?.();
      });
    }
  }
  const app=moduleLoader({
    'api.js':{health:async()=>({tts:'configured'}),ttsStreamUrl:(_token,options)=>'wss://voice.invalid/?'+new URLSearchParams(options),
      transcribeAudio: options.transcribeAudio},
    'audio-wav.js':{blobToWav16kMono: options.convertRecording || (async blob => blob)},
    'toast.js':{toast:message=>notices.push(message)},
    'voice-orb.js':{createVoiceOrb:canvas=>{
      orbEvents.push({canvas});
      return {setState:state=>orbEvents.push({state}),setLevels:levels=>orbEvents.push({levels}),
        destroy:()=>orbEvents.push({destroy:true}),resize(){}};
    }},
  },{globals:{Blob, MediaRecorder: Recorder, ArrayBuffer, Int16Array, WebSocket:Socket,performance:{now:()=>Date.now() + (options.clockOffset?.() || 0)},
    setTimeout:(fn,ms)=>setTimeout(fn,ms).unref(),
    requestAnimationFrame:fn=>setTimeout(()=>fn(Date.now()),10).unref(),cancelAnimationFrame:clearTimeout,
  }});
  Object.defineProperty(app.dom.window.document,'hidden',{configurable:true,value:false});
  if(options.getUserMedia) Object.defineProperty(app.dom.window.navigator,'mediaDevices',{
    configurable:true,value:{getUserMedia:options.getUserMedia},
  });
  app.dom.window.localStorage.setItem('bimo-voice-lang',language);
  app.dom.window.AudioContext=Audio;
  app.dom.window.SpeechRecognition=options.recorder ? undefined : class {
    constructor(){recognitions.push(this);} start(){if (!options.recognitionStalls) this.onstart?.();} stop(){};
  };
  app.dom.window.HTMLMediaElement.prototype.play=()=>Promise.resolve();
  const {openVoiceOverlay,voiceDelivery}=await app.load('js/components/voice-overlay.js');
  let interrupted=0;
  const overlay=openVoiceOverlay({token:'test',sendTurn,onInterrupt:()=>interrupted++});
  await tick();
  return {...app,sockets,commands,notices,orbEvents,analysers,recorders,recognitions,overlay,voiceDelivery,interrupted:()=>interrupted,
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


test('voice renders a procedural canvas and releases its renderer on close', async () => {
  const page = await voicePage(async () => '');
  assert.equal(page.dom.window.document.querySelectorAll('.voice-globe canvas').length, 1);
  assert.equal(page.dom.window.document.querySelectorAll('.voice-globe video').length, 0);
  page.overlay.close();page.overlay.close();
  assert.equal(page.orbEvents.filter(e => e.destroy).length, 1);
});

test('all streamed audio chunks share one playback analyser and actual waveform levels', async t => {
  const reply = 'One sentence. Another sentence. Last sentence.';
  const page = await voicePage(async (_, handlers) => {
    handlers.onDelta('One sentence. ');
    handlers.onDelta('One sentence. Another sentence. ');
    handlers.onDelta(reply);
    return reply;
  });
  t.after(() => page.overlay.close());
  page.submit('Say something');
  await until(() => page.commands.filter(e => e.type === 'Speak').length >= 3);
  assert.equal(page.analysers.length, 1);
  await until(() => page.orbEvents.some(e => e.levels?.playback > 0));
});

test('Web Speech also feeds real microphone energy and releases the capture', async t => {
  let stopped = 0;
  const page = await voicePage(async () => '', 'en', {
    micLevel: 0.1,
    getUserMedia: async () => ({getTracks: () => [{stop(){stopped++;}}]}),
  });
  t.after(() => page.overlay.close());
  await until(() => page.orbEvents.some(e => e.levels?.mic > 0));
  page.overlay.close();
  assert.equal(stopped, 1);
});

test('a microphone acquired after close is immediately released', async () => {
  let resolveCapture, stopped = 0;
  const page = await voicePage(async () => '', 'en', {
    getUserMedia: () => new Promise(resolve => {resolveCapture = resolve;}),
  });
  await until(() => resolveCapture);
  page.overlay.close();
  resolveCapture({getTracks: () => [{stop(){stopped++;}}]});
  await tick();
  assert.equal(stopped, 1);
});

test('language control is operable with a normal button click', async t => {
  const page = await voicePage(async () => '');
  t.after(() => page.overlay.close());
  page.dom.window.document.querySelector('.voice-lang-btn').click();
  assert.match(page.dom.window.document.querySelector('.voice-lang-btn').getAttribute('aria-label'), /Dutch/);
});


test('recorder VAD and visual microphone levels share one capture and analyser', async () => {
  let captures = 0, stopped = 0;
  const page = await voicePage(async () => '', 'en', {
    recorder: true,
    micLevel: 0.1,
    getUserMedia: async () => {
      captures++;
      return { getTracks: () => [{ stop() { stopped++; } }] };
    },
  });
  try {
    await until(() => page.orbEvents.some(event => event.levels?.mic > 0));
    assert.equal(captures, 1);
    assert.equal(page.analysers.length, 1);
  } finally {
    page.overlay.close();
  }
  await tick();
  assert.equal(stopped, 1);
});

for (const action of ['close', 'type', 'listen']) {
  test(`${action} cancels pending transcription and ignores its late failure`, async t => {
    let rejectTranscription, signal, offset = 0;
    const sent = [];
    const page = await voicePage(async text => { sent.push(text); return ''; }, 'en', {
      recorder: true, recordingData: true, clockOffset: () => offset,
      getUserMedia: async () => ({getTracks: () => [{stop(){}}]}),
      transcribeAudio: (_token, _blob, options) => {
        signal = options.signal;
        return new Promise((_resolve, reject) => {rejectTranscription = reject;});
      },
    });
    t.after(() => page.overlay.close());
    await until(() => page.recorders[0]?.state === 'recording');
    offset = 700;
    page.dom.window.document.querySelector('.voice-mic').click();
    await until(() => rejectTranscription);
    if (action === 'close') page.overlay.close();
    else if (action === 'type') {page.submit('A newer typed turn'); await tick();}
    else page.dom.window.document.querySelector('.voice-mic').click();
    assert.equal(signal?.aborted, true);
    const eventCount = page.orbEvents.length;
    rejectTranscription(new Error('Late transcription failure'));
    await tick();
    assert.deepEqual(page.notices, []);
    assert.equal(page.orbEvents.slice(eventCount).some(event => event.state === 'idle'), false);
    assert.deepEqual(sent, action === 'type' ? ['A newer typed turn'] : []);
  });
}

test('late recognition start cannot replace a typed turn state', async t => {
  const page = await voicePage(() => new Promise(() => {}));
  t.after(() => page.overlay.close());
  await until(() => page.recognitions.length);
  const lateStart = page.recognitions[0].onstart;
  page.submit('A typed turn');
  await tick();
  lateStart();
  assert.equal(page.dom.window.document.querySelector('.voice-overlay').dataset.state, 'thinking');
});

test('transcription API forwards cancellation to fetch', async () => {
  const controller = new AbortController();
  let sentSignal;
  const app = moduleLoader({
    'config.js':{config:{apiUrl:'https://api.invalid'}},
    'auth.js':{getAuth:()=>({auth:{token:'test'}}),refreshSession:async()=>null},
    'supabaseClient.js':{isSupabaseConfigured:()=>false,supabaseClient(){}},
  }, {globals:{fetch:async (_url, options) => {sentSignal = options.signal; return new Response('{"text":"hello"}');}}});
  const {transcribeAudio} = await app.load('js/api.js');
  const result = await transcribeAudio('test', new Blob(['audio']), {language:'en', signal:controller.signal});
  assert.equal(result.text, 'hello');
  assert.equal(sentSignal, controller.signal);
});

test('a late transcription result cannot submit over a newer typed turn', async t => {
  let resolveTranscription, offset = 0;
  const sent = [];
  const page = await voicePage(async text => {sent.push(text); return '';}, 'en', {
    recorder: true, recordingData: true, clockOffset: () => offset,
    getUserMedia: async () => ({getTracks: () => [{stop(){}}]}),
    transcribeAudio: () => new Promise(resolve => {resolveTranscription = resolve;}),
  });
  t.after(() => page.overlay.close());
  await until(() => page.recorders[0]?.state === 'recording');
  offset = 700;
  page.dom.window.document.querySelector('.voice-mic').click();
  await until(() => resolveTranscription);
  page.submit('Use the typed question');
  await tick();
  resolveTranscription({text: 'An older recording'});
  await tick();
  assert.deepEqual(sent, ['Use the typed question']);
});

test('closing during audio conversion prevents a later transcription request', async t => {
  let finishConversion, offset = 0, requests = 0;
  const page = await voicePage(async () => '', 'en', {
    recorder: true, recordingData: true, clockOffset: () => offset,
    getUserMedia: async () => ({getTracks: () => [{stop(){}}]}),
    convertRecording: blob => new Promise(resolve => {finishConversion = () => resolve(blob);}),
    transcribeAudio: async () => {requests++; return {text: 'Old recording'};},
  });
  t.after(() => page.overlay.close());
  await until(() => page.recorders[0]?.state === 'recording');
  offset = 700;
  page.dom.window.document.querySelector('.voice-mic').click();
  await until(() => finishConversion);
  page.overlay.close();
  finishConversion();
  await tick();
  assert.equal(requests, 0);
  assert.deepEqual(page.notices, []);
});

test('a current recording is transcribed and submits its recognized text', async t => {
  let offset = 0;
  const sent = [];
  const page = await voicePage(async text => {sent.push(text); return '';}, 'en', {
    recorder: true, recordingData: true, clockOffset: () => offset,
    getUserMedia: async () => ({getTracks: () => [{stop(){}}]}),
    transcribeAudio: async () => ({text:'A spoken question'}),
  });
  t.after(() => page.overlay.close());
  await until(() => page.recorders[0]?.state === 'recording');
  offset = 700;
  page.dom.window.document.querySelector('.voice-mic').click();
  await until(() => sent.length);
  assert.deepEqual(sent, ['A spoken question']);
  assert.deepEqual(page.notices, []);
});

test('recording owns the first utterance even when browser speech never starts', async t => {
  let captures = 0;
  const page = await voicePage(async () => '', 'en', {
    recognitionStalls: true,
    getUserMedia: async () => { captures++; return {getTracks: () => [{stop(){}}]}; },
  });
  t.after(() => page.overlay.close());
  assert.equal(captures, 1);
  await until(() => page.recorders[0]?.state === 'recording');
  assert.equal(captures, 1);
  assert.equal(page.dom.window.document.querySelector('.voice-overlay').dataset.state, 'listening');
});

test('the first recording can answer without waiting for browser transcripts', async t => {
  let offset = 0;
  const sent = [];
  const page = await voicePage(async text => {sent.push(text); return '';}, 'en', {
    micLevel: 0.1, recordingData: true, clockOffset: () => offset,
    getUserMedia: async () => ({getTracks: () => [{stop(){}}]}),
    transcribeAudio: async () => ({text:'A recovered spoken question'}),
  });
  t.after(() => page.overlay.close());
  await until(() => page.recorders[0]?.state === 'recording');
  offset = 700;
  page.dom.window.document.querySelector('.voice-mic').click();
  await until(() => sent.length);
  assert.deepEqual(sent, ['A recovered spoken question']);
});

test('browser speech results submit the question and play the assistant reply', async t => {
  const sent = [];
  const reply = 'I heard your spoken question.';
  const page = await voicePage(async (text, handlers) => {
    sent.push(text); handlers.onDelta(reply); return reply;
  });
  t.after(() => page.overlay.close());
  await until(() => page.recognitions.length);
  const result = Object.assign([{transcript:'Can you hear me?', confidence:1}], {isFinal:true});
  page.recognitions[0].onresult({results:[result], resultIndex:0});
  await until(() => page.commands.some(command => command.type === 'Speak'), 1500);
  assert.deepEqual(sent, ['Can you hear me?']);
  assert.equal(page.commands.filter(command => command.type === 'Speak').map(command => command.text).join('').trim(), reply);
  assert.equal(page.recorders.length, 0);
});

test('live captions update immediately and disappear on first assistant audio', async t => {
  let finish;
  const page = await voicePage(async (_text, handlers) => {
    handlers.onDelta('Here is your spoken answer.');
    return new Promise(resolve => {finish = resolve;});
  }, 'en', {
    recordingData: true,
    getUserMedia: async () => ({getTracks: () => [{stop(){}}]}),
    transcribeAudio: async () => ({text:'Can you hear me?'}),
  });
  t.after(() => {finish?.('Here is your spoken answer.'); page.overlay.close();});
  await until(() => page.recognitions.length);
  const emit = (text, final) => page.recognitions[0].onresult({results:[Object.assign([{transcript:text}],{isFinal:final})]});
  emit('Can you', false);
  assert.equal(page.dom.window.document.querySelector('.voice-transcript').textContent, 'Can you');
  emit('Can you hear me?', true);
  assert.equal(page.dom.window.document.querySelector('.voice-transcript').textContent, 'Can you hear me?');
  await until(() => page.dom.window.document.querySelector('.voice-overlay').dataset.state === 'speaking', 1600);
  assert.equal(page.dom.window.document.querySelector('.voice-transcript').textContent, '');
  assert.equal(page.recorders.length, 1);
});

test('all language selections restart captions and capture with the selected locale', async t => {
  let stopped = 0;
  const page = await voicePage(async () => '', 'en', {
    getUserMedia: async () => ({getTracks: () => [{stop(){stopped++;}}]}),
  });
  t.after(() => page.overlay.close());
  await until(() => page.recognitions.length);
  const locales = ['nl-NL','fr-FR','de-DE','it-IT','es-ES','ja-JP','en-US'];
  for (const locale of locales) {
    const previous = page.recognitions.length;
    page.dom.window.document.querySelector('.voice-lang-btn').click();
    await until(() => page.recognitions.length > previous);
    assert.equal(page.recognitions.at(-1).lang, locale);
    assert.equal(page.dom.window.localStorage.getItem('bimo-voice-lang'), locale.slice(0,2));
  }
  assert.equal(stopped, locales.length);
});

test('recorder setup failure releases the microphone and permits retry', async t => {
  let stopped = 0;
  const page = await voicePage(async () => '', 'en', {
    recorderStartFails: true,
    getUserMedia: async () => ({getTracks: () => [{stop(){stopped++;}}]}),
  });
  t.after(() => page.overlay.close());
  await until(() => page.notices.length);
  assert.equal(stopped, 1);
  assert.equal(page.dom.window.document.querySelector('.voice-overlay').dataset.state, 'idle');
});

test('failed WAV conversion never uploads mislabeled compressed audio', async t => {
  let offset = 0, uploads = 0;
  const page = await voicePage(async () => '', 'en', {
    recorder: true, recordingData: true, clockOffset: () => offset,
    getUserMedia: async () => ({getTracks: () => [{stop(){}}]}),
    convertRecording: async () => {throw Error('Audio conversion failed');},
    transcribeAudio: async () => {uploads++; return {text:'wrong'};},
  });
  t.after(() => page.overlay.close());
  await until(() => page.recorders[0]?.state === 'recording');
  offset = 700;
  page.dom.window.document.querySelector('.voice-mic').click();
  await until(() => page.notices.length);
  assert.equal(uploads, 0);
});

test('failed browser captions never truncate the recorded question', async t => {
  let offset = 0, uploads = 0;
  const sent = [];
  const page = await voicePage(async text => {sent.push(text);return '';}, 'en', {
    recordingData: true, clockOffset: () => offset,
    getUserMedia: async () => ({getTracks: () => [{stop(){}}]}),
    transcribeAudio: async () => {uploads++;return {text:'What is the weather in Lahore?'};},
  });
  t.after(() => page.overlay.close());
  await until(() => page.recognitions.length);
  page.recognitions[0].onresult({results:[Object.assign([{transcript:'What is'}],{isFinal:false})]});
  page.recognitions[0].onerror({error:'network'});
  assert.equal(page.recorders[0].state, 'recording');
  offset = 700;
  page.dom.window.document.querySelector('.voice-mic').click();
  await until(() => sent.length);
  assert.deepEqual(sent, ['What is the weather in Lahore?']);
  assert.equal(uploads, 1);
});

test('rapid language changes create one replacement recording with the final language', async t => {
  let captures = 0;
  const page = await voicePage(async () => '', 'en', {
    getUserMedia: async () => {captures++;return {getTracks: () => [{stop(){}}]};},
  });
  t.after(() => page.overlay.close());
  await until(() => page.recorders.length === 1);
  const button = page.dom.window.document.querySelector('.voice-lang-btn');
  button.click();button.click();
  await tick();
  assert.equal(captures, 2);
  assert.equal(page.recognitions.at(-1).lang, 'fr-FR');
});

test('healthy final browser speech starts the answer without a second transcription request', async t => {
  let uploads = 0;
  const sent = [];
  const page = await voicePage(async text => {sent.push(text);return '';}, 'en', {
    recordingData: true,
    getUserMedia: async () => ({getTracks: () => [{stop(){}}]}),
    transcribeAudio: async () => {uploads++;return new Promise(()=>{});},
  });
  t.after(() => page.overlay.close());
  await until(() => page.recognitions.length);
  page.recognitions[0].onresult({results:[Object.assign([{transcript:'How are you today?'}],{isFinal:true})]});
  await until(() => sent.length, 1200);
  assert.deepEqual(sent, ['How are you today?']);
  assert.equal(uploads, 0);
});

test('continued microphone speech invalidates an earlier final caption', async t => {
  let level = 0.1, uploads = 0;
  const sent = [];
  const page = await voicePage(async text => {sent.push(text);return '';}, 'en', {
    recordingData: true, micLevel: () => level,
    getUserMedia: async () => ({getTracks: () => [{stop(){}}]}),
    transcribeAudio: async () => {uploads++;return {text:'What is the weather in Lahore?'};},
  });
  t.after(() => page.overlay.close());
  await until(() => page.recognitions.length);
  page.recognitions[0].onresult({results:[Object.assign([{transcript:'What is'}],{isFinal:true})]});
  await new Promise(resolve=>setTimeout(resolve,350));
  level = 0;
  await until(() => sent.length, 1700);
  assert.deepEqual(sent, ['What is the weather in Lahore?']);
  assert.equal(uploads, 1);
});
