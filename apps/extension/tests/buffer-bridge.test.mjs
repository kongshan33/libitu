import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { setImmediate as nextTurn } from "node:timers/promises";
const code = readFileSync(new URL("../src/buffer-bridge.js", import.meta.url), "utf8");
const arm = { type: "LIBITU_BUFFER_REQUEST", version: 4, contentId: "a0000000-0000-4000-8000-000000000001", videoId: "first-video", action: "arm", sessionId: "session-1", requestId: "session-1" };
const extract = { ...arm, action: "extract", requestId: "clip-1", start: 10, end: 20 };
const initial = "http://localhost:3000/practice/a0000000-0000-4000-8000-000000000001";
function fixture({ top = true, url = initial } = {}) {
  const callbacks = {}; const calls = []; const replies = []; let listener;
  const window = { location: new URL(url), addEventListener: (type, handler) => { callbacks[type] = handler; },
    postMessage: (message) => replies.push(message) };
  window.top = top ? window : {};
  const chrome = { runtime: { id: "libitu", onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: async (message) => {
    calls.push(message);
    return ["arm", "ping", "register"].includes(message.action) ? { type: "LIBITU_BUFFER_EVENT", version: 4, sessionId: message.sessionId,
      requestId: message.requestId, status: message.action === "arm" ? "armed" : "available" } : { accepted: true };
  } } };
  runInNewContext(code, { window, chrome, URL, crypto });
  return { window, callbacks, calls, replies,
    async send(message, extra = {}) { callbacks.message?.({ data: message, source: window, origin: window.location.origin, ...extra }); await nextTurn(); },
    runtime(message, sender = { id: "libitu" }) { let result; listener?.(message, sender, (value) => { result = value; }); return result; }
  };
}
test("buffer bridge accepts only same-origin top-frame messages and whitelists observation fields", async () => {
  for (const options of [{ top: false }, { url: "http://evil.test/" }, { url: `${initial}/unknown` }]) {
    const f = fixture(options); await f.send(arm); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); await f.send(arm, { source: {} }); await f.send(arm, { origin: "http://evil.test" });
  assert.equal(f.calls.length, 0); await f.send(arm);
  await f.send({ ...arm, action: "observe", telemetry: { epochTime: 1, wallTime: 2, time: 3, rate: 1, state: 1, generation: 1, token: "private" }, secret: "private" });
  assert.equal("secret" in f.calls.at(-1), false); assert.equal("token" in f.calls.at(-1).telemetry, false);
});
test("same-document Stage 1/2 and sentence/segment navigation preserve a session; another source rejects it", async () => {
  const f = fixture(); await f.send(arm);
  f.window.location = new URL(`${initial}/shadow?segmentId=two&sentenceId=three#melody`);
  assert.equal(f.runtime({ type: "LIBITU_BUFFER_VERIFY", sessionId: arm.sessionId }).available, true);
  await f.send(extract);
  f.runtime({ type: "LIBITU_BUFFER_EVENT", version: 4, status: "complete", sessionId: arm.sessionId, requestId: extract.requestId });
  assert.equal(f.replies.at(-1).status, "complete");
  f.window.location = new URL(initial.replace("a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002"));
  assert.equal(f.runtime({ type: "LIBITU_BUFFER_VERIFY", sessionId: arm.sessionId }).available, false);
  await f.send({ ...arm, action: "observe", telemetry: {} });
  assert.equal(f.calls.at(-1).action, "extract");
});
test("late or foreign extract events are discarded and pagehide releases the grant", async () => {
  const f = fixture(); await f.send(arm); await f.send(extract);
  const event = { type: "LIBITU_BUFFER_EVENT", version: 4, status: "complete", sessionId: arm.sessionId, requestId: extract.requestId };
  f.runtime(event, { id: "other" }); f.runtime({ ...event, requestId: "other" }); assert.equal(f.replies.length, 1);
  f.runtime(event); f.runtime(event); assert.equal(f.replies.length, 2);
  f.callbacks.pagehide(); await nextTurn(); assert.equal(f.calls.at(-1).action, "close");
  assert.equal(f.runtime({ type: "LIBITU_BUFFER_VERIFY", sessionId: arm.sessionId }).available, false);
});
test("availability probes do not exhaust session capacity", async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) await f.send({ ...arm, action: "ping", sessionId: `probe-${i}`, requestId: `probe-${i}` });
  await f.send(arm); assert.equal(f.replies.at(-1).status, "armed");
});

test("verified registrations release their probe slot without arming capture", async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) await f.send({ ...arm, action: "register", sessionId: `register-${i}`, requestId: `register-${i}` });
  assert.equal(f.calls.length, 12);
  assert.equal(f.replies.every(reply => reply.status === "available"), true);
  await f.send(arm); assert.equal(f.replies.at(-1).status, "armed");
});
