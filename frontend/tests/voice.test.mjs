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
          const band = typeof options.micBandLevel === 'function' ? options.micBandLevel() : options.micBandLevel;
          data.fill(band == null ? (context.playing || configured ? 100 : 0) : Math.round(band * 255));
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
    ...(options.liveTranscriber ? {'live-transcriber.js':{LiveTranscriber:options.liveTranscriber}} : {}),
    'api.js':{health:async()=>({tts:'configured'}),ttsStreamUrl:(_token,options)=>'wss://voice.invalid/?'+new URLSearchParams(options),
      transcribeAudio: options.transcribeAudio},
    'audio-wav.js':{blobToWav16kMono: options.convertRecording || (async blob => blob)},
    'toast.js':{toast:message=>notices.push(message)},
    'voice-orb.js':{createVoiceOrb:canvas=>{
      orbEvents.push({canvas});
      return {setState:state=>orbEvents.push({state}),setLevels:levels=>orbEvents.push({levels}),
        destroy:()=>orbEvents.push({destroy:true}),resize(){}};
    }},
  },{globals:{...(options.liveTranscriber ? {AudioWorkletNode:class {}} : {}), Blob, MediaRecorder: Recorder, ArrayBuffer, Int16Array, WebSocket:Socket,performance:{now:()=>Date.now() + (options.clockOffset?.() || 0)},
    setTimeout:(fn,ms)=>setTimeout(fn,ms).unref(),
    requestAnimationFrame:fn=>setTimeout(()=>fn(Date.now()),options.frameInterval ?? 10).unref(),cancelAnimationFrame:clearTimeout,
  }});
  Object.defineProperty(app.dom.window.document,'hidden',{configurable:true,value:false});
  if(options.getUserMedia) Object.defineProperty(app.dom.window.navigator,'mediaDevices',{
    configurable:true,value:{getUserMedia:options.getUserMedia},
  });
  app.dom.window.localStorage.setItem('bimo-voice-lang',language);
  app.dom.window.localStorage.setItem('bimo-voice-auto-lang', language === 'auto' ? '1' : '0');
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
  assert.ok(page.sockets.every(s=>!new URL(s.url).searchParams.has('speed')));
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

test('language control selects a language directly', async t => {
  const page = await voicePage(async () => '');
  t.after(() => page.overlay.close());
  const select=page.dom.window.document.querySelector('.voice-lang-btn');
  select.value='nl';select.dispatchEvent(new page.dom.window.Event('change'));
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
  await until(() => page.commands.some(command => command.type === 'Speak'), 4800);
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
  await until(() => page.dom.window.document.querySelector('.voice-overlay').dataset.state === 'speaking', 4800);
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
    const select=page.dom.window.document.querySelector('.voice-lang-btn');
    select.value=locale.slice(0,2);select.dispatchEvent(new page.dom.window.Event('change'));
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
  button.value='nl';button.dispatchEvent(new page.dom.window.Event('change'));
  button.value='fr';button.dispatchEvent(new page.dom.window.Event('change'));
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
  await until(() => sent.length, 4800);
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
  await until(() => sent.length, 4800);
  assert.deepEqual(sent, ['What is the weather in Lahore?']);
  assert.equal(uploads, 1);
});


test('Deepgram streams Urdu captions, finalizes the complete take, and uses Flux Urdu TTS',async t=>{
  const sessions=[],sent=[];
  class Live {
    constructor(options){this.options=options;sessions.push(this);}
    async start(stream){this.stream=stream;}
    finish(){return Promise.resolve('آپ کیسے ہیں؟');}
    cancel(){this.cancelled=true;}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'ur',{
    liveTranscriber:Live,recordingData:true,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]}),
    transcribeAudio:()=>assert.fail('A healthy live stream must not upload a second recording'),
  });
  t.after(()=>page.overlay.close());
  await until(()=>sessions.length);
  assert.equal(sessions[0].options.language,'ur');
  sessions[0].options.onTranscript('آپ کیسے');
  assert.equal(page.dom.window.document.querySelector('.voice-transcript').textContent,'آپ کیسے');
  sessions[0].options.onUtteranceEnd();
  await until(()=>sent.length);
  assert.deepEqual(sent,['آپ کیسے ہیں؟']);
  assert.ok(page.sockets.some(socket=>socket.url.includes('model=flux-ambreen-ur')));
});

