import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

async function scene({ reduced = false, available = true, shaderOK = true } = {}) {
  const callbacks = new Map();
  const calls = { draws: 0, deletedPrograms: 0, deletedShaders: 0, deletedArrays: 0 };
  let serial = 0, intersect;
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    TRIANGLES: 5, COLOR_BUFFER_BIT: 6,
    createShader: () => ({}), shaderSource() {}, compileShader() {},
    getShaderParameter: () => shaderOK, getShaderInfoLog: () => 'compile failed',
    deleteShader() { calls.deletedShaders++; },
    createProgram: () => ({}), attachShader() {}, linkProgram() {},
    getProgramParameter: () => true, getProgramInfoLog: () => '',
    deleteProgram() { calls.deletedPrograms++; },
    createVertexArray: () => ({}), bindVertexArray() {},
    deleteVertexArray() { calls.deletedArrays++; },
    getUniformLocation: (_, name) => name, useProgram() {}, viewport() {},
    uniform1f() {}, uniform2f() {}, clearColor() {}, clear() {},
    drawArrays() { calls.draws++; },
  };
  const app = moduleLoader({}, { globals: {
    requestAnimationFrame: callback => { const id = ++serial; callbacks.set(id, callback); return id; },
    cancelAnimationFrame: id => callbacks.delete(id),
  } });
  const { document } = app.dom.window;
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  app.dom.window.matchMedia = () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} });
  app.dom.window.IntersectionObserver = class {
    constructor(callback) { intersect = callback; }
    observe() {} disconnect() {}
  };
  Object.defineProperty(app.dom.window, 'devicePixelRatio', { value: 3 });
  const canvas = document.createElement('canvas');
  canvas.getContext = () => available ? gl : null;
  canvas.getBoundingClientRect = () => ({ width: 96, height: 96 });
  document.body.append(canvas);
  const { createVoiceOrb } = await app.load('js/components/voice-orb.js');
  const orb = createVoiceOrb(canvas);
  return { ...app, orb, canvas, callbacks, calls, intersect,
    tick(time = 100) { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(fn => fn(time)); },
  };
}

test('orb caps DPR, owns one loop, and deletes its GPU resources on destroy', async () => {
  const view = await scene();
  assert.equal(view.canvas.dataset.renderer, 'webgl2');
  assert.equal(view.canvas.width, 192);
  assert.equal(view.callbacks.size, 1);
  view.orb.setState('speaking');
  view.orb.setLevels({ playback: 0.8, low: 0.6, mid: 0.4 });
  view.orb.resize();
  assert.equal(view.callbacks.size, 1);
  view.tick();
  assert.equal(view.calls.draws, 1);
  assert.equal(view.callbacks.size, 1);
  view.orb.destroy();
  view.orb.destroy();
  assert.equal(view.callbacks.size, 0);
  assert.equal(view.calls.deletedPrograms, 1);
  assert.equal(view.calls.deletedShaders, 2);
  assert.equal(view.calls.deletedArrays, 1);
  view.orb.setState('thinking');
  assert.equal(view.callbacks.size, 0);
});

test('hidden and offscreen orbs suspend and resume without multiplying loops', async () => {
  const view = await scene();
  Object.defineProperty(view.dom.window.document, 'hidden', { value: true, configurable: true });
  view.dom.window.document.dispatchEvent(new view.dom.window.Event('visibilitychange'));
  assert.equal(view.callbacks.size, 0);
  Object.defineProperty(view.dom.window.document, 'hidden', { value: false, configurable: true });
  view.dom.window.document.dispatchEvent(new view.dom.window.Event('visibilitychange'));
  assert.equal(view.callbacks.size, 1);
  view.intersect([{ isIntersecting: false }]);
  assert.equal(view.callbacks.size, 0);
  view.intersect([{ isIntersecting: true }]);
  assert.equal(view.callbacks.size, 1);
  view.orb.destroy();
});

test('reduced motion draws a still frame without a continuous animation loop', async () => {
  const view = await scene({ reduced: true });
  view.tick();
  assert.equal(view.calls.draws, 1);
  assert.equal(view.callbacks.size, 0);
  view.orb.setLevels({ playback: 1 });
  assert.equal(view.callbacks.size, 0);
  view.orb.destroy();
});

test('unavailable GPU and shader failures use a quiet fallback without a loop', async () => {
  for (const options of [{ available: false }, { shaderOK: false }]) {
    const view = await scene(options);
    assert.equal(view.canvas.dataset.renderer, 'fallback');
    assert.equal(view.callbacks.size, 0);
    view.orb.destroy();
  }
});

test('context loss prevents default, stops rendering, and rebuilds on restoration', async () => {
  const view = await scene();
  const lost = new view.dom.window.Event('webglcontextlost', { cancelable: true });
  view.canvas.dispatchEvent(lost);
  assert.equal(lost.defaultPrevented, true);
  assert.equal(view.callbacks.size, 0);
  view.canvas.dispatchEvent(new view.dom.window.Event('webglcontextrestored'));
  assert.equal(view.canvas.dataset.renderer, 'webgl2');
  assert.equal(view.callbacks.size, 1);
  view.orb.destroy();
});

test('sustained slow frames reduce pixel work without changing the CSS orb size', async () => {
  const view = await scene();
  for (let time = 100; time <= 3000; time += 80) view.tick(time);
  assert.ok(view.canvas.width < 192);
  assert.ok(view.canvas.width >= 96);
  assert.equal(view.canvas.getBoundingClientRect().width, 96);
  assert.equal(view.callbacks.size, 1);
  view.orb.destroy();
});
