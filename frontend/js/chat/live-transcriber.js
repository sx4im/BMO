import * as api from '../api.js?v=73';

const CONNECTION_TIMEOUT_MS = 10000;
const FINAL_TIMEOUT_MS = 5000;
const MAX_PENDING_SECONDS = 5;

// One microphone take. The caller owns the stream; this owns capture + socket.
export class LiveTranscriber {
  constructor({ token, language, endpointingMs = 2000, onTranscript, onLanguage, onUtteranceEnd, onError } = {}) {
    Object.assign(this, { token, language, endpointingMs, onTranscript, onLanguage, onUtteranceEnd, onError });
    this.controller = new AbortController();
    this.pending = [];
    this.pendingBytes = 0;
    this.finals = new Map();
    this.interim = '';
    this.audioSeconds = 0;
    this.energy = 0;
    this.audioFrames = 0;
    this.delivery = 'neutral';
    this.done = false;
    this.finishing = false;
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // Failure can precede a caller pressing confirm; retain it for finish().
    this.result.catch(() => {});
  }

  get text() { return [...this.finals.values(), this.interim].filter(Boolean).join(' ').trim(); }

  async start(stream) {
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio || typeof AudioWorkletNode === 'undefined') throw Error('Live microphone input is not supported in this browser.');
      this.context = new Audio();
      this.sampleRate = this.context.sampleRate;
      // Resume inside the originating user gesture, before network awaits.
      const resumed = this.context.resume();
      this.connectTimer = setTimeout(() => this.fail(Error('Microphone connection timed out. Please try again.')), CONNECTION_TIMEOUT_MS);
      await Promise.all([resumed, this.context.audioWorklet.addModule('/js/chat/pcm-capture-worklet.js?v=2')]);
      if (this.done) return;
      this.source = this.context.createMediaStreamSource(stream);
      this.capture = new AudioWorkletNode(this.context, 'bimo-pcm-capture');
      this.capture.port.onmessage = ({ data }) => {
        if (this.done) return;
        if (data?.type === 'flushed') {
          this.captureFlushed = true;
          this.stopCapture();
          this.closeStream();
        } else if (data instanceof ArrayBuffer) this.sendAudio(data);
        else if (data?.audio instanceof ArrayBuffer) {
          this.audioSeconds += data.duration;
          if (data.rms > 0.008) { this.energy += data.rms; this.audioFrames++; }
          this.sendAudio(data.audio);
        }
      };
      this.capture.onprocessorerror = () => this.fail(Error('Microphone capture failed. Please try again.'));
      this.source.connect(this.capture);
      // Worklet writes silence to its output; only the microphone is transmitted.
      this.capture.connect(this.context.destination);
      if (this.finishing) this.capture.port.postMessage({ type: 'flush' });
      const grant = await api.createTranscriptionToken(this.token, { signal: this.controller.signal });
      if (this.done) return;
      const query = new URLSearchParams({ model: grant.model || 'nova-3', language: this.language || grant.language || 'multi',
        encoding: 'linear16', sample_rate: String(this.sampleRate), channels: '1',
        interim_results: 'true', smart_format: 'true', punctuate: 'true', endpointing: String(this.endpointingMs) });
      const socket = this.socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${query}`, ['bearer', grant.access_token]);
      socket.onopen = () => {
        if (this.done) return;
        clearTimeout(this.connectTimer);
        for (const bytes of this.pending) this.sendAudio(bytes);
        this.pending = [];
        this.pendingBytes = 0;
        if (this.captureFlushed) this.closeStream();
      };
      socket.onmessage = ({ data }) => {
        if (this.done) return;
        let event;
        try { event = JSON.parse(data); } catch { this.fail(Error('Invalid transcription response.')); return; }
        if (event.type === 'Results') {
          const alternative = event.channel?.alternatives?.[0];
          const text = alternative?.transcript?.trim() || '';
          if (event.is_final) {
            if (text) this.finals.set(event.start, text);
            this.interim = '';
            if (text) {
              // Provider languages are ordered by word count. A borrowed word
              // at the end must not select the whole reply's language/voice.
              const counts = new Map();
              for (const word of alternative.words || []) {
                if (word.language) counts.set(word.language, (counts.get(word.language) || 0) + 1);
              }
              const dominant = alternative.languages?.[0] || [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
              if (dominant) { this.detectedLanguage = dominant; this.onLanguage?.(dominant); }
              const words = alternative.words || [];
              const duration = words.length ? words.at(-1).end - words[0].start : 0;
              const rate = duration > 0 && words.length >= 4 ? words.length / duration : 0;
              const meanEnergy = this.audioFrames ? this.energy / this.audioFrames : 0;
              // Delivery hints describe observable pace/volume, never emotion.
              this.delivery = rate > 3.2 ? 'lively' : (rate > 0 && rate < 1.6) || (meanEnergy > 0 && meanEnergy < 0.018) ? 'gentle' : 'neutral';
            }
          } else this.interim = text;
          this.onTranscript?.(this.text);
          if (event.speech_final && this.text && !this.finishing) this.onUtteranceEnd?.();
        } else if (event.type === 'Metadata' && this.closeSent) {
          if (this.interim) this.fail(Error('The final transcription was incomplete. Please try again.'));
          else this.complete();
        } else if (event.type === 'Error') this.fail(Error('Deepgram could not transcribe this audio. Please try again.'));
      };
      socket.onerror = () => this.fail(Error('Could not connect to live transcription. Please try again.'));
      socket.onclose = () => { if (!this.done) this.fail(Error('Transcription connection disconnected. Please try again.')); };
    } catch (error) {
      if (!this.done) this.fail(error);
    }
  }

  sendAudio(bytes) {
    if (this.done || !bytes.byteLength) return;
    if (this.socket?.readyState === 1) {
      if (this.socket.bufferedAmount > this.sampleRate * 2 * MAX_PENDING_SECONDS) {
        this.fail(Error('Your connection is too slow for live transcription. Please try again.'));
      } else this.socket.send(bytes);
    } else {
      this.pendingBytes += bytes.byteLength;
      if (this.pendingBytes > this.sampleRate * 2 * MAX_PENDING_SECONDS) {
        this.fail(Error('Live transcription is taking too long to connect. Please try again.'));
      } else this.pending.push(bytes);
    }
  }

  finish() {
    if (!this.done && !this.finishing) {
      this.finishing = true;
      this.finalTimer = setTimeout(() => this.fail(Error('Transcription did not finish. Please try again.')), FINAL_TIMEOUT_MS);
      // The worklet acknowledges only after sending its last partial PCM frame.
      if (this.capture) this.capture.port.postMessage({ type: 'flush' });
    }
    return this.result;
  }

  closeStream() {
    if (!this.done && this.finishing && this.captureFlushed && this.socket?.readyState === 1 && !this.closeSent) {
      this.closeSent = true;
      this.socket.send(JSON.stringify({ type: 'CloseStream' }));
    }
  }

  stopCapture() {
    this.source?.disconnect();
    this.capture?.disconnect();
    this.capture?.port.close();
    this.source = null;
    this.capture = null;
    if (this.context) { this.context.close().catch(() => {}); this.context = null; }
  }

  cleanup() {
    clearTimeout(this.connectTimer);
    clearTimeout(this.finalTimer);
    this.controller.abort();
    this.stopCapture();
    if (this.socket) { this.socket.onclose = null; this.socket.onerror = null; this.socket.close(); }
    this.pending = [];
    this.pendingBytes = 0;
  }

  complete() {
    if (this.done) return;
    this.done = true;
    this.resolve(this.text);
    this.cleanup();
  }

  fail(error) {
    if (this.done) return;
    this.done = true;
    this.reject(error);
    this.cleanup();
    this.onError?.(error);
  }

  cancel() { this.fail(new DOMException('Microphone input cancelled', 'AbortError')); }
}
