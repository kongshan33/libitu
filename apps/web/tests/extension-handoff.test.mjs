import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { readCaptionTrack, readExtensionCaptions, readExtensionTranscript } from "../features/stage-one/api/extension-handoff.ts";
import { loadStageOneBlueprint } from "../features/stage-one/api/stage-one-api.ts";

let listeners;
let request;
beforeEach(() => {
  listeners = new Set();
  globalThis.window = {
    location: { origin: "http://localhost:3000" }, setTimeout, clearTimeout,
    addEventListener: (_type, handler) => listeners.add(handler),
    removeEventListener: (_type, handler) => listeners.delete(handler),
    postMessage: (data) => { request = data; }
  };
});
afterEach(() => { mock.restoreAll(); mock.timers.reset(); delete globalThis.window; });
function reply(data, overrides = {}) {
  for (const listener of listeners) listener({
    source: window, origin: window.location.origin,
    data: { ...request, type: "LIBITU_HANDOFF_RESPONSE", ...data }, ...overrides
  });
}

const captionTrack = {
  version: "youtube-json3-v1", video_id: "abcdefghijk", language: null, kind: "asr",
  events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "From ", tOffsetMs: 0 }, { utf8: "captions.", tOffsetMs: 400 }] }]
};

test("optional structured captions survive handoff, while malformed tracks keep text fallback", async () => {
  const loading = readExtensionCaptions("rich");
  reply({ phase: "ready", transcriptText: "0:01\tFrom captions.", captionTrack });
  assert.deepEqual(await loading, { transcriptText: "0:01\tFrom captions.", captionTrack });
  const fallback = readExtensionCaptions("invalid");
  reply({ phase: "ready", transcriptText: "From captions.", captionTrack: { ...captionTrack, events: [{ tStartMs: -1 }] } });
  assert.deepEqual(await fallback, { transcriptText: "From captions.", captionTrack: undefined });
});

test("caption track bounds reject oversized events, segments, text and payloads", () => {
  assert.deepEqual(readCaptionTrack(captionTrack), captionTrack);
  assert.deepEqual(readCaptionTrack({ ...captionTrack, signedUrl: "secret", events: captionTrack.events.map((event) => ({
    ...event, unknown: "private", segs: event.segs.map((seg) => ({ ...seg, private: "not caption text" }))
  })) }), captionTrack, "unknown provider fields never leave the browser");
  assert.equal(readCaptionTrack({ ...captionTrack, events: Array(10_001).fill(captionTrack.events[0]) }), undefined);
  assert.equal(readCaptionTrack({ ...captionTrack, events: [{ tStartMs: 0, segs: Array(50_001).fill({ utf8: "" }) }] }), undefined);
  assert.equal(readCaptionTrack({ ...captionTrack, events: [{ tStartMs: 0, segs: [{ utf8: "x".repeat(240_001) }] }] }), undefined);
  assert.equal(readCaptionTrack({ ...captionTrack, extra: "x".repeat(2 * 1024 * 1024) }), undefined);
  assert.equal(readCaptionTrack({ ...captionTrack, events: [{ tStartMs: 0, segs: [{ utf8: "word", tOffsetMs: NaN }] }] }), undefined);
  for (const extra of [{ tStartMs: 0.5 }, { tStartMs: 604_800_001 }, { dDurationMs: -1 }, { dDurationMs: 0.5 },
    { aAppend: 2 }, { wWinId: 1.5 }, { segs: Array(12_001).fill({ utf8: "" }) }, { segs: [{ utf8: "word", tOffsetMs: -1 }] }]) {
    assert.equal(readCaptionTrack({ ...captionTrack, events: [{ ...captionTrack.events[0], ...extra }] }), undefined);
  }
});

test("only matching same-window handoff responses are accepted", async () => {
  const loading = readExtensionTranscript("handoff");
  reply({ phase: "ready", transcriptText: "Wrong origin" }, { origin: "https://example.com" });
  reply({ phase: "ready", transcriptText: "Wrong request", requestId: "unrelated" });
  assert.equal(listeners.size, 1);
  reply({ phase: "connected" });
  reply({ phase: "ready", transcriptText: "0:01\tCorrect captions." });
  assert.equal(await loading, "0:01\tCorrect captions.");
  assert.equal(listeners.size, 0);
});

test("cancelling handoff removes its listener and ignores late captions", async () => {
  const controller = new AbortController();
  const loading = readExtensionTranscript("handoff", controller.signal);
  controller.abort();
  await assert.rejects(loading, { name: "AbortError" });
  assert.equal(listeners.size, 0);
});

test("an absent bridge or stalled capture has a bounded fallback", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  const absent = readExtensionTranscript("absent");
  mock.timers.tick(1_500);
  assert.equal(await absent, undefined);
  const stalled = readExtensionTranscript("stalled");
  reply({ phase: "connected" });
  mock.timers.tick(10_000);
  assert.equal(await stalled, undefined);
  assert.equal(listeners.size, 0);
});

test("handoff captions are resolved once, and job IDs are exposed before analysis completes", async () => {
  const calls = [];
  const resolved = [];
  const source = { kind: "youtube", sourceUrl: "https://www.youtube.com/watch?v=test", title: "Test", handoffId: "handoff" };
  mock.method(globalThis, "fetch", async (url, init) => {
    calls.push([new URL(url).pathname, init.body ? JSON.parse(init.body) : null]);
    const data = url.includes("/content/resolve") ? { content_id: "content", source_url: source.sourceUrl, title: source.title }
      : url.endsWith("/api/jobs") ? { id: "job", content_id: "content", status: "ready" }
      : { id: "blueprint", content_id: "content", title: "Test", summary: "Summary", source_url: source.sourceUrl,
        chapters: [], logic_flow: [], corpus_items: [], transcript: [] };
    return new Response(JSON.stringify(data));
  });
  const loading = loadStageOneBlueprint(source, undefined, { onResolved: (ids) => resolved.push(ids) });
  await nextTurn();
  assert.equal(calls.length, 0);
  reply({ phase: "ready", transcriptText: "0:01\tFrom the browser.", captionTrack });
  assert.equal((await loading).contentId, "content");
  assert.equal(calls[0][1].transcript_text, "0:01\tFrom the browser.");
  assert.deepEqual(calls[0][1].caption_track, captionTrack);
  assert.deepEqual(calls.map(([path]) => path), ["/api/content/resolve", "/api/jobs", "/api/blueprints/content"]);
  assert.deepEqual(resolved, [{ contentId: "content", jobId: "job" }]);
});
