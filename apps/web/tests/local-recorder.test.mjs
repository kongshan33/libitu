import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LocalSentenceRecorder, MAX_RECORDING_DURATION_MS, RECORDING_FINALIZATION_TIMEOUT_MS
} from "../features/stage-two/recording/local-recorder.ts";

class TrackedTarget extends EventTarget {
  listeners = new Map();
  addEventListener(type, callback) {
    super.addEventListener(type, callback);
    const callbacks = this.listeners.get(type) ?? new Set();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }
  removeEventListener(type, callback) {
    super.removeEventListener(type, callback);
    this.listeners.get(type)?.delete(callback);
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0);
  }
}

function microphone() {
  const track = new TrackedTarget();
  track.readyState = "live";
  track.stops = 0;
  track.stop = () => { track.stops += 1; track.readyState = "ended"; };
  track.disconnect = () => { track.readyState = "ended"; track.dispatchEvent(new Event("ended")); };
  return { getTracks: () => [track], getAudioTracks: () => [track], track };
}

class FakeMediaRecorder extends TrackedTarget {
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  stops = 0;
  startError = null;
  start(timeslice) {
    if (this.startError) throw this.startError;
    this.timeslice = timeslice;
    this.state = "recording";
  }
  stop() {
    this.stops += 1;
    this.state = "inactive";
  }
  data(text, mimeType = this.mimeType) {
    const event = new Event("dataavailable");
    event.data = new Blob([text], { type: mimeType });
    this.dispatchEvent(event);
  }
  finish(text = "audio") {
    this.state = "inactive";
    this.data(text);
    this.dispatchEvent(new Event("stop"));
  }
}

function fixture(options = {}) {
  let time = 0;
  let timerId = 0;
  const timers = new Map();
  const requests = [];
  const recorders = [];
  const snapshots = [];
  const blobs = new Map();
  const revoked = [];
  let nextUrl = 0;
  const environment = {
    getSupportError: () => options.supportError ?? null,
    getUserMedia: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    createRecorder: () => {
      if (options.constructorError) throw options.constructorError;
      const recorder = new FakeMediaRecorder();
      recorder.startError = options.startError ?? null;
      if (options.mimeType !== undefined) recorder.mimeType = options.mimeType;
      recorders.push(recorder);
      return recorder;
    },
    now: () => time,
    setTimeout: (callback, delayMs) => {
      const id = ++timerId;
      timers.set(id, { callback, at: time + delayMs });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    createObjectURL: (blob) => {
      if (options.urlError) throw new Error("Cannot allocate URL");
      const url = `blob:take-${++nextUrl}`;
      blobs.set(url, blob);
      return url;
    },
    revokeObjectURL: (url) => { revoked.push(url); blobs.delete(url); }
  };
  const controller = new LocalSentenceRecorder((state) => snapshots.push(state), environment);
  controller.setSentence("sentence-1");
  const f = {
    controller, environment, timers, requests, recorders, snapshots, blobs, revoked,
    advance(ms) {
      const end = time + ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].callback();
      }
      time = end;
    },
    async record() {
      const start = controller.start();
      const stream = microphone();
      requests.at(-1).resolve(stream);
      await start;
      return { stream, recorder: recorders.at(-1) };
    },
    async take(durationMs = 1200) {
      const session = await f.record();
      f.advance(durationMs);
      controller.stop();
      session.recorder.finish();
      return { ...session, clip: controller.getSnapshot().clip };
    }
  };
  return f;
}

test("waveform access shares the active recorder stream and stops exposing it on cleanup", async () => {
  const f = fixture();
  assert.equal(f.controller.getActiveStream(), null);
  const {stream, recorder} = await f.record();
  assert.equal(f.requests.length, 1);
  assert.equal(f.controller.getActiveStream(), stream);
  f.controller.stop();
  assert.equal(f.controller.getActiveStream(), null);
  assert.equal(stream.track.stops, 1);
  recorder.finish();
  const next = await f.record();
  assert.equal(f.controller.getActiveStream(), next.stream);
  f.controller.cancel();
  assert.equal(f.controller.getActiveStream(), null);
  assert.equal(next.stream.track.stops, 1);
  f.controller.dispose();
});

test("recording is explicit; requesting publishes synchronously and rapid starts share one request", async () => {
  const f = fixture();
  assert.equal(f.requests.length, 0);
  const pending = f.controller.start();
  assert.equal(f.controller.getSnapshot().phase, "requesting");
  await f.controller.start();
  assert.equal(f.requests.length, 1);
  const stream = microphone();
  f.requests[0].resolve(stream);
  await pending;
  assert.equal(f.controller.getSnapshot().phase, "recording");
  assert.equal(f.recorders.length, 1);
  f.controller.dispose();
  assert.equal(stream.track.stops, 1);
  assert.equal(f.timers.size, 0);
});

