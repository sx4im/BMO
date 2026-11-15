// Capture mono signed little-endian PCM without an encode/decode round trip.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(Math.round(sampleRate * 0.08));
    this.offset = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data.type !== 'flush') return;
      this.stopped = true;
      if (this.offset) this.emit();
      this.port.postMessage({ type: 'flushed' });
    };
  }

  emit() {
    const bytes = new ArrayBuffer(this.offset * 2);
    const view = new DataView(bytes);
    let squares = 0;
    for (let i = 0; i < this.offset; i++) {
      view.setInt16(i * 2, this.frame[i], true);
      squares += (this.frame[i] / 32768) ** 2;
    }
    this.port.postMessage({ audio: bytes, rms: Math.sqrt(squares / this.offset), duration: this.offset / sampleRate }, [bytes]);
    this.offset = 0;
  }

  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i] / channels.length;
      const value = Math.max(-1, Math.min(1, mono));
      this.frame[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767));
      if (this.offset === this.frame.length) this.emit();
    }
    return true;
  }
}

registerProcessor('bimo-pcm-capture', PcmCapture);
