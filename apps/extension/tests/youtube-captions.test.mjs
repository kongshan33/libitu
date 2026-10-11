import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { captionTrackToTranscript } from "../src/youtube-captions.js";

const source = readFileSync(new URL("../src/youtube-captions.js", import.meta.url), "utf8").replace(/^export /gm, "");
const events = [
  { tStartMs: 0, id: 1, wpWinPosId: 1 },
  { tStartMs: 40, dDurationMs: 2040, wWinId: 1, segs: [{ utf8: "have", acAsrConf: 0 }, { utf8: " you", tOffsetMs: 120 }] },
  { tStartMs: 1200, dDurationMs: 880, aAppend: 1, wWinId: 1, segs: [{ utf8: "\n" }] },
  { tStartMs: 2040, segs: [{ utf8: "ever noticed this" }] }
];
const track = { version: "youtube-json3-v1", video_id: "first-video", language: "en", kind: "asr", events };
const clone = (value) => JSON.parse(JSON.stringify(value));

function harness({ result = { status: "ready", captionTrack: track }, read, missing = false,
  href = "https://www.youtube.com/watch?v=first-video", domVideoId = "first-video",
  language = "en", observerWaitMs = 0, duringRead, duringWait } = {}) {
  const documentEvents = new Map();
  const windowEvents = new Map();
  const eventTarget = (listeners) => ({
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); }
  });
  const window = { ...eventTarget(windowEvents), location: { href } };
  const calls = [];
  const document = { ...eventTarget(documentEvents), querySelector: (selector) => selector === "ytd-watch-flexy"
    ? { getAttribute: () => domVideoId } : null };
  const observer = { version: 1, read: (...args) => {
    calls.push(args);
    duringRead?.({ window, documentEvents, windowEvents });
    return read ? read(calls.length) : result;
  } };
  const context = { window, document, URL, TextEncoder, clearTimeout,
    fetch: () => { throw new Error("Reader must never fetch or replay a signed URL"); },
    setTimeout: (callback) => {
      if (!observerWaitMs) throw new Error("Reader must not wait on background-tab timers");
      return setTimeout(() => { duringWait?.({ window, documentEvents, windowEvents }); callback(); }, 1);
    },
    ...(missing ? {} : { __libituCaptionObserverV1: observer })
  };
  const work = runInNewContext(source + "\nreadCurrentYouTubeCaptionTrack('first-video', " + JSON.stringify(language) + ", "
    + JSON.stringify(observerWaitMs) + ");", context);
  return { work, calls, documentEvents, windowEvents, window, observer };
}

test("reads and re-sanitizes observed timing without requesting or exporting signed metadata", async () => {
  const h = harness({ result: { status: "ready", requestUrl: "signed-secret", captionTrack: { ...track, token: "private",
    events: events.map((event) => ({ ...event, requestUrl: "signed-secret" })) } } });
  const result = clone(await h.work);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.captionTrack, {
    version: "youtube-json3-v1", video_id: "first-video", language: "en", kind: "asr",
    events: [
      { tStartMs: 40, dDurationMs: 2040, wWinId: 1, segs: [{ utf8: "have" }, { utf8: " you", tOffsetMs: 120 }] },
      { tStartMs: 1200, dDurationMs: 880, aAppend: 1, wWinId: 1, segs: [{ utf8: "\n" }] },
      { tStartMs: 2040, segs: [{ utf8: "ever noticed this" }] }
    ]
  });
  assert.deepEqual(h.calls, [["first-video", "en"]]);
  assert.equal(/signed|private|token|acAsrConf/.test(JSON.stringify(result)), false);
  assert.equal(h.documentEvents.size + h.windowEvents.size, 0);
  assert.equal(captionTrackToTranscript(result.captionTrack), "0:00.040\thave you\n0:02.040\tever noticed this");
});

