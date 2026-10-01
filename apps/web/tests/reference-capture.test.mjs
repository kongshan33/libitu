import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ReferenceCaptureController, REFERENCE_PING_TIMEOUT_MS, REFERENCE_ARM_TIMEOUT_MS,
  REFERENCE_ENCODER_TIMEOUT_MS, REFERENCE_START_TIMEOUT_MS, REFERENCE_FINISH_TIMEOUT_MS, REFERENCE_HEARTBEAT_MS
} from "../features/stage-two/reference/reference-capture.ts";

function fixture() {
  let now = 1_000_000;
  let sequence = 0;
  let timerSequence = 0;
  const timers = new Map();
  const commands = [];
  const states = [];
  const player = [];
  const controller = new ReferenceCaptureController({
    change: (state) => states.push(state), prepare: (range) => player.push(["prepare", range]),
    play: () => player.push(["play"]), pause: () => player.push(["pause"])
  }, {
    now: () => now,
    requestId: () => "request-" + ++sequence,
    send: (message) => commands.push(message),
    setTimeout(callback, milliseconds) {
      const id = ++timerSequence;
      timers.set(id, { at: now + milliseconds, callback });
      return id;
    },
    clearTimeout: (id) => timers.delete(id)
  });
  controller.setSentence("sentence-1", { start: 10, end: 12 });
  controller.setEligible(true);
  function advance(milliseconds) {
    const target = now + milliseconds;
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
    const sessionEvent = ["available", "armed", "enabled", "closed"].includes(status);
    controller.handleMessage({ type: "LIBITU_REFERENCE_EVENT", version: 2, sessionId,
      requestId: sessionEvent ? sessionId : commands.findLast((command) => command.action === "begin")?.requestId,
      status, ...extra });
  }
  function sample(time, { state = 1, rate = 1, delta = 100, epochSkew = 0 } = {}) {
    advance(delta);
    controller.sample({ time, state, rate, wallTime: now - 900_000, epochTime: now + epochSkew });
  }
  function arm() { controller.enable(); event("available"); event("armed"); }
  function enable() { arm(); event("enabled"); }
  function begin(delay = 0) {
    if (controller.getSnapshot().sessionPhase !== "enabled") enable();
    assert.equal(controller.play(), true);
    event("recording", { captureStartedAt: now });
    advance(delay);
    sample(10, { delta: 0 });
  }
  function reachEnd() { for (let index = 1; index <= 20; index += 1) sample(10 + index / 10); }
  function complete(extra = {}) {
    event("complete", { audioBase64: Buffer.from("encoded audio fixture").toString("base64"),
      mimeType: "audio/webm;codecs=opus", durationMs: 2000, ...extra });
  }
  return { controller, commands, states, player, timers, advance, event, sample, arm, enable, begin, reachEnd, complete, now: () => now };
}

test("enabling authorizes the tab once without playback or an encoder", () => {
  const f = fixture();
  f.arm();
  assert.equal(f.controller.getSnapshot().sessionPhase, "armed");
  assert.equal(f.controller.isBusy(), false);
  assert.deepEqual(f.commands.map((command) => command.action), ["ping", "arm"]);
  assert.deepEqual(f.player, []);
  f.event("enabled");
  assert.equal(f.controller.getSnapshot().sessionPhase, "enabled");
  assert.deepEqual(f.player, []);
  assert.equal(f.commands.every((command) => command.requestId === command.sessionId && command.version === 2), true);
});

test("first eligible Play starts an encoder before the sentence and publishes bounded local trim", async () => {
  const f = fixture();
  f.enable();
  assert.equal(f.controller.play(), true);
  assert.equal(f.controller.getSnapshot().phase, "starting");
  assert.equal(f.commands.at(-1).action, "begin");
  assert.notEqual(f.commands.at(-1).requestId, f.commands.at(-1).sessionId);
  assert.deepEqual(f.player, [["prepare", { start: 10, end: 12 }]]);
  f.event("recording", { captureStartedAt: f.now() });
  f.sample(10, { state: 3, delta: 300 });
  f.sample(10, { delta: 100 });
  f.reachEnd();
  assert.equal(f.controller.getSnapshot().phase, "stopping");
  assert.equal(f.commands.at(-1).action, "stop");
  f.complete({ durationMs: 2400 });
  const state = f.controller.getSnapshot();
  assert.equal(state.phase, "ready");
  assert.equal(state.sessionPhase, "enabled");
  assert.equal(state.clip.sentenceId, "sentence-1");
  assert.equal(state.clip.rangeStart, 10);
  assert.equal(state.clip.rangeEnd, 12);
  assert.equal(state.clip.startOffsetMs, 400);
  assert.equal(state.clip.endOffsetMs, 2400);
  assert.equal(await state.clip.blob.text(), "encoded audio fixture");
  assert.equal(f.timers.size, 1, "only the session heartbeat remains");
  assert.equal(f.controller.isBusy(), false);
});

