import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { setImmediate as nextTurn } from "node:timers/promises";
import { readCurrentYouTubeCaptionTrack } from "../src/youtube-captions.js";

const source = readFileSync(new URL("../src/fresh-captions.js", import.meta.url), "utf8")
  .replace('import { readCurrentYouTubeCaptionTrack } from "./youtube-captions.js";', "").replace(/^export /gm, "");
const videoId = "first-video";
const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
const webUrl = `http://localhost:3000/?contentId=old-content&sourceUrl=${encodeURIComponent(sourceUrl)}`;
const track = {
  version: "youtube-json3-v1", video_id: videoId, language: "en", kind: "asr",
  events: [{ tStartMs: 1040, dDurationMs: 1500, segs: [{ utf8: "We" }, { utf8: " can.", tOffsetMs: 300 }] }]
};
const request = { type: "LIBITU_READ_FRESH_CAPTIONS", requestId: "fresh-one", sourceUrl, videoId, language: "en" };
const clone = (value) => JSON.parse(JSON.stringify(value));

function harness({ quickTimeout = false } = {}) {
  const sourceTab = { id: 1, windowId: 1, active: false, url: sourceUrl };
  const webTab = { id: 2, windowId: 1, active: true, url: webUrl };
  const tabs = new Map([[1, sourceTab], [2, webTab]]);
  const calls = [];
  const state = { result: Promise.resolve({ captionTrack: structuredClone(track) }), query: undefined };
  const chrome = {
    runtime: { id: "test-extension" },
    tabs: {
      get: async (id) => { if (!tabs.has(id)) throw new Error("Closed tab"); return tabs.get(id); },
      query: async (options) => { calls.push(["query", options]); return state.query ?? [...tabs.values()]; }
    },
    scripting: { executeScript: async (options) => { calls.push(["inject", options]); return [{ result: await state.result }]; } }
  };
  const reader = runInNewContext(`${source}\ncreateFreshCaptionReader(chrome);`, {
    chrome, URL, TextEncoder, readCurrentYouTubeCaptionTrack, clearTimeout,
    setTimeout: (callback, milliseconds) => setTimeout(callback, quickTimeout ? Math.min(milliseconds, 10) : milliseconds)
  });
  const sender = { id: chrome.runtime.id, frameId: 0, documentId: "web-document", tab: webTab, url: webTab.url, origin: "http://localhost:3000" };
  return { reader, sender, tabs, calls, state };
}

test("fresh reader does not require handoff state and returns only safe caption fields", async () => {
  const h = harness();
  const unsafe = structuredClone(track);
  unsafe.baseUrl = "https://www.youtube.com/api/timedtext?signature=private";
  unsafe.events[0].requestUrl = "signed-private-url";
  unsafe.events[0].segs[0].token = "private-token";
  h.state.result = Promise.resolve({ captionTrack: unsafe });
  const result = clone(await h.reader.read(request, h.sender));
  assert.equal(result.status, "ready");
  assert.deepEqual(result.captionTrack, track);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(h.calls.map(([type]) => type), ["query", "inject"]);
  assert.equal(h.calls[1][1].target.tabId, 1);
  assert.equal(h.calls[1][1].world, "MAIN");
  assert.deepEqual(Array.from(h.calls[1][1].args), [videoId, "en"]);
  assert.equal(h.calls[1][1].func, readCurrentYouTubeCaptionTrack);
});

test("fresh requests reject unrelated senders, missing URL binding and cross-video sources before reading tabs", async () => {
  for (const variant of [
    { sender: { frameId: 1 } }, { sender: { id: "another-extension" } }, { sender: { documentId: "" } },
    { sender: { origin: "https://example.com" } }, { sender: { url: webUrl.replace("localhost", "example.com") } },
    { sender: { url: "http://localhost:3000/?contentId=old-content" } },
    { sender: { tab: { id: 2, url: "http://localhost:3000/?contentId=old-content" } } },
    { request: { sourceUrl: "https://www.youtube.com/watch?v=other-video" } },
    { request: { videoId: "other-video" } }, { request: { language: "fr" } },
    { request: { sourceUrl: sourceUrl.replace("www.youtube.com", "example.com") } },
    { request: { requestId: "x".repeat(101) } }
  ]) {
    const h = harness();
    const result = await h.reader.read({ ...request, ...variant.request }, { ...h.sender, ...variant.sender });
    assert.equal(result.status, "invalid_request");
    assert.equal(h.calls.length, 0);
  }
});

