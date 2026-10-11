import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BufferedReferenceController, bufferedRangeCovered, BUFFER_ARM_TIMEOUT_MS,
  BUFFER_EXTRACT_TIMEOUT_MS, BUFFER_HEARTBEAT_MS, BUFFER_PING_TIMEOUT_MS, BUFFER_PREPARE_TIMEOUT_MS
} from "../features/stage-two/reference/buffered-reference.ts";

const sentence = { id: "sentence-v3-source-0-4", startMs: 10_000, endMs: 12_000 };

function wav(durationMs = 2000, sampleRate = 16000) {
  const samples = Math.round(sampleRate * durationMs / 1000);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

function fixture() {
  let now = 1_000_000;
  let sequence = 0;
  let timerId = 0;
  const timers = new Map();
  const commands = [];
  const states = [];
  const controller = new BufferedReferenceController((state) => states.push(state), {
    now: () => now, wallTime: () => now - 900_000,
    requestId: () => `request-${++sequence}`,
    send: (message) => commands.push(message),
    setTimeout(callback, duration) {
      const id = ++timerId;
      timers.set(id, { at: now + duration, callback });
      return id;
    },
    clearTimeout: (id) => timers.delete(id)
  });
  controller.setSource("content-one|video-one");
  function advance(duration) {
    const target = now + duration;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = target;
  }
  function event(status, extra = {}) {
    const sessionId = commands.at(-1)?.sessionId;
    const requestId = ["complete", "missing"].includes(status)
      ? commands.findLast((command) => command.action === "extract")?.requestId : sessionId;
    controller.handleMessage({ type: "LIBITU_BUFFER_EVENT", version: 4, sessionId, requestId, status, ...extra });
  }
  function arm() { controller.enable(); event("available"); event("armed"); }
  function enable() { arm(); event("enabled"); }
  function coverage(ranges = [{ start: 10, end: 12 }], extra = {}) {
    event("coverage", { ranges, retainedBytes: 128000, recording: false, ...extra });
  }
  function sample(time, { delta = 100, state = 1, rate = 1, generation = 0, epochSkew = 0 } = {}) {
    advance(delta);
    controller.sample({ time, state, rate, wallTime: now - 900_000, epochTime: now + epochSkew }, generation);
  }
  function complete(extra = {}) {
    event("complete", { audioBase64: wav().toString("base64"), mimeType: "audio/wav", durationMs: 2000,
      start: 10, end: 12, captureId: "capture-1", ...extra });
  }
  return { controller, commands, states, timers, advance, event, arm, enable, coverage, sample, complete };
}

test("mount and telemetry cause no messages until explicit enable; arming never plays or observes", () => {
  const f = fixture();
  f.sample(10); f.controller.suspend();
  assert.equal(f.commands.length, 0);
  f.arm(); f.controller.enable();
  assert.deepEqual(f.commands.map((message) => message.action), ["ping", "arm"]);
  assert.equal(f.controller.getSnapshot().phase, "armed");
  f.event("enabled");
  assert.equal(f.controller.getSnapshot().phase, "enabled");
  assert.equal(f.commands.every((command) => command.version === 4 && command.requestId === command.sessionId), true);
  f.controller.dispose();
});

test("steady playback observations are throttled without publishing React state; changes send immediately", () => {
  const f = fixture(); f.enable();
  const count = f.states.length;
  f.sample(10, { delta: 0 });
  for (let i = 1; i <= 10; i += 1) f.sample(10 + i / 10);
  assert.equal(f.commands.filter((command) => command.action === "observe").length, 4);
  assert.equal(f.states.length, count);
  f.sample(11, { delta: 10, state: 2 });
  assert.equal(f.commands.at(-1).telemetry.state, 2);
  f.sample(20, { delta: 10, state: 1, generation: 1 });
  assert.equal(f.commands.at(-1).telemetry.generation, 1);
  f.sample(20.01, { delta: 10, rate: 1.3, generation: 1 });
  assert.equal(f.commands.at(-1).telemetry.rate, 1.3);
  const observations = f.commands.length;
  f.sample(10, { delta: 10, state: 2, generation: 0 });
  assert.equal(f.commands.length, observations, "late events from the prior player cannot interrupt the new generation");
  assert.equal(f.commands.every((command) => command.requestId === command.sessionId), true);
  f.controller.dispose();
});

test("hidden/paused/unmounted player cuts observations but retains coverage and the enabled lease", () => {
  const f = fixture(); f.enable(); f.coverage(undefined, { recording: true });
  f.sample(10, { delta: 0 }); f.controller.suspend();
  assert.equal(f.commands.at(-1).telemetry.state, 2);
  assert.equal(f.controller.getSnapshot().recording, false);
  assert.equal(f.controller.getSnapshot().phase, "enabled");
  assert.equal(f.controller.covers({ start: 10, end: 12 }), true);
  f.advance(BUFFER_HEARTBEAT_MS);
  assert.equal(f.commands.at(-1).action, "heartbeat");
  f.sample(30, { generation: 2 });
  assert.equal(f.commands.at(-1).telemetry.generation, 2);
  assert.equal(f.commands.filter((command) => command.action === "arm").length, 1);
  f.controller.dispose();
});

test("invalid telemetry is not sent as progress and immediately reports a stopped player", () => {
  const f = fixture(); f.enable(); f.sample(10, { delta: 0 });
  for (const [value, generation] of [
    [{ time: NaN, rate: 1, state: 1, wallTime: 100000, epochTime: 1000000 }, 0],
    [{ time: 10, rate: 1, state: 1, wallTime: 100000 }, 0],
    [{ time: 10, rate: 1, state: 1, wallTime: 100000, epochTime: 1000000 }, -1]
  ]) {
    f.controller.sample(value, generation);
    assert.equal(f.commands.at(-1).telemetry.state, 2);
    assert.equal(Number.isFinite(f.commands.at(-1).telemetry.time), true);
  }
  f.controller.dispose();
});

test("coverage preserves individual runs including replays, rejects holes and suppresses identical updates", () => {
  const f = fixture(); f.enable();
  f.coverage([{ start: 10, end: 11 }, { start: 11.5, end: 13 }]);
  assert.equal(f.controller.covers({ start: 10, end: 12 }), false);
  assert.equal(f.controller.covers({ start: 11.5, end: 12 }), true);
  const count = f.states.length;
  f.coverage([{ start: 10, end: 11 }, { start: 11.5, end: 13 }]);
  assert.equal(f.states.length, count);
  for (const ranges of [[{ start: NaN, end: 13 }], [{ start: 13, end: 10 }]]) {
    f.coverage(ranges);
    assert.equal(f.states.length, count);
  }
  f.coverage([], { retainedBytes: Infinity });
  assert.equal(f.states.length, count);
  assert.equal(bufferedRangeCovered([{ start: 10, end: 11 }, { start: 11, end: 12 }], { start: 10, end: 12 }), false);
  f.coverage([{ start: 12, end: 14 }, { start: 10, end: 13 }]);
  assert.equal(f.controller.covers({ start: 10, end: 14 }), false, "overlapping takes cannot be stitched");
  assert.equal(f.controller.covers({ start: 10, end: 13 }), true, "earlier video time in a later recording remains usable");
  assert.equal(bufferedRangeCovered([], { start: 10, end: 10 }), false);
  f.controller.dispose();
});

test("covered extraction returns validated PCM with exact caller identity and actual audio duration", async () => {
  const f = fixture(); f.enable(); f.coverage();
  const pending = f.controller.extract(sentence);
  const request = f.commands.at(-1);
  assert.equal(request.action, "extract");
  assert.notEqual(request.requestId, request.sessionId);
  assert.deepEqual([request.start, request.end], [10, 12]);
  f.complete({ durationMs: 2050, audioBase64: wav(2050).toString("base64") });
  const clip = await pending;
  assert.equal(clip.sentenceId, sentence.id);
  assert.deepEqual([clip.rangeStart, clip.rangeEnd, clip.startOffsetMs, clip.endOffsetMs], [10, 12, 0, 2050]);
  assert.equal(clip.blob.type, "audio/wav");
  assert.equal(clip.blob.size, wav(2050).length);
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
});

test("uncovered or evicted clips return missing without starting playback or changing session", async () => {
  const f = fixture();
  assert.equal(await f.controller.extract(sentence), null);
  f.enable();
  assert.equal(await f.controller.extract(sentence), null);
  assert.equal(f.commands.some((command) => command.action === "extract"), false);
  f.coverage([{ start: 10, end: 12 }, { start: 20, end: 24 }]);
  const pending = f.controller.extract(sentence);
  f.event("missing", { reason: "The buffer no longer contains this range." });
  assert.equal(await pending, null);
  assert.equal(f.controller.getSnapshot().phase, "enabled");
  assert.equal(f.controller.covers({ start: 10, end: 12 }), false);
  assert.equal(f.controller.covers({ start: 20, end: 24 }), true);
  const requests = f.commands.filter((command) => command.action === "extract").length;
  assert.equal(await f.controller.extract(sentence), null);
  assert.equal(f.commands.filter((command) => command.action === "extract").length, requests);
  f.controller.dispose();
});

test("coverage changes during extraction do not cancel or duplicate the source-bound request", async () => {
  const f = fixture(); f.enable(); f.coverage();
  const pending = f.controller.extract(sentence);
  const requestId = f.commands.at(-1).requestId;
  for (let offset = 1; offset <= 10; offset++) f.coverage([{ start: 10, end: 12 + offset / 10 }]);
  assert.equal(f.commands.filter((command) => command.action === "extract").length, 1);
  f.complete({ requestId });
  assert.equal((await pending).sentenceId, sentence.id);
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
});

test("aborted requests release resources and ignore late completion while next sentence can extract", async () => {
  const f = fixture(); f.enable(); f.coverage();
  const abort = new AbortController();
  const pending = f.controller.extract(sentence, abort.signal);
  const previousId = f.commands.at(-1).requestId;
  const rejected = assert.rejects(pending, { name: "AbortError" });
  abort.abort(); await rejected;
  f.complete({ requestId: previousId });
  assert.equal(f.timers.size, 1);
  const next = f.controller.extract({ ...sentence, id: "sentence-v3-updated-0-4" });
  f.complete({ requestId: previousId });
  assert.equal(f.timers.size, 2);
  f.complete();
  assert.equal((await next).sentenceId, "sentence-v3-updated-0-4");
  await assert.rejects(f.controller.extract(sentence, abort.signal), { name: "AbortError" });
  f.controller.dispose();
});

test("source changes close, clear coverage and cancel source-bound requests; old messages cannot reenable", async () => {
  const f = fixture(); f.enable(); f.coverage();
  const pending = f.controller.extract(sentence);
  const previous = f.commands.at(-1);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  f.controller.setSource("content-two|video-two"); await rejected;
  assert.equal(f.commands.at(-1).action, "close");
  assert.equal(f.controller.getSnapshot().phase, "idle");
  assert.deepEqual(f.controller.getSnapshot().ranges, []);
  assert.equal(f.timers.size, 0);
  f.controller.enable();
  f.event("enabled", { sessionId: previous.sessionId, requestId: previous.sessionId });
  f.complete({ sessionId: previous.sessionId, requestId: previous.requestId });
  assert.equal(f.controller.getSnapshot().phase, "checking");
  f.controller.dispose();
});

test("untrusted payloads cannot publish wrong range, invalid RIFF or fabricated audio duration", async () => {
  for (const extra of [
    { start: 10.1 }, { end: 12.1 }, { start: NaN }, { end: Infinity }, { durationMs: 1000 },
    { durationMs: 2050 }, { audioBase64: "bad audio" }, { audioBase64: Buffer.from("not wav").toString("base64") },
    { mimeType: "audio/webm" }, { captureId: "../unexpected" },
    { audioBase64: (() => { const bytes = wav(); bytes.writeUInt16LE(2, 22); return bytes.toString("base64"); })() }
  ]) {
    const f = fixture(); f.enable(); f.coverage();
    const pending = f.controller.extract(sentence);
    f.complete(extra);
    await assert.rejects(pending, /invalid or incomplete/);
    assert.equal(f.controller.getSnapshot().phase, "enabled");
    assert.equal(f.timers.size, 1);
    f.controller.dispose();
  }
});

test("request concurrency, range bounds and extraction timeout are bounded", async () => {
  const f = fixture(); f.enable(); f.coverage();
  for (const invalid of [{ ...sentence, id: "" }, { ...sentence, startMs: NaN }, { ...sentence, endMs: 100_000 }]) {
    await assert.rejects(f.controller.extract(invalid), /bounded reference/);
  }
  const first = f.controller.extract(sentence);
  const second = f.controller.extract(sentence);
  await assert.rejects(f.controller.extract(sentence), /busy/);
  const checks = Promise.all([assert.rejects(first, /did not return/), assert.rejects(second, /did not return/)]);
  f.advance(BUFFER_EXTRACT_TIMEOUT_MS);
  await checks;
  assert.equal(f.controller.getSnapshot().phase, "enabled");
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
});

test("session deadlines and disconnect release pending work and allow explicit retry", async () => {
  for (const phase of ["ping", "arm"]) {
    const f = fixture();
    if (phase === "ping") f.controller.enable(); else f.arm();
    f.advance(phase === "ping" ? BUFFER_PING_TIMEOUT_MS : BUFFER_ARM_TIMEOUT_MS);
    assert.equal(f.controller.getSnapshot().phase, "error");
    assert.equal(f.commands.at(-1).action, "close");
    assert.equal(f.timers.size, 0);
    f.controller.enable(); assert.equal(f.controller.getSnapshot().phase, "checking");
    f.controller.dispose();
  }
  const f = fixture(); f.enable(); f.coverage();
  const pending = f.controller.extract(sentence);
  f.event("closed", { error: "The tab lease expired." });
  await assert.rejects(pending, /lease expired/);
  assert.equal(f.controller.getSnapshot().phase, "error");
  assert.deepEqual(f.controller.getSnapshot().ranges, []);
  assert.equal(f.timers.size, 0);
});

test("disposal emits no state update and supports Strict Mode remount; foreign envelopes are ignored", () => {
  const f = fixture(); f.enable();
  const count = f.states.length;
  for (const value of [null, {}, { type: "LIBITU_BUFFER_EVENT", version: 2 },
    { type: "LIBITU_BUFFER_EVENT", version: 4, sessionId: "foreign", requestId: "foreign", status: "closed" }]) {
    f.controller.handleMessage(value);
  }
  assert.equal(f.states.length, count);
  f.controller.dispose();
  assert.equal(f.states.length, count);
  assert.equal(f.timers.size, 0);
  f.controller.setSource("content-one|video-one");
  f.enable(); assert.equal(f.controller.getSnapshot().phase, "enabled");
  f.controller.dispose();
});

test("availability does not announce toolbar readiness before arm acknowledgement", () => {
  const f = fixture(); f.controller.enable(); f.event("available");
  assert.equal(f.controller.getSnapshot().phase, "preparing");
  f.event("available");
  assert.equal(f.commands.filter(command => command.action === "arm").length, 1);
  f.advance(BUFFER_PREPARE_TIMEOUT_MS - 1);
  assert.equal(f.controller.getSnapshot().phase, "preparing");
  f.event("armed"); assert.equal(f.controller.getSnapshot().phase, "armed");
  f.advance(1); assert.equal(f.controller.getSnapshot().phase, "armed");
  f.controller.dispose();
});

test("preparation cancellation and timeout ignore late armed/enabled responses", () => {
  for (const cancel of [true, false]) {
    const f = fixture(); f.controller.enable(); f.event("available");
    if (cancel) f.controller.disable(); else f.advance(BUFFER_PREPARE_TIMEOUT_MS);
    assert.equal(f.commands.at(-1).action, "close");
    const phase = f.controller.getSnapshot().phase;
    assert.equal(phase, cancel ? "idle" : "error");
    f.event("armed"); f.event("enabled");
    assert.equal(f.controller.getSnapshot().phase, phase);
    f.controller.dispose();
  }
});