test("normal playback is untouched before authorization, for context/speed/microphone gates, or invalid bounds", () => {
  const f = fixture();
  assert.equal(f.controller.play(), false);
  assert.equal(f.commands.length, 0);
  f.enable();
  f.controller.setEligible(false);
  assert.equal(f.controller.play(), false);
  f.sample(10, { state: 2 }); f.sample(10);
  assert.equal(f.commands.some((command) => command.action === "begin"), false);
  f.controller.setEligible(true);
  for (const range of [null, { start: -1, end: 2 }, { start: 1, end: 1 }, { start: 0, end: 61 },
    { start: NaN, end: 1 }, { start: 0, end: Infinity }]) {
    f.controller.setSentence("sentence-1", range);
    assert.equal(f.controller.play(), false);
  }
});

test("raw or cached reference prevents repeated capture, with identity-guarded raw release", () => {
  const f = fixture();
  f.begin(); f.reachEnd(); f.complete();
  const clip = f.controller.getSnapshot().clip;
  assert.equal(f.controller.play(), false);
  f.controller.releaseClip({ ...clip });
  assert.equal(f.controller.getSnapshot().clip, clip);
  f.controller.setReferenceReady(true);
  f.controller.releaseClip(clip);
  assert.equal(f.controller.getSnapshot().clip, null);
  assert.equal(f.controller.play(), false, "pending/ready/error cache entries avoid automatic duplicate work");
  f.controller.setReferenceReady(false);
  assert.equal(f.controller.play(), true, "explicit cache invalidation permits recapture on the next Play");
  assert.equal(f.commands.filter((command) => command.action === "arm").length, 1);
});

test("sentence changes retain one authorized tab stream and invalidate only the old clip", () => {
  const f = fixture();
  f.begin();
  const oldRequestId = f.commands.at(-1).requestId;
  const sessionId = f.commands.at(-1).sessionId;
  f.controller.setSentence("sentence-2", { start: 12, end: 14 });
  assert.equal(f.commands.at(-1).action, "cancel");
  assert.equal(f.controller.getSnapshot().sessionPhase, "enabled");
  assert.equal(f.controller.getSnapshot().clip, null);
  f.event("recording", { requestId: oldRequestId, captureStartedAt: f.now() });
  f.complete({ requestId: oldRequestId });
  assert.equal(f.controller.getSnapshot().phase, "idle");
  assert.equal(f.controller.play(), true);
  assert.equal(f.commands.at(-1).sessionId, sessionId);
  assert.notEqual(f.commands.at(-1).requestId, oldRequestId);
  assert.equal(f.commands.filter((command) => command.action === "arm").length, 1);
});

test("rapid enable/Play actions and malformed/foreign/stale/version1 events do not duplicate capture", () => {
  const f = fixture();
  f.controller.enable(); f.controller.enable();
  assert.equal(f.commands.length, 1);
  const id = f.commands.at(-1).sessionId;
  for (const value of [null, "bad", {}, { type: "LIBITU_REFERENCE_EVENT", version: 1, sessionId: id, requestId: id, status: "enabled" },
    { type: "LIBITU_REFERENCE_EVENT", version: 2, sessionId: "other", requestId: id, status: "available" }]) f.controller.handleMessage(value);
  f.event("enabled");
  assert.equal(f.controller.getSnapshot().sessionPhase, "checking");
  f.event("available"); f.event("enabled");
  f.controller.play(); f.controller.play();
  assert.equal(f.commands.filter((command) => command.action === "begin").length, 1);
  f.complete();
  assert.equal(f.controller.getSnapshot().phase, "starting", "unsolicited completion before verified range end is ignored");
});

test("native Play can capture at the boundary, while recurring playback and enabling alone cannot", () => {
  const f = fixture();
  f.sample(10, { state: 1 });
  f.enable();
  f.sample(10, { state: 1 });
  assert.equal(f.commands.some((command) => command.action === "begin"), false);
  f.sample(10, { state: 2 }); f.sample(10, { state: 1 });
  assert.equal(f.commands.at(-1).action, "begin");
  assert.equal(f.player.some(([action]) => action === "play"), false);
  f.event("recording", { captureStartedAt: f.now() });
  assert.equal(f.player.at(-1)[0], "play");
});

