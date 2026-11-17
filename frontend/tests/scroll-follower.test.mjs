import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

test('jump to latest stays anchored to the composer and repins the feed', async t => {
  const app = moduleLoader();
  const { ScrollFollower } = await app.load('js/chat/scroll-follower.js');
  const document = app.dom.window.document;
  document.body.innerHTML = '<div class="chat-page"><div class="chat-stream"></div><div class="composer-wrap"><form class="composer"></form></div></div>';
  const stream = document.querySelector('.chat-stream');
  Object.defineProperty(stream, 'scrollHeight', { value: 2000 });
  const follower = new ScrollFollower(stream);
  follower.mount();
  t.after(() => follower.unmount());
  follower.detach();
  const button = document.querySelector('button[aria-label="Jump to latest"]');
  assert.ok(document.querySelector('.composer-wrap').contains(button), 'button must follow composer layout as the draft resizes');
  button.click();
  assert.equal(stream.scrollTop, 2000);
  assert.equal(follower.pinned, true);
  assert.equal(document.querySelector('.stream-jump-pill'), null);
  follower.detach();
  follower.unmount();
  assert.equal(document.querySelector('.stream-jump-pill'), null);
});
