import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { installReferenceCapture, validReferenceRequest, practiceUrl } from "../src/reference-capture.js";

const page = { id: 8, url: "http://localhost:3000/?stage=2&segmentId=segment-1&sentenceId=sentence-1" };
const sender = { id: "libitu", frameId: 0, documentId: "document-1", url: page.url, tab: page };
const arm = { type: "LIBITU_REFERENCE_REQUEST", version: 2, sessionId: "session-1", requestId: "session-1", action: "arm" };
const begin = { ...arm, requestId: "clip-1", action: "begin", sentenceId: "sentence-1", start: 2, end: 8 };
const payload = { audioBase64: "YXVkaW8=", mimeType: "audio/webm;codecs=opus", durationMs: 1200 };

function fixture() {
  const listeners = {};
  const calls = [];
  const events = [];
  const stored = {};
  const timers = new Map();
  let timerId = 0;
  let offscreen = false;
  const state = { streamId: Promise.resolve("tab-stream"), verification: true, cancelAck: null };
  const event = (name) => ({ addListener: (callback) => { listeners[name] = callback; } });
  const chrome = {
    runtime: {
      id: "libitu", onMessage: event("message"), getURL: (path) => `chrome-extension://libitu/${path}`,
      getContexts: async () => offscreen ? [{}] : [],
      sendMessage: async (message) => {
        calls.push(["command", message]);
        if (message.action === "cancel" && state.cancelAck) await state.cancelAck;
        return { accepted: true };
      }
    },
    action: { setBadgeText: (value) => calls.push(["badge", value]), setTitle: (value) => calls.push(["title", value]) },
    tabs: {
      onUpdated: event("updated"), onRemoved: event("removed"),
      sendMessage: async (id, message, options) => {
        calls.push(["tab", id, message, options]);
        if (message.type === "LIBITU_REFERENCE_VERIFY") return { available: state.verification, url: page.url };
        events.push(message);
      }
    },
    offscreen: {
      createDocument: async (options) => { offscreen = true; calls.push(["create", options]); },
      closeDocument: async () => { offscreen = false; calls.push(["close"]); }
    },
    tabCapture: { getMediaStreamId: async (options) => { calls.push(["stream", options]); return state.streamId; } },
    storage: { session: {
      get: async (key) => ({ [key]: structuredClone(stored[key]) }),
      set: async (data) => Object.assign(stored, structuredClone(data)),
      remove: async (key) => { delete stored[key]; }
    } }
  };
  const clock = {
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: (id) => timers.delete(id)
  };
  let controller = installReferenceCapture(chrome, clock);
  const dispatch = (message, origin = sender) => new Promise((resolve) => {
    if (!listeners.message(message, origin, resolve)) resolve(undefined);
  });
  return {
    chrome, state, calls, events, stored, timers, listeners, dispatch,
    get controller() { return controller; },
    restart() { timers.clear(); controller = installReferenceCapture(chrome, clock); },
    async emit(status, extra = {}, requestId = "clip-1", origin = { id: "libitu", url: chrome.runtime.getURL("src/reference-offscreen.html") }) {
      const command = calls.find(([type, message]) => type === "command" && message.action === "open")?.[1];
      return dispatch({
        type: "LIBITU_REFERENCE_OFFSCREEN_EVENT", version: 2, token: command?.token,
        sessionId: "session-1", requestId, status, ...extra
      }, origin);
    },
    async expire(ms) {
      const timer = [...timers.values()].find((entry) => entry.ms === ms);
      assert.ok(timer, `Expected a ${ms} ms timeout`);
      timer.callback();
      await nextTurn();
    },
    async enabled() {
      assert.equal((await dispatch(arm)).status, "armed");
      await controller.onToolbarClick(page);
      await this.emit("enabled", {}, arm.sessionId);
    },
    async recording(request = begin, origin = sender) {
      await dispatch(request, origin);
      await this.emit("recording", { captureStartedAt: 123456 }, request.requestId);
    },
    async complete(request = begin, origin = sender) {
      await dispatch({ ...request, action: "stop" }, origin);
      await this.emit("complete", payload, request.requestId);
    }
  };
}

