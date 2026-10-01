class LibituPcmBuffer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabledUntil = 0;
    this.samples = new Int16Array(4096);
    this.length = 0;
    this.firstFrame = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.enabled === true) this.enabledUntil = currentFrame + sampleRate * 0.9;
      else { this.flush(); this.enabledUntil = 0; }
    };
  }
  flush() {
    if (!this.length) return;
    const pcm = this.samples.slice(0, this.length);
    this.port.postMessage({ startFrame: this.firstFrame, pcm: pcm.buffer }, [pcm.buffer]);
    this.length = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (currentFrame >= this.enabledUntil || !channels?.length) { this.flush(); return true; }
    const length = channels[0].length;
    for (let frame = 0; frame < length; frame++) {
      if (!this.length) this.firstFrame = currentFrame + frame;
      let value = 0;
      for (const channel of channels) value += Number.isFinite(channel[frame]) ? channel[frame] : 0;
      value = Math.max(-1, Math.min(1, value / channels.length));
      this.samples[this.length++] = Math.round(value * (value < 0 ? 32768 : 32767));
      if (this.length === this.samples.length) this.flush();
    }
    // Output remains silent; the source has its own normal audible monitor.
    return true;
  }
}
registerProcessor("libitu-pcm-buffer", LibituPcmBuffer);