test('language selector offers all 42 Flux languages with explicit Nova-3 locales',async t=>{
  const page=await voicePage(async()=> '');t.after(()=>page.overlay.close());
  const select=page.dom.window.document.querySelector('.voice-lang-btn');
  assert.equal(select.tagName,'SELECT');
  assert.equal(select.options.length,43);
  for(const id of ['ur','hi','bn','ar','ja']) {
    // Arabic is not in the current Flux TTS catalog; do not offer unsupported voices.
    assert.equal([...select.options].some(option=>option.value===id),id!=='ar');
  }
});

test('automatic language changes the Flux voice without restarting the microphone',async t=>{
  const sessions=[];let captures=0,submitted;
  class Live {
    delivery='gentle';
    constructor(options){this.options=options;sessions.push(this);}
    async start(){}
    finish(){return Promise.resolve('Bonjour comment allez vous?');}
    cancel(){}
  }
  const page=await voicePage(async(_text,opts)=>{submitted=opts;return '';},'auto',{
    liveTranscriber:Live,recordingData:true,
    getUserMedia:async()=>{captures++;return {getTracks:()=>[{stop(){}}]};},
  });t.after(()=>page.overlay.close());
  await until(()=>sessions.length);
  assert.equal(sessions[0].options.language,'multi');
  sessions[0].options.onLanguage('fr');
  sessions[0].options.onUtteranceEnd();
  await until(()=>submitted);
  assert.equal(submitted.language,'fr');
  assert.equal(submitted.delivery,'gentle');
  assert.equal(captures,1);
  assert.ok(page.sockets.some(socket=>socket.url.includes('model=flux-arnaud-fr')));
});

test('a failed live stream cannot submit only the suffix heard by fallback captions',async t=>{
  let live,offset=0,uploads=0;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.reject(Error('Provider disconnected'));}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    liveTranscriber:Live,recordingData:true,clockOffset:()=>offset,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]}),
    transcribeAudio:async()=>{uploads++;return {text:'The beginning and the end of my question'};},
  });t.after(()=>page.overlay.close());
  await until(()=>live);live.options.onError(Error('Disconnected'));
  await until(()=>page.recognitions.length);
  offset=1000;
  page.recognitions.at(-1).onresult({results:[Object.assign([{transcript:'the end of my question'}],{isFinal:true})]});
  await until(()=>sent.length,4800);
  assert.deepEqual(sent,['The beginning and the end of my question']);
  assert.equal(uploads,1);
});


test('Voice Auto option has a short label', async t=>{
  const page=await voicePage(async()=>'', 'auto');t.after(()=>page.overlay.close());
  assert.equal(page.dom.window.document.querySelector('.voice-lang-btn option[value="auto"]').textContent,'Auto');
});

