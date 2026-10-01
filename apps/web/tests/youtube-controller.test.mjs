import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { YouTubePlaybackController } from "../features/playback/youtube-controller.ts";

afterEach(() => mock.restoreAll());

function fixture({ attach = true } = {}) {
  const calls = [];
  const times = [];
  const playback = [];
  const errors = [];
  let time = 0;
  const controller = new YouTubePlaybackController({
    time: (value) => times.push(value), playback: (value) => playback.push(value), error: (value) => errors.push(value)
  });
  const player = {
    getCurrentTime: () => time,
    seekTo: (value) => calls.push(["seek", value]),
    playVideo: () => { calls.push(["play"]); controller.onStateChange(1); },
    pauseVideo: () => { calls.push(["pause"]); controller.onStateChange(2); },
    setPlaybackRate: (rate) => calls.push(["rate", rate])
  };
  if (attach) controller.attach(player);
  calls.length = 0;
  return { controller, player, calls, times, playback, errors, sample(value) { time = value; controller.sample(value); } };
}

test("seeking cues paused by default; Stage 1 can explicitly request playback", () => {
  const f = fixture();
  f.controller.seekTo(5);
  assert.ok(!f.calls.some(([action]) => action === "play"));
  assert.deepEqual(f.calls.at(-1), ["pause"]);
  f.sample(5);
  f.controller.seekTo(12, { autoplay: true });
  assert.deepEqual(f.calls.at(-1), ["play"]);
});

test("paused-seek telemetry blocks native play until the target position is acknowledged", () => {
  const f = fixture();
  assert.equal(f.controller.isPausedSeekPending(), false);
  f.controller.seekTo(5);
  assert.equal(f.controller.isPausedSeekPending(), true);
  f.controller.onStateChange(1); // YouTube may emit Play while completing a paused seek.
  assert.deepEqual(f.calls.at(-1), ["pause"]);
  assert.equal(f.playback.includes(true), false, "a transient native Play cannot authorize capture or playback");
  f.sample(0);
  assert.equal(f.controller.isPausedSeekPending(), true, "the old video time does not release the capture guard");
  f.sample(5);
  assert.equal(f.controller.isPausedSeekPending(), false);
  f.controller.onStateChange(1);
  assert.equal(f.playback.at(-1), true, "a subsequent intentional native Play is accepted");
});

test("the paused-seek guard follows explicit playback intent and player attachment", () => {
  const f = fixture({ attach: false });
  f.controller.seekTo(8);
  assert.equal(f.controller.isPausedSeekPending(), false, "there is no native seek before the player is ready");
  f.controller.attach(f.player);
  assert.equal(f.controller.isPausedSeekPending(), true);
  f.controller.play();
  assert.equal(f.controller.isPausedSeekPending(), false, "explicit Play permits capture even before the seek clock catches up");
  f.controller.pause();
  assert.equal(f.controller.isPausedSeekPending(), true, "cancelled autoplay restores protection against a late Play event");
  f.controller.seekTo(10, { autoplay: true });
  assert.equal(f.controller.isPausedSeekPending(), false, "Stage 1 timestamp autoplay keeps its previous behavior");
  assert.equal(f.controller.isSeekPending(), true, "word highlighting still waits for the autoplay seek to reach its target");
  f.sample(10);
  assert.equal(f.controller.isSeekPending(), false);
  f.controller.pause();
  f.controller.detach();
  assert.equal(f.controller.isPausedSeekPending(), false, "a detached player has no pending native seek");
});

test("before readiness only the latest seek and playback intent survive", () => {
  const f = fixture({ attach: false });
  f.controller.seekTo(2, { autoplay: true });
  f.controller.seekTo(9);
  f.controller.setPlaybackRate(0.75);
  f.controller.attach(f.player);
  assert.deepEqual(f.calls.filter(([action]) => action === "seek"), [["seek", 9]]);
  assert.ok(!f.calls.some(([action]) => action === "play"));
  assert.ok(f.calls.some(([action, rate]) => action === "rate" && rate === 0.75));
});

