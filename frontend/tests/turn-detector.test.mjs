import assert from 'node:assert/strict';
import test from 'node:test';
import { SemanticTurnDetector } from '../js/chat/turn-detector.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,check){
  const calls=[],completed=[],failures=[];
  const detector=new SemanticTurnDetector({settleMs:5,timeoutMs:100,
    check:async(text,options)=>{calls.push({text,options});return check(text,options);},
    onComplete:text=>completed.push(text),onUnavailable:()=>failures.push(true)});
  t.after(()=>detector.cancel());
  return {detector,calls,completed,failures};
}

test('a completed thought submits after the semantic verdict, not a four-second timer',async t=>{
  const f=fixture(t,async()=>({available:true,complete:true}));
  f.detector.update('What is photosynthesis?');await wait(15);
  assert.equal(f.calls.length,0,'Do not evaluate while audio is active');
  f.detector.setSpeaking(false);await wait(15);
  assert.deepEqual(f.completed,['What is photosynthesis?']);
});

test('an unfinished thought waits indefinitely for more words and is evaluated once',async t=>{
  const f=fixture(t,async text=>({available:true,complete:text.endsWith('Lahore?')}));
  f.detector.update('What is the weather in');f.detector.setSpeaking(false);await wait(15);
  for(let i=0;i<20;i++)f.detector.setSpeaking(false);
  await wait(30);assert.equal(f.calls.length,1);assert.equal(f.completed.length,0);
  f.detector.update('What is the weather in Lahore?');await wait(15);
  assert.deepEqual(f.completed,['What is the weather in Lahore?']);
});

test('resumed audio cancels a pending verdict even before a new transcript arrives',async t=>{
  let resolve;
  const f=fixture(t,()=>new Promise(r=>resolve=r));
  f.detector.update('Can you help?');f.detector.setSpeaking(false);await wait(15);
  f.detector.setSpeaking(true);
  assert.equal(f.calls[0].options.signal.aborted,true);
  resolve({available:true,complete:true});await tick();
  assert.equal(f.completed.length,0);
});

test('new transcript text invalidates an old positive verdict',async t=>{
  const pending=[];
  const f=fixture(t,()=>new Promise(resolve=>pending.push(resolve)));
  f.detector.update('Can you help?');f.detector.setSpeaking(false);await wait(15);
  f.detector.update('Can you help with');await wait(15);
  pending[0]({available:true,complete:true});await tick();
  assert.equal(f.completed.length,0);
  pending[1]({available:true,complete:false});await tick();
  assert.equal(f.completed.length,0);
});

test('a bounded unavailable verdict enables recovery but never authorizes a semantic submission',async t=>{
  const f=fixture(t,async()=>({available:false,complete:false}));
  f.detector.update('A question');f.detector.setSpeaking(false);await wait(15);
  assert.equal(f.detector.unavailable,true);assert.equal(f.failures.length,1);assert.equal(f.completed.length,0);
});

test('a provider that ignores cancellation still cannot hold the detector indefinitely',async t=>{
  const f=fixture(t,()=>new Promise(()=>{}));
  f.detector.update('A question');f.detector.setSpeaking(false);await wait(130);
  assert.equal(f.detector.unavailable,true);assert.equal(f.calls[0].options.signal.aborted,true);
});

test('cancel prevents late completion and releases pending evaluation',async t=>{
  let resolve;
  const f=fixture(t,()=>new Promise(r=>resolve=r));
  f.detector.update('A question');f.detector.setSpeaking(false);await wait(15);
  f.detector.cancel();resolve({available:true,complete:true});await tick();
  assert.equal(f.completed.length,0);assert.equal(f.calls[0].options.signal.aborted,true);
});

test('a cleared recognition hypothesis invalidates its pending positive verdict',async t=>{
  let resolve;
  const f=fixture(t,()=>new Promise(r=>resolve=r));
  f.detector.update('Can you help?');f.detector.setSpeaking(false);await wait(15);
  f.detector.update('');resolve({available:true,complete:true});await tick();
  assert.equal(f.completed.length,0);assert.equal(f.calls[0].options.signal.aborted,true);
});
