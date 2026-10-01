import assert from "node:assert/strict";
import { test } from "node:test";
import { createPcmReferenceBuffer, encodeMonoWav } from "../src/buffer-pcm.js";

function fixture(options = {}) {
  let counter = 0;
  const buffer = createPcmReferenceBuffer({ sampleRate: 8000, idFactory: () => `capture-${++counter}`, ...options });
  const observe = (wall, time = wall + 100, extra = {}) => buffer.observe({
    epochTime: 1700000000000 + wall * 1000, wallTime: wall * 1000, time, state: 1, rate: 1, generation: 0, ...extra
  }, wall);
  const append = (start, end, value = 1000) => buffer.append(Math.round(start * 8000), new Int16Array(Math.round((end - start) * 8000)).fill(value));
  const play = (first = 0, last = 2, offset = 100, extra = {}) => {
    observe(first, first + offset, extra);
    for (let current = first; current < last; current += 0.25) {
      append(current, current + 0.25); observe(current + 0.25, current + 0.25 + offset, extra);
    }
  };
  return { buffer, observe, append, play };
}

test("WAV contains actual mono signed PCM samples and correct rate/duration header", () => {
  const bytes = encodeMonoWav(new Int16Array([-32768, 0, 32767]), 48000);
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), "RIFF");
  assert.equal(Buffer.from(bytes.subarray(8, 12)).toString(), "WAVE");
  const header = new DataView(bytes.buffer);
  assert.equal(header.getUint16(20, true), 1); assert.equal(header.getUint16(22, true), 1);
  assert.equal(header.getUint32(24, true), 48000); assert.equal(header.getUint16(34, true), 16);
  assert.equal(header.getUint32(40, true), 6); assert.equal(header.getInt16(44, true), -32768);
  assert.equal(header.getInt16(48, true), 32767);
});

test("verified 1x video timeline maps to PCM clock rather than absolute video offset", () => {
  const f = fixture(); f.play();
  const result = f.buffer.extract(100.5, 101.5);
  assert.equal(result.status, "complete"); assert.equal(result.durationMs, 1000);
  assert.equal(result.bytes.length, 16044); assert.equal(result.start, 100.5); assert.equal(result.end, 101.5);
  assert.equal(result.captureId, "capture-1");
  assert.equal(new DataView(result.bytes.buffer).getInt16(44, true), 1000);
  assert.equal(f.buffer.extract(0, 1).status, "missing");
});

test("telemetry alone never claims coverage and future or missing samples cannot be exported", () => {
  const f = fixture(); f.observe(0); f.observe(0.25);
  assert.deepEqual(f.buffer.snapshot().ranges, []);
  f.append(0.25, 0.5); f.observe(0.5);
  assert.equal(f.buffer.extract(100, 100.4).status, "missing");
  assert.equal(f.buffer.extract(100.3, 100.4).status, "complete");
  assert.equal(f.buffer.extract(100.3, 100.6).status, "missing");
});

test("pause, seek, rate, generation, delayed observation and PCM holes cannot be stitched", () => {
  for (const cause of ["pause", "seek", "rate", "generation", "stale", "pcm-hole"]) {
    const f = fixture(); f.play(0, 1);
    if (cause === "pause") { f.observe(1.1, 101, { state: 2 }); f.observe(1.25, 101.25); }
    if (cause === "seek") f.observe(1.25, 130);
    if (cause === "rate") f.observe(1.25, 101.25, { rate: 1.3 });
    if (cause === "generation") f.observe(1.25, 101.25, { generation: 1 });
    if (cause === "stale") f.observe(2.5, 102.5);
    if (cause === "pcm-hole") f.observe(1.25);
    const offset = cause === "seek" ? 128.75 : 100;
    f.play(cause === "stale" ? 2.5 : 1.5, 3.5, offset, cause === "generation" ? { generation: 1 } : {});
    assert.equal(f.buffer.extract(100.5, 102).status, "missing", cause);
    assert.equal(f.buffer.extract(100.25, 100.75).status, "complete", cause);
  }
});

test("continuous PCM across a generation boundary is still two separate reference runs", () => {
  const f = fixture(); f.play(0, 1);
  f.observe(1, 101, { generation: 1 });
  f.play(1, 2, 100, { generation: 1 });
  assert.equal(f.buffer.extract(100.5, 101.5).status, "missing");
  assert.equal(f.buffer.extract(101.1, 101.9).status, "complete");
});

test("byte and time eviction remove old coverage, idle and stale samples are not retained", () => {
  const f = fixture({ maxBytes: 16000, maxSeconds: 10 }); f.play(0, 3);
  assert.ok(f.buffer.snapshot().retainedBytes <= 16000);
  assert.equal(f.buffer.extract(100, 100.5).status, "missing");
  assert.equal(f.buffer.extract(102.25, 102.75).status, "complete");
  const before = f.buffer.snapshot().retainedBytes;
  f.observe(3.1, 103, { state: 2 }); f.append(3.1, 3.35);
  assert.equal(f.buffer.snapshot().retainedBytes, before);
  f.observe(4, 104); f.append(5, 5.25);
  assert.equal(f.buffer.snapshot().retainedBytes, before);
  const duration = fixture({ maxSeconds: 1 }); duration.play(0, 3);
  assert.equal(duration.buffer.extract(100, 101).status, "missing");
  duration.buffer.clear(); assert.deepEqual(duration.buffer.snapshot(), { ranges: [], retainedBytes: 0, recording: false });
});

test("invalid and oversized requested ranges abstain without allocating a clip", () => {
  const f = fixture(); f.play();
  for (const [start, end] of [[NaN, 1], [-1, 1], [1, 1], [100, 161]]) assert.equal(f.buffer.extract(start, end).status, "missing");
});

test("another full listening pass returns its new samples rather than an older overlapping capture", () => {
  const f = fixture(); f.play(0, 2);
  const original = f.buffer.extract(100.5, 101.5);
  f.observe(3, 100, { generation: 1 });
  for (let now = 3; now < 5; now += 0.25) {
    f.append(now, now + 0.25, -2345); f.observe(now + 0.25, now - 3 + 100.25, { generation: 1 });
  }
  const fresh = f.buffer.extract(100.5, 101.5);
  assert.equal(fresh.status, "complete"); assert.notEqual(fresh.captureId, original.captureId);
  assert.equal(new DataView(fresh.bytes.buffer).getInt16(44, true), -2345);
});
