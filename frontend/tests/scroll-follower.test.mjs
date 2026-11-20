import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

test('jump to latest stays anchored to the composer and repins the feed', async t => {
  const callbacks = [];
  class FakeResizeObserver {
    constructor(cb) { this.cb = cb; callbacks.push(cb); }
    observe() {}
    disconnect() {}
  }
  const app = moduleLoader({}, { globals: { ResizeObserver: FakeResizeObserver } });
  const { ScrollFollower } = await app.load('js/chat/scroll-follower.js');
  const document = app.dom.window.document;
  document.body.innerHTML = '<div class="chat-page"><div class="chat-stream"></div><div class="composer-wrap"><form class="composer"></form></div></div>';
  const stream = document.querySelector('.chat-stream');
  Object.defineProperty(stream, 'scrollHeight', { value: 2000, configurable: true });
  const follower = new ScrollFollower(stream);
  follower.mount();
  t.after(() => follower.unmount());
  stream.scrollTop = 100;
  callbacks[0]();
  assert.equal(stream.scrollTop, 2000, 'pinned stream must chase bottom when viewport shrinks');
  follower.detach();
  stream.scrollTop = 500;
  callbacks[0]();
  assert.equal(stream.scrollTop, 500, 'detached stream must stay where user is reading');
  const button = document.querySelector('button[aria-label="Jump to latest"]');
  assert.ok(document.querySelector('.composer-wrap').contains(button), 'button must follow composer layout as the draft resizes');
  assert.equal(button.querySelector('svg').getAttribute('width'), '18');
  const styles = await readFile(new URL('../css/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.stream-jump-pill\s*\{[^}]*width:\s*35px;\s*height:\s*35px;/);
  button.click();
  assert.equal(stream.scrollTop, 2000);
  assert.equal(follower.pinned, true);
  assert.equal(document.querySelector('.stream-jump-pill'), null);
  follower.detach();
  follower.unmount();
  assert.equal(document.querySelector('.stream-jump-pill'), null);
});