test("only a matching existing YouTube tab is read; no match opens nothing", async () => {
  const h = harness();
  h.tabs.set(1, { ...h.tabs.get(1), url: "https://www.youtube.com/watch?v=other-video" });
  assert.equal((await h.reader.read(request, h.sender)).status, "no_matching_tab");
  assert.deepEqual(h.calls.map(([type]) => type), ["query"]);

  h.tabs.set(3, { id: 3, windowId: 2, active: true, url: sourceUrl });
  h.tabs.set(4, { id: 4, windowId: 1, active: false, url: sourceUrl });
  h.tabs.set(5, { id: 5, windowId: 1, active: true, url: sourceUrl });
  assert.equal((await h.reader.read({ ...request, requestId: "next" }, h.sender)).status, "ready");
  assert.equal(h.calls.find(([type]) => type === "inject")[1].target.tabId, 5);
});

test("block-only and unavailable captions are explicit; neither invokes DOM fallback", async () => {
  const h = harness();
  const block = { ...track, events: [{ tStartMs: 1000, segs: [{ utf8: "One whole caption." }] }] };
  h.state.result = Promise.resolve({ captionTrack: block });
  const coarse = clone(await h.reader.read(request, h.sender));
  assert.equal(coarse.status, "no_word_offsets");
  assert.deepEqual(coarse.captionTrack, block);
  for (const [response, expected] of [[{ unavailable: true }, "unavailable"], [{ timeout: true }, "timeout"],
    [{ stale: true }, "stale"], [{ captionTrack: { ...track, video_id: "other-video" } }, "unavailable"],
    [{ captionTrack: { ...track, language: "fr" } }, "unavailable"]]) {
    h.state.result = Promise.resolve(response);
    assert.equal((await h.reader.read(request, h.sender)).status, expected);
  }
  assert.equal(h.calls.every(([type]) => type === "query" || type === "inject"), true);
});

test("same in-flight request is shared, another is busy, and completion permits a genuinely fresh read", async () => {
  const h = harness();
  let finish;
  h.state.result = new Promise((resolve) => { finish = resolve; });
  const first = h.reader.read(request, h.sender);
  assert.equal(h.reader.read(request, h.sender), first);
  assert.equal((await h.reader.read({ ...request, requestId: "another" }, h.sender)).status, "busy");
  await nextTurn();
  assert.equal(h.calls.filter(([type]) => type === "inject").length, 1);
  finish({ captionTrack: track });
  assert.equal((await first).status, "ready");
  h.state.result = Promise.resolve({ unavailable: true });
  assert.equal((await h.reader.read(request, h.sender)).status, "unavailable");
  assert.equal(h.calls.filter(([type]) => type === "inject").length, 2);
});

test("observer acquisition reasons survive the fresh reader without leaking diagnostic payloads", async () => {
  const h = harness();
  for (const status of ["observer_missing", "not_observed", "request_failed", "empty_response", "invalid_response", "response_too_large", "observer_timeout"]) {
    h.state.result = Promise.resolve({ status, error: "private-signed-url", captionTrack: track });
    assert.deepEqual(clone(await h.reader.read(request, h.sender)), { status });
  }
  h.state.result = Promise.reject(new Error("private injection failure"));
  assert.deepEqual(clone(await h.reader.read(request, h.sender)), { status: "bridge_error" });
});

test("source and requesting-page A to B to A navigation invalidate old results", async () => {
  for (const target of [1, 2]) {
    const h = harness();
    let finish;
    h.state.result = new Promise((resolve) => { finish = resolve; });
    const pending = h.reader.read(request, h.sender);
    await nextTurn();
    const other = target === 1 ? "https://www.youtube.com/watch?v=other-video"
      : `http://localhost:3000/?sourceUrl=${encodeURIComponent("https://www.youtube.com/watch?v=other-video")}`;
    h.reader.onTabUpdated(target, { url: other });
    h.reader.onTabUpdated(target, { url: target === 1 ? sourceUrl : webUrl });
    finish({ captionTrack: track });
    const result = await pending;
    assert.equal(result.status, "stale");
    assert.equal(result.captionTrack, undefined);
  }
});

test("unresponsive injection times out safely, does not cache a late result and permits retry", async () => {
  const h = harness({ quickTimeout: true });
  let finish;
  h.state.result = new Promise((resolve) => { finish = resolve; });
  assert.equal((await h.reader.read(request, h.sender)).status, "timeout");
  finish({ captionTrack: track });
  await nextTurn();
  h.state.result = Promise.resolve({ unavailable: true });
  assert.equal((await h.reader.read({ ...request, requestId: "retry" }, h.sender)).status, "unavailable");
});

