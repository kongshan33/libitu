import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { installBufferedCapture, bufferedSourceUrl, validBufferedRequest } from "../src/buffer-capture.js";

const page = { id: 8, url: "http://localhost:3000/practice/a0000000-0000-4000-8000-000000000001" };
const sender = { id: "libitu", frameId: 0, documentId: "document-1", url: page.url, tab: page };
const arm = { type: "LIBITU_BUFFER_REQUEST", version: 4, contentId: "a0000000-0000-4000-8000-000000000001", videoId: "first-video", documentNonce: "document-nonce-12345", action: "arm", sessionId: "session-1", requestId: "session-1" };
const extract = { ...arm, action: "extract", requestId: "clip-1", start: 100, end: 101 };
const observation = { ...arm, action: "observe", telemetry: { epochTime: 1700000000000, wallTime: 1000, time: 100, rate: 1, state: 1, generation: 1 } };

function fixture(verifySource) {
  const listeners = {};
  const calls = []; const events = []; const stored = {}; const timers = new Map();
  let timerId = 0; let offscreen = false;
  const state = { streamId: Promise.resolve("stream-1"), verify: true, url: page.url, documentId: sender.documentId };
  const event = (name) => ({ addListener(fn) { (listeners[name] ??= []).push(fn); } });
  const chrome = {
    webNavigation: { onCommitted: event("committed"), getFrame: async () => ({ url: state.url, documentId: state.documentId }) },
    runtime: { id: "libitu", onMessage: event("message"), getURL: (path) => `chrome-extension://libitu/${path}`,
      getContexts: async () => offscreen ? [{}] : [], sendMessage: async (message) => { calls.push(["command", message]); return { accepted: true }; } },
    action: { setBadgeText: (value) => calls.push(["badge", value]), setTitle: (value) => calls.push(["title", value]) },
    tabs: { get: async () => ({ ...page, url: state.url }), onUpdated: event("updated"), onRemoved: event("removed"), sendMessage: async (id, message, options) => {
      calls.push(["tab", id, message, options]);
      if (message.type.endsWith("VERIFY")) return { available: state.verify, url: state.url, contentId: arm.contentId, videoId: arm.videoId, documentNonce: arm.documentNonce };
      events.push(message);
    } },
    offscreen: { createDocument: async (options) => { offscreen = true; calls.push(["create", options]); },
      closeDocument: async () => { offscreen = false; calls.push(["close"]); } },
    tabCapture: { getMediaStreamId: async (options) => { calls.push(["stream", options]); return state.streamId; } },
    storage: { session: { get: async (key) => ({ [key]: stored[key] }), set: async (data) => Object.assign(stored, data),
      remove: async (key) => { delete stored[key]; } } }
  };
  const clock = { setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timers.delete(id) };
  let controller = installBufferedCapture(chrome, clock, { verifySource: verifySource ?? (async (id, video) => id === arm.contentId && video === arm.videoId) });
  const dispatch = (message, origin = sender) => new Promise((resolve) => {
    let handled = false;
    for (const listener of listeners.message) if (listener(message, origin, resolve)) handled = true;
    if (!handled) resolve(undefined);
  });
  const f = { state, calls, events, stored, timers, dispatch,
    get controller() { return controller; },
    async emit(status, extra = {}, requestId = arm.sessionId, origin) {
      const command = calls.find(([type, message]) => type === "command" && message.type === "LIBITU_BUFFER_OFFSCREEN_COMMAND" && message.action === "open")?.[1];
      await dispatch({ type: "LIBITU_BUFFER_OFFSCREEN_EVENT", version: 4, token: command?.token, sessionId: arm.sessionId, requestId, status, ...extra },
        origin ?? { id: "libitu", url: chrome.runtime.getURL("src/reference-offscreen.html") });
    },
    async enabled() { assert.equal((await dispatch(arm)).status, "armed"); await controller.onToolbarClick(page); await f.emit("enabled"); },
    async update(change) { for (const fn of listeners.updated) fn(page.id, change); await nextTurn(); },
    async expire(ms) { const timer = [...timers.values()].find((entry) => entry.ms === ms); assert.ok(timer); timer.fn(); await nextTurn(); },
    async documentChange() { for (const fn of listeners.committed) fn({ tabId: page.id, frameId: 0, documentId: "new-document" }); await nextTurn(); },
    async remove() { for (const fn of listeners.removed) fn(page.id); await nextTurn(); },
    async restart() { timers.clear(); listeners.message = []; listeners.updated = []; listeners.removed = [];
      controller = installBufferedCapture(chrome, clock, { verifySource: async () => true }); await controller.ready; }
  };
  return f;
}

