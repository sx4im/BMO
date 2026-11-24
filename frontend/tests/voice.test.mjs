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
    constructor(url) { this.url=url; sockets.push(this);queueMicrotask(()=>{if(this.readyState===0){this.readyState=1;this.onopen?.();}}); }
    send(raw) {
      const command=JSON.parse(raw);commands.push({...command,url:this.url});
      if (options.closeSpeechSocket) {
        queueMicrotask(() => this.close());
        return;
      }
      if(command.type==='Speak' && !(options.silentFirstSpeech && commands.filter(c=>c.type==='Speak').length===1)) queueMicrotask(()=>this.onmessage?.({data:new Int16Array(240).buffer}));
      if(command.type==='Flush' && !(options.silentFirstSpeech && commands.filter(c=>c.type==='Speak').length===1)) queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:this.url.includes('aura')?'Flushed':'SpeechMetadata'})}));
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
        options.onPlayback?.(this.buffer);
        context.playing++;
        setTimeout(()=>{context.playing--;this.onended?.();},50).unref();
      },stop(){}};
    }
    async decodeAudioData(bytes) { return { duration: 0.05, bytes }; }
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
      synthesizeSpeech: options.synthesizeSpeech,
      transcribeAudio: options.transcribeAudio,
      ...(options.checkVoiceTurn ? {checkVoiceTurn: options.checkVoiceTurn} : {})},
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
  app.dom.window.matchMedia = query => ({ matches: query === '(pointer: coarse)' && Boolean(options.coarsePointer) });
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

test('voice opens a speech socket only for audio and releases it after playback', async t => {
  let resolveReply;
  let recoveryCalls = 0;
  const page = await voicePage(() => new Promise(resolve => { resolveReply = resolve; }), 'en', {
    synthesizeSpeech: async () => { recoveryCalls++; },
  });
  t.after(() => page.overlay.close());
  assert.equal(page.sockets.length, 0);

  const language = page.dom.window.document.querySelector('.voice-lang-btn');
  language.value = 'fr';
  language.dispatchEvent(new page.dom.window.Event('change'));
  page.submit('Bonjour');
  await until(() => resolveReply);
  assert.equal(page.sockets.length, 0);

  resolveReply('Bonjour, voici une réponse.');
  await until(() => page.commands.some(command => command.type === 'Flush'));
  assert.equal(page.sockets.length, 1);
  assert.match(page.sockets[0].url, /model=flux-arnaud-fr/);
  assert.equal(page.sockets[0].readyState, 1);
  await until(() => page.sockets[0].readyState === 3);
  assert.equal(recoveryCalls, 0);
});

test('voice plays one HTTP synthesis fallback when the socket closes without any audio', async t => {
  const calls = [];
  const played = [];
  const bytes = new ArrayBuffer(64);
  const page = await voicePage(async () => 'Bonjour, voici une réponse.', 'fr', {
    closeSpeechSocket: true,
    synthesizeSpeech: async (token, text, options) => {
      calls.push({ token, text, voice: options.voice });
      return bytes;
    },
    onPlayback: buffer => played.push(buffer),
  });
  t.after(() => page.overlay.close());
  page.submit('Bonjour');
  await until(() => played.length > 0);
  assert.deepEqual(calls, [{ token: 'test', text: 'Bonjour, voici une réponse.', voice: 'flux-arnaud-fr' }]);
  assert.deepEqual(played.map(buffer => buffer.bytes), [bytes]);
});

test('closing voice aborts speech recovery and discards its audio', async t => {
  let finishRecovery;
  let signal;
  const played = [];
  const page = await voicePage(async () => 'Here is a reply.', 'en', {
    closeSpeechSocket: true,
    synthesizeSpeech: (_token, _text, options) => {
      signal = options.signal;
      return new Promise(resolve => { finishRecovery = resolve; });
    },
    onPlayback: buffer => played.push(buffer),
  });
  t.after(() => page.overlay.close());
  page.submit('Hello');
  await until(() => finishRecovery);
  page.overlay.close();
  assert.equal(signal.aborted, true);
  finishRecovery(new ArrayBuffer(64));
  await tick();
  assert.deepEqual(played, []);
});

