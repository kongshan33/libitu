import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { setImmediate as nextTurn } from "node:timers/promises";

const code = readFileSync(new URL("../src/stage-two-bridge.js", import.meta.url), "utf8");
const arm = { type: "LIBITU_REFERENCE_REQUEST", version: 2, action: "arm", sessionId: "session-1", requestId: "session-1" };
const begin = { ...arm, action: "begin", requestId: "clip-1", sentenceId: "sentence-1", start: 0, end: 2 };

function fixture({ top = true, url = "http://localhost:3000/?stage=2" } = {}) {
  const callbacks = {};
  const calls = [];
  const replies = [];
  let runtimeListener;
  const window = {
    location: new URL(url),
    addEventListener: (type, handler) => { callbacks[type] = handler; },
    postMessage: (message, origin) => replies.push({ message, origin })
  };
  window.top = top ? window : {};
  const chrome = { runtime: {
    id: "libitu", onMessage: { addListener: (callback) => { runtimeListener = callback; } },
    sendMessage: async (message) => {
      calls.push(message);
      if (["ping", "arm"].includes(message.action)) return {
        type: "LIBITU_REFERENCE_EVENT", version: 2, sessionId: message.sessionId, requestId: message.requestId,
        status: message.action === "ping" ? "available" : "armed"
      };
      return { accepted: true };
    }
  } };
  runInNewContext(code, { window, chrome, URLSearchParams });
  return {
    window, calls, replies, callbacks,
    async send(message, extra = {}) {
      callbacks.message?.({ data: message, source: window, origin: window.location.origin, ...extra });
      await nextTurn();
    },
    runtime(message, sender = { id: "libitu" }) {
      let response;
      runtimeListener?.(message, sender, (value) => { response = value; });
      return response;
    }
  };
}

test("v2 bridge accepts only top-frame Stage 2, same-window and same-origin messages", async () => {
  for (const options of [{ top: false }, { url: "http://evil.test/?stage=2" }, { url: "http://localhost:3000/" }]) {
    const f = fixture(options);
    await f.send(arm);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await f.send(arm, { origin: "http://evil.test" });
  await f.send(arm, { source: {} });
  await f.send({ ...arm, version: 1 });
  assert.equal(f.calls.length, 0);
  await f.send({ ...arm, secret: "not forwarded" });
  await f.send(begin);
  assert.equal("secret" in f.calls[0], false);
  assert.equal(f.calls[1].sentenceId, begin.sentenceId);
  assert.equal(f.replies[0].origin, "http://localhost:3000");
});

test("session stays known after a completed clip, drops stale clip events, and closes on page exit", async () => {
  const f = fixture();
  await f.send(arm);
  await f.send(begin);
  const event = { type: "LIBITU_REFERENCE_EVENT", version: 2, sessionId: arm.sessionId, requestId: begin.requestId, status: "recording" };
  f.runtime(event, { id: "other-extension" });
  f.runtime({ ...event, requestId: "stale" });
  assert.equal(f.replies.length, 1);
  f.runtime(event);
  f.runtime({ ...event, status: "complete", audioBase64: "YQ==" });
  f.runtime({ ...event, status: "error" });
  assert.equal(f.replies.length, 3);
  assert.equal(f.runtime({ type: "LIBITU_REFERENCE_VERIFY", sessionId: arm.sessionId }).available, true);
  await f.send({ ...begin, requestId: "clip-2" });
  f.runtime({ ...event, requestId: "clip-2" });
  assert.equal(f.replies.at(-1).message.requestId, "clip-2");
  f.callbacks.pagehide();
  await nextTurn();
  assert.equal(f.calls.at(-1).action, "close");
  assert.equal(f.calls.at(-1).requestId, arm.sessionId);
  assert.equal(f.runtime({ type: "LIBITU_REFERENCE_VERIFY", sessionId: arm.sessionId }).available, false);
});

test("completed availability probes do not accumulate sessions or consume enable capacity", async () => {
  const f = fixture();
  for (let i = 0; i < 12; i += 1) {
    const id = `probe-${i}`;
    await f.send({ ...arm, action: "ping", sessionId: id, requestId: id });
  }
  assert.equal(f.calls.length, 12);
  await f.send(arm);
  assert.equal(f.replies.at(-1).message.status, "armed");
  f.runtime({ type: "LIBITU_REFERENCE_EVENT", version: 2, sessionId: arm.sessionId, requestId: arm.sessionId, status: "closed" });
  await f.send(begin);
  assert.equal(f.calls.at(-1).action, "arm");
});