test("cancel invalidates pending permission immediately and stops a late granted stream", async () => {
  const f = fixture();
  const pending = f.controller.start();
  f.controller.cancel();
  assert.equal(f.controller.getSnapshot().phase, "idle");
  const updates = f.snapshots.length;
  const stream = microphone();
  f.requests[0].resolve(stream);
  await pending;
  assert.equal(stream.track.stops, 1);
  assert.equal(f.recorders.length, 0);
  assert.equal(f.snapshots.length, updates);
});

test("a newer recording cannot be overwritten by an old permission result or rejection", async () => {
  const f = fixture();
  const old = f.controller.start();
  f.controller.setSentence("sentence-2");
  const current = await f.record();
  f.requests[0].reject(new DOMException("Denied", "NotAllowedError"));
  await old;
  assert.equal(f.controller.getSnapshot().phase, "recording");
  assert.equal(f.controller.getSnapshot().sentenceId, "sentence-2");
  assert.equal(current.stream.track.stops, 0);
  f.controller.dispose();
});

test("stop releases the microphone immediately but waits for the final chunk and stop event", async () => {
  const f = fixture();
  const { stream, recorder } = await f.record();
  f.advance(1234);
  recorder.data("first");
  f.controller.stop();
  assert.equal(f.controller.getSnapshot().phase, "stopping");
  assert.equal(stream.track.stops, 1);
  assert.equal(stream.track.listenerCount, 0);
  assert.equal(f.blobs.size, 0);
  f.advance(600);
  recorder.finish("last");
  const state = f.controller.getSnapshot();
  assert.equal(state.phase, "ready");
  assert.equal(state.clip.durationMs, 1234);
  assert.equal(state.elapsedMs, 1234);
  assert.equal(state.clip.mimeType, "audio/webm;codecs=opus");
  assert.equal(await f.blobs.get(state.clip.url).text(), "firstlast");
  assert.equal(recorder.listenerCount, 0);
  assert.equal(f.timers.size, 0);
  f.controller.dispose();
});

test("re-recording retains the previous clip until successful replacement", async () => {
  const f = fixture();
  const previous = await f.take();
  const replacement = await f.record();
  assert.equal(f.controller.getSnapshot().clip.url, previous.clip.url);
  assert.equal(f.revoked.length, 0);
  f.advance(800);
  f.controller.stop();
  assert.equal(f.controller.getSnapshot().clip.url, previous.clip.url);
  replacement.recorder.finish("replacement");
  assert.notEqual(f.controller.getSnapshot().clip.url, previous.clip.url);
  assert.deepEqual(f.revoked, [previous.clip.url]);
  assert.equal(f.blobs.size, 1);
  f.controller.dispose();
  assert.equal(f.blobs.size, 0);
});

test("cancel while recording or finalizing discards partial data and keeps the previous take", async () => {
  const f = fixture();
  const previous = await f.take();
  for (const finalize of [false, true]) {
    const { recorder, stream } = await f.record();
    recorder.data("partial");
    if (finalize) f.controller.stop();
    f.controller.cancel();
    const updates = f.snapshots.length;
    recorder.finish("late");
    assert.equal(f.snapshots.length, updates);
    assert.equal(f.controller.getSnapshot().phase, "ready");
    assert.equal(f.controller.getSnapshot().clip.url, previous.clip.url);
    assert.equal(stream.track.stops, 1);
    assert.equal(recorder.listenerCount, 0);
    assert.equal(f.timers.size, 0);
  }
  f.controller.dispose();
});

test("switching sentences cancels live/stopping attempts and revokes the previous sentence clip", async () => {
  for (const finalize of [false, true]) {
    const f = fixture();
    const previous = await f.take();
    const { recorder, stream } = await f.record();
    if (finalize) f.controller.stop();
    f.controller.setSentence("sentence-2");
    recorder.finish("stale");
    assert.deepEqual(f.controller.getSnapshot(), {
      phase: "idle", sentenceId: "sentence-2", clip: null, elapsedMs: 0, error: null
    });
    assert.deepEqual(f.revoked, [previous.clip.url]);
    assert.equal(f.blobs.size, 0);
    assert.equal(stream.track.stops, 1);
    assert.equal(f.timers.size, 0);
  }
});