test('voice displays Bmo and sends its letter names to speech synthesis', async t => {
  const reply = "I'm Bmo. BMO is here to help.";
  const page = await voicePage(async (_text, handlers) => {
    handlers.onDelta("I'm B");
    handlers.onDelta(reply);
    return reply;
  });
  t.after(() => page.overlay.close());

  const dialog = page.dom.window.document.querySelector('.voice-overlay');
  assert.equal(dialog.getAttribute('aria-label'), 'Bmo');
  assert.equal(dialog.querySelector('.voice-title').textContent, 'Bmo');

  page.submit('Who are you?');
  await until(() => page.commands.some(command => command.type === 'Flush'));
  const spoken = page.commands.filter(command => command.type === 'Speak').map(command => command.text).join('').trim();
  assert.equal(spoken, "I'm Bee Em Oh. Bee Em Oh is here to help.");
});

test('voice announces retrieval once, then speaks only the answer with its chosen register',async t=>{
  const reply='That sounds difficult. Take one small step today. We can work through this together.';
  const page=await voicePage(async(_text,handlers)=>{
    handlers.onSearching();handlers.onSearching();await tick();
    handlers.onVoiceStyle('gentle');handlers.onDelta(reply);
    return reply;
  });t.after(()=>page.overlay.close());
  page.submit('What happened today?');
  await until(()=>page.commands.filter(c=>c.type==='Flush').length===2);
  await until(()=>page.dom.window.document.querySelector('.voice-overlay').dataset.state==='idle');
  const spoken=page.commands.filter(c=>c.type==='Speak');
  const {voiceAcknowledgments}=await page.load("js/components/voice-acknowledgments.js");
  assert.ok(voiceAcknowledgments("en","search").includes(spoken[0].text.trim()));
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


test('a browser with only native speech recognition can still type without opening a recognizer', async t => {
  const sent = [];
  const page = await voicePage(async text => { sent.push(text); return ''; });
  t.after(() => page.overlay.close());
  assert.equal(page.recognitions.length, 0);
  assert.equal(page.dom.window.document.querySelector('.voice-overlay').dataset.state, 'idle');
  page.submit('A typed turn');
  await until(() => sent.length);
  assert.deepEqual(sent, ['A typed turn']);
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



test('voice displays only the completed Deepgram transcript', async t => {
  let live, finalize;
  class Live {
    constructor(options) { this.options = options; live = this; }
    async start() {}
    finish() { return new Promise(resolve => { finalize = resolve; }); }
    cancel() {}
  }
  const page = await voicePage(async () => 'Here is your spoken answer.', 'en', {
    liveTranscriber: Live,
    recordingData: true,
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
  });
  t.after(() => page.overlay.close());
  await until(() => live);
  const caption = page.dom.window.document.querySelector('.voice-transcript');
  live.options.onTranscript('Can you');
  assert.equal(caption.textContent, '');
  live.options.onUtteranceEnd();
  await until(() => finalize);
  assert.equal(caption.textContent, '');
  finalize('Can you hear me?');
  await until(() => page.dom.window.document.querySelector('.voice-overlay').dataset.state === 'speaking');
  assert.equal(caption.textContent, 'Can you hear me?');
  assert.equal(page.recognitions.length, 0);
});


test('changing languages updates the visible label and restarts Deepgram in that locale', async t => {
  let stopped = 0;
  const sessions = [];
  class Live {
    constructor(options) { sessions.push(options); }
    async start() {}
    async finish() { return ''; }
    cancel() {}
  }
  const page = await voicePage(async () => '', 'en', {
    liveTranscriber: Live,
    getUserMedia: async () => ({getTracks: () => [{stop(){stopped++;}}]}),
  });
  t.after(() => page.overlay.close());
  await until(() => sessions.length);
  const select = page.dom.window.document.querySelector('.voice-lang-btn');
  const label = page.dom.window.document.querySelector('.voice-lang-label');
  for (const locale of ['nl', 'fr', 'de', 'it', 'es', 'ja', 'ur', 'en']) {
    const previous = sessions.length;
    select.value = locale;
    select.dispatchEvent(new page.dom.window.Event('change'));
    await until(() => sessions.length > previous);
    assert.equal(sessions.at(-1).language, locale);
    assert.equal(label.textContent, select.selectedOptions[0].textContent);
    assert.equal(page.dom.window.localStorage.getItem('bimo-voice-lang'), locale);
  }
  assert.equal(stopped, 8);
  assert.equal(page.recognitions.length, 0);
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
  assert.equal(page.dom.window.document.querySelector('.voice-lang-label').textContent, 'French');
  assert.equal(page.recognitions.length, 0);
});



test('explicit Urdu streams through Deepgram and shows only the completed transcript',async t=>{
  const sessions=[],sent=[];
  class Live {
    constructor(options){this.options=options;sessions.push(this);}
    async start(stream){this.stream=stream;}
    finish(){return Promise.resolve('آپ کیسے ہیں؟');}
    cancel(){this.cancelled=true;}
  }
  const page=await voicePage(async text=>{sent.push(text);return 'میں ٹھیک ہوں۔';},'ur',{
    liveTranscriber:Live,recordingData:true,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]}),
    transcribeAudio:()=>assert.fail('A healthy live stream must not upload a second recording'),
  });
  t.after(()=>page.overlay.close());
  await until(()=>sessions.length);
  assert.equal(sessions[0].options.language,'ur');
  sessions[0].options.onTranscript('آپ کیسے');
  assert.equal(page.dom.window.document.querySelector('.voice-transcript').textContent,'');
  sessions[0].options.onUtteranceEnd();
  await until(()=>page.commands.some(command=>command.type==='Speak'));
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
  const page=await voicePage(async(_text,opts)=>{submitted=opts;return 'Très bien, merci.';},'auto',{
    liveTranscriber:Live,recordingData:true,
    transcribeAudio:async()=>({text:"Bonjour comment allez vous?",language:"french"}),
    getUserMedia:async()=>{captures++;return {getTracks:()=>[{stop(){}}]};},
  });t.after(()=>page.overlay.close());
  await until(()=>sessions.length);
  assert.equal(sessions[0].options.language,'multi');
  sessions[0].options.onLanguage('fr');
  sessions[0].options.onUtteranceEnd();
  await until(()=>page.commands.some(command=>command.type==='Speak'));
  assert.equal(submitted.language,'fr');
  assert.equal(submitted.delivery,'gentle');
  assert.equal(captures,1);
  assert.ok(page.sockets.some(socket=>socket.url.includes('model=flux-arnaud-fr')));
});

test('a failed live stream recovers the full recording through Deepgram',async t=>{
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
    transcribeAudio:async(_token,_audio,opts)=>{assert.equal(opts.deepgramOnly,true);uploads++;return {text:'The beginning and the end of my question'};},
  });t.after(()=>page.overlay.close());
  await until(()=>live);live.options.onError(Error('Disconnected'));
  assert.equal(page.recognitions.length,0);
  offset=1000;
  page.dom.window.document.querySelector('.voice-mic').click();
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

test('a mid-sentence pause of about 600 ms keeps the same recording open',async t=>{
  let live,level=0.1,offset=0;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('I would like to');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    liveTranscriber:Live,recordingData:true,micLevel:()=>level,clockOffset:()=>offset,
    checkVoiceTurn:async()=>({available:true,complete:true}),
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});
  t.after(()=>page.overlay.close());await until(()=>live);
  live.options.onTranscript('I would like to');
  await new Promise(resolve=>setTimeout(resolve,250));level=0;
  await new Promise(resolve=>setTimeout(resolve,70));offset=550;
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(page.recorders[0].state,'recording');assert.equal(sent.length,0);
});

