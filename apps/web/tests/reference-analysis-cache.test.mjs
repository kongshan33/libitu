import assert from "node:assert/strict";
import test from "node:test";
import { ReferenceAnalysisCache, buildReferenceKey, referenceKeyMatchesClip } from "../features/stage-two/analysis/reference-analysis-cache.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const clip = (size = 128) => ({ blob: new Blob([new Uint8Array(size)]), startOffsetMs: 100, endOffsetMs: 2100 });
const features = (status = "usable") => ({ version: "local-acoustics-v1", quality: { status, issues: status === "usable" ? [] : ["insufficient_speech"] } });
function harness(options = {}) {
  const calls = [];
  let changes = 0;
  const cache = new ReferenceAnalysisCache({ ...options, onChange: () => changes++, analyze: (blob, signal, window) =>
    new Promise((resolve, reject) => calls.push({ blob, signal, window, resolve, reject })) });
  return { cache, calls, changes: () => changes };
}
const alignmentSource = (overrides = {}) => ({
  contentId: "content", sentenceId: "sentence", text: "Hello world.", startMs: 1000, endMs: 3000, ...overrides,
});
const alignmentKey = (source = alignmentSource()) => buildReferenceKey(
  source.contentId, "https://youtube.test/one", source.sentenceId, source.startMs, source.endMs,
);
const aligned = (status = "ready", audioSha256 = "a".repeat(64)) => ({
  audioSha256,
  result: {
    status, engineVersion: "charsiu-en-fc-10ms-v1", contentVerification: "not_independently_verified",
    phoneLabels: "dictionary_targets", durationMs: 2000,
    ...(status === "ready" ? {} : { reason: "Alignment is unavailable for this reference." }),
    words: status === "ready" ? [
      { tokenIndex: 0, token: "Hello", pronunciationIndex: 0, startMs: 200, endMs: 700, phones: [{ phone: "HH", startMs: 200, endMs: 300 }] },
      { tokenIndex: 1, token: "world.", pronunciationIndex: 0, startMs: 900, endMs: 1500, phones: [{ phone: "W", startMs: 900, endMs: 1000 }] },
    ] : [],
  },
});
function alignmentHarness(options = {}) {
  const alignmentCalls = [];
  const result = harness({ ...options, align: (blob, signal, window, source) =>
    new Promise((resolve, reject) => alignmentCalls.push({ blob, signal, window, source, resolve, reject })) });
  return { ...result, alignmentCalls };
}

test("source keys include exact bounds, source and model identity; stale sentence clips cannot bind", () => {
  const key = buildReferenceKey("content", "https://youtube.test/one", "sentence", 1000, 3000);
  assert.notEqual(key, buildReferenceKey("content", "https://youtube.test/two", "sentence", 1000, 3000));
  assert.notEqual(key, buildReferenceKey("content", "https://youtube.test/one", "sentence", 1001, 3000));
  assert.equal(referenceKeyMatchesClip(key, { ...clip(), sentenceId: "sentence", rangeStart: 1, rangeEnd: 3 }), true);
  assert.equal(referenceKeyMatchesClip(key, { ...clip(), sentenceId: "other", rangeStart: 1, rangeEnd: 3 }), false);
  assert.equal(referenceKeyMatchesClip(key, { ...clip(), sentenceId: "sentence", rangeStart: 1, rangeEnd: 4 }), false);
  assert.equal(referenceKeyMatchesClip("not-json", { ...clip(), sentenceId: "sentence" }), false);
});

test("each key analyzes once and ready hits release raw audio without rerunning a worker", async () => {
  const { cache, calls } = harness();
  const first = clip();
  assert.equal(cache.ingest("one", first), true);
  assert.equal(cache.ingest("one", first), true);
  assert.equal(cache.get("one").phase, "analyzing");
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].blob, first.blob);
  assert.deepEqual(calls[0].window, { startMs: 100, endMs: 2100 });
  calls[0].resolve(features());
  await flush();
  assert.equal(cache.isReady("one"), true);
  assert.equal(cache.getUsage().rawBlobs, 0);
  assert.equal(cache.getUsage().rawBytes, 0);
  assert.equal(cache.ingest("one", clip()), true);
  await flush();
  assert.equal(calls.length, 1);
  cache.dispose();
});