test("interrupted native capture cannot repeatedly recapture until the next explicit Play", () => {
  const f = fixture();
  f.begin();
  f.sample(10.1, { state: 3 });
  assert.equal(f.controller.getSnapshot().phase, "error");
  f.sample(10, { state: 2 }); f.sample(10, { state: 1 }); f.sample(10);
  assert.equal(f.commands.filter((command) => command.action === "begin").length, 1);
  assert.equal(f.controller.getSnapshot().sessionPhase, "enabled");
  assert.equal(f.controller.play(), true);
  assert.equal(f.commands.filter((command) => command.action === "begin").length, 2);
});

test("a native Play suppressed during a paused seek cannot start capture on a later ordinary time sample", () => {
  const f = fixture();
  f.enable();
  f.sample(10, { state: 2 });
  f.controller.setEligible(false); // Parent reports a native Play still blocked by a paused seek.
  f.sample(10, { state: 1 });
  f.controller.setEligible(true);
  f.sample(10, { state: 1 });
  assert.equal(f.commands.some((command) => command.action === "begin"), false);
  f.sample(10, { state: 2 });
  f.sample(10, { state: 1 });
  assert.equal(f.commands.at(-1).action, "begin", "a subsequent deliberate native Play remains supported");
});

test("session heartbeat persists between sentences and stops only on disable/clear/dispose", () => {
  const f = fixture();
  f.enable();
  f.controller.cancel();
  f.controller.setSentence("sentence-2", { start: 12, end: 14 });
  f.advance(REFERENCE_HEARTBEAT_MS * 2);
  assert.equal(f.commands.filter((command) => command.action === "heartbeat").length, 2);
  assert.equal(f.controller.getSnapshot().sessionPhase, "enabled");
  f.controller.disable();
  assert.equal(f.commands.at(-1).action, "close");
  assert.equal(f.timers.size, 0);
  const count = f.commands.length;
  f.advance(REFERENCE_HEARTBEAT_MS * 2);
  assert.equal(f.commands.length, count);
});

test("ping/toolbar deadlines close the session and make enabling recoverable", () => {
  for (const setup of ["ping", "arm"]) {
    const f = fixture();
    if (setup === "ping") f.controller.enable(); else f.arm();
    f.advance(setup === "ping" ? REFERENCE_PING_TIMEOUT_MS : REFERENCE_ARM_TIMEOUT_MS);
    assert.equal(f.controller.getSnapshot().sessionPhase, "error");
    assert.equal(f.commands.at(-1).action, "close");
    assert.equal(f.timers.size, 0);
    f.controller.enable();
    assert.equal(f.controller.getSnapshot().sessionPhase, "checking");
  }
});

test("encoder, playback, capture and finalization deadlines cancel the clip but retain authorization", () => {
  const cases = [
    { setup: (f) => { f.enable(); f.controller.play(); }, delay: REFERENCE_ENCODER_TIMEOUT_MS },
    { setup: (f) => { f.enable(); f.controller.play(); f.event("recording", { captureStartedAt: f.now() }); }, delay: REFERENCE_START_TIMEOUT_MS },
    { setup: (f) => f.begin(), delay: 6000 },
    { setup: (f) => { f.begin(); f.reachEnd(); }, delay: REFERENCE_FINISH_TIMEOUT_MS }
  ];
  for (const item of cases) {
    const f = fixture(); item.setup(f); f.advance(item.delay);
    assert.equal(f.controller.getSnapshot().phase, "error");
    assert.equal(f.controller.getSnapshot().sessionPhase, "enabled");
    assert.equal(f.commands.at(-1).action, "cancel");
    assert.equal(f.controller.isBusy(), false);
    assert.equal(f.timers.size, 1);
  }
});

test("session loss cancels active capture, preserves a previous reference, and ignores stale enabled events", () => {
  const f = fixture();
  f.begin(); f.reachEnd(); f.complete();
  const clip = f.controller.getSnapshot().clip;
  const oldSessionId = f.commands.at(-1).sessionId;
  f.event("closed");
  assert.equal(f.controller.getSnapshot().sessionPhase, "error");
  assert.equal(f.controller.getSnapshot().clip, clip);
  assert.equal(f.controller.play(), false);
  assert.equal(f.timers.size, 0);
  f.controller.enable();
  f.event("enabled", { sessionId: oldSessionId, requestId: oldSessionId });
  assert.equal(f.controller.getSnapshot().sessionPhase, "checking");
  f.event("available"); f.event("enabled");
  f.controller.releaseClip(clip); f.controller.play();
  f.event("error", { requestId: f.commands.at(-1).sessionId, error: "Session lease expired." });
  assert.equal(f.controller.isBusy(), false);
  assert.equal(f.controller.getSnapshot().sessionError, "Session lease expired.");
  assert.equal(f.timers.size, 0);
});