test('a delayed Deepgram endpoint cannot stop speech that has already resumed',async t=>{
  let live,level=0.01,offset=0;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('Here is the full question');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    liveTranscriber:Live,micLevel:()=>level,clockOffset:()=>offset,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});
  t.after(()=>page.overlay.close());await until(()=>live);
  await new Promise(resolve=>setTimeout(resolve,240));level=0.12;
  live.options.onTranscript('Here is');
  await new Promise(resolve=>setTimeout(resolve,80));level=0.01;
  await new Promise(resolve=>setTimeout(resolve,70));level=0.12;
  await new Promise(resolve=>setTimeout(resolve,80));
  live.options.onUtteranceEnd();
  await tick();
  assert.equal(page.recorders[0].state,'recording');assert.equal(sent.length,0);
  live.options.onTranscript('Here is the full question');level=0.01;
  await new Promise(resolve=>setTimeout(resolve,60));
  live.options.onUtteranceEnd();
  await tick();
  assert.equal(page.recorders[0].state,'recording');assert.equal(sent.length,0);
  offset=1900;
  await until(()=>sent.length);
  assert.deepEqual(sent,['Here is the full question']);
});

test('one microphone startup spike does not restart the recording',async t=>{
  let frames=0,offset=0;
  class Live {
    async start(){}
    finish(){return Promise.resolve('');}
    cancel(){}
  }
  const page=await voicePage(async()=>assert.fail('No user turn was spoken'),'en',{
    liveTranscriber:Live,micLevel:()=>++frames===1 ? 0.2 : 0.004,clockOffset:()=>offset,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});
  t.after(()=>page.overlay.close());
  await new Promise(resolve=>setTimeout(resolve,285));offset=1950;
  await new Promise(resolve=>setTimeout(resolve,70));
  assert.equal(page.recorders.length,1);
  assert.equal(page.recorders[0].state,'recording');
});