test("v4 identity preserves content across paths and ignores display query and hash", () => {
  assert.equal(bufferedSourceUrl(page.url), bufferedSourceUrl(`${page.url}/shadow?segmentId=next&sentenceId=word#sound`));
  assert.notEqual(bufferedSourceUrl(page.url), bufferedSourceUrl(page.url.replace("a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002")));
  assert.equal(bufferedSourceUrl(page.url), bufferedSourceUrl(`${page.url}?learnerLevel=B2&returnTo=ignored`));
  for (const url of ["http://evil.test/", `${page.url}/unknown`]) assert.equal(bufferedSourceUrl(url), null);
  assert.equal(validBufferedRequest(observation), true); assert.equal(validBufferedRequest(extract), true);
  for (const invalid of [{ ...arm, version: 2 }, { ...extract, end: 161 }, { ...extract, start: -1 },
    { ...observation, telemetry: { ...observation.telemetry, generation: 0.5 } },
    { ...observation, telemetry: { ...observation.telemetry, time: NaN } }, { ...observation, requestId: "not-session" }]) {
    assert.equal(validBufferedRequest(invalid), false);
  }
});

test("setup never grants audio; same-document Stage 1 to Stage 2 reuse requires only one toolbar invocation", async () => {
  const f = fixture();
  assert.equal((await f.dispatch({ ...arm, action: "ping" })).status, "available"); await f.dispatch(arm);
  assert.equal(f.calls.some(([type]) => type === "stream"), false);
  await f.controller.onToolbarClick({ ...page, id: 99 });
  assert.equal(f.calls.some(([type]) => type === "stream"), false);
  await f.controller.onToolbarClick(page); await f.emit("enabled");
  const next = { ...page, url: `${page.url}/shadow?segmentId=next&sentenceId=next` };
  await f.update({ status: "loading", url: next.url });
  assert.equal((await f.dispatch(arm, { ...sender, tab: next })).status, "enabled");
  await f.dispatch(observation, { ...sender, tab: next });
  assert.equal(f.calls.filter(([type]) => type === "stream").length, 1);
  assert.equal(f.calls.at(-1)[1].action, "observe");
  assert.deepEqual(f.calls.at(-1)[1].telemetry, observation.telemetry);
  assert.deepEqual(Object.keys(f.stored.libituBufferedSession).sort(), ["documentId", "sessionId", "tabId"]);
  await f.dispatch({ ...arm, action: "close" }, { ...sender, tab: next });
  assert.equal(f.events.at(-1).status, "closed");
});

test("untrusted origins, frames, documents and old source URLs cannot control or receive media", async () => {
  const f = fixture();
  for (const origin of [{ ...sender, frameId: 1 }, { ...sender, id: "foreign" }, { ...sender, url: "http://evil.test" },
    { ...sender, documentId: "" }]) assert.equal((await f.dispatch(arm, origin)).status, "error");
  await f.enabled();
  for (const origin of [{ ...sender, documentId: "new" }, { ...sender, tab: { ...page, url: `${page.url}/unknown` } }]) {
    assert.equal((await f.dispatch(observation, origin)).status, origin.documentId === "new" ? "closed" : "error");
  }
  const before = f.events.length;
  await f.emit("coverage", { ranges: [{ start: 1, end: 2 }], retainedBytes: 10, recording: true }, arm.sessionId, { ...sender });
  assert.equal(f.events.length, before);
  await f.dispatch({ ...arm, action: "close" });
});

test("coverage and source-bound extracts pass only through the offscreen owner; duplicate IDs are rejected", async () => {
  const f = fixture(); await f.enabled();
  await f.emit("coverage", { ranges: [{ start: 100, end: 101 }], retainedBytes: 16000, recording: true });
  assert.equal(f.events.at(-1).status, "coverage"); assert.equal("token" in f.events.at(-1), false);
  await f.dispatch(extract);
  await f.emit("complete", { audioBase64: "UklGRg==", mimeType: "audio/wav", durationMs: 1000, start: 100, end: 101, captureId: "capture-1" }, extract.requestId);
  assert.equal(f.events.at(-1).status, "complete"); assert.equal(f.events.at(-1).captureId, "capture-1");
  assert.equal((await f.dispatch(extract)).status, "error");
  const next = { ...extract, requestId: "clip-2" }; await f.dispatch(next);
  await f.emit("complete", { audioBase64: "UklGRg==", mimeType: "audio/wav", durationMs: 1000, start: 999, end: 1000, captureId: "capture-1" }, next.requestId);
  assert.equal(f.events.at(-1).status, "missing");
  await f.dispatch({ ...arm, action: "close" });
});

test("paused and stale pages, full navigation, source changes, toolbar stop and worker restart release media", async () => {
  for (const cause of ["lease", "maximum", "reload", "source", "document", "toolbar", "removed", "restart"]) {
    const f = fixture(); await f.enabled();
    if (cause === "lease") await f.expire(45_000);
    if (cause === "maximum") await f.expire(30 * 60_000);
    if (cause === "reload") await f.update({ status: "loading" });
    if (cause === "source") await f.update({ url: page.url.replace("a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002") });
    if (cause === "toolbar") await f.controller.onToolbarClick(page);
    if (cause === "document") await f.documentChange();
    if (cause === "removed") await f.remove();
    if (cause === "restart") await f.restart();
    assert.equal(f.calls.filter(([type]) => type === "close").length, 1, cause);
    assert.equal(f.stored.libituBufferedSession, undefined, cause); assert.equal(f.timers.size, 0, cause);
  }
});

