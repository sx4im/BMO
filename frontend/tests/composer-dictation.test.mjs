import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

async function fixture(getUserMedia) {
  const sessions=[],notices=[];
  class Live {
    constructor(options){ this.options=options;sessions.push(this); }
    async start(stream){this.stream=stream;}
    finish(){return new Promise(resolve=>this.resolve=resolve);}
    cancel(){this.cancelled=true;}
  }
  const app=moduleLoader({
    'live-transcriber.js':{LiveTranscriber:Live},'api.js':{},
    'auth.js':{getAuth:()=>({auth:{token:'test'}})},
    'toast.js':{toast:message=>notices.push(message)},'image-modal.js':{openImageModal(){}},
  });
  Object.defineProperty(app.dom.window.navigator,'mediaDevices',{value:{getUserMedia}});
  const {Composer}=await app.load('js/chat/composer.js');
  const composer=Object.create(Composer.prototype);
  Object.assign(composer,{getAuthToken:()=> 'test',textarea:app.dom.window.document.createElement('textarea'),
    showRecordingBar(on){this.isRecording=on;},startRecordTimer(){},stopRecordTimer(){},
    startWaveMeter(){},stopWaveMeter(){},setTranscribingUI(){},autoSize(){},syncSendEnabled(){},syncUrlHighlight(){}});
  composer.textarea.value='Existing draft';
  return {composer,sessions,notices,app};
}

test('composer shows revised words live and confirms only after the final audio flush',async()=>{
  let stopped=0;
  const f=await fixture(async()=>({getTracks:()=>[{stop(){stopped++;}}]}));
  await f.composer.startVoiceRecording();
  f.sessions[0].options.onTranscript('hello');
  assert.equal(f.composer.textarea.value,'Existing draft hello');
  f.sessions[0].options.onTranscript('Hello world.');
  assert.equal(f.composer.textarea.value,'Existing draft Hello world.');
  const finish=f.composer.confirmRecording();
  assert.equal(f.composer.isRecording,true);
  f.sessions[0].resolve('Hello world!');await finish;
  assert.equal(f.composer.textarea.value,'Existing draft Hello world!');
  assert.equal(f.composer.isRecording,false);
  assert.ok(stopped>0);
});

test('cancel restores the exact draft and ignores late transcript events',async()=>{
  const f=await fixture(async()=>({getTracks:()=>[{stop(){}}]}));
  await f.composer.startVoiceRecording();
  f.sessions[0].options.onTranscript('discard me');
  f.composer.discardRecording();
  f.sessions[0].options.onTranscript('late words');
  assert.equal(f.composer.textarea.value,'Existing draft');
  assert.equal(f.sessions[0].cancelled,true);
});

test('cancel while microphone permission is pending releases a late microphone',async()=>{
  let resolve,stopped=0;
  const f=await fixture(()=>new Promise(r=>resolve=r));
  const started=f.composer.startVoiceRecording();
  f.composer.discardRecording();
  resolve({getTracks:()=>[{stop(){stopped++;}}]});await started;
  assert.equal(stopped,1);
  assert.equal(f.sessions.length,0);
});

test('composer can explicitly select Urdu instead of unsupported multilingual detection',async()=>{
  const f=await fixture(async()=>({getTracks:()=>[{stop(){}}]}));
  await f.composer.startVoiceRecording();
  f.sessions[0].options.onTranscript('discarded language');
  await f.composer.changeDictationLanguage('ur');
  assert.equal(f.sessions[0].cancelled,true);
  assert.equal(f.sessions[1].options.language,'ur');
  assert.equal(f.composer.textarea.value,'Existing draft');
  f.composer.discardRecording();
});

test('composer synchronizes its displayed language after preferences change in Voice',async()=>{
  const f=await fixture(async()=>({getTracks:()=>[{stop(){}}]}));
  f.composer.recLanguage=f.app.dom.window.document.createElement('select');
  for(const language of ['auto','ur']) {
    const option=f.app.dom.window.document.createElement('option');option.value=language;
    f.composer.recLanguage.append(option);
  }
  f.app.dom.window.localStorage.setItem('bimo-voice-auto-lang','0');
  f.app.dom.window.localStorage.setItem('bimo-voice-lang','ur');
  await f.composer.startVoiceRecording();
  assert.equal(f.composer.recLanguage.value,'ur');
  assert.equal(f.sessions[0].options.language,'ur');
  f.composer.discardRecording();
});
