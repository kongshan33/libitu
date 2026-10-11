import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { requestFreshCaptions, captionVideoId, bindFreshCaptionSource, freshCaptionFailureMessages } from "../features/stage-one/api/fresh-captions.ts";
import { updateCaptionTiming } from "../features/stage-one/api/stage-one-api.ts";

const source = { contentId: "a0000000-0000-4000-8000-000000000001", videoId: "YIokM_4i1i0", sourceUrl: "https://www.youtube.com/watch?v=YIokM_4i1i0" };
const track = { version: "youtube-json3-v1", video_id: source.videoId, language: "en", kind: "asr",
  events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "Hello.", tOffsetMs: 0 }] }] };
let listeners, messages;
beforeEach(() => {
  listeners = new Set(); messages = [];
  globalThis.window = { location: { href: "http://localhost:3000/practice/a0000000-0000-4000-8000-000000000001?learnerLevel=B2#transcript-old", origin: "http://localhost:3000", get pathname() { return new URL(this.href).pathname; } },
    setTimeout, clearTimeout, history: { state: { keep: true }, replaceState: (_state, _unused, url) => { window.location.href = String(url); } },
    addEventListener: (_event, fn) => listeners.add(fn), removeEventListener: (_event, fn) => listeners.delete(fn),
    postMessage: (message) => messages.push(message) };
  mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
});
afterEach(() => { mock.restoreAll(); mock.timers.reset(); delete globalThis.window; });
function reply(data = {}, outer = {}) {
  const request = messages.at(-1);
  for (const handler of listeners) handler({ source: window, origin: window.location.origin,
    data: { type: "LIBITU_FRESH_CAPTIONS_RESPONSE", version: 4, requestId: request.requestId, videoId: source.videoId,
      status: "ready", captionTrack: track, ...data }, ...outer });
}

test("old content-only links bind a canonical source without disturbing durable page state", async () => {
  const loading = requestFreshCaptions(source);
  const page = new URL(window.location.href);
  assert.equal(page.searchParams.get("sourceUrl"), null);
  assert.equal(page.searchParams.get("jobId"), null);
  assert.equal(page.searchParams.get("learnerLevel"), "B2");
  assert.equal(page.hash, "#transcript-old");
  assert.deepEqual(messages[0], { type: "LIBITU_FRESH_CAPTIONS_REQUEST", version: 4, contentId: source.contentId, requestId: messages[0].requestId,
    sourceUrl: source.sourceUrl, videoId: source.videoId, language: "en" });
  reply();
  assert.deepEqual(await loading, { status: "ready", captionTrack: track });
  assert.equal(listeners.size, 0);
  assert.equal(fetch.mock.callCount(), 0, "the bridge does not resolve content or create jobs");
});

test("short/mobile URLs are canonicalized and ambiguous or credential URLs are rejected", async () => {
  for (const url of [`https://youtu.be/${source.videoId}?si=share`, `http://m.youtube.com/watch?v=${source.videoId}`,
    `https://www.youtube.com/shorts/${source.videoId}`]) {
    window.location.href = `http://localhost:3000/practice/${source.contentId}`;
    const loading = requestFreshCaptions({ ...source, sourceUrl: url });
    assert.equal(messages.at(-1).sourceUrl, source.sourceUrl);
    assert.equal(new URL(window.location.href).searchParams.get("sourceUrl"), null);
    reply(); await loading;
  }
  for (const url of [`https://u:p@www.youtube.com/watch?v=${source.videoId}`,
    `${source.sourceUrl}&v=anotherVid1`, `https://youtube.com.attacker.invalid/watch?v=${source.videoId}`]) assert.equal(captionVideoId(url), null);
});

test("mismatched content or video never starts a fresh caption read", async () => {
  window.location.href = `http://localhost:3000/?contentId=another-content&sourceUrl=${encodeURIComponent(source.sourceUrl)}`;
  assert.equal(bindFreshCaptionSource(source), false);
  assert.deepEqual(await requestFreshCaptions(source), { status: "stale" });
  window.location.href = "http://localhost:3000/?contentId=cached-content&sourceUrl=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DanotherVid1";
  assert.deepEqual(await requestFreshCaptions(source), { status: "stale" });
  assert.equal(messages.length, 0);
});

test("only matching same-window origin/request/video responses are accepted", async () => {
  const loading = requestFreshCaptions(source);
  reply({}, { origin: "https://other.invalid" });
  reply({}, { source: {} });
  reply({ requestId: "different-request" });
  reply({ videoId: "anotherVid1" });
  assert.equal(listeners.size, 1);
  reply({ status: "no_matching_tab", captionTrack: undefined });
  assert.deepEqual(await loading, { status: "no_matching_tab", captionTrack: undefined });
});

test("absent extension times out independently without any API request", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  window.setTimeout = setTimeout; window.clearTimeout = clearTimeout;
  const loading = requestFreshCaptions(source);
  mock.timers.tick(4500);
  assert.deepEqual(await loading, { status: "timeout" });
  assert.equal(listeners.size, 0);
  assert.equal(fetch.mock.callCount(), 0);
});