test("block and repeated captions remain usable without invented offsets", async () => {
  const repeated = { tStartMs: 1040, dDurationMs: 2000, segs: [{ utf8: "Yes, yes.\nWe can." }] };
  const h = harness({ result: { status: "ready", captionTrack: { ...track, kind: "manual", events: [repeated, repeated] } } });
  const result = await h.work;
  assert.equal(result.status, "no_word_offsets");
  assert.equal(result.captionTrack.events.length, 2);
  assert.equal("tOffsetMs" in result.captionTrack.events[0].segs[0], false);
  assert.equal(captionTrackToTranscript(result.captionTrack), "0:01.040\tYes, yes. We can.\n0:01.040\tYes, yes. We can.");
});

test("compatibility timestamps preserve milliseconds and hours", () => {
  for (const [start, expected] of [[3_599_999, "59:59.999"], [3_600_000, "1:00:00.000"],
    [6_000_040, "1:40:00.040"], [360_000_123, "100:00:00.123"]]) {
    assert.equal(captionTrackToTranscript({ events: [{ tStartMs: start, segs: [{ utf8: "Still speaking." }] }] }),
      expected + "\tStill speaking.");
  }
});

test("missing early observer explicitly requests source-page reload, without late installation or fetch", async () => {
  const h = harness({ missing: true });
  assert.deepEqual(clone(await h.work), { status: "observer_missing" });
  assert.equal(h.calls.length, 0);
  assert.equal(h.documentEvents.size + h.windowEvents.size, 0);
});

test("unobserved captions return one immediate cache snapshot without background-tab timers", async () => {
  const none = harness({ result: { status: "not_observed" } });
  assert.deepEqual(clone(await none.work), { status: "not_observed" });
  assert.equal(none.calls.length, 1);
  assert.equal(none.documentEvents.size + none.windowEvents.size, 0);
});

test("bounded reader wait takes a second cache snapshot without requesting captions", async () => {
  const h = harness({ observerWaitMs: 6_000, read: (count) => count === 1
    ? { status: "not_observed" }
    : { status: "ready", captionTrack: track } });
  const result = await h.work;
  assert.equal(result.status, "ready");
  assert.equal(h.calls.length, 2);
  assert.equal(h.windowEvents.size, 0);
});

test("known response failures retain their safe cause without raw provider errors", async () => {
  for (const status of ["request_failed", "empty_response", "invalid_response", "response_too_large", "observer_timeout", "stale"]) {
    const h = harness({ result: { status, error: "https://www.youtube.com/api/timedtext?pot=private" } });
    const result = clone(await h.work);
    assert.deepEqual(result, { status, ...(status === "stale" ? { stale: true } : {}) });
    assert.equal(h.calls.length, 1);
  }
  const thrown = harness({ read: () => { throw new Error("signed-private"); } });
  assert.deepEqual(clone(await thrown.work), { status: "invalid_response" });
  const unknown = harness({ result: { status: "signed-private" } });
  assert.deepEqual(clone(await unknown.work), { status: "invalid_response" });
});

test("reader validates current page, video DOM and language before observing", async () => {
  for (const options of [
    { href: "https://www.youtube.com/watch?v=other-video" },
    { href: "https://example.com/watch?v=first-video" },
    { href: "https://www.youtube.com/shorts/first-video" },
    { domVideoId: "other-video" }, { language: "fr" }
  ]) {
    const h = harness(options);
    assert.equal((await h.work).captionTrack, undefined);
    assert.equal(h.calls.length, 0);
  }
});