test('desktop releases the mic at the quiet fallback before transcription finishes',async t=>{
  let level=0.1,offset=0,live,tracksStopped=0,finalize;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return new Promise(resolve=>{finalize=resolve;});}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    liveTranscriber:Live,recordingData:true,micLevel:()=>level,clockOffset:()=>offset,
    getUserMedia:async()=>({getTracks:()=>[{stop(){tracksStopped++;}}]})});t.after(()=>page.overlay.close());
  await until(()=>live);live.options.onTranscript('This is the complete question');
  await new Promise(resolve=>setTimeout(resolve,250));level=0;
  assert.equal(live.options.endpointingMs,1800);
  await new Promise(resolve=>setTimeout(resolve,40));offset=650;
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(sent.length,0);assert.equal(page.recorders[0].state,'recording');
  live.options.onTranscript('This is the complete question.');
  offset=2550;await until(()=>tracksStopped===1);
  assert.equal(sent.length,0);
  finalize('This is the complete question');
  await until(()=>sent.length);
  assert.deepEqual(sent,['This is the complete question']);
  assert.equal(page.recorders[0].state,'inactive');
  assert.equal(tracksStopped,1);
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

test('mobile uses the same quiet fallback over steady room noise',async t=>{
  let level=0.03,band=0.05,offset=0,live;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('This is my complete question');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    coarsePointer:true,liveTranscriber:Live,recordingData:true,micLevel:()=>level,micBandLevel:()=>band,clockOffset:()=>offset,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>live);await new Promise(resolve=>setTimeout(resolve,250));
  level=0.12;band=0.3;live.options.onTranscript('This is my complete question');
  await new Promise(resolve=>setTimeout(resolve,100));level=0.03;band=0.05;
  assert.equal(live.options.endpointingMs,1800);
  await new Promise(resolve=>setTimeout(resolve,60));offset=650;
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(sent.length,0);
  offset=1900;await until(()=>sent.length);
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
  await new Promise(resolve=>setTimeout(resolve,60));offset=2100;
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
  await new Promise(resolve=>setTimeout(resolve,60));offset=2100;
  await until(()=>sent.length);
  assert.deepEqual(sent,['A complete question after microphone startup']);
});


test('semantic Voice submits a complete question promptly without a provider silence endpoint',async t=>{
  let live,level=0.1,offset=0;const sent=[],checks=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('What is photosynthesis?');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    liveTranscriber:Live,recordingData:true,micLevel:()=>level,clockOffset:()=>offset,
    checkVoiceTurn:async(_token,text)=>{checks.push(text);return {available:true,complete:true};},
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>live);live.options.onTranscript('What is photosynthesis?');
  await new Promise(resolve=>setTimeout(resolve,250));level=0;
  await new Promise(resolve=>setTimeout(resolve,60));offset=700;
  await until(()=>sent.length);
  assert.deepEqual(sent,['What is photosynthesis?']);assert.equal(checks.length,1);
});