test("one sequential worker and two raw clips bound the queue; selection changes preserve earlier work", async () => {
  const { cache, calls } = harness();
  assert.equal(cache.ingest("one", clip()), true);
  assert.equal(cache.ingest("two", clip()), true);
  assert.equal(cache.ingest("three", clip()), false);
  assert.deepEqual(cache.getUsage(), { entries: 2, rawBlobs: 2, rawBytes: 256, active: 1, queued: 1 });
  await flush();
  assert.equal(calls.length, 1);
  cache.get("two");
  assert.equal(calls[0].signal.aborted, false);
  calls[0].resolve(features());
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(cache.ingest("three", clip()), true);
  assert.equal(cache.get("one").phase, "ready");
  assert.equal(calls[1].signal.aborted, false);
  cache.dispose();
});

test("aggregate byte cap refuses overflow and oversized or invalid clips become errors without retained blobs", async () => {
  const { cache, calls } = harness({ maxBlobBytes: 256 });
  assert.equal(cache.ingest("one", clip(200)), true);
  assert.equal(cache.ingest("two", clip(100)), false);
  assert.equal(cache.get("two").phase, "missing");
  assert.equal(cache.ingest("oversized", clip(300)), true);
  assert.equal(cache.get("oversized").phase, "error");
  assert.equal(cache.get("oversized").canRetry, false);
  assert.match(cache.get("oversized").error, /Play the sentence again/);
  assert.equal(cache.ingest("invalid", { ...clip(), endOffsetMs: 10 }), true);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(cache.getUsage().rawBytes, 200);
  cache.dispose();
});

test("LRU evicts oldest completed feature entries while accessed sentences remain cached", async () => {
  const { cache, calls } = harness({ maxEntries: 2 });
  cache.ingest("one", clip());
  await flush(); calls[0].resolve(features()); await flush();
  cache.ingest("two", clip());
  await flush(); calls[1].resolve(features()); await flush();
  cache.get("one");
  cache.ingest("three", clip());
  assert.equal(cache.has("one"), true);
  assert.equal(cache.has("two"), false);
  assert.equal(cache.get("two").phase, "missing");
  assert.equal(cache.getUsage().entries, 2);
  cache.dispose();
});

test("analysis errors retain a bounded retry clip, but retry is explicit and success releases it", async () => {
  const { cache, calls } = harness();
  const original = clip();
  cache.ingest("one", original);
  await flush(); calls[0].reject(new Error("Model unavailable.")); await flush();
  assert.equal(cache.get("one").phase, "error");
  assert.equal(cache.get("one").canRetry, true);
  assert.equal(cache.has("one"), true);
  assert.equal(cache.ingest("one", original), true);
  await flush(); assert.equal(calls.length, 1);
  assert.equal(cache.retry("one"), true);
  assert.equal(cache.retry("one"), false);
  await flush(); assert.equal(calls.length, 2);
  assert.equal(calls[1].blob, original.blob);
  calls[1].resolve(features()); await flush();
  assert.equal(cache.isReady("one"), true);
  assert.equal(cache.getUsage().rawBlobs, 0);
  cache.dispose();
});

