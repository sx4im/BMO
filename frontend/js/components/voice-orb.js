import { vertexShader, fragmentShader } from './voice-orb-shaders.js?v=2';

const STATES = {
  idle: { speed: 0.025, activity: 0 },
  listening: { speed: 0.045, activity: 0.15 },
  thinking: { speed: 0.13, activity: 0.45 },
  speaking: { speed: 0.055, activity: 0.2 },
};
const LEVEL_KEYS = ['mic', 'playback', 'low', 'mid'];
const clamp = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Owns only the canvas and GPU resources. Voice capture and playback stay outside. */
export function createVoiceOrb(canvas) {
  const view = canvas.ownerDocument.defaultView;
  const doc = canvas.ownerDocument;
  const reducedMotion = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  let gl = null;
  let gpu = null;
  let frame = null;
  let destroyed = false;
  let contextLost = false;
  let inView = true;
  let state = 'idle';
  const targets = { mic: 0, playback: 0, low: 0, mid: 0 };
  let level = 0, low = 0, mid = 0, activity = 0;
  let speed = STATES.idle.speed;
  let time = 0;
  let previous = null;
  let lastDraw = -Infinity;
  let resolutionScale = 1;
  let slowFrames = 0;

  function cancelFrame() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    previous = null;
  }

  function release() {
    if (!gpu) return;
    gl.deleteProgram(gpu.program);
    gl.deleteVertexArray(gpu.vao);
    gpu = null;
  }

  function compile(type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Shader allocation failed');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const detail = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Voice orb shader compilation failed: ${detail}`);
    }
    return shader;
  }

  function initialize() {
    if (destroyed) return;
    canvas.dataset.renderer = 'fallback';
    let vertex = null, fragment = null, program = null, vao = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: true, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, powerPreference: 'low-power',
      });
      if (!gl) return;
      vertex = compile(gl.VERTEX_SHADER, vertexShader);
      fragment = compile(gl.FRAGMENT_SHADER, fragmentShader);
      program = gl.createProgram();
      if (!program) throw new Error('Program allocation failed');
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error('Voice orb shader linking failed');
      }
      vao = gl.createVertexArray();
      if (!vao) throw new Error('Vertex array allocation failed');
      const uniforms = Object.fromEntries(
        ['Resolution', 'Time', 'Activity', 'Level', 'Low', 'Mid']
          .map(name => [name, gl.getUniformLocation(program, `u${name}`)]),
      );
      gpu = { program, vao, uniforms };
      canvas.dataset.renderer = 'webgl2';
      resize();
    } catch (error) {
      console.warn("Voice orb renderer unavailable; using static fallback.", error);
      if (program) gl.deleteProgram(program);
      if (vao) gl.deleteVertexArray(vao);
      gpu = null;
    } finally {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
    }
  }

  function visible() {
    return !destroyed && !contextLost && !doc.hidden && inView;
  }

  function requestFrame() {
    if (frame === null && gpu && visible()) frame = requestAnimationFrame(draw);
  }

  function draw(now) {
    frame = null;
    if (!gpu || !visible()) return;
    const still = reducedMotion?.matches;
    if (still || now - lastDraw >= 1000 / 30 - 1) {
      const elapsed = previous === null ? 1 / 30 : (now - previous) / 1000;
      // Reduce pixels only after sustained slow frames, never change the layout.
      if (!still) {
        slowFrames = elapsed > 0.045 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
        if (slowFrames >= 12 && resolutionScale > 0.65) {
          resolutionScale = Math.max(0.65, resolutionScale * 0.85);
          slowFrames = 0;
          resize();
        }
      }
      const dt = Math.min(elapsed, 0.1);
      previous = now;
      lastDraw = now;
      const desired = STATES[state];
      const amplitude = state === 'listening' ? targets.mic : state === 'speaking' ? targets.playback : 0;
      // Audio envelopes use quick attack and slower release; state flow changes gently.
      level += (amplitude-level)*(1-Math.exp(-dt/(amplitude>level ? 0.055 : 0.22)));
      low += (targets.low-low)*(1-Math.exp(-dt/0.18));
      mid += (targets.mid-mid)*(1-Math.exp(-dt/0.09));
      activity += (desired.activity-activity)*(1-Math.exp(-dt/0.4));
      speed += (desired.speed + level * 0.22 - speed)*(1-Math.exp(-dt/0.4));
      if (!still) time += dt*speed;
      const { uniforms } = gpu;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(gpu.program);
      gl.bindVertexArray(gpu.vao);
      gl.uniform2f(uniforms.Resolution, canvas.width, canvas.height);
      gl.uniform1f(uniforms.Time, time);
      gl.uniform1f(uniforms.Activity, still ? 0 : activity);
      gl.uniform1f(uniforms.Level, still ? 0 : level);
      gl.uniform1f(uniforms.Low, still ? 0 : low);
      gl.uniform1f(uniforms.Mid, still ? 0 : mid);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (!still) requestFrame();
  }

  function resize() {
    if (destroyed) return;
    const bounds = canvas.getBoundingClientRect();
    const dpr = Math.min(view.devicePixelRatio || 1, 2);
    const side = Math.max(32, Math.min(384, Math.round(Math.min(bounds.width || 96, bounds.height || 96)*dpr*resolutionScale)));
    if (canvas.width !== side || canvas.height !== side) {
      canvas.width = side;
      canvas.height = side;
    }
    lastDraw = -Infinity;
    requestFrame();
  }

  function visibilityChanged() {
    cancelFrame();
    lastDraw = -Infinity;
    requestFrame();
  }
  function lost(event) {
    event.preventDefault();
    contextLost = true;
    cancelFrame();
    // Context loss invalidates all GL objects; restoration creates new ones.
    gpu = null;
    canvas.dataset.renderer = 'fallback';
  }
  function restored() {
    contextLost = false;
    initialize();
  }
  const resizeObserver = view.ResizeObserver ? new view.ResizeObserver(resize) : null;
  const intersectionObserver = view.IntersectionObserver
    ? new view.IntersectionObserver(entries => {
      inView = entries[0]?.isIntersecting !== false;
      visibilityChanged();
    }) : null;
  resizeObserver?.observe(canvas);
  intersectionObserver?.observe(canvas);
  view.addEventListener('resize', resize);
  doc.addEventListener('visibilitychange', visibilityChanged);
  reducedMotion?.addEventListener?.('change', visibilityChanged);
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);
  initialize();

  return {
    setState(next) {
      if (destroyed || !Object.hasOwn(STATES, next)) return;
      state = next;
    },
    setLevels(levels = {}) {
      if (destroyed) return;
      for (const key of LEVEL_KEYS) targets[key] = clamp(levels[key] ?? targets[key]);
    },
    resize,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelFrame();
      release();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      view.removeEventListener('resize', resize);
      doc.removeEventListener('visibilitychange', visibilityChanged);
      reducedMotion?.removeEventListener?.('change', visibilityChanged);
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
    },
  };
}