for (const stalled of [false, true]) {
  test(`the longer quiet fallback submits even when the semantic check ${stalled ? 'stalls' : 'rejects completion'}`,async t=>{
    let live,level=0.03,offset=0,signal;const sent=[],checks=[];
    class Live {
      constructor(options){this.options=options;live=this;}
      async start(){}
      finish(){return Promise.resolve('Compare Python and JavaScript');}
      cancel(){}
    }
    const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
      coarsePointer:true,liveTranscriber:Live,recordingData:true,micLevel:()=>level,clockOffset:()=>offset,
      checkVoiceTurn:async(_token,text,_previous,options)=>{
        checks.push(text);signal=options.signal;
        return stalled ? new Promise(()=>{}) : {available:true,complete:false};
      },
      getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
    await until(()=>live);await new Promise(resolve=>setTimeout(resolve,250));
    level=0.12;live.options.onTranscript('Compare Python and JavaScript');
    await new Promise(resolve=>setTimeout(resolve,100));level=0.03;
    await new Promise(resolve=>setTimeout(resolve,60));offset=700;
    await until(()=>checks.length);
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(sent.length,0);assert.equal(page.recorders[0].state,'recording');
    offset=1950;await until(()=>sent.length);
    assert.deepEqual(sent,['Compare Python and JavaScript']);
    assert.equal(page.recorders[0].state,'inactive');
    if(stalled) assert.equal(signal.aborted,true);
  });
}

test('a provider endpoint can recover a quiet turn rejected by semantic completion',async t=>{
  let live,level=0.01,offset=0,checked=false;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('A complete question');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    liveTranscriber:Live,recordingData:true,micLevel:()=>level,clockOffset:()=>offset,
    checkVoiceTurn:async()=>{checked=true;return {available:true,complete:false};},
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>live);await new Promise(resolve=>setTimeout(resolve,250));
  level=0.1;live.options.onTranscript('A complete question');
  await new Promise(resolve=>setTimeout(resolve,90));level=0.01;
  await new Promise(resolve=>setTimeout(resolve,60));offset=700;
  await until(()=>checked);
  assert.equal(page.recorders[0].state,'recording');
  live.options.onUtteranceEnd();await until(()=>sent.length);
  assert.deepEqual(sent,['A complete question']);
});

test('resuming speech resets the quiet window',async t=>{
  let live,level=0.03,offset=0;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('The rest of my question');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    coarsePointer:true,liveTranscriber:Live,recordingData:true,micLevel:()=>level,clockOffset:()=>offset,
    checkVoiceTurn:async()=>({available:true,complete:false}),
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>live);await new Promise(resolve=>setTimeout(resolve,250));
  level=0.12;live.options.onTranscript('The beginning');
  await new Promise(resolve=>setTimeout(resolve,80));level=0.03;
  await new Promise(resolve=>setTimeout(resolve,60));offset=90;
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(sent.length,0);
  level=0.12;live.options.onTranscript('The rest of my question');
  await new Promise(resolve=>setTimeout(resolve,60));offset=3100;
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(sent.length,0);
  level=0.03;await new Promise(resolve=>setTimeout(resolve,60));offset=4000;
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(sent.length,0);
  offset=5050;await until(()=>sent.length);
  assert.deepEqual(sent,['The rest of my question']);
});

test('closing Voice aborts a semantic request and ignores its late positive verdict',async t=>{
  let live,level=0.1,resolveCheck,signal;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('Can you help me?');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    liveTranscriber:Live,recordingData:true,micLevel:()=>level,
    checkVoiceTurn:(_token,_text,_previous,options)=>{signal=options.signal;return new Promise(resolve=>resolveCheck=resolve);},
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>live);live.options.onTranscript('Can you help me?');
  await new Promise(resolve=>setTimeout(resolve,250));level=0;
  await until(()=>resolveCheck,1500);page.overlay.close();
  assert.equal(signal.aborted,true);resolveCheck({available:true,complete:true});await tick();
  assert.equal(sent.length,0);
});

test('recorded-only browsers use recovery rather than wait for a nonexistent semantic transcript',async t=>{
  let level=0.1,offset=0;const sent=[];
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    recorder:true,recordingData:true,micLevel:()=>level,clockOffset:()=>offset,
    checkVoiceTurn:async()=>assert.fail('No caption source should request semantic checks'),
    transcribeAudio:async()=>({text:'A recorded question'}),
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>page.recorders.length);await new Promise(resolve=>setTimeout(resolve,250));level=0;
  await new Promise(resolve=>setTimeout(resolve,60));offset=2100;await until(()=>sent.length);
  assert.deepEqual(sent,['A recorded question']);
});

