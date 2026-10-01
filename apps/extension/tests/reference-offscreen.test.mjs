import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createReferenceRecorder } from "../src/reference-offscreen.js";

const session = { token: "token-1", sessionId: "session-1", requestId: "session-1", streamId: "tab-source" };
const request = { ...session, requestId: "clip-1" };
class MediaRecorderFixture extends EventTarget {
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; }
  started() { this.dispatchEvent(new Event("start")); }
  data(text) {
    const event = new Event("dataavailable");
    event.data = new Blob([text], { type: this.mimeType });
    this.dispatchEvent(event);
  }
  finish(text = "audio") { this.data(text); this.dispatchEvent(new Event("stop")); }
}

function fixture() {
  const events = [];
  const timers = new Map();
  const recorders = [];
  let timerId = 0;
  let now = 0;
  const track = new EventTarget();
  track.readyState = "live";
  track.stops = 0;
  track.stop = () => { track.stops += 1; track.readyState = "ended"; };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const source = { connected: false, connect() { this.connected = true; }, disconnect() { this.connected = false; } };
  const context = { state: "running", closed: 0, destination: {}, createMediaStreamSource: () => source,
    resume: async () => {}, close: async () => { context.closed += 1; } };
  const state = { media: Promise.resolve(stream), encoderFailure: false, base64: null, acquisitions: 0 };
  const controller = createReferenceRecorder((event) => { events.push(event); }, {
    getUserMedia: () => { state.acquisitions += 1; return state.media; },
    createContext: () => context,
    createRecorder: (input) => {
      if (state.encoderFailure) throw new Error("Encoder failed");
      assert.equal(input, stream);
      const recorder = new MediaRecorderFixture();
      recorders.push(recorder);
      return recorder;
    },
    now: () => now, epoch: () => 1700000000000 + now,
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    toBase64: async (blob) => state.base64 ?? Buffer.from(await blob.arrayBuffer()).toString("base64")
  });
  return {
    controller, events, state, track, stream, recorders, context, source, timers,
    advance(ms) { now += ms; },
    async expire(ms) {
      const timer = [...timers.entries()].find(([, entry]) => entry.ms === ms);
      assert.ok(timer);
      timers.delete(timer[0]);
      timer[1].callback();
      await nextTurn();
    },
    record(message = request) {
      controller.begin(message);
      const native = recorders.at(-1);
      native?.started();
      return native;
    }
  };
}

test("enabled retains the stream and monitor but creates no encoder or audio buffers while idle", async () => {
  const f = fixture();
  await f.controller.open(session);
  assert.equal(f.events[0].status, "enabled");
  assert.equal(f.events[0].requestId, session.sessionId);
  assert.equal(f.source.connected, true);
  assert.equal(f.recorders.length, 0);
  assert.equal(f.track.stops, 0);
  await f.expire(10_000);
  assert.equal(f.events.at(-1).status, "heartbeat");
  assert.equal(f.recorders.length, 0);
  f.controller.close(session);
  assert.equal(f.source.connected, false);
  assert.equal(f.context.closed, 1);
  assert.equal(f.track.stops, 1);
  assert.equal(f.timers.size, 0);
});

test("two clips use separate encoders on the same stream and preserve the monitor between recordings", async () => {
  const f = fixture();
  await f.controller.open(session);
  for (const requestId of ["clip-1", "clip-2"]) {
    const message = { ...request, requestId };
    f.controller.begin(message);
    const native = f.recorders.at(-1);
    assert.notEqual(f.events.at(-1).requestId, requestId);
    native.started();
    assert.equal(f.events.at(-1).status, "recording");
    native.data("first");
    f.advance(1300);
    f.controller.stop(message);
    assert.equal(native.state, "inactive");
    assert.equal(f.track.stops, 0);
    assert.equal(f.context.closed, 0);
    f.advance(500);
    native.finish("last");
    await nextTurn();
    const complete = f.events.at(-1);
    assert.equal(complete.status, "complete");
    assert.equal(complete.requestId, requestId);
    assert.equal(Buffer.from(complete.audioBase64, "base64").toString(), "firstlast");
    assert.equal(complete.durationMs, 1300);
    assert.equal(f.source.connected, true);
    assert.equal(f.recorders.filter((recorder) => recorder.state !== "inactive").length, 0);
  }
  assert.equal(f.recorders.length, 2);
  assert.equal(f.state.acquisitions, 1);
  f.controller.close(session);
  assert.equal(f.track.stops, 1);
});