test("a tab query resolving after the overall deadline never starts a caption request", async () => {
  const h = harness({ quickTimeout: true });
  let finish;
  h.state.query = new Promise((resolve) => { finish = resolve; });
  assert.equal((await h.reader.read(request, h.sender)).status, "timeout");
  finish([h.tabs.get(1)]);
  await nextTurn();
  assert.equal(h.calls.some(([type]) => type === "inject"), false);
});

function bridgeHarness({ quickTimeout = false } = {}) {
  const code = readFileSync(new URL("../src/stage-one-bridge.js", import.meta.url), "utf8");
  const replies = [];
  const calls = [];
  const state = { result: Promise.resolve({ status: "ready", captionTrack: track }) };
  let onMessage;
  const window = { location: { href: webUrl, origin: "http://localhost:3000", search: new URL(webUrl).search },
    addEventListener: (_type, listener) => { onMessage = listener; }, postMessage: (reply) => replies.push(reply) };
  window.top = window;
  runInNewContext(code, { window, URL, URLSearchParams, clearTimeout,
    setTimeout: (callback, milliseconds) => setTimeout(callback, quickTimeout ? Math.min(milliseconds, 10) : milliseconds),
    chrome: { runtime: { sendMessage: (message) => { calls.push(message); return state.result; } } } });
  const dispatch = (data = { ...request, type: "LIBITU_FRESH_CAPTIONS_REQUEST" }, event = {}) =>
    onMessage({ source: window, origin: window.location.origin, data, ...event });
  return { window, replies, calls, state, dispatch };
}

test("the top-frame fresh bridge works without handoffId and forwards only protocol response fields", async () => {
  const h = bridgeHarness();
  h.state.result = Promise.resolve({ status: "ready", captionTrack: track, error: "private-error", sourceUrl: "signed-private" });
  h.dispatch();
  await nextTurn();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].type, "LIBITU_READ_FRESH_CAPTIONS");
  assert.equal(h.calls[0].handoffId, undefined);
  assert.deepEqual(clone(h.replies[0]), { type: "LIBITU_FRESH_CAPTIONS_RESPONSE", requestId: request.requestId,
    videoId, status: "ready", captionTrack: track });
});

test("fresh bridge rejects missing source binding, cross-video, foreign messages and subframes", async () => {
  const h = bridgeHarness();
  h.dispatch(undefined, { origin: "https://example.com" });
  h.dispatch(undefined, { source: {} });
  h.window.top = {};
  h.dispatch();
  assert.equal(h.calls.length, 0);
  h.window.top = h.window;
  h.dispatch({ ...request, type: "LIBITU_FRESH_CAPTIONS_REQUEST", videoId: "other-video" });
  h.window.location.href = "http://localhost:3000/?contentId=old-content";
  h.dispatch();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.replies.map((reply) => reply.status), ["invalid_request", "invalid_request"]);
});

test("fresh bridge discards source changes and bounds an unresponsive extension", async () => {
  const h = bridgeHarness();
  let finish;
  h.state.result = new Promise((resolve) => { finish = resolve; });
  h.dispatch();
  h.window.location.href = `http://localhost:3000/?sourceUrl=${encodeURIComponent("https://www.youtube.com/watch?v=other-video")}`;
  finish({ status: "ready", captionTrack: track });
  await nextTurn();
  assert.equal(h.replies[0].status, "stale");
  assert.equal(h.replies[0].captionTrack, undefined);

  const timed = bridgeHarness({ quickTimeout: true });
  timed.state.result = new Promise(() => {});
  timed.dispatch();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(timed.replies.length, 1);
  assert.equal(timed.replies[0].status, "timeout");
});

test("fresh bridge preserves observer reasons and labels channel rejection as communication failure", async () => {
  const h = bridgeHarness();
  for (const status of ["observer_missing", "not_observed", "request_failed", "empty_response", "invalid_response", "response_too_large", "observer_timeout", "bridge_error"]) {
    h.state.result = Promise.resolve({ status, error: "signed-private", captionTrack: track });
    h.dispatch();
    await nextTurn();
    assert.equal(h.replies.at(-1).status, status);
    assert.equal(h.replies.at(-1).captionTrack, undefined);
    assert.equal(JSON.stringify(h.replies.at(-1)).includes("signed-private"), false);
  }
  h.state.result = Promise.reject(new Error("The message channel closed: private"));
  h.dispatch();
  await nextTurn();
  assert.equal(h.replies.at(-1).status, "bridge_error");
});
