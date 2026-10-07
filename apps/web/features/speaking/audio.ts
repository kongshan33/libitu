export function encodePcm(bytes: ArrayBuffer): string {
  let value = "";
  for (const byte of new Uint8Array(bytes)) value += String.fromCharCode(byte);
  return btoa(value);
}
export function decodePcm(value: string): Float32Array<ArrayBuffer> {
  if (value.length > 100_000) throw new Error("Audio frame too large.");
  const binary = atob(value);
  if (binary.length % 2) throw new Error("Invalid audio frame.");
  const samples = new Float32Array(binary.length / 2);
  for (let i = 0; i < samples.length; i++) {
    const unsigned = binary.charCodeAt(i * 2) | binary.charCodeAt(i * 2 + 1) << 8;
    samples[i] = (unsigned >= 32768 ? unsigned - 65536 : unsigned) / 32768;
  }
  return samples;
}
type Segment = { item: string; start: number; duration: number; node: AudioBufferSourceNode };
export class ConversationAudio {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private capture: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private segments: Segment[] = [];
  private played = new Map<string, number>();
  private nextAt = 0;
  private generation = 0;
  private disposed = false;
  private captureGeneration = 0;
  constructor(private readonly onFrame: (audio: string) => void, private readonly onBoundary: (item: string, milliseconds: number) => void, private readonly onTrackLost: () => void) {}
  async prepare(): Promise<void> {
    if (this.disposed) throw new Error("Conversation closed.");
    this.context ??= new AudioContext({ latencyHint: "interactive" });
    await this.context.resume();
    if (this.context.state !== "running") throw new Error("Audio is paused. Enable the microphone again to resume.");
  }
  async enableMicrophone(): Promise<void> {
    const generation = ++this.captureGeneration;
    await this.prepare();
    if (!navigator.mediaDevices?.getUserMedia || !this.context?.audioWorklet) throw new Error("Microphone capture is unavailable in this browser. You can keep typing.");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (this.disposed || generation !== this.captureGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    try {
      const context = this.context;
      await context.audioWorklet.addModule("/audio/speaking-capture.worklet.js");
      if (this.disposed || generation !== this.captureGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
      const node = new AudioWorkletNode(context, "libitu-speaking-capture");
      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => { if (!this.disposed && generation === this.captureGeneration && event.data instanceof ArrayBuffer && event.data.byteLength <= 32768) this.onFrame(encodePcm(event.data)); };
      this.capture = node; this.source = context.createMediaStreamSource(stream); this.sink = context.createGain(); this.sink.gain.value = 0;
      this.source.connect(node); node.connect(this.sink); this.sink.connect(context.destination);
      stream.getAudioTracks().forEach(track => { track.onended = () => { if (!this.disposed && generation === this.captureGeneration) { this.disableMicrophone(); this.onTrackLost(); } }; });
    } catch (error) { this.disableMicrophone(); throw error; }
  }
  disableMicrophone(): void {
    this.captureGeneration++;
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); this.stream = null;
    if (this.capture) { this.capture.port.onmessage = null; this.capture.disconnect(); this.capture.port.close(); }
    this.source?.disconnect(); this.sink?.disconnect(); this.capture = null; this.source = null; this.sink = null;
  }
  append(item: string, audio: string): void {
    const context = this.context;
    if (this.disposed || !context || context.state !== "running") return;
    const samples = decodePcm(audio);
    if (!samples.length) return;
    if (this.nextAt - context.currentTime > 15) throw new Error("Audio playback fell behind. Reconnect to continue.");
    const buffer = context.createBuffer(1, samples.length, 24000); buffer.copyToChannel(samples, 0);
    const node = context.createBufferSource(); node.buffer = buffer; node.connect(context.destination);
    const start = Math.max(context.currentTime + 0.015, this.nextAt);
    this.nextAt = start + buffer.duration;
    const segment = { item, start, duration: buffer.duration, node }; this.segments.push(segment);
    const generation = this.generation;
    node.onended = () => { if (generation !== this.generation) return; this.played.set(item, (this.played.get(item) ?? 0) + segment.duration * 1000); this.segments = this.segments.filter(value => value !== segment); node.disconnect(); this.report(); };
    node.start(start);
  }
  report(): void {
    if (!this.context) return;
    const totals = new Map(this.played);
    for (const segment of this.segments) totals.set(segment.item, (totals.get(segment.item) ?? 0) + Math.max(0, Math.min(segment.duration, this.context.currentTime - segment.start)) * 1000);
    for (const [item, ms] of totals) this.onBoundary(item, Math.floor(ms));
  }
  clear(): void {
    this.report(); this.generation++;
    for (const segment of this.segments) { segment.node.onended = null; try { segment.node.stop(); } catch { /* Already ended. */ } segment.node.disconnect(); }
    this.segments = []; this.played.clear(); this.nextAt = 0;
  }
  dispose(): void { if (this.disposed) return; this.clear(); this.disableMicrophone(); this.disposed = true; void this.context?.close().catch(() => {}); this.context = null; }
}