test('Voice automatically listens after a spoken answer and stays open while the user thinks',async t=>{
  const sessions=[],sent=[];let offset=0;
  class Live {
    text='';
    constructor(options){this.options=options;sessions.push(this);}
    async start(){}
    finish(){return Promise.resolve(this.text);}
    cancel(){}
  }
  const page=await voicePage(async(text,handlers)=>{
    sent.push(text);handlers.onDelta('Here is your answer.');return 'Here is your answer.';
  },'en',{liveTranscriber:Live,recordingData:true,clockOffset:()=>offset,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>sessions.length===1);
  sessions[0].text='What is a triangle?';sessions[0].options.onTranscript(sessions[0].text);
  sessions[0].options.onUtteranceEnd();
  await until(()=>sessions.length===2,2500);
  offset=12000;await new Promise(resolve=>setTimeout(resolve,70));
  assert.equal(page.dom.window.document.querySelector('.voice-overlay').dataset.state,'listening');
  assert.equal(page.recorders[1].state,'recording');
  assert.equal(sent.length,1);
  sessions[1].text='And what is a square?';sessions[1].options.onTranscript(sessions[1].text);
  sessions[1].options.onUtteranceEnd();
  await until(()=>sent.length===2,2500);
  assert.deepEqual(sent,['What is a triangle?','And what is a square?']);
});

test('a short mid-sentence pause does not submit an unfinished thought',async t=>{
  let live,level=0.1;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('I would like to');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    liveTranscriber:Live,recordingData:true,micLevel:()=>level,getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});
  t.after(()=>page.overlay.close());await until(()=>live);
  live.options.onTranscript('I would like to');
  await new Promise(resolve=>setTimeout(resolve,250));level=0;
  await new Promise(resolve=>setTimeout(resolve,750));
  assert.equal(page.recorders[0].state,'recording');assert.equal(sent.length,0);
});


test('local turn detection waits four seconds of quiet before submitting speech',async t=>{
  let level=0.1,offset=0,live;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('This is the complete question');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    liveTranscriber:Live,recordingData:true,micLevel:()=>level,clockOffset:()=>offset,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>live);live.options.onTranscript('This is the complete question');
  await new Promise(resolve=>setTimeout(resolve,250));level=0;
  await new Promise(resolve=>setTimeout(resolve,40));offset=3500;
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(sent.length,0);assert.equal(page.recorders[0].state,'recording');
  offset=4500;await until(()=>sent.length);
  assert.deepEqual(sent,['This is the complete question']);
});

test('closing during the post-reply restart delay cannot reopen the microphone',async()=>{
  let captures=0;
  const page=await voicePage(async(_text,handlers)=>{
    handlers.onDelta('Here is the answer.');return 'Here is the answer.';
  },'en',{getUserMedia:async()=>{captures++;return {getTracks:()=>[{stop(){}}]};}});
  page.submit('A typed question');
  await until(()=>page.commands.some(command=>command.type==='Flush'));
  await until(()=>page.dom.window.document.querySelector('.voice-overlay').dataset.state==='idle');
  page.overlay.close();const before=captures;
  await new Promise(resolve=>setTimeout(resolve,350));assert.equal(captures,before);
});

test('incidental sound with no recognized words returns to listening automatically',async t=>{
  let level=0.1,offset=0,captures=0;
  class Live {
    constructor(){}
    async start(){}
    finish(){return Promise.resolve('');}
    cancel(){}
  }
  const page=await voicePage(async()=>assert.fail('Noise is not a user question'),'en',{
    liveTranscriber:Live,recordingData:true,micLevel:()=>level,clockOffset:()=>offset,
    getUserMedia:async()=>{captures++;return {getTracks:()=>[{stop(){}}]};}});
  t.after(()=>page.overlay.close());
  await until(()=>page.recorders.length===1);
  await new Promise(resolve=>setTimeout(resolve,250));level=0;
  await new Promise(resolve=>setTimeout(resolve,40));offset=4500;
  await until(()=>captures===2,1000);
  assert.equal(page.dom.window.document.querySelector('.voice-overlay').dataset.state,'listening');
  assert.equal(page.recorders[1].state,'recording');
});

test('a stopped empty recording cannot restart the mic during a newer typed request',async()=>{
  let resolveReply,captures=0;
  class Live {
    constructor(){}
    async start(){}
    finish(){return Promise.resolve('');}
    cancel(){}
  }
  const page=await voicePage(()=>new Promise(resolve=>resolveReply=resolve),'en',{
    liveTranscriber:Live,recordingData:true,
    getUserMedia:async()=>{captures++;return {getTracks:()=>[{stop(){}}]};}});
  try {
    await until(()=>page.recorders[0]?.state==='recording');
    page.dom.window.document.querySelector('.voice-mic').click();
    page.submit('Typed question');
    await new Promise(resolve=>setTimeout(resolve,400));
    assert.equal(captures,1);
    assert.equal(page.dom.window.document.querySelector('.voice-overlay').dataset.state,'thinking');
  } finally {page.overlay.close();resolveReply?.('');}
});