test("v2 validates session/clip identities and ignores only sentence/hash in the practice URL", () => {
  assert.equal(validReferenceRequest(arm), true);
  assert.equal(validReferenceRequest(begin), true);
  for (const invalid of [
    { ...arm, version: 1 }, { ...arm, requestId: "different" }, { ...begin, sessionId: 12 },
    { ...begin, requestId: arm.sessionId }, { ...begin, sentenceId: {} }, { ...begin, start: -1 },
    { ...begin, end: 63 }, { ...begin, end: 2 }, { ...begin, start: NaN }, { ...arm, action: "upload" }
  ]) assert.equal(validReferenceRequest(invalid), false);
  assert.equal(practiceUrl(page.url), practiceUrl(page.url.replace("sentence-1", "sentence-2") + "#progress"));
  assert.notEqual(practiceUrl(page.url), practiceUrl(page.url.replace("segment-1", "segment-2")));
  assert.notEqual(practiceUrl(page.url), practiceUrl(page.url + "&sourceUrl=other"));
  assert.equal(practiceUrl("http://evil.test/?stage=2"), null);
});

test("ping and arm are gesture-free setup; one toolbar action enables a stream without starting an encoder", async () => {
  const f = fixture();
  assert.equal((await f.dispatch({ ...arm, action: "ping" })).status, "available");
  await f.dispatch(arm);
  assert.equal(f.calls.some(([type]) => type === "stream"), false);
  await f.controller.onToolbarClick({ ...page, id: 99 });
  assert.equal(f.calls.some(([type]) => type === "stream"), false);
  await f.controller.onToolbarClick(page);
  assert.deepEqual(f.calls.find(([type]) => type === "stream")[1], { targetTabId: page.id });
  assert.deepEqual(f.calls.find(([type]) => type === "create")[1].reasons, ["USER_MEDIA"]);
  assert.deepEqual(f.calls.filter(([type]) => type === "command").map(([, command]) => command.action), ["open"]);
  assert.equal(f.events.length, 0);
  await f.emit("enabled", {}, arm.sessionId);
  assert.equal(f.events.at(-1).status, "enabled");
  assert.equal(f.events.at(-1).requestId, arm.sessionId);
  await f.dispatch({ ...arm, action: "close" });
});

test("same-document Stage 1 to Stage 2 navigation accepts Chrome's committed sender URL", async () => {
  const f = fixture();
  const stageOneDocument = {
    ...sender,
    url: "http://localhost:3000/?sourceUrl=https%3A%2F%2Fyoutu.be%2Ffixture&contentId=content-1",
    tab: page
  };
  assert.equal((await f.dispatch({ ...arm, action: "ping" }, stageOneDocument)).status, "available");
  assert.equal((await f.dispatch(arm, stageOneDocument)).status, "armed");
  assert.equal(f.stored.libituReferenceSession.documentId, sender.documentId);
  await f.dispatch({ ...arm, action: "close" }, stageOneDocument);
});

test("two clips reuse one authorization, one offscreen document, and one stream ID", async () => {
  const f = fixture();
  await f.enabled();
  await f.recording();
  await f.complete();
  assert.equal(f.events.at(-1).status, "complete");
  assert.equal(f.calls.some(([type]) => type === "close"), false);
  const next = { ...begin, requestId: "clip-2", sentenceId: "sentence-2" };
  await f.recording(next);
  await f.complete(next);
  assert.deepEqual(f.events.filter((event) => event.status === "complete").map((event) => event.requestId), ["clip-1", "clip-2"]);
  assert.equal(f.calls.filter(([type]) => type === "stream").length, 1);
  assert.equal(f.calls.filter(([type]) => type === "create").length, 1);
  assert.equal(f.calls.filter(([type, message]) => type === "command" && message.action === "begin").length, 2);
  assert.equal(f.timers.size, 1);
  assert.deepEqual(Object.keys(f.stored.libituReferenceSession).sort(), ["documentId", "sessionId", "tabId"]);
  await f.dispatch({ ...arm, action: "close" });
  assert.equal(f.calls.filter(([type]) => type === "close").length, 1);
  assert.deepEqual(f.stored, {});
});