test("observer failure statuses settle immediately without API work, retries or diagnostic payloads", async () => {
  const expected = {
    observer_missing: /reload the extension first.*Refresh that YouTube page once.*retry word timing/,
    not_observed: /Turn on English captions.*retry word timing/,
    request_failed: /caption request failed/,
    empty_response: /empty caption JSON response/,
    invalid_response: /not valid JSON3/,
    response_too_large: /exceeded the supported size limit/,
    observer_timeout: /Reading the observed captions timed out/,
    bridge_error: /Communication with the Libitu extension was interrupted/
  };
  for (const [status, message] of Object.entries(expected)) {
    const requestCount = messages.length;
    const loading = requestFreshCaptions(source);
    reply({ status, captionTrack: undefined, error: "https://youtube.invalid/timedtext?token=private", responseBody: "private caption text" });
    assert.deepEqual(await loading, { status, captionTrack: undefined });
    assert.match(freshCaptionFailureMessages[status], message);
    assert.doesNotMatch(freshCaptionFailureMessages[status], /private|token|https?:/);
    assert.equal(listeners.size, 0);
    assert.equal(messages.length, requestCount + 1, "failure does not automatically read again");
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("generic check timeout does not diagnose an absent extension or caption network failure", () => {
  assert.match(freshCaptionFailureMessages.timeout, /caption check timed out/);
  assert.doesNotMatch(freshCaptionFailureMessages.timeout, /did not respond|not installed|unavailable|network|request failed/i);
  assert.notEqual(freshCaptionFailureMessages.timeout, freshCaptionFailureMessages.observer_timeout);
  assert.match(freshCaptionFailureMessages.observer_missing, /If you just updated Libitu/);
  assert.match(freshCaptionFailureMessages.not_observed, /No caption response has been observed yet/);
});

test("passive recovery guidance distinguishes the observed track and requires a new player request after failure", () => {
  const noOffsets = freshCaptionFailureMessages.no_word_offsets;
  assert.match(noOffsets, /currently observed caption track has no word offsets/);
  assert.match(noOffsets, /If English \(auto-generated\) is available on YouTube, select it and retry/);
  assert.match(noOffsets, /Word timing may still be unavailable/);
  assert.match(noOffsets, /sentence playback is still available/);
  assert.doesNotMatch(noOffsets, /no word offsets for this video|did not provide word offsets for this video/);
  for (const status of ["request_failed", "empty_response", "observer_timeout"]) {
    assert.match(freshCaptionFailureMessages[status],
      /Turn English captions off and back on in the matching YouTube tab.*player can request captions again.*then retry word timing in Libitu/);
  }
});

test("unknown statuses are ignored while legacy non-ready statuses retain their contract", async () => {
  for (const status of ["no_matching_tab", "no_word_offsets", "unavailable", "timeout", "stale", "invalid_request", "busy"]) {
    const loading = requestFreshCaptions(source);
    reply({ status: "unrecognized_observer_status", captionTrack: undefined });
    assert.equal(listeners.size, 1);
    reply({ status, captionTrack: undefined });
    assert.deepEqual(await loading, { status, captionTrack: undefined });
    assert.equal(typeof freshCaptionFailureMessages[status], "string");
    assert.equal(listeners.size, 0);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("aborting source recovery removes listeners and rejects late replies", async () => {
  const controller = new AbortController();
  const loading = requestFreshCaptions(source, controller.signal);
  const rejected = assert.rejects(loading, { name: "AbortError" });
  controller.abort(); await rejected;
  reply();
  assert.equal(listeners.size, 0);
  assert.equal(fetch.mock.callCount(), 0);
});

test("same-video different-content navigation cannot accept an old response", async () => {
  const loading = requestFreshCaptions(source);
  const url = new URL(window.location.href); url.pathname = "/practice/a0000000-0000-4000-8000-000000000002"; window.location.href = url.href;
  reply();
  assert.deepEqual(await loading, { status: "stale" });
});

test("a ready reply still requires a sanitized matching track", async () => {
  const loading = requestFreshCaptions(source);
  reply({ captionTrack: { ...track, video_id: "anotherVid1" } });
  assert.deepEqual(await loading, { status: "unavailable" });
});

test("caption-only API recovery preserves semantic data and never invokes jobs or resolve", async () => {
  const raw = { id: "blueprint", content_id: source.contentId, source_url: source.sourceUrl, title: "Cached title",
    summary: "Cached semantic summary", logic_flow: [], chapters: [], corpus_items: [], segments: [],
    transcript: [{ id: "sentence-v3-recovered", time: "0:01", parts: ["Hello."], segmentation_version: "sentence-v3",
      source_token_start: 0, source_token_end: 1, start_ms: 1000, end_ms: 1500, timing_source: "caption_word_offsets",
      word_timings: [{ source_token_index: 0, text: "Hello.", start_ms: 1000, end_ms: 1500,
        start_source: "caption_offset", end_source: "event_end_estimate", source_event_index: 0, source_seg_index: 0 }] }] };
  fetch.mock.mockImplementation(async (url, init) => {
    assert.equal(new URL(url).pathname, `/api/content/${source.contentId}/caption-timing`);
    assert.equal(new URL(url).searchParams.get("learner_level"), "B2");
    assert.deepEqual(JSON.parse(init.body), { caption_track: track });
    return new Response(JSON.stringify({ status: "updated", blueprint: raw }));
  });
  const result = await updateCaptionTiming(source.contentId, track, { learnerLevel: "B2" });
  assert.equal(result.blueprint.summary, raw.summary);
  assert.equal(result.blueprint.transcript[0].wordTimings[0].endMs, 1500);
  assert.equal(fetch.mock.callCount(), 1);
});

test("caption-only API errors retain structured detail messages and caller cancellation", async () => {
  fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ detail: {
    code: "caption_text_mismatch", message: "The caption words do not match this saved blueprint."
  } }), { status: 409 }));
  await assert.rejects(updateCaptionTiming(source.contentId, track), /caption words do not match/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(updateCaptionTiming(source.contentId, track, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 1);
});