test('room noise above the visual meter threshold cannot block Deepgram end-of-speech',async t=>{
  let live;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('What is the weather?');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    liveTranscriber:Live,recordingData:true,micLevel:0.03,micBandLevel:0.05,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>live);live.options.onTranscript('What is the weather?');
  live.options.onUtteranceEnd();
  await until(()=>sent.length);
  assert.deepEqual(sent,['What is the weather?']);
});

test('local four-second detection submits over steady room noise when no provider endpoint arrives',async t=>{
  let level=0.03,band=0.05,offset=0,live;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('This is my complete question');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    liveTranscriber:Live,recordingData:true,micLevel:()=>level,micBandLevel:()=>band,clockOffset:()=>offset,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>live);await new Promise(resolve=>setTimeout(resolve,250));
  level=0.12;band=0.3;live.options.onTranscript('This is my complete question');
  await new Promise(resolve=>setTimeout(resolve,100));level=0.03;band=0.05;
  await new Promise(resolve=>setTimeout(resolve,60));offset=3500;
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(sent.length,0);
  offset=4500;await until(()=>sent.length);
  assert.deepEqual(sent,['This is my complete question']);
});

test('sustained speech does not become the noise floor and trigger a false endpoint',async t=>{
  let level=0.02,band=0.03,offset=0,live;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('Still speaking');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    liveTranscriber:Live,recordingData:true,micLevel:()=>level,micBandLevel:()=>band,
    clockOffset:()=>offset,frameInterval:1,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>live);await new Promise(resolve=>setTimeout(resolve,250));
  level=0.12;band=0.3;live.options.onTranscript('I am still speaking');
  await new Promise(resolve=>setTimeout(resolve,1000));offset=5000;
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(sent.length,0);assert.equal(page.recorders[0].state,'recording');
});

test('speech starting during microphone calibration still auto-sends over audible background noise',async t=>{
  let level=0.12,band=0.3,offset=0,live;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('A complete question over background noise');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    liveTranscriber:Live,recordingData:true,micLevel:()=>level,micBandLevel:()=>band,clockOffset:()=>offset,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>live);live.options.onTranscript('A complete question over background noise');
  await new Promise(resolve=>setTimeout(resolve,250));level=0.06;band=0.18;
  await new Promise(resolve=>setTimeout(resolve,60));offset=4500;
  await until(()=>sent.length);
  assert.deepEqual(sent,['A complete question over background noise']);
});

test('softer continued speech after startup calibration cannot submit while new words arrive',async t=>{
  let level=0.12,offset=0,live;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('A question that is still being spoken');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    liveTranscriber:Live,recordingData:true,micLevel:()=>level,clockOffset:()=>offset,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>live);live.options.onTranscript('I would like');
  await new Promise(resolve=>setTimeout(resolve,250));level=0.06;
  live.options.onTranscript('I would like to ask');
  await new Promise(resolve=>setTimeout(resolve,80));offset=4500;
  live.options.onTranscript('I would like to ask about this and continue');
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(sent.length,0);assert.equal(page.recorders[0].state,'recording');
});

test('microphone startup ramp cannot freeze a low noise floor and block the next question',async t=>{
  let level=0.012,offset=0,live;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('A complete question after microphone startup');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    liveTranscriber:Live,recordingData:true,micLevel:()=>level,clockOffset:()=>offset,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>live);await new Promise(resolve=>setTimeout(resolve,50));level=0.03;
  await new Promise(resolve=>setTimeout(resolve,300));level=0.12;
  live.options.onTranscript('A complete question after microphone startup');
  await new Promise(resolve=>setTimeout(resolve,100));level=0.03;
  await new Promise(resolve=>setTimeout(resolve,60));offset=4500;
  await until(()=>sent.length);
  assert.deepEqual(sent,['A complete question after microphone startup']);
});
