/** Sample a real audio waveform; the renderer receives normalized envelopes only. */
export function createAudioMeter(analyser, sampleRate) {
  const waveform = new Float32Array(analyser.fftSize);
  const bytes = new Uint8Array(analyser.fftSize);
  const frequencies = new Uint8Array(analyser.frequencyBinCount);
  const result = { level: 0, low: 0, mid: 0, rawLevel: 0 };
  const targets = { level: 0, low: 0, mid: 0 };
  const keys = ["level", "low", "mid"];
  const binHz = sampleRate / analyser.fftSize;
  let previousTime;

  function band(from, to) {
    const first = Math.max(1, Math.ceil(from / binHz));
    const end = Math.min(frequencies.length, Math.floor(to / binHz) + 1);
    let energy = 0;
    for (let i = first; i < end; i++) energy += frequencies[i] / 255;
    return end > first ? Math.min(1, energy / (end - first) * 2) : 0;
  }

  return {
    sample(now) {
      let sum = 0;
      if (analyser.getFloatTimeDomainData) {
        analyser.getFloatTimeDomainData(waveform);
        for (const value of waveform) sum += value * value;
      } else if (analyser.getByteTimeDomainData) {
        analyser.getByteTimeDomainData(bytes);
        for (const value of bytes) sum += ((value - 128) / 128) ** 2;
      }
      const rms = Math.sqrt(sum / waveform.length);
      const level = Math.min(1, Math.max(0, (rms - 0.006) / 0.18));
      result.rawLevel = level;
      analyser.getByteFrequencyData?.(frequencies);
      const dt = previousTime == null ? 1 / 60 : Math.max(0, (now - previousTime) / 1000);
      previousTime = now;
      targets.level = level;
      targets.low = level ? band(80, 300) : 0;
      targets.mid = level ? band(300, 2500) : 0;
      for (const key of keys) {
        const tau = targets[key] > result[key] ? 0.035 : 0.16;
        result[key] += (targets[key] - result[key]) * (1 - Math.exp(-dt / tau));
      }
      return result;
    },
  };
}