test("untrusted origins, subframes, extensions and stale documents cannot control the owner session", async () => {
  const f = fixture();
  for (const invalid of [
    { ...sender, id: "another-extension" }, { ...sender, frameId: 1 }, { ...sender, documentId: undefined },
    { ...sender, url: "http://evil.test/" }, { ...sender, tab: { ...page, url: "http://localhost:3000/" } },
    { ...sender, tab: { ...page, url: "https://youtube.com" } }
  ]) assert.equal((await f.dispatch(arm, invalid)).status, "error");
  await f.enabled();
  await f.recording();
  const result = await f.dispatch({ ...begin, action: "stop" }, { ...sender, documentId: "new-document" });
  assert.equal(result.status, "closed");
  assert.equal(result.requestId, arm.sessionId);
  assert.equal(f.calls.some(([type, message]) => type === "command" && message.action === "stop"), false);
  await f.emit("error", {}, arm.sessionId, { id: "libitu", url: page.url, tab: page });
  assert.equal(f.events.at(-1).status, "recording");
  await f.dispatch({ ...arm, action: "close" });
});

test("duplicate arm/begin are idempotent; reused clip IDs cannot reopen an ended encoder", async () => {
  const f = fixture();
  await f.enabled();
  assert.equal((await f.dispatch(arm)).status, "enabled");
  await f.recording();
  await f.dispatch(begin);
  assert.equal(f.calls.filter(([type, message]) => type === "command" && message.action === "begin").length, 1);
  assert.equal((await f.dispatch({ ...begin, requestId: "busy-clip" })).status, "error");
  await f.complete();
  assert.equal((await f.dispatch(begin)).status, "error");
  assert.equal(f.calls.some(([type]) => type === "close"), false);
  await f.dispatch({ ...arm, action: "close" });
});

test("cancel followed by begin drops old stop/data events and never stops the newer clip", async () => {
  const f = fixture();
  await f.enabled();
  await f.recording();
  await f.dispatch({ ...begin, action: "cancel" });
  const next = { ...begin, requestId: "clip-2" };
  await f.recording(next);
  const before = f.calls.filter(([type]) => type === "command").length;
  await f.dispatch({ ...begin, action: "cancel" });
  await f.dispatch({ ...begin, action: "stop" });
  await f.emit("complete", payload);
  await f.emit("error");
  assert.equal(f.calls.filter(([type]) => type === "command").length, before);
  assert.equal(f.events.at(-1).requestId, "clip-2");
  assert.equal(f.events.at(-1).status, "recording");
  await f.complete(next);
  assert.equal(f.events.at(-1).status, "complete");
  await f.dispatch({ ...arm, action: "close" });
});

test("a new begin waits for the previous encoder's cancel acknowledgement", async () => {
  const f = fixture();
  await f.enabled();
  await f.recording();
  let release;
  f.state.cancelAck = new Promise((resolve) => { release = resolve; });
  const cancelling = f.dispatch({ ...begin, action: "cancel" });
  const next = f.dispatch({ ...begin, requestId: "clip-2" });
  await nextTurn();
  assert.equal(f.calls.filter(([type, message]) => type === "command" && message.action === "begin").length, 1);
  release();
  await Promise.all([cancelling, next]);
  assert.equal(f.calls.filter(([type, message]) => type === "command" && message.action === "begin").length, 2);
  await f.dispatch({ ...arm, action: "close" });
});

test("close then immediately arm creates a new owner only after old session teardown", async () => {
  const f = fixture();
  await f.enabled();
  const closing = f.dispatch({ ...arm, action: "close" });
  const nextArm = { ...arm, sessionId: "session-2", requestId: "session-2" };
  const result = f.dispatch(nextArm);
  await closing;
  assert.equal((await result).status, "armed");
  assert.equal(f.stored.libituReferenceSession.sessionId, "session-2");
  await f.dispatch({ ...nextArm, action: "close" });
});