test("late authorization results and missing original document never open an abandoned session", async () => {
  const f = fixture(); let release;
  f.state.streamId = new Promise((resolve) => { release = resolve; });
  await f.dispatch(arm); const starting = f.controller.onToolbarClick(page); await nextTurn();
  await f.dispatch({ ...arm, action: "close" }); release("late-stream"); await starting;
  assert.equal(f.calls.some(([type]) => type === "command"), false);
  const missing = fixture(); await missing.dispatch(arm); missing.state.verify = false;
  await missing.controller.onToolbarClick(page);
  assert.equal(missing.calls.some(([type]) => type === "stream"), false);
});

test("obsolete protocols, video changes and document nonce changes cannot control v4", async () => {
  const f = fixture(); await f.enabled();
  for (const version of [2, 3]) assert.equal(await f.dispatch({ ...arm, version }), undefined);
  assert.equal((await f.dispatch({ ...observation, documentNonce: "another-document-nonce" })).status, "closed");
  assert.equal((await f.dispatch({ ...arm, videoId: "other-video" })).status, "error");
  assert.equal(f.calls.filter(([type]) => type === "stream").length, 1);
  await f.dispatch({ ...arm, action: "close" });
});

test("import-to-content navigation arms the live document and rejects a replaced document", async () => {
  const f = fixture();
  const imported = { ...sender, url: "http://localhost:3000/practice/import?sourceUrl=original" };
  assert.equal((await f.dispatch({ ...arm, action: "ping" }, imported)).status, "available");
  assert.equal((await f.dispatch(arm, imported)).status, "armed");
  assert.equal(f.calls.some(([type]) => type === "stream"), false);
  f.state.documentId = "replacement-document";
  assert.equal((await f.dispatch(arm, imported)).status, "error");
});

test("ping is local; arm validates once and duplicate arm reuses the pending check", async () => {
  let release, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(async () => { reads++; return gate; });
  assert.equal((await f.dispatch({ ...arm, action: "ping" })).status, "available");
  assert.equal(reads, 0); assert.deepEqual(f.stored, {});
  const first = f.dispatch(arm);
  await nextTurn();
  const duplicate = f.dispatch(arm);
  await nextTurn();
  assert.equal(reads, 1);
  assert.equal(f.calls.some(([kind, value]) => kind === "badge" && value.text === "ON?"), false);
  await f.controller.onToolbarClick(page);
  assert.equal(f.calls.some(([kind]) => kind === "stream"), false);
  release(true);
  assert.equal((await first).status, "armed");
  assert.equal((await duplicate).status, "armed");
  assert.equal(f.calls.filter(([kind, value]) => kind === "badge" && value.text === "ON?").length, 1);
  assert.equal((await f.dispatch(arm)).status, "armed"); assert.equal(reads, 1);
  await f.dispatch({ ...arm, action: "close" });
});

test("cancel, source/document changes and tab closure fence delayed arming", async () => {
  for (const cause of ["cancel", "source", "document", "removed", "reload"]) {
    let release;
    const f = fixture(() => new Promise(resolve => { release = resolve; }));
    const pending = f.dispatch(arm); await nextTurn();
    if (cause === "cancel") await f.dispatch({ ...arm, action: "close" });
    if (cause === "source") { f.state.url = "http://localhost:3000/profile"; await f.update({ url: f.state.url }); }
    if (cause === "document") { f.state.documentId = "replacement"; await f.documentChange(); }
    if (cause === "removed") await f.remove();
    if (cause === "reload") await f.update({ status: "loading" });
    release(true); await pending;
    assert.equal(f.calls.some(([kind, value]) => kind === "badge" && value.text === "ON?"), false, cause);
    assert.equal(f.stored.libituBufferedSession, undefined, cause);
    assert.equal(f.controller.handlesTab(page), false, cause);
  }
});

test("registration verifies source without arming; source failures never expose ON?", async () => {
  let valid = true, reads = 0;
  const f = fixture(async () => { reads++; return valid; });
  assert.equal((await f.dispatch({ ...arm, action: "register" })).status, "available");
  assert.equal(reads, 1); assert.equal(f.stored[`libituContentTab:${page.id}`].videoId, arm.videoId);
  assert.equal(f.stored.libituBufferedSession, undefined);
  valid = false;
  assert.equal((await f.dispatch(arm)).status, "error");
  assert.equal(f.calls.some(([kind, value]) => kind === "badge" && value.text === "ON?"), false);
  assert.equal(f.controller.handlesTab(page), false);
});