test("error raw audio expires after one minute and new clips may reclaim retry memory sooner", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { cache, calls } = harness({ maxBlobBytes: 256 });
  cache.ingest("one", clip(200));
  await flush(); calls[0].reject(new Error("Failed.")); await flush();
  assert.equal(cache.ingest("two", clip(200)), true);
  assert.equal(cache.get("one").canRetry, false);
  assert.equal(cache.retry("one"), false);
  await flush(); calls[1].reject(new Error("Failed again.")); await flush();
  t.mock.timers.tick(60000);
  assert.equal(cache.getUsage().rawBlobs, 0);
  assert.equal(cache.get("two").canRetry, false);
  assert.match(cache.get("two").error, /Play the sentence again/);
  cache.dispose();
});

test("insufficient-quality ready results block automatic recapture but allow explicit invalidation", async () => {
  const { cache, calls } = harness();
  cache.ingest("one", clip());
  await flush(); calls[0].resolve(features("insufficient")); await flush();
  assert.equal(cache.get("one").phase, "ready");
  assert.equal(cache.has("one"), true);
  assert.equal(cache.isReady("one"), false);
  assert.equal(cache.getUsage().rawBlobs, 0);
  assert.equal(cache.retry("one"), false);
  cache.invalidate("one");
  assert.equal(cache.has("one"), false);
  cache.ingest("one", clip()); await flush();
  assert.equal(calls.length, 2);
  cache.dispose();
});

test("clear aborts all in-flight work and late completion cannot restore a removed entry", async () => {
  const { cache, calls } = harness();
  cache.ingest("one", clip()); cache.ingest("two", clip()); await flush();
  cache.clear();
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(cache.getUsage(), { entries: 0, rawBlobs: 0, rawBytes: 0, active: 0, queued: 0 });
  calls[0].resolve(features()); await flush();
  assert.equal(cache.has("one"), false);
  assert.equal(calls.length, 1);
});

test("dispose is reusable for Strict Mode and old same-key results cannot overwrite the new attempt", async () => {
  const { cache, calls } = harness();
  cache.ingest("one", clip()); await flush();
  cache.dispose(); cache.ingest("one", clip()); await flush();
  assert.equal(calls.length, 2);
  calls[0].resolve(features("insufficient")); await flush();
  assert.equal(cache.get("one").phase, "analyzing");
  calls[1].resolve(features()); await flush();
  assert.equal(cache.isReady("one"), true);
  cache.dispose();
});

test("invalidating an active entry releases its queue slot without cancelling another sentence", async () => {
  const { cache, calls } = harness();
  cache.ingest("one", clip()); cache.ingest("two", clip()); await flush();
  cache.invalidate("one"); await flush();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].signal.aborted, false);
  calls[0].reject(new Error("Late failure.")); await flush();
  assert.equal(cache.has("one"), false);
  assert.equal(cache.get("two").phase, "analyzing");
  cache.dispose();
});

test("reference alignment uses the same captured blob and publishes basic features before it completes", async () => {
  const { cache, calls, alignmentCalls } = alignmentHarness();
  const source = alignmentSource();
  const key = alignmentKey(source);
  const captured = { ...clip(), captureId: "capture-one" };
  cache.ingest(key, captured, source);
  await flush();
  assert.equal(alignmentCalls.length, 0);
  const basic = features();
  calls[0].resolve(basic); await flush();
  const pending = cache.get(key);
  assert.equal(pending.phase, "ready");
  assert.equal(pending.features, basic);
  assert.equal(cache.isReady(key), true);
  assert.equal(pending.alignment.phase, "aligning");
  assert.equal(alignmentCalls.length, 1);
  assert.equal(alignmentCalls[0].blob, calls[0].blob);
  assert.equal(alignmentCalls[0].blob, captured.blob);
  assert.deepEqual(alignmentCalls[0].window, { startMs: 100, endMs: 2100 });
  assert.deepEqual(alignmentCalls[0].source, source);
  assert.equal(cache.getUsage().rawBlobs, 1);

  const completed = aligned();
  alignmentCalls[0].resolve(completed); await flush();
  const ready = cache.get(key);
  assert.equal(ready.features, basic);
  assert.equal(ready.alignment.phase, "ready");
  assert.deepEqual(ready.alignment.source, source);
  assert.equal(ready.alignment.captureId, "capture-one");
  assert.equal(ready.alignment.audioSha256, completed.audioSha256);
  assert.deepEqual(ready.alignment.result, completed.result);
  assert.equal(ready.alignment.result.contentVerification, "not_independently_verified");
  assert.equal(ready.alignment.canRetry, false);
  assert.equal(cache.getUsage().rawBlobs, 0);
  cache.dispose();
});