test("initial playback requires target position and trustworthy capture timestamp", () => {
  for (const captureStartedAt of [undefined, NaN, 996_000, 1_001_000]) {
    const f = fixture(); f.enable(); f.controller.play();
    f.event("recording", { captureStartedAt });
    assert.equal(f.controller.getSnapshot().phase, "error");
  }
  const f = fixture(); f.enable(); f.controller.play();
  f.event("recording", { captureStartedAt: f.now() }); f.sample(11, { delta: 0 });
  assert.match(f.controller.getSnapshot().error, /did not start at the selected sentence/);
});

test("mid-capture pause, buffering, rates, seeks, clock jumps and gaps are rejected", () => {
  const samples = [
    { time: 10.1, options: { state: 2 } }, { time: 10.1, options: { state: 3 } },
    { time: 10.1, options: { state: 0 } }, { time: 10.1, options: { rate: 0.75 } },
    { time: 12, options: {} }, { time: 9.8, options: {} },
    { time: 11.2, options: { delta: 1200 } }, { time: 10.1, options: { epochSkew: 2000 } }
  ];
  for (const sample of samples) {
    const f = fixture(); f.begin(); f.sample(sample.time, sample.options);
    assert.equal(f.controller.getSnapshot().phase, "error");
    assert.equal(f.commands.at(-1).action, "cancel");
    assert.equal(f.controller.getSnapshot().clip, null);
  }
});

test("native end tolerance accepts only continuous playback and trims to actual captured duration", () => {
  const f = fixture(); f.begin();
  for (let index = 1; index <= 18; index += 1) f.sample(10 + index / 10);
  f.sample(11.9, { state: 0 }); f.complete({ durationMs: 1900 });
  assert.equal(f.controller.getSnapshot().phase, "ready");
  assert.equal(f.controller.getSnapshot().clip.endOffsetMs, 1900);
});

test("cancellation during encoder startup ignores late recording without closing the tab stream", () => {
  const f = fixture(); f.enable(); f.controller.play();
  f.controller.cancel();
  f.event("recording", { captureStartedAt: f.now() }); f.complete();
  assert.equal(f.controller.getSnapshot().phase, "idle");
  assert.equal(f.controller.getSnapshot().sessionPhase, "enabled");
  assert.equal(f.player.some(([action]) => action === "play"), false);
  assert.equal(f.commands.some((command) => command.action === "close"), false);
});

test("changed eligibility cancels a live clip without revoking authorization", () => {
  const f = fixture(); f.begin();
  f.controller.setEligible(false); f.sample(10.1);
  assert.equal(f.controller.isBusy(), false);
  assert.equal(f.controller.getSnapshot().sessionPhase, "enabled");
  assert.equal(f.commands.at(-1).action, "cancel");
});

test("same sentence/range retains raw reference; changed timing or clear releases it", () => {
  const f = fixture(); f.begin(); f.reachEnd(); f.complete();
  const clip = f.controller.getSnapshot().clip;
  f.controller.setSentence("sentence-1", { start: 10, end: 12 });
  assert.equal(f.controller.getSnapshot().clip, clip);
  f.controller.setSentence("sentence-1", { start: 10, end: 13 });
  assert.equal(f.controller.getSnapshot().clip, null);
  assert.equal(f.controller.getSnapshot().sessionPhase, "enabled");
  f.controller.clear();
  assert.equal(f.controller.getSnapshot().sessionPhase, "idle");
  assert.equal(f.timers.size, 0);
});

test("malformed, oversized and truncated payloads cannot publish reference audio", () => {
  for (const extra of [{ audioBase64: "" }, { audioBase64: "not base64" }, { audioBase64: "A".repeat(8 * 1024 * 1024 + 4) },
    { mimeType: "text/html" }, { durationMs: 1000 }, { durationMs: Infinity }, { durationMs: 66_000 }]) {
    const f = fixture(); f.begin(); f.reachEnd(); f.complete(extra);
    assert.equal(f.controller.getSnapshot().phase, "error");
    assert.equal(f.controller.getSnapshot().clip, null);
    assert.equal(f.timers.size, 1);
  }
});

test("dispose closes the session silently and permits Strict Mode reinitialization", () => {
  const f = fixture(); f.begin();
  const count = f.states.length;
  f.controller.dispose();
  assert.equal(f.states.length, count);
  assert.equal(f.timers.size, 0);
  assert.equal(f.commands.at(-1).action, "close");
  assert.equal(f.controller.getSnapshot().sentenceId, null);
  f.controller.setSentence("sentence-1", { start: 10, end: 12 });
  f.controller.enable();
  assert.equal(f.controller.getSnapshot().sessionPhase, "checking");
});
