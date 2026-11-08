/*
 * Nova: AudioWorklet that turns mic audio into 16 kHz Int16 frames for Porcupine
 * (and for the silence detector). Loaded by offscreen.js with addModule(). It is a
 * real file (not a blob: URL) because the extension CSP only allows 'self' scripts.
 *
 * processorOptions: { frameLength: 512, targetRate: 16000 }
 * Posts: Int16Array frames of exactly frameLength samples (transferred).
 */
class NovaFrameProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.frameLength = opts.frameLength || 512;
    this.step = sampleRate / (opts.targetRate || 16000); // input samples per output sample
    this.pos = 0; // fractional read position into the current input block
    this.prev = 0; // last sample of the previous block, for interpolation across blocks
    this.frame = new Int16Array(this.frameLength);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const ch = input[0];
    const n = ch.length;
    // Linear-interpolating resampler. Position -1 refers to this.prev.
    while (this.pos < n) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i === 0 ? this.prev : ch[i - 1];
      const b = ch[i];
      const s = a + (b - a) * frac;
      const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
      this.frame[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (this.filled === this.frameLength) {
        const out = this.frame;
        this.port.postMessage(out, [out.buffer]);
        this.frame = new Int16Array(this.frameLength);
        this.filled = 0;
      }
      this.pos += this.step;
    }
    this.pos -= n;
    this.prev = ch[n - 1];
    return true;
  }
}

registerProcessor("nova-frame-processor", NovaFrameProcessor);
