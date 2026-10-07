/* Browser-owned PCM only. Streaming resampling works with the device's actual rate. */
class SpeakingCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sum = 0;
    this.weight = 0;
    this.remaining = sampleRate / 24000;
    this.frame = new Int16Array(2400);
    this.offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const length = channels[0].length;
    for (let i = 0; i < length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      sample /= channels.length;
      let available = 1;
      while (available > 1e-7) {
        const used = Math.min(available, this.remaining);
        this.sum += sample * used; this.weight += used;
        available -= used; this.remaining -= used;
        if (this.remaining <= 1e-7) {
          const value = Math.max(-1, Math.min(1, this.sum / this.weight));
          this.frame[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767));
          this.sum = 0; this.weight = 0; this.remaining = sampleRate / 24000;
          if (this.offset === this.frame.length) {
            this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
            this.frame = new Int16Array(2400); this.offset = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor("libitu-speaking-capture", SpeakingCapture);