test('loss of live captions cancels an incomplete semantic turn and recovers its full recording',async t=>{
  let live,level=0.1,offset=0,checked=false;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.reject(new Error('Lost connection'));}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    recorder:true,liveTranscriber:Live,recordingData:true,micLevel:()=>level,clockOffset:()=>offset,
    checkVoiceTurn:async()=>{checked=true;return {available:true,complete:false};},
    transcribeAudio:async()=>({text:'A whole question recovered from audio'}),
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>live);live.options.onTranscript('An unfinished partial');
  await new Promise(resolve=>setTimeout(resolve,250));level=0;
  await new Promise(resolve=>setTimeout(resolve,60));offset=700;await until(()=>checked);
  live.options.onError(new Error('Lost connection'));offset=2100;await until(()=>sent.length);
  assert.deepEqual(sent,['A whole question recovered from audio']);
});


test('without an AudioWorklet, quiet automatically sends the entire recording to Deepgram', async t => {
  let level = 0.1, offset = 0;
  const sent = [];
  const page = await voicePage(async text => { sent.push(text); return ''; }, 'en', {
    recordingData: true, micLevel: () => level, clockOffset: () => offset,
    checkVoiceTurn: async () => assert.fail('No live transcript should request semantic checks'),
    transcribeAudio: async (_token, _audio, options) => {
      assert.equal(options.deepgramOnly, true);
      return { text: 'A complete recorded question' };
    },
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
  });
  t.after(() => page.overlay.close());
  await until(() => page.recorders[0]?.state === 'recording');
  await new Promise(resolve => setTimeout(resolve, 250));
  level = 0;
  await new Promise(resolve => setTimeout(resolve, 60));
  offset = 1900;
  await until(() => sent.length);
  assert.deepEqual(sent, ['A complete recorded question']);
  assert.equal(page.recognitions.length, 0);
});

test('semantic service failure falls back to acoustic quiet without dropping the question',async t=>{
  let live,level=0.1,offset=0;const sent=[];
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}
    finish(){return Promise.resolve('A question during a model outage');}
    cancel(){}
  }
  const page=await voicePage(async text=>{sent.push(text);return '';},'en',{
    recorder:true,liveTranscriber:Live,recordingData:true,micLevel:()=>level,clockOffset:()=>offset,
    checkVoiceTurn:async()=>({available:false,complete:false}),
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})});t.after(()=>page.overlay.close());
  await until(()=>live);live.options.onTranscript('A question during a model outage');
  await new Promise(resolve=>setTimeout(resolve,250));level=0;
  await new Promise(resolve=>setTimeout(resolve,60));offset=700;await until(()=>page.notices.length);
  assert.equal(sent.length,0);offset=2100;await until(()=>sent.length);
  assert.deepEqual(sent,['A question during a model outage']);assert.equal(page.notices.length,1);
});

test('semantic API sends bounded speech context with authentication and cancellation',async()=>{
  let captured;const controller=new AbortController();
  const app=moduleLoader({
    'config.js':{config:{apiUrl:'https://api.invalid'}},
    'auth.js':{getAuth:()=>({auth:{token:'session'}}),refreshSession:async()=>null},
    'supabaseClient.js':{isSupabaseConfigured:()=>false,supabaseClient(){}},
  },{globals:{fetch:async(url,options)=>{captured={url,...options};return new Response('{"available":true,"complete":true}');}}});
  const {checkVoiceTurn}=await app.load('js/api.js');
  await checkVoiceTurn('test','What is this?','Ask me anything',{signal:controller.signal});
  assert.equal(captured.url,'https://api.invalid/voice/turn');assert.equal(captured.headers.Authorization,'Bearer session');
  assert.equal(captured.signal,controller.signal);assert.deepEqual(JSON.parse(captured.body),{transcript:'What is this?',previous_assistant:'Ask me anything'});
});