test("clips without source metadata keep their basic-only lifecycle even when an aligner exists", async () => {
  const { cache, calls, alignmentCalls } = alignmentHarness();
  cache.ingest("legacy", clip()); await flush();
  calls[0].resolve(features()); await flush();
  assert.equal(cache.get("legacy").phase, "ready");
  assert.equal(cache.get("legacy").alignment.phase, "missing");
  assert.equal(alignmentCalls.length, 0);
  assert.equal(cache.retryAlignment("legacy"), false);
  assert.equal(cache.getUsage().rawBlobs, 0);
  cache.dispose();
});

test("alignment rejects source/key mismatches and never relabels a cached capture", async () => {
  const { cache, calls, alignmentCalls } = alignmentHarness();
  const source = alignmentSource();
  const key = alignmentKey(source);
  for (const mismatched of [
    { contentId: "another-content" }, { sentenceId: "another-sentence" }, { startMs: 1001 }, { endMs: 3001 },
  ]) {
    assert.equal(cache.ingest(key, clip(), { ...source, ...mismatched }), false);
    assert.equal(cache.has(key), false);
  }
  assert.equal(cache.ingest("invalid-key", clip(), source), false);
  const captured = { ...clip(), captureId: "capture-one" };
  cache.ingest(key, captured, source); await flush();
  assert.equal(cache.ingest(key, { ...clip(), captureId: "capture-two" }, { ...source, text: "Different words." }), false);
  calls[0].resolve(features()); await flush();
  alignmentCalls[0].resolve(aligned()); await flush();
  assert.equal(cache.ingest(key, { ...clip(), captureId: "capture-two" }, source), true);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(alignmentCalls.length, 1);
  assert.equal(cache.get(key).alignment.captureId, "capture-one");
  assert.deepEqual(cache.get(key).alignment.source, source);
  cache.dispose();
});

test("alignment failure preserves usable features and retries only the alignment on the original capture", async () => {
  const { cache, calls, alignmentCalls } = alignmentHarness();
  const source = alignmentSource();
  const key = alignmentKey(source);
  const captured = { ...clip(), captureId: "capture-one" };
  cache.ingest(key, captured, source); await flush();
  const basic = features();
  calls[0].resolve(basic); await flush();
  alignmentCalls[0].reject(new Error("Alignment model unavailable.")); await flush();
  const failed = cache.get(key);
  assert.equal(failed.phase, "ready");
  assert.equal(failed.features, basic);
  assert.equal(failed.error, null);
  assert.equal(failed.alignment.phase, "error");
  assert.equal(failed.alignment.canRetry, true);
  assert.match(failed.alignment.error, /Alignment model unavailable/);
  assert.equal(cache.retry(key), false);
  assert.equal(cache.ingest(key, { ...clip(), captureId: "capture-two" }, source), true);
  await flush(); assert.equal(alignmentCalls.length, 1);
  assert.equal(cache.retryAlignment(key), true);
  assert.equal(cache.retryAlignment(key), false);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(alignmentCalls.length, 2);
  assert.equal(alignmentCalls[1].blob, captured.blob);
  assert.deepEqual(alignmentCalls[1].source, source);
  alignmentCalls[1].resolve(aligned()); await flush();
  assert.equal(cache.get(key).alignment.phase, "ready");
  assert.equal(cache.get(key).alignment.captureId, "capture-one");
  assert.equal(cache.get(key).features, basic);
  assert.equal(cache.getUsage().rawBlobs, 0);
  cache.dispose();
});