test("a pause before readiness cancels queued autoplay", () => {
  const f = fixture({ attach: false });
  f.controller.playRange(5, 8, { loop: true });
  f.controller.pause();
  f.controller.attach(f.player);
  assert.ok(!f.calls.some(([action]) => action === "play"));
});

test("looping waits for the full range; stale seek samples cannot trigger another loop", () => {
  const f = fixture();
  f.controller.playRange(5, 8, { loop: true });
  f.sample(5);
  f.calls.length = 0;
  f.sample(7.99);
  assert.deepEqual(f.calls, []);
  f.sample(8.03);
  assert.deepEqual(f.calls, [["seek", 5], ["play"]]);
  f.sample(8.1);
  f.sample(8.2);
  assert.equal(f.calls.length, 2);
  f.sample(5.1);
  f.sample(8);
  assert.equal(f.calls.length, 4);
});

test("short sentence endpoints cannot acknowledge a pending loop seek", () => {
  const f = fixture();
  f.controller.playRange(5, 5.2, { loop: true });
  f.sample(5);
  f.calls.length = 0;
  f.sample(5.2);
  f.sample(5.2);
  f.sample(5.3);
  assert.deepEqual(f.calls, [["seek", 5], ["play"]]);
  f.sample(5.02);
  f.sample(5.2);
  assert.equal(f.calls.length, 4);
});

test("paused playback at the endpoint stays paused even with looping enabled", () => {
  const f = fixture();
  f.controller.playRange(5, 8, { loop: true });
  f.sample(5);
  f.controller.pause();
  f.calls.length = 0;
  f.sample(8);
  f.sample(9);
  assert.deepEqual(f.calls, []);
});

test("loop off pauses at the end and play restarts the selected range", () => {
  const f = fixture();
  f.controller.playRange(5, 8);
  f.sample(5);
  f.calls.length = 0;
  f.sample(8.1);
  assert.deepEqual(f.calls, [["pause"]]);
  f.controller.play();
  assert.deepEqual(f.calls.slice(-2), [["seek", 5], ["play"]]);
});

test("switching from a segment to a sentence replaces the old loop atomically", () => {
  const f = fixture();
  f.controller.playRange(0, 30, { loop: true });
  f.sample(0);
  f.controller.pause();
  f.controller.setRange({ start: 10, end: 13, loop: true });
  f.controller.seekTo(10);
  f.sample(29.9);
  f.sample(10);
  f.controller.play();
  f.calls.length = 0;
  f.sample(13);
  assert.deepEqual(f.calls, [["seek", 10], ["play"]]);
});

test("a cancelled seek cannot play late; buffering does not start a loop", () => {
  const f = fixture();
  f.controller.playRange(5, 8, { loop: true });
  f.controller.seekTo(12);
  f.controller.onStateChange(1);
  assert.deepEqual(f.calls.at(-1), ["pause"]);
  f.sample(12);
  f.controller.playRange(5, 8, { loop: true });
  f.sample(5);
  f.controller.onStateChange(3);
  f.calls.length = 0;
  f.sample(8);
  assert.deepEqual(f.calls, []);
});

test("native ended events loop the final segment; detached callbacks are inert", () => {
  const f = fixture();
  f.controller.playRange(5, 8, { loop: true });
  f.sample(5);
  f.calls.length = 0;
  f.controller.onStateChange(0);
  assert.deepEqual(f.calls, [["seek", 5], ["play"]]);
  f.controller.detach();
  f.calls.length = 0;
  f.sample(8);
  f.controller.onStateChange(0);
  assert.deepEqual(f.calls, []);
});

test("an unsuccessful seek stops with a recoverable message instead of spinning", () => {
  const f = fixture();
  mock.method(Date, "now", () => 1000);
  f.controller.playRange(5, 8, { loop: true });
  Date.now.mock.mockImplementation(() => 5000);
  f.sample(0);
  assert.equal(f.errors.length, 1);
  assert.equal(f.playback.at(-1), false);
});