test("sentence-only URL changes retain authorization while segment changes and full reload end it", async () => {
  const f = fixture();
  await f.enabled();
  const nextUrl = page.url.replace("sentence-1", "sentence-2") + "#progress";
  f.listeners.updated(page.id, { url: nextUrl });
  await nextTurn();
  assert.equal(f.calls.some(([type]) => type === "close"), false);
  const nextSender = { ...sender, url: nextUrl, tab: { ...page, url: nextUrl } };
  await f.recording({ ...begin, sentenceId: "sentence-2" }, nextSender);
  await f.complete({ ...begin, sentenceId: "sentence-2" }, nextSender);
  f.listeners.updated(page.id, { url: nextUrl.replace("segment-1", "segment-2") });
  await nextTurn();
  assert.equal(f.events.at(-1).status, "closed");
  const reloaded = fixture();
  await reloaded.enabled();
  reloaded.listeners.updated(page.id, { status: "loading" });
  await nextTurn();
  assert.equal(reloaded.events.at(-1).status, "closed");
});

test("only page heartbeats renew the 45-second lease; offscreen heartbeat cannot keep an abandoned page authorized", async () => {
  const f = fixture();
  await f.enabled();
  const lease = [...f.timers.keys()][0];
  await f.emit("heartbeat", {}, arm.sessionId);
  assert.equal([...f.timers.keys()][0], lease);
  await f.dispatch({ ...arm, action: "heartbeat" });
  assert.notEqual([...f.timers.keys()][0], lease);
  await f.expire(45_000);
  assert.equal(f.events.at(-1).requestId, arm.sessionId);
  assert.equal(f.events.at(-1).status, "error");
  assert.equal(f.calls.filter(([type]) => type === "close").length, 1);
  assert.equal(f.timers.size, 0);
});

test("clip errors, invalid payloads, and finalization expiry retain the healthy enabled stream", async () => {
  for (const cause of ["payload", "recorder", "timeout"]) {
    const f = fixture();
    await f.enabled();
    await f.recording();
    if (cause === "recorder") await f.emit("error");
    else {
      await f.dispatch({ ...begin, action: "stop" });
      if (cause === "timeout") await f.expire(5_000);
      else await f.emit("complete", { ...payload, audioBase64: "data:audio/webm;base64,YQ==" });
    }
    assert.equal(f.events.at(-1).status, "error");
    assert.equal(f.events.at(-1).requestId, begin.requestId);
    assert.equal(f.calls.some(([type]) => type === "close"), false);
    assert.equal((await f.dispatch(arm)).status, "enabled");
    await f.dispatch({ ...arm, action: "close" });
  }
});

test("lost-session begin reports session closure, while old close cannot disable a different session", async () => {
  const f = fixture();
  const lost = await f.dispatch(begin);
  assert.equal(lost.status, "closed");
  assert.equal(lost.requestId, arm.sessionId);
  await f.enabled();
  await f.dispatch({ ...arm, sessionId: "old-session", requestId: "old-session", action: "close" });
  assert.equal((await f.dispatch(arm)).status, "enabled");
  await f.controller.onToolbarClick(page);
  assert.equal(f.events.at(-1).status, "closed");
});

test("closing during stream-ID allocation prevents late session creation", async () => {
  const f = fixture();
  let release;
  f.state.streamId = new Promise((resolve) => { release = resolve; });
  await f.dispatch(arm);
  const starting = f.controller.onToolbarClick(page);
  await nextTurn();
  await f.dispatch({ ...arm, action: "close" });
  release("late-stream-id");
  await starting;
  assert.equal(f.calls.some(([type]) => type === "command"), false);
  assert.equal(f.events.at(-1).status, "closed");
  assert.equal(f.timers.size, 0);
});

test("arm expiry, tab closure, and worker restart release authorization and metadata", async () => {
  for (const cause of ["arm-expiry", "tab-close", "restart"]) {
    const f = fixture();
    if (cause === "arm-expiry") { await f.dispatch(arm); await f.expire(30_000); }
    else {
      await f.enabled();
      if (cause === "tab-close") f.listeners.removed(page.id);
      else f.restart();
      await nextTurn();
      assert.equal(f.calls.filter(([type]) => type === "close").length, 1);
    }
    assert.equal(f.events.at(-1).requestId, arm.sessionId);
    assert.equal(f.timers.size, 0);
    assert.deepEqual(f.stored, {});
  }
});

test("a missing original document fails before obtaining tab media", async () => {
  const f = fixture();
  await f.dispatch(arm);
  f.state.verification = false;
  await f.controller.onToolbarClick(page);
  assert.equal(f.calls.some(([type]) => type === "stream"), false);
  assert.match(f.events.at(-1).error, /page changed/);
});
