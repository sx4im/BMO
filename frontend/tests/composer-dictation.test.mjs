import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

async function fixture({ getUserMedia, transcribe, convert, recorderFails=false }={}) {
  const recorders=[],uploads=[],notices=[];let stopped=0;
  class Recorder {
    static isTypeSupported(){return true;}
    state='inactive';mimeType='audio/webm';listeners={};
    constructor(){recorders.push(this);}
    addEventListener(name,handler){this.listeners[name]=handler;}
    start(){if(recorderFails)throw Error('Capture failed');this.state='recording';}
    stop(){this.state='inactive';queueMicrotask(()=>{this.listeners.dataavailable?.({data:new Blob(['recorded audio'])});this.listeners.stop?.();});}
  }
  const app=moduleLoader({
    'api.js':{transcribeAudio:async(token,blob,options)=>{uploads.push({token,blob,options});return transcribe?transcribe(token,blob,options):{text:'Recorded words.'};}},
    'audio-wav.js':{blobToWav16kMono:convert|| (async()=>new Blob(['wav'],{type:'audio/wav'}))},
    'auth.js':{getAuth:()=>({auth:{token:'test'}})},
    'toast.js':{toast:message=>notices.push(message)},'image-modal.js':{openImageModal(){}},
  },{globals:{MediaRecorder:Recorder,Blob}});
  Object.defineProperty(app.dom.window.navigator,'mediaDevices',{value:{getUserMedia:getUserMedia|| (async()=>({getTracks:()=>[{stop(){stopped++;}}]}))}});
  const {Composer}=await app.load('js/chat/composer.js');
  const composer=Object.create(Composer.prototype);
  Object.assign(composer,{getAuthToken:()=> 'test',textarea:app.dom.window.document.createElement('textarea'),
    showRecordingBar(on){this.isRecording=on;},startRecordTimer(){},stopRecordTimer(){},
    startWaveMeter(){},stopWaveMeter(){},setTranscribingUI(){},autoSize(){},syncSendEnabled(){},syncUrlHighlight(){}});
  composer.textarea.value='Existing draft';
  return {composer,recorders,uploads,notices,app,Composer,stopped:()=>stopped};
}

test('composer records locally and adds text only after confirmation and transcription',async()=>{
  let resolve;
  const f=await fixture({transcribe:()=>new Promise(r=>resolve=r)});
  await f.composer.startVoiceRecording();
  assert.equal(f.recorders[0].state,'recording');
  assert.equal(f.uploads.length,0);
  assert.equal(f.composer.textarea.value,'Existing draft');
  const finish=f.composer.confirmRecording();await new Promise(setImmediate);
  assert.equal(f.uploads.length,1);
  assert.equal(f.uploads[0].blob.type,'audio/wav');
  assert.equal(f.composer.textarea.value,'Existing draft');
  resolve({text:'Hello world!'});await finish;
  assert.equal(f.composer.textarea.value,'Existing draft Hello world!');
  assert.equal(f.composer.isRecording,false);
  assert.ok(f.stopped()>0);
});

test('cancel discards recorded audio without requesting transcription',async()=>{
  const f=await fixture();await f.composer.startVoiceRecording();
  f.composer.discardRecording();await new Promise(setImmediate);
  assert.equal(f.recorders[0].state,'inactive');
  assert.equal(f.uploads.length,0);
  assert.equal(f.composer.textarea.value,'Existing draft');
});

test('cancel during pending transcription aborts and ignores late text',async()=>{
  let resolve;
  const f=await fixture({transcribe:()=>new Promise(r=>resolve=r)});
  await f.composer.startVoiceRecording();const finished=f.composer.confirmRecording();
  await new Promise(setImmediate);f.composer.discardRecording();
  assert.equal(f.uploads[0].options.signal.aborted,true);
  resolve({text:'late result'});await finished;
  assert.equal(f.composer.textarea.value,'Existing draft');
});

test('cancel while microphone permission is pending releases a late microphone',async()=>{
  let resolve,stopped=0;
  const f=await fixture({getUserMedia:()=>new Promise(r=>resolve=r)});
  const started=f.composer.startVoiceRecording();f.composer.discardRecording();
  resolve({getTracks:()=>[{stop(){stopped++;}}]});await started;
  assert.equal(stopped,1);assert.equal(f.recorders.length,0);
});

test('composer automatically detects language and ignores an old Voice preference',async()=>{
  const f=await fixture();
  f.app.dom.window.localStorage.setItem('bimo-voice-auto-lang','0');
  f.app.dom.window.localStorage.setItem('bimo-voice-lang','ur');
  await f.composer.startVoiceRecording();await f.composer.confirmRecording();
  assert.equal(f.uploads[0].options.language,'multi');
  assert.equal(f.composer.changeDictationLanguage,undefined);
});

test('recorder initialization failure releases the microphone and leaves the draft intact',async()=>{
  const f=await fixture({recorderFails:true});await f.composer.startVoiceRecording();
  assert.ok(f.stopped()>0);assert.equal(f.composer.isRecording,false);
  assert.equal(f.composer.textarea.value,'Existing draft');
  assert.equal(f.notices.length,1);
});

test('failed conversion reports an error and never uploads mislabeled audio',async()=>{
  const f=await fixture({convert:async()=>{throw Error('Could not decode recording');}});
  await f.composer.startVoiceRecording();await f.composer.confirmRecording();
  assert.equal(f.uploads.length,0);assert.equal(f.composer.textarea.value,'Existing draft');
  assert.equal(f.composer.isRecording,false);assert.equal(f.notices.length,1);
});


test('composer recording UI has no language selector',async()=>{
  const f=await fixture();const composer=new f.Composer({getAuthToken:()=> 'test'});
  assert.equal(composer.element.querySelector('[aria-label="Dictation language"]'),null);
  assert.equal(composer.element.querySelector('.rec-language'),null);
  composer.destroy();
});

test('extended thinking is available only for Nexos during the Stanza Groq experiment',async()=>{
  const f=await fixture();const composer=new f.Composer({getAuthToken:()=> 'test'});
  composer.extendedThinking=true;
  composer.currentModel='thinking';composer.renderModelDropdown();
  assert.equal(composer.modelDropdown.querySelector('.extended-thinking-item'),null);
  assert.equal(composer.getReasoningEffort('thinking'),null);
  composer.currentModel='deep';composer.renderModelDropdown();
  const option=composer.modelDropdown.querySelector('.extended-thinking-item');
  assert.ok(option);assert.equal(option.getAttribute('aria-checked'),'true');
  assert.equal(composer.getReasoningEffort('deep'),'high');
  composer.toggleExtendedThinking();
  assert.equal(composer.getReasoningEffort('deep'),'low');
  assert.equal(composer.getReasoningEffort('thinking'),null);
  composer.destroy();
});
