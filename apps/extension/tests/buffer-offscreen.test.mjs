import assert from "node:assert/strict";
import { test } from "node:test";
import { createBufferedRecorder } from "../src/buffer-offscreen.js";
const session = { token: "token-1", sessionId: "session-1", requestId: "session-1", streamId: "stream-1" };
function fixture() {
  const events = []; const timers = new Map(); const worklet = []; let timerId = 0; let now = 0;
  const track = new EventTarget(); track.readyState = "live"; track.stops = 0;
  track.stop = () => { track.stops++; track.readyState = "ended"; };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const source = { connects: [], disconnected: false, connect(target) { this.connects.push(target); }, disconnect() { this.disconnected = true; } };
  const context = Object.assign(new EventTarget(), { currentTime: 0, sampleRate: 8000, destination: {}, state: "running", closed: 0,
    createMediaStreamSource: () => source, resume: async () => {}, close: async () => { context.closed++; },
    audioWorklet: { addModule: async (url) => worklet.push(url) } });
  const node = { port: { onmessage: null, controls: [], postMessage(value) { this.controls.push(value); }, close() { this.closed = true; } },
    connect() {}, disconnect() { this.disconnected = true; } };
  const state = { media: Promise.resolve(stream), base64: null };
  const recorder = createBufferedRecorder((event) => events.push(event), {
    getUserMedia: () => state.media, createContext: () => context, createNode: () => node, workletUrl: () => "fixture-worklet.js",
    epoch: () => 1700000000000 + now * 1000,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timers.delete(id),
    toBase64: (bytes) => state.base64 ?? Buffer.from(bytes).toString("base64")
  });
  const f = { recorder, context, source, track, node, stream, state, events, timers, worklet,
    observe(time, { state: playerState = 1, rate = 1, generation = 0, delay = 0, token = session.token } = {}) {
      now = time; context.currentTime = time;
      recorder.observe({ ...session, token, telemetry: { epochTime: 1700000000000 + time * 1000 - delay,
        wallTime: time * 1000, time: 100 + time, rate, state: playerState, generation } });
    },
    pcm(start, end) { node.port.onmessage?.({ data: { startFrame: Math.round(start * 8000), pcm: new Int16Array(Math.round((end - start) * 8000)).fill(1234).buffer } }); },
    play() { f.observe(0); for (let i = 0; i < 2; i += 0.25) { f.pcm(i, i + 0.25); f.observe(i + 0.25); } },
    expire(ms) { const timer = [...timers.values()].find((entry) => entry.ms === ms); assert.ok(timer); timer.fn(); }
  };
  return f;
}
test("offscreen keeps one audible monitor, begins idle, and exports worklet PCM as WAV", async () => {
  const f = fixture(); await f.recorder.open(session);
  assert.equal(f.events[0].status, "enabled"); assert.equal(f.source.connects[0], f.context.destination);
  assert.equal(f.events.at(-1).retainedBytes, 0); assert.equal(f.events.at(-1).recording, false);
  f.play();
  await f.recorder.extract({ ...session, requestId: "clip-1", start: 100.5, end: 101.5 });
  const result = f.events.at(-1); assert.equal(result.status, "complete"); assert.equal(result.durationMs, 1000);
  const bytes = Buffer.from(result.audioBase64, "base64"); assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
  assert.equal(bytes.readUInt32LE(24), 8000); assert.equal(bytes.readInt16LE(44), 1234);
  f.recorder.close(session); assert.equal(f.track.stops, 1); assert.equal(f.context.closed, 1); assert.equal(f.node.port.closed, true);
  assert.equal(f.timers.size, 0);
});
test("pause, changed rate, stale telemetry and old tokens stop retention without discarding completed references", async () => {
  const f = fixture(); await f.recorder.open(session); f.play(); const bytes = f.events.at(-1).retainedBytes;
  f.observe(2.25, { state: 2 }); f.pcm(2.25, 2.5); assert.equal(f.node.port.controls.at(-1).enabled, false);
  f.observe(2.5, { rate: 1.3 }); f.pcm(2.5, 2.75); assert.equal(f.events.at(-1).retainedBytes, bytes);
  f.observe(3, { delay: 1000 }); assert.equal(f.events.at(-1).recording, false);
  f.observe(3.5); f.expire(800); assert.equal(f.events.at(-1).recording, false);
  const before = f.node.port.controls.length; f.observe(4, { token: "other" }); assert.equal(f.node.port.controls.length, before);
  await f.recorder.extract({ ...session, requestId: "clip-1", start: 100.5, end: 101.5 }); assert.equal(f.events.at(-1).status, "complete");
  f.recorder.close(session);
});
test("closing pending stream/model setup or WAV delivery cannot publish into a new session", async () => {
  const f = fixture(); let release; f.state.media = new Promise((resolve) => { release = resolve; });
  const open = f.recorder.open(session); f.recorder.close(session); release(f.stream); await open;
  assert.equal(f.track.stops, 1); assert.equal(f.events.length, 0);
  const active = fixture(); await active.recorder.open(session); active.play();
  active.state.base64 = new Promise((resolve) => { release = resolve; });
  const extracting = active.recorder.extract({ ...session, requestId: "clip-1", start: 100.5, end: 101.5 });
  active.recorder.close(session); release("UklGRg=="); await extracting;
  assert.equal(active.events.some((event) => event.status === "complete"), false);
});
test("track loss, suspended AudioContext and independent maximum release all media", async () => {
  for (const reason of ["track", "context", "maximum"]) {
    const f = fixture(); await f.recorder.open(session);
    if (reason === "track") f.track.dispatchEvent(new Event("ended"));
    if (reason === "context") { f.context.state = "suspended"; f.context.dispatchEvent(new Event("statechange")); }
    if (reason === "maximum") f.expire(30 * 60_000);
    assert.equal(f.events.at(-1).status, "error"); assert.equal(f.track.stops, 1); assert.equal(f.context.closed, 1); assert.equal(f.timers.size, 0);
  }
});