test('voice waiting phrases rotate until audio starts and stop after closing',async t=>{
  let finish,handlers;
  const page=await voicePage((_text,callbacks)=>{
    handlers=callbacks;return new Promise(resolve=>finish=resolve);
  });t.after(()=>{page.overlay.close();finish?.('');});
  page.submit('A question');
  const status=page.dom.window.document.querySelector('.voice-status');
  const first=status.textContent;
  assert.notEqual(first,'Preparing response…');
  await until(()=>status.textContent!==first,3500);
  handlers.onDelta('Here is your answer.');
  await until(()=>page.dom.window.document.querySelector('.voice-overlay').dataset.state==='speaking');
  const speaking=status.textContent;
  await new Promise(resolve=>setTimeout(resolve,3100));
  assert.equal(status.textContent,speaking);
  page.overlay.close();const closed=status.textContent;
  await new Promise(resolve=>setTimeout(resolve,3100));
  assert.equal(status.textContent,closed);
});

test('all supported Voice languages have twelve distinct, nonrepeating local speech cues', async () => {
  const app=moduleLoader();
  const {VOICE_LANGUAGES}=await app.load('js/components/voice-languages.js');
  const {voiceAcknowledgments,getVoiceAcknowledgment}=await app.load('js/components/voice-acknowledgments.js');
  for(const language of VOICE_LANGUAGES) for(const kind of ['thinking','search']) {
    const choices=voiceAcknowledgments(language.id,kind);
    assert.equal(new Set(choices).size,12,language.label+' '+kind);
    const first=getVoiceAcknowledgment(language.id,kind);
    assert.notEqual(getVoiceAcknowledgment(language.id,kind),first);
    if(language.id!=='en') assert.ok(choices.every(text=>!text.includes("I'm searching")&&!text.includes('Let me think')));
  }
});

test('Urdu Voice announces an actual web search in Urdu', async t => {
  const page=await voicePage(async (_text,ctx)=>{ctx.onSearching();await tick();return 'یہ تازہ معلومات ہیں۔';},'ur');
  t.after(()=>page.overlay.close());page.submit('تازہ خبریں کیا ہیں؟');
  await until(()=>page.commands.some(command=>command.type==='Speak'));
  const first=page.commands.find(command=>command.type==='Speak');
  assert.match(first.text,/[\u0600-\u06ff]/);
  assert.match(first.text,/تلاش|آن لائن|معلومات/);
  assert.ok(new URL(first.url).searchParams.get('model').endsWith('-ur'));
});

test('a slow voice reply waits for the answer without a spoken search cue', async t => {
  let finish;
  const page=await voicePage(()=>new Promise(resolve=>{finish=resolve;}),'fr');
  t.after(()=>{page.overlay.close();finish?.('');});
  page.submit('Explique ce sujet.');
  await new Promise(resolve=>setTimeout(resolve,780));
  assert.equal(page.commands.some(command=>command.type==='Speak'),false);
  finish('Voici la réponse.');
  await until(()=>page.commands.some(command=>command.type==='Flush'));
  assert.deepEqual(page.commands.filter(command=>command.type==='Speak').map(command=>command.text.trim()),['Voici la réponse.']);
});

test('Urdu sentence punctuation starts speaking before model completion', async t => {
  let finish;
  const page=await voicePage((_text,ctx)=>{ctx.onDelta('یہ جواب ہے۔');return new Promise(resolve=>{finish=resolve;});},'ur');
  t.after(()=>page.overlay.close());page.submit('جواب دیں');
  await until(()=>page.commands.some(command=>command.type==='Speak'),500);
  assert.equal(page.commands.find(command=>command.type==='Speak').text.trim(),'یہ جواب ہے۔');
  finish('یہ جواب ہے۔');
});


test('an acknowledgment with no audio never blocks the actual answer', async t => {
  const reply='The answer is ready.';
  const page=await voicePage(async (_text,ctx)=>{ctx.onSearching();await tick();ctx.onDelta(reply);return reply;},'en',{silentFirstSpeech:true});
  t.after(()=>page.overlay.close());page.submit('Find the latest update.');
  await until(()=>page.commands.some(command=>command.type==='Speak'&&command.text.includes(reply)),500);
  assert.ok(page.commands.some(command=>command.type==='Interrupt'));
  assert.equal(page.sockets[0].readyState,3);
});