test("closing a pending session releases a late stream without creating an encoder", async () => {
  const f = fixture();
  let resolve;
  f.state.media = new Promise((done) => { resolve = done; });
  const pending = f.controller.open(session);
  f.controller.close(session);
  resolve(f.stream);
  await pending;
  assert.equal(f.track.stops, 1);
  assert.equal(f.events.length, 0);
  assert.equal(f.recorders.length, 0);
  assert.equal(f.timers.size, 0);
});

test("cancel drops an old encoder's delayed final data, and old stop/cancel cannot affect the next clip", async () => {
  const f = fixture();
  await f.controller.open(session);
  const old = f.record();
  old.data("discard");
  f.controller.stop(request);
  f.controller.cancel(request);
  const nextRequest = { ...request, requestId: "clip-2" };
  const next = f.record(nextRequest);
  old.finish("late");
  f.controller.stop(request);
  f.controller.cancel(request);
  assert.equal(next.state, "recording");
  assert.equal(f.events.at(-1).requestId, "clip-2");
  assert.equal(f.track.stops, 0);
  f.controller.stop(nextRequest);
  next.finish("current");
  await nextTurn();
  assert.equal(f.events.filter((event) => event.status === "complete").length, 1);
  assert.equal(Buffer.from(f.events.at(-1).audioBase64, "base64").toString(), "current");
  f.controller.close(session);
});

test("cancel while base64 encoding is pending cannot publish media into a later clip", async () => {
  const f = fixture();
  let resolve;
  f.state.base64 = new Promise((done) => { resolve = done; });
  await f.controller.open(session);
  const old = f.record();
  f.controller.stop(request);
  old.finish();
  f.controller.cancel(request);
  f.record({ ...request, requestId: "clip-2" });
  resolve("YXVkaW8=");
  await nextTurn();
  assert.equal(f.events.some((event) => event.status === "complete"), false);
  assert.equal(f.events.at(-1).requestId, "clip-2");
  f.controller.close(session);
});

test("encoder errors and per-clip timeouts preserve the stream, while device loss closes the session", async () => {
  for (const cause of ["encoder", "native-error", "unexpected-stop", "capture-timeout", "finalization-timeout", "device"]) {
    const f = fixture();
    await f.controller.open(session);
    if (cause === "encoder") f.state.encoderFailure = true;
    const native = f.record();
    if (cause === "native-error") native.dispatchEvent(new Event("error"));
    if (cause === "unexpected-stop") native.finish();
    if (cause === "capture-timeout") await f.expire(65_000);
    if (cause === "finalization-timeout") { f.controller.stop(request); await f.expire(5_000); }
    if (cause === "device") f.track.dispatchEvent(new Event("ended"));
    await nextTurn();
    assert.equal(f.events.at(-1).status, "error");
    assert.equal(f.events.at(-1).requestId, cause === "device" ? session.sessionId : request.requestId);
    assert.equal(f.track.stops, cause === "device" ? 1 : 0);
    f.controller.close(session);
    assert.equal(f.context.closed, 1);
    assert.equal(f.timers.size, 0);
  }
});

test("the offscreen session has an independent 30-minute maximum even with normal heartbeats", async () => {
  const f = fixture();
  await f.controller.open(session);
  await f.expire(10_000);
  await f.expire(30 * 60_000);
  assert.equal(f.events.at(-1).requestId, session.sessionId);
  assert.equal(f.events.at(-1).status, "error");
  assert.equal(f.track.stops, 1);
  assert.equal(f.context.closed, 1);
  assert.equal(f.timers.size, 0);
});

test("empty and oversized clips fail locally without ending the authorized stream", async () => {
  for (const payload of ["", "a".repeat(6 * 1024 * 1024 + 1)]) {
    const f = fixture();
    await f.controller.open(session);
    const native = f.record();
    f.controller.stop(request);
    native.finish(payload);
    await nextTurn();
    assert.equal(f.events.at(-1).status, "error");
    assert.equal(f.events.at(-1).requestId, request.requestId);
    assert.equal(f.events.some((event) => "audioBase64" in event), false);
    assert.equal(f.track.stops, 0);
    assert.equal(f.source.connected, true);
    f.controller.close(session);
  }
});

test("closed and wrong-token sessions cannot begin or affect the current stream", async () => {
  const f = fixture();
  await f.controller.open(session);
  f.controller.close({ ...session, token: "old" });
  assert.equal(f.track.stops, 0);
  f.controller.begin({ ...request, token: "old" });
  assert.equal(f.recorders.length, 0);
  f.controller.close(session);
  f.controller.begin(request);
  assert.equal(f.events.at(-1).requestId, session.sessionId);
  assert.equal(f.events.at(-1).status, "error");
  assert.equal(f.recorders.length, 0);
});