test("basic analysis failure never starts alignment and its explicit retry retains source identity", async () => {
  const { cache, calls, alignmentCalls } = alignmentHarness();
  const source = alignmentSource();
  const key = alignmentKey(source);
  cache.ingest(key, { ...clip(), captureId: "capture-one" }, source); await flush();
  calls[0].reject(new Error("Speech model unavailable.")); await flush();
  assert.equal(cache.get(key).phase, "error");
  assert.equal(alignmentCalls.length, 0);
  assert.equal(cache.retryAlignment(key), false);
  assert.equal(cache.retry(key), true); await flush();
  calls[1].resolve(features()); await flush();
  assert.deepEqual(alignmentCalls[0].source, source);
  alignmentCalls[0].resolve(aligned()); await flush();
  assert.equal(cache.get(key).alignment.captureId, "capture-one");
  cache.dispose();
});

test("failed alignment raw audio expires after a minute while completed basic features remain", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { cache, calls, alignmentCalls } = alignmentHarness();
  const source = alignmentSource();
  const key = alignmentKey(source);
  cache.ingest(key, clip(), source); await flush();
  const basic = features();
  calls[0].resolve(basic); await flush();
  alignmentCalls[0].reject(new Error("Failed.")); await flush();
  t.mock.timers.tick(59999);
  assert.equal(cache.get(key).alignment.canRetry, true);
  assert.equal(cache.getUsage().rawBlobs, 1);
  t.mock.timers.tick(1);
  assert.equal(cache.getUsage().rawBlobs, 0);
  assert.equal(cache.get(key).phase, "ready");
  assert.equal(cache.get(key).features, basic);
  assert.equal(cache.get(key).alignment.canRetry, false);
  assert.equal(cache.retryAlignment(key), false);
  assert.match(cache.get(key).alignment.error, /Play the sentence again/);
  cache.dispose();
});

test("new work can reclaim failed alignment audio without erasing its usable basic features", async () => {
  const { cache, calls, alignmentCalls } = alignmentHarness({ maxBlobBytes: 256 });
  const source = alignmentSource();
  const key = alignmentKey(source);
  cache.ingest(key, clip(200), source); await flush();
  const basic = features();
  calls[0].resolve(basic); await flush();
  alignmentCalls[0].reject(new Error("Failed.")); await flush();
  const nextSource = alignmentSource({ sentenceId: "next-sentence" });
  assert.equal(cache.ingest(alignmentKey(nextSource), clip(200), nextSource), true);
  assert.equal(cache.get(key).features, basic);
  assert.equal(cache.get(key).alignment.canRetry, false);
  assert.equal(cache.retryAlignment(key), false);
  assert.equal(cache.getUsage().rawBytes, 200);
  cache.dispose();
});

for (const status of ["unsupported", "unreliable"]) {
  test(`${status} alignment is explicit, releases raw audio and cannot automatically retry`, async () => {
    const { cache, calls, alignmentCalls } = alignmentHarness();
    const source = alignmentSource();
    const key = alignmentKey(source);
    cache.ingest(key, clip(), source); await flush();
    const basic = features();
    calls[0].resolve(basic); await flush();
    alignmentCalls[0].resolve(aligned(status)); await flush();
    assert.equal(cache.get(key).phase, "ready");
    assert.equal(cache.get(key).features, basic);
    assert.equal(cache.get(key).alignment.phase, status);
    assert.equal(cache.get(key).alignment.canRetry, false);
    assert.equal(cache.retryAlignment(key), false);
    assert.equal(cache.getUsage().rawBlobs, 0);
    cache.ingest(key, clip(), source); await flush();
    assert.equal(calls.length, 1);
    assert.equal(alignmentCalls.length, 1);
    cache.dispose();
  });
}