test('a failed searched turn cannot replay buffered answer text after its cue is cancelled', async t => {
  const page=await voicePage(async (_text,ctx)=>{
    ctx.onSearching();await tick();
    ctx.onDelta('Buffered partial answer.');
    throw new Error('Isolated provider failure');
  });
  t.after(()=>page.overlay.close());page.submit('Check the latest news.');
  await until(()=>page.notices.length===1);await tick();
  assert.ok(page.commands.filter(command=>command.type==='Speak').every(command=>!command.text.includes('Buffered partial answer')));
});


test('Auto uses a healthy finalized Deepgram transcript without uploading the recording again', async t => {
  let live, submitted;
  class Live {
    delivery = 'neutral';
    detectedLanguage = 'fr';
    constructor(options) { this.options = options; live = this; }
    async start() {}
    async finish() { return 'Bonjour, comment allez-vous ?'; }
    cancel() {}
  }
  const page = await voicePage(async (text, opts) => { submitted = { text, ...opts }; return 'Très bien, merci.'; }, 'auto', {
    liveTranscriber: Live, recordingData: true,
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    transcribeAudio: async () => assert.fail('A healthy stream should not upload a second copy'),
  });
  t.after(() => page.overlay.close());
  await until(() => live);
  assert.equal(live.options.language, 'multi');
  live.options.onUtteranceEnd();
  await until(() => page.commands.some(command => command.type === 'Speak'));
  assert.equal(submitted.text, 'Bonjour, comment allez-vous ?');
  assert.equal(submitted.language, 'fr');
  assert.ok(page.sockets.some(socket => socket.url.includes('model=flux-arnaud-fr')));
});

test('Auto recorded recovery applies a detected regional locale instead of the previous English voice',async t=>{
  let offset=0,submitted,request;
  const page=await voicePage(async(text,opts)=>{submitted={text,...opts};return '';},'auto',{
    recorder:true,recordingData:true,clockOffset:()=>offset,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]}),
    transcribeAudio:async(_token,_audio,opts)=>{request=opts;return {text:'Bonjour à vous.',language:'FR_fr'};},
  });t.after(()=>page.overlay.close());await until(()=>page.recorders[0]?.state==='recording');
  offset=1000;page.dom.window.document.querySelector('.voice-mic').click();await until(()=>submitted);
  assert.equal(request.language,'auto');assert.equal(request.deepgramOnly,true);assert.equal(submitted.language,'fr');
  assert.equal(submitted.languageName,'French');
});

test('Auto recovers the full recording when its live transcript is empty',async t=>{
  let live,submitted,uploads=0;
  class Live {constructor(options){this.options=options;live=this;}async start(){}finish(){return Promise.resolve('');}cancel(){}}
  const page=await voicePage(async text=>{submitted=text;return '';},'auto',{
    liveTranscriber:Live,recordingData:true,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]}),
    transcribeAudio:async()=>{uploads++;return {text:'The whole question.',language:'english'};},
  });t.after(()=>page.overlay.close());await until(()=>live);live.options.onUtteranceEnd();await until(()=>submitted);
  assert.equal(submitted,'The whole question.');assert.equal(uploads,1);
});

test('provider language names and regional tags normalize to supported voices',async()=>{
  const app=moduleLoader();const {normalizeVoiceLanguage}=await app.load('js/components/voice-languages.js');
  for(const [value,expected] of [['urdu','ur'],['FR_fr','fr'],['Greek','el'],['filipino','tl'],['nb-NO','no'],['en-US','en'],['not-supported',null],[null,null]]) {
    assert.equal(normalizeVoiceLanguage(value),expected);
  }
});

test('an explicitly selected voice language stays pinned despite different detection metadata',async t=>{
  let live,submitted;
  class Live {
    constructor(options){this.options=options;live=this;}
    async start(){}finish(){return Promise.resolve('آپ کیسے ہیں؟');}cancel(){}
  }
  const page=await voicePage(async(text,opts)=>{submitted=opts;return '';},'ur',{
    liveTranscriber:Live,recordingData:true,
    getUserMedia:async()=>({getTracks:()=>[{stop(){}}]}),
  });t.after(()=>page.overlay.close());await until(()=>live);
  live.options.onLanguage('fr');live.options.onUtteranceEnd();await until(()=>submitted);
  assert.equal(submitted.language,'ur');
});
