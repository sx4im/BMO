import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

async function meterFor(signal = 0, band = 0, sampleRate = 48000) {
  const input = { signal, band };
  const analyser = {
    fftSize: 512,
    frequencyBinCount: 256,
    getFloatTimeDomainData(data) {
      for (let i = 0; i < data.length; i++) data[i] = input.signal * (i % 2 ? 1 : -1);
    },
    getByteFrequencyData(data) { data.fill(0); data[input.band] = 255; },
  };
  const app = moduleLoader();
  const { createAudioMeter } = await app.load('js/components/voice-audio-meter.js');
  return { input, meter: createAudioMeter(analyser, sampleRate) };
}

test('microphone noise is gated and genuine waveform energy drives a smooth envelope', async () => {
  const { input, meter } = await meterFor(0.002);
  assert.equal(meter.sample(0).level, 0);
  input.signal = 0.1;
  const onset = meter.sample(16).level;
  const sustained = meter.sample(66).level;
  assert.ok(onset > 0 && sustained > onset && sustained <= 1);
  input.signal = 0;
  const release = meter.sample(82).level;
  assert.ok(release > 0 && release < sustained);
  assert.ok(meter.sample(1082).level < 0.01);
});

test('frequency bands use the analyser sample rate and remain silent behind the waveform gate', async () => {
  const { input, meter } = await meterFor(0.1, 2);
  const low = { ...meter.sample(0) };
  assert.ok(low.low > 0 && low.mid === 0);
  input.band = 12;
  const mid = meter.sample(100);
  assert.ok(mid.mid > 0);
  input.signal = 0;
  const quiet = meter.sample(2100);
  assert.ok(quiet.low < 0.01 && quiet.mid < 0.01);
});

test('missing waveform support does not invent activity', async () => {
  const app = moduleLoader();
  const { createAudioMeter } = await app.load('js/components/voice-audio-meter.js');
  const meter = createAudioMeter({ fftSize: 512, frequencyBinCount: 256,
    getByteFrequencyData(data) { data.fill(255); },
  }, 48000);
  assert.equal(meter.sample(100).level, 0);
});

test('byte waveforms produce audio envelopes without float waveform support', async () => {
  const app = moduleLoader();
  const { createAudioMeter } = await app.load('js/components/voice-audio-meter.js');
  const meter = createAudioMeter({ fftSize: 512, frequencyBinCount: 256,
    getByteTimeDomainData(data) { data.fill(144); },
    getByteFrequencyData(data) { data.fill(0); },
  }, 24000);
  assert.ok(meter.sample(0).level > 0);
  assert.ok(meter.sample(40).level <= 1);
});