test("alignment occupies the same bounded queue slot until both analyses complete", async () => {
  const { cache, calls, alignmentCalls } = alignmentHarness();
  const first = alignmentSource();
  const second = alignmentSource({ sentenceId: "second" });
  const third = alignmentSource({ sentenceId: "third" });
  cache.ingest(alignmentKey(first), clip(), first);
  cache.ingest(alignmentKey(second), clip(), second);
  await flush(); calls[0].resolve(features()); await flush();
  assert.equal(alignmentCalls.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(cache.ingest(alignmentKey(third), clip(), third), false);
  assert.deepEqual(cache.getUsage(), { entries: 2, rawBlobs: 2, rawBytes: 256, active: 1, queued: 1 });
  alignmentCalls[0].resolve(aligned()); await flush();
  assert.equal(calls.length, 2);
  assert.equal(cache.ingest(alignmentKey(third), clip(), third), true);
  cache.dispose();
});

test("the result-entry limit does not evict a reference whose basic result is ready but alignment is active", async () => {
  const { cache, calls, alignmentCalls } = alignmentHarness({ maxEntries: 2 });
  const first = alignmentSource();
  const second = alignmentSource({ sentenceId: "second" });
  const third = alignmentSource({ sentenceId: "third" });
  cache.ingest(alignmentKey(first), clip(), first);
  cache.ingest(alignmentKey(second), clip(), second);
  await flush(); calls[0].resolve(features()); await flush();
  assert.equal(cache.get(alignmentKey(first)).phase, "ready");
  assert.equal(cache.ingest(alignmentKey(third), { ...clip(), endOffsetMs: 10 }, third), false);
  assert.equal(alignmentCalls[0].signal.aborted, false);
  assert.equal(cache.has(alignmentKey(first)), true);
  assert.equal(cache.has(alignmentKey(second)), true);
  assert.equal(cache.getUsage().entries, 2);
  cache.dispose();
});

test("clear cancels alignment and late results cannot overwrite a new capture with the same key", async () => {
  const { cache, calls, alignmentCalls } = alignmentHarness();
  const source = alignmentSource();
  const key = alignmentKey(source);
  cache.ingest(key, { ...clip(), captureId: "old-capture" }, source); await flush();
  calls[0].resolve(features()); await flush();
  cache.clear();
  assert.equal(alignmentCalls[0].signal.aborted, true);
  assert.deepEqual(cache.getUsage(), { entries: 0, rawBlobs: 0, rawBytes: 0, active: 0, queued: 0 });
  cache.ingest(key, { ...clip(), captureId: "new-capture" }, source); await flush();
  alignmentCalls[0].resolve(aligned()); await flush();
  assert.equal(cache.get(key).phase, "analyzing");
  calls[1].resolve(features()); await flush();
  const replacement = aligned("ready", "b".repeat(64));
  alignmentCalls[1].resolve(replacement); await flush();
  assert.equal(cache.get(key).alignment.captureId, "new-capture");
  assert.equal(cache.get(key).alignment.audioSha256, replacement.audioSha256);
  cache.dispose();
});

test("invalidating alignment starts the next queued sentence and rejects late alignment failure", async () => {
  const { cache, calls, alignmentCalls } = alignmentHarness();
  const first = alignmentSource();
  const second = alignmentSource({ sentenceId: "second" });
  const firstKey = alignmentKey(first);
  const secondKey = alignmentKey(second);
  cache.ingest(firstKey, clip(), first);
  cache.ingest(secondKey, clip(), second);
  await flush(); calls[0].resolve(features()); await flush();
  cache.invalidate(firstKey); await flush();
  assert.equal(alignmentCalls[0].signal.aborted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].signal.aborted, false);
  alignmentCalls[0].reject(new Error("Late alignment failure.")); await flush();
  assert.equal(cache.has(firstKey), false);
  assert.equal(cache.get(secondKey).phase, "analyzing");
  cache.dispose();
});
