import assert from "node:assert/strict";
import test from "node:test";
import { extractAcousticFeatures, speechSegmentsFromProbabilities, VAD_FRAME_SAMPLES } from "../features/stage-two/acoustics/features.ts";
import { compareAcoustics } from "../features/stage-two/acoustics/comparison.ts";
import { resampleMono, rmsDbfs } from "../features/stage-two/acoustics/signal.ts";
import { validateAudioWindow } from "../features/stage-two/acoustics/window.ts";
import { analyzeLocalAudio } from "../features/stage-two/acoustics/client.ts";

function tone(seconds = 2, hz = 180, sampleRate = 16000, amplitude = 0.2) {
  return Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / sampleRate));
}
function detected(samples, probability = 0.95) {
  return Array(Math.ceil(samples.length / VAD_FRAME_SAMPLES)).fill(probability);
}
function near(actual, expected, tolerance = 0.01) { assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be near ${expected}`); }

test("pitch baseline measures known tones and normalizes each speaker independently", () => {
  const low = tone(2, 120);
  const high = tone(2, 240);
  const first = extractAcousticFeatures(low, detected(low));
  const second = extractAcousticFeatures(high, detected(high));
  near(first.pitchMedianHz, 120, 1);
  near(second.pitchMedianHz, 240, 1);
  assert.equal(first.quality.status, "usable");
  assert.ok(first.pitchCurve.filter((point) => point.semitones !== null).every((point) => Math.abs(point.semitones) < 0.5));
  near(compareAcoustics(first, second).pitchRangeDifferenceSemitones, 0, 0.1);
});

test("relative pitch retains a known octave interval without comparing absolute voice register", () => {
  const audio = new Float32Array(48000);
  audio.set(tone(1.5, 120));
  audio.set(tone(1.5, 240), 24000);
  const features = extractAcousticFeatures(audio, detected(audio));
  near(features.pitchRangeSemitones, 12, 0.1);
  const relative = features.pitchCurve.flatMap((point) => point.semitones === null ? [] : [point.semitones]);
  near(Math.max(...relative) - Math.min(...relative), 12, 0.5);
});

test("VAD hysteresis rejects short bursts and does not count capture silence as internal pauses", () => {
  const probabilities = [0, 0, 0.9, 0.9, 0, 0, 0, 0, 0, ...Array(12).fill(0.9), ...Array(8).fill(0), ...Array(12).fill(0.9), ...Array(7).fill(0)];
  const segments = speechSegmentsFromProbabilities(probabilities, probabilities.length * 32);
  assert.deepEqual(segments, [{ startMs: 288, endMs: 672 }, { startMs: 928, endMs: 1312 }]);
  const features = extractAcousticFeatures(tone(probabilities.length * 0.032), probabilities);
  assert.equal(features.pauseCount, 1);
  assert.equal(features.internalPauseDurationMs, 256);
  assert.equal(features.speechSpanMs, 1024);
  assert.equal(features.speechDurationMs, 768);
  assert.ok(features.pitchCurve.filter((point) => point.timeMs < 288 || point.timeMs >= 1312).every((point) => point.hz === null));
});

test("small VAD probability fluctuations do not fragment continuous speech", () => {
  const probabilities = [...Array(10).fill(0.9), 0.2, 0.45, ...Array(10).fill(0.9)];
  assert.deepEqual(speechSegmentsFromProbabilities(probabilities, 704), [{ startMs: 0, endMs: 704 }]);
});

test("silent recordings abstain and provide no misleading pitch or comparison", () => {
  const silence = new Float32Array(32000);
  const features = extractAcousticFeatures(silence, detected(silence, 0));
  assert.equal(features.quality.status, "insufficient");
  assert.ok(features.quality.issues.includes("silent"));
  assert.ok(features.quality.issues.includes("insufficient_speech"));
  assert.equal(features.pitchMedianHz, null);
  assert.equal(features.speechSpanMs, null);
  assert.equal(compareAcoustics(features, features).durationRatio, null);
  assert.ok(features.energyCurve.every((point) => Number.isFinite(point.dbfs)));
});

test("too-short and low voiced evidence are separate gates, with timing available for unvoiced speech", () => {
  const short = tone(0.25);
  assert.ok(extractAcousticFeatures(short, detected(short)).quality.issues.includes("too_short"));
  // A deterministic nonperiodic waveform with VAD probabilities supplied by the fixture.
  let seed = 73;
  const noise = Float32Array.from({ length: 32000 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed / 2 ** 32 - 0.5) * 0.2; });
  const features = extractAcousticFeatures(noise, detected(noise));
  assert.equal(features.quality.status, "usable");
  assert.deepEqual(features.quality.issues, ["insufficient_pitch"]);
  assert.equal(features.pitchMedianHz, null);
  assert.equal(compareAcoustics(features, features).status, "available");
  assert.equal(compareAcoustics(features, features).pitchRangeDifferenceSemitones, null);
});

test("comparison uses speech span rather than extra microphone or capture lead-in", () => {
  const samples = tone(2);
  const features = extractAcousticFeatures(samples, detected(samples));
  const withLeadIn = { ...features, durationMs: 5000, speechStartMs: 3000, speechEndMs: 5000 };
  assert.equal(compareAcoustics(features, withLeadIn).durationRatio, 1);
  const slower = { ...features, speechSpanMs: 3000, speechDurationMs: 3000, pauseCount: 2 };
  const comparison = compareAcoustics(features, slower);
  assert.equal(comparison.durationRatio, 1.5);
  assert.equal(comparison.pauseCountDifference, 2);
  assert.equal("score" in comparison, false);
});

test("resampling preserves speech-band frequency and suppresses above-Nyquist aliasing", () => {
  const low = resampleMono(tone(1, 180, 48000), 48000);
  assert.equal(low.length, 16000);
  near(extractAcousticFeatures(low, detected(low)).pitchMedianHz, 180, 1);
  const high = resampleMono(tone(1, 12000, 48000), 48000);
  assert.ok(rmsDbfs(high.subarray(100, -100)) < -65);
  const oddRate = resampleMono(tone(0.75, 220, 44100), 44100);
  assert.equal(oddRate.length, 12000);
});

test("invalid PCM and detector outputs fail instead of fabricating defaults", () => {
  assert.throws(() => resampleMono(new Float32Array(), 16000));
  assert.throws(() => resampleMono(new Float32Array([NaN]), 16000));
  assert.throws(() => resampleMono(new Float32Array(16000 * 66), 16000));
  assert.throws(() => resampleMono(tone(), 4000));
  assert.throws(() => extractAcousticFeatures(tone(), []));
  assert.throws(() => speechSegmentsFromProbabilities([NaN], 1000));
});

test("capture trimming is explicit and cannot silently accept missing sentence audio", () => {
  assert.deepEqual(validateAudioWindow(2500), { startMs: 0, endMs: 2500 });
  assert.deepEqual(validateAudioWindow(2500, { startMs: 250, endMs: 2000 }), { startMs: 250, endMs: 2000 });
  for (const range of [{ startMs: -1, endMs: 1000 }, { startMs: 1000, endMs: 1000 }, { startMs: 0, endMs: 2501 }, { startMs: NaN, endMs: 10 }]) assert.throws(() => validateAudioWindow(2500, range));
  assert.throws(() => validateAudioWindow(65001));
});

function localAudioHarness(options = {}) {
  const originals = new Map(["AudioContext", "Worker", "location"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const contexts = [];
  const workers = [];
  const decoded = { duration: 2, length: 32000, sampleRate: 16000, numberOfChannels: 2, getChannelData: (channel) => new Float32Array(32000).fill(channel ? 0.3 : 0.1), ...options.decoded };
  class Context {
    constructor() { this.closed = 0; contexts.push(this); }
    decodeAudioData() { return options.decode ? options.decode() : Promise.resolve(decoded); }
    close() { this.closed++; return Promise.resolve(); }
  }
  class Worker {
    constructor(url) { this.url = url; this.terminated = false; workers.push(this); }
    postMessage(request, transfer) { this.request = request; this.transfer = transfer; options.onRequest?.(this); }
    terminate() { this.terminated = true; }
  }
  Object.defineProperties(globalThis, {
    AudioContext: { configurable: true, writable: true, value: Context },
    Worker: { configurable: true, writable: true, value: Worker },
    location: { configurable: true, writable: true, value: { origin: "https://local.test" } },
  });
  return { contexts, workers, decoded, restore() {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  } };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("client trims PCM, mixes stereo, transfers to its worker and releases resources on completion", async () => {
  const harness = localAudioHarness();
  try {
    const result = analyzeLocalAudio(new Blob(["encoded"]), undefined, { startMs: 250, endMs: 1750 });
    await flush();
    assert.equal(harness.workers.length, 1);
    const worker = harness.workers[0];
    assert.equal(worker.request.samples.length, 24000);
    near(worker.request.samples[0], 0.2);
    assert.equal(worker.request.assetOrigin, "https://local.test");
    assert.equal(worker.transfer[0], worker.request.samples.buffer);
    assert.equal(harness.contexts[0].closed, 1);
    const expected = { version: "local-acoustics-v1" };
    worker.onmessage({ data: { type: "complete", features: expected } });
    assert.equal(await result, expected);
    assert.equal(worker.terminated, true);
  } finally { harness.restore(); }
});

test("client cancellation during decoding releases context and ignores its late completion", async () => {
  let finishDecode;
  const harness = localAudioHarness({ decode: () => new Promise((resolve) => { finishDecode = resolve; }) });
  try {
    const controller = new AbortController();
    const result = analyzeLocalAudio(new Blob(["encoded"]), controller.signal);
    const rejected = assert.rejects(result, { name: "AbortError" });
    await flush();
    controller.abort();
    await rejected;
    finishDecode(harness.decoded);
    await flush();
    assert.equal(harness.contexts[0].closed, 1);
    assert.equal(harness.workers.length, 0);
  } finally { harness.restore(); }
});

test("client cancellation during inference terminates the worker and ignores late results", async () => {
  const harness = localAudioHarness();
  try {
    const controller = new AbortController();
    const result = analyzeLocalAudio(new Blob(["encoded"]), controller.signal);
    const rejected = assert.rejects(result, { name: "AbortError" });
    await flush();
    controller.abort();
    await rejected;
    assert.equal(harness.workers[0].terminated, true);
    harness.workers[0].onmessage({ data: { type: "complete", features: {} } });
  } finally { harness.restore(); }
});

test("model failure remains visible and never switches silently to an energy detector", async () => {
  const harness = localAudioHarness();
  try {
    const result = analyzeLocalAudio(new Blob(["encoded"]));
    const rejected = assert.rejects(result, /model unavailable/);
    await flush();
    harness.workers[0].onmessage({ data: { type: "error", message: "model unavailable" } });
    await rejected;
    assert.equal(harness.workers[0].terminated, true);
    assert.equal(harness.workers.length, 1);
  } finally { harness.restore(); }
});

test("invalid decoded duration releases context before creating a worker", async () => {
  const harness = localAudioHarness({ decoded: { duration: 70 } });
  try {
    await assert.rejects(analyzeLocalAudio(new Blob(["encoded"])), /65 seconds/);
    assert.equal(harness.contexts[0].closed, 1);
    assert.equal(harness.workers.length, 0);
  } finally { harness.restore(); }
});

test("already-aborted and empty input requests acquire no browser resources", async () => {
  const harness = localAudioHarness();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(analyzeLocalAudio(new Blob(["encoded"]), controller.signal), { name: "AbortError" });
    await assert.rejects(analyzeLocalAudio(new Blob()), /empty/);
    assert.equal(harness.contexts.length, 0);
    assert.equal(harness.workers.length, 0);
  } finally { harness.restore(); }
});

test("an analysis deadline terminates a stalled worker and leaves a retryable error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = localAudioHarness();
  try {
    const result = analyzeLocalAudio(new Blob(["encoded"]));
    const rejected = assert.rejects(result, /took too long/);
    await flush();
    t.mock.timers.tick(90000);
    await rejected;
    assert.equal(harness.workers[0].terminated, true);
    assert.equal(harness.contexts[0].closed, 1);
  } finally { harness.restore(); }
});