test("same-sentence selection is inert; clear deletes the take without losing sentence selection", async () => {
  const f = fixture();
  const { recorder } = await f.record();
  f.controller.setSentence("sentence-1");
  assert.equal(f.controller.getSnapshot().phase, "recording");
  f.controller.stop();
  recorder.finish();
  const url = f.controller.getSnapshot().clip.url;
  f.controller.clear();
  assert.equal(f.controller.getSnapshot().clip, null);
  assert.equal(f.controller.getSnapshot().sentenceId, "sentence-1");
  assert.deepEqual(f.revoked, [url]);
  f.controller.clear();
  assert.deepEqual(f.revoked, [url]);
});

test("permission errors are actionable, preserve a prior clip, and allow retry", async () => {
  const f = fixture();
  const previous = await f.take();
  for (const [name, message] of [
    ["NotAllowedError", /access was denied/], ["NotFoundError", /No available microphone/],
    ["NotReadableError", /could not start/], ["NotSupportedError", /supported format/]
  ]) {
    const pending = f.controller.start();
    f.requests.at(-1).reject(new DOMException("Private provider detail", name));
    await pending;
    assert.equal(f.controller.getSnapshot().phase, "error");
    assert.match(f.controller.getSnapshot().error, message);
    assert.equal(f.controller.getSnapshot().clip.url, previous.clip.url);
  }
  await f.record();
  assert.equal(f.controller.getSnapshot().error, null);
  f.controller.dispose();
});

test("unsupported recording fails before requesting hardware; missing sentence never requests it", async () => {
  const f = fixture({ supportError: "Microphone recording requires HTTPS or localhost." });
  await f.controller.start();
  assert.equal(f.controller.getSnapshot().phase, "error");
  assert.match(f.controller.getSnapshot().error, /HTTPS/);
  assert.equal(f.requests.length, 0);
  f.controller.setSentence(null);
  await f.controller.start();
  assert.equal(f.controller.getSnapshot().phase, "idle");
  assert.equal(f.requests.length, 0);
});

test("constructor/start failures release all tracks and registered listeners", async () => {
  for (const option of ["constructorError", "startError"]) {
    const f = fixture({ [option]: new DOMException("Cannot encode", "NotSupportedError") });
    const { stream, recorder } = await f.record();
    assert.equal(f.controller.getSnapshot().phase, "error");
    assert.equal(stream.track.stops, 1);
    assert.equal(stream.track.listenerCount, 0);
    assert.equal(recorder?.listenerCount ?? 0, 0);
    assert.equal(f.timers.size, 0);
  }
});

test("disconnected devices and unexpected recorder stops fail without accepting partial data", async () => {
  for (const cause of ["device", "error", "stop"]) {
    const f = fixture();
    const previous = await f.take();
    const { recorder, stream } = await f.record();
    recorder.data("partial");
    if (cause === "device") stream.track.disconnect();
    if (cause === "error") recorder.dispatchEvent(new Event("error"));
    if (cause === "stop") recorder.finish();
    assert.equal(f.controller.getSnapshot().phase, "error");
    assert.equal(f.controller.getSnapshot().clip.url, previous.clip.url);
    assert.equal(stream.track.stops, 1);
    assert.equal(recorder.listenerCount, 0);
    assert.equal(f.timers.size, 0);
    f.controller.dispose();
  }
});

test("an already ended or empty stream fails and releases every returned track", async () => {
  for (const empty of [false, true]) {
    const f = fixture();
    const pending = f.controller.start();
    const stream = microphone();
    if (empty) stream.getAudioTracks = () => [];
    else stream.track.readyState = "ended";
    f.requests[0].resolve(stream);
    await pending;
    assert.equal(f.controller.getSnapshot().phase, "error");
    assert.equal(stream.track.stops, 1);
    assert.equal(f.recorders.length, 0);
  }
});

test("cleanup attempts every track even when one disconnected track throws on stop", async () => {
  const f = fixture();
  const pending = f.controller.start();
  const stream = microphone();
  const extra = microphone().track;
  stream.getTracks = () => [stream.track, extra];
  stream.track.stop = () => { throw new Error("Device unavailable"); };
  f.requests[0].resolve(stream);
  await pending;
  f.controller.cancel();
  assert.equal(extra.stops, 1);
  assert.equal(stream.track.listenerCount, 0);
  assert.equal(f.controller.getSnapshot().phase, "idle");
  assert.equal(f.timers.size, 0);
});

test("object URL allocation failure retains the previous take and releases the new attempt", async () => {
  const options = {};
  const f = fixture(options);
  const previous = await f.take();
  const { recorder, stream } = await f.record();
  f.controller.stop();
  options.urlError = true;
  recorder.finish();
  assert.equal(f.controller.getSnapshot().phase, "error");
  assert.equal(f.controller.getSnapshot().clip.url, previous.clip.url);
  assert.equal(stream.track.stops, 1);
  assert.equal(recorder.listenerCount, 0);
  assert.equal(f.timers.size, 0);
  f.controller.dispose();
});