test("reader rejects cross-source, malformed and oversized MAIN-world data", async () => {
  const badTracks = [
    { ...track, video_id: "other-video" }, { ...track, language: "fr" }, { ...track, kind: "bad" },
    { ...track, version: "bad" }, { ...track, events: [] },
    ...[
      { tStartMs: 0, segs: [{ utf8: "\n" }] },
      { tStartMs: -1, segs: [{ utf8: "bad" }] },
      { tStartMs: 1.5, segs: [{ utf8: "bad" }] },
      { tStartMs: 604_800_001, segs: [{ utf8: "bad" }] },
      { tStartMs: 0, dDurationMs: 604_800_001, segs: [{ utf8: "bad" }] },
      { tStartMs: 0, aAppend: 2, segs: [{ utf8: "bad" }] },
      { tStartMs: 0, segs: [{ utf8: "bad", tOffsetMs: 1.5 }] },
      { tStartMs: 0, segs: [{ utf8: "bad", tOffsetMs: "120" }] },
      { tStartMs: 0, segs: [{ utf8: "x".repeat(240_001) }] },
      { tStartMs: 0, segs: Array.from({ length: 12_001 }, () => ({ utf8: "a" })) }
    ].map((event) => ({ ...track, events: [event] })),
    { ...track, events: Array.from({ length: 10_001 }, () => events[1]) }
  ];
  for (const captionTrack of badTracks) {
    const h = harness({ result: { status: "ready", captionTrack } });
    assert.equal((await h.work).status, "invalid_response");
    assert.equal(h.documentEvents.size + h.windowEvents.size, 0);
  }
});

test("navigation during an untrusted observer read invalidates the snapshot and releases listeners", async () => {
  for (const type of ["yt-navigate-start", "popstate", "pagehide"]) {
    const h = harness({ result: { status: "not_observed" }, duringRead: ({ window, documentEvents, windowEvents }) => {
      (type === "yt-navigate-start" ? documentEvents : windowEvents).get(type)?.();
      window.location.href = "https://www.youtube.com/watch?v=other-video";
      window.location.href = "https://www.youtube.com/watch?v=first-video";
    } });
    assert.deepEqual(clone(await h.work), { status: "stale", stale: true });
    assert.equal(h.calls.length, 1);
    assert.equal(h.documentEvents.size + h.windowEvents.size, 0);
  }
});

test("DOM fallback preserves repeated segments, including identical text and timestamps", () => {
  const contentSource = readFileSync(new URL("../src/content-script.js", import.meta.url), "utf8");
  const reader = contentSource.slice(contentSource.indexOf("function readVisibleTranscriptText("), contentSource.indexOf("async function waitForTranscript("));
  const segment = { querySelector: (selector) => ({ textContent: selector === ".segment-timestamp" ? "0:01" : "Again." }) };
  const result = runInNewContext(`${reader}\nreadVisibleTranscriptText();`, {
    document: { querySelectorAll: () => [segment, segment] }, staleTranscript: undefined
  });
  assert.equal(result, "0:01\tAgain.\n0:01\tAgain.");
});

test("v4 import bridge forwards safe track and transcript together", async () => {
  const code = readFileSync(new URL("../src/stage-one-bridge.js", import.meta.url), "utf8");
  let onMessage;
  const sent = [];
  const captionTrack = { version: "youtube-json3-v1", video_id: "first-video", language: "en", kind: "asr", events: [events[1]] };
  const window = {
    location: { pathname: "/practice/import", origin: "http://localhost:3000", search: "?handoffId=test-handoff" },
    addEventListener: (_type, listener) => { onMessage = listener; },
    postMessage: (message, origin) => sent.push({ message, origin })
  };
  runInNewContext(code, { window, URLSearchParams, crypto, chrome: { runtime: {
    sendMessage: async () => ({ transcriptText: "0:00.040\thave you", captionTrack })
  } } });
  onMessage({ source: window, origin: window.location.origin, data: { type: "LIBITU_HANDOFF_REQUEST", version: 4, handoffId: "test-handoff", requestId: "one" } });
  await Promise.resolve();
  assert.equal(sent[0].message.phase, "connected");
  assert.equal(sent[1].message.phase, "ready");
  assert.deepEqual(sent[1].message.captionTrack, captionTrack);
  assert.equal(sent[1].message.transcriptText, "0:00.040\thave you");
});
