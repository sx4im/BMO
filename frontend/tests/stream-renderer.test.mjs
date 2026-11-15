import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

async function renderer() {
  const app=moduleLoader({'markdown.js':{renderMarkdown:source=>source.trim()?'<p>'+source.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</p>' : ''}});
  const {StreamingRenderer}=await app.load('js/chat/stream-renderer.js');
  const bubble=app.dom.window.document.createElement('div');app.dom.window.document.body.append(bubble);
  return {bubble,view:new StreamingRenderer(bubble)};
}

test('appending chunks preserves closed blocks and moves the outer spacing boundary',async()=>{
  const {bubble,view}=await renderer();
  view.pendingText='First paragraph.\n\nSecond paragraph.\n';view._flush();
  const frozen=view.blockEls[0];assert.ok(frozen);
  view.pendingText+='\n\nThird paragraph.';view._flush();
  assert.equal(view.blockEls[0],frozen);
  assert.equal(bubble.querySelectorAll('.stream-last').length,1);
  assert.match(bubble.querySelector('.stream-last').textContent,/Third paragraph/);
  assert.equal(frozen.classList.contains('stream-last'),false);
});

test('an empty tail after a closed fence does not become the visible spacing boundary',async()=>{
  const {bubble,view}=await renderer();
  const source='Introduction.\n\n```js\nconst n = 1;\n```\n';
  view.pendingText=source;view._flush();
  assert.equal(view.tailEl.childNodes.length,0);
  assert.equal(bubble.querySelector('.stream-last'),view.blockEls.at(-1));
  view.finish(source);
  assert.equal(bubble.querySelector('.cursor'),null);
  assert.equal(bubble.querySelectorAll('.stream-last').length,1);
});

test('leading blank chunks do not take the visible first-block spacing boundary',async()=>{
  const {bubble,view}=await renderer();
  view.pendingText='\n\n## Heading\n';view._flush();
  assert.equal(view.blockEls[0].childNodes.length,0);
  assert.equal(bubble.querySelector('.stream-first'),view.tailEl);
  assert.equal(bubble.querySelectorAll('.stream-first').length,1);
});