test("empty output and finalization timeout preserve a previous take and ignore late events", async () => {
  for (const timeout of [false, true]) {
    const f = fixture();
    const previous = await f.take();
    const { recorder } = await f.record();
    f.controller.stop();
    if (timeout) f.advance(RECORDING_FINALIZATION_TIMEOUT_MS);
    else recorder.finish("");
    assert.equal(f.controller.getSnapshot().phase, "error");
    assert.match(f.controller.getSnapshot().error, timeout ? /could not finish/ : /No audio/);
    const updates = f.snapshots.length;
    recorder.finish("late");
    assert.equal(f.snapshots.length, updates);
    assert.equal(f.controller.getSnapshot().clip.url, previous.clip.url);
    assert.equal(f.timers.size, 0);
    f.controller.dispose();
  }
});

test("recording automatically stops at 60 seconds and measured duration excludes finalization", async () => {
  const f = fixture();
  const { recorder, stream } = await f.record();
  f.advance(MAX_RECORDING_DURATION_MS - 1);
  assert.equal(f.controller.getSnapshot().phase, "recording");
  f.advance(1);
  assert.equal(f.controller.getSnapshot().phase, "stopping");
  assert.equal(stream.track.stops, 1);
  f.advance(750);
  recorder.finish();
  assert.equal(f.controller.getSnapshot().clip.durationMs, MAX_RECORDING_DURATION_MS);
  assert.equal(f.timers.size, 0);
  f.controller.dispose();
});

test("dispose is silent and reusable; pending sessions cannot affect a Strict Mode replacement", async () => {
  const f = fixture();
  const pending = f.controller.start();
  const updates = f.snapshots.length;
  f.controller.dispose();
  assert.equal(f.snapshots.length, updates);
  f.controller.setSentence("sentence-1");
  const current = await f.record();
  const staleStream = microphone();
  f.requests[0].resolve(staleStream);
  await pending;
  assert.equal(staleStream.track.stops, 1);
  assert.equal(f.controller.getSnapshot().phase, "recording");
  assert.equal(current.stream.track.stops, 0);
  f.controller.dispose();
  f.controller.dispose();
  assert.equal(current.stream.track.stops, 1);
  assert.equal(f.timers.size, 0);
});

test("container type comes from the actual recorder or emitted blob, not an assumed extension", async () => {
  const f = fixture({ mimeType: "" });
  const { recorder } = await f.record();
  f.controller.stop();
  recorder.data("aac", "audio/mp4");
  recorder.dispatchEvent(new Event("stop"));
  assert.equal(f.controller.getSnapshot().clip.mimeType, "audio/mp4");
  f.controller.dispose();
});

test("MIME negotiation tolerates failed advertised encoders and falls back to the browser default", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "MediaRecorder", original);
    else delete globalThis.MediaRecorder;
  });
  const attempts = [];
  class AdvertisedButUnavailable extends FakeMediaRecorder {
    static isTypeSupported(type) { return type !== "audio/ogg;codecs=opus"; }
    constructor(_stream, options) {
      super();
      attempts.push(options?.mimeType ?? "default");
      if (options) throw new DOMException("Encoder unavailable", "NotSupportedError");
      this.mimeType = "audio/mp4";
    }
  }
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: AdvertisedButUnavailable });
  const f = fixture();
  const environment = { ...f.environment };
  delete environment.createRecorder;
  const recorder = new LocalSentenceRecorder(() => {}, environment);
  recorder.setSentence("sentence-1");
  const pending = recorder.start();
  const stream = microphone();
  f.requests[0].resolve(stream);
  await pending;
  assert.deepEqual(attempts, ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "default"]);
  assert.equal(recorder.getSnapshot().phase, "recording");
  recorder.dispose();
  assert.equal(stream.track.stops, 1);
});

test('Quick can record a long 2x turn without changing the default Detailed limit', async () => {
  const f = fixture();
  const start = f.controller.start(90_000);
  f.requests.at(-1).resolve(microphone());
  await start;
  f.advance(60_000);
  assert.equal(f.controller.getSnapshot().phase, 'recording');
  f.advance(30_000);
  assert.equal(f.controller.getSnapshot().phase, 'stopping');
  f.recorders.at(-1).finish();
  assert.equal(f.controller.getSnapshot().clip.durationMs, 90_000);
  assert.equal(MAX_RECORDING_DURATION_MS, 60_000);
});
