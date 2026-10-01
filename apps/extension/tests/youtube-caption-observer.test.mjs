import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";

const source = readFileSync(new URL("../src/youtube-caption-observer.js", import.meta.url), "utf8");
const video = "first-video";
const other = "other-video";
const watch = (id = video) => `https://www.youtube.com/watch?v=${id}`;
const timedtext = (query = "") => `https://www.youtube.com/api/timedtext?v=${video}&lang=en&fmt=json3&kind=asr${query}`;
const fine = { events: [
  { tStartMs: 0, wpWinPosId: 1 },
  { tStartMs: 1040, dDurationMs: 1600, wWinId: 1, segs: [{ utf8: "We", secret: "never-copy" }, { utf8: " can.", tOffsetMs: 300 }] },
  { tStartMs: 1700, aAppend: 1, wWinId: 1, segs: [{ utf8: "\n" }] }
] };
const coarse = { events: [{ tStartMs: 1040, dDurationMs: 1600, segs: [{ utf8: "We can." }] }] };
const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

class Events {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type) {
    const event = { type, target: this };
    const listeners = [...(this.listeners.get(type) ?? [])];
    this[`on${type}`]?.(event);
    for (const listener of listeners) if (this.listeners.get(type)?.has(listener)) listener.call(this, event);
  }
  count() { return [...this.listeners.values()].reduce((total, group) => total + group.size, 0); }
}

function harness({ url = watch(), fetchImpl, subframe = false, origin = "https://www.youtube.com", beforeInstall } = {}) {
  let timestamp = 0;
  let nextTimer = 0;
  const timers = new Map();
  const calls = [];
  const xhrs = [];
  const maps = [];
  const document = new Events();
  class XHR extends Events {
    responseType = "";
    responseText = "";
    response = null;
    status = 0;
    responseURL = "";
    header = null;
    aborts = 0;
    constructor() { super(); xhrs.push(this); }
    open(...args) {
      if (!(this instanceof XHR)) throw new TypeError("native open receiver");
      if (this.openError) throw this.openError;
      this.openArgs = args;
      this.url = typeof args[1] === "string" ? args[1] : args[1]?.href;
      this.sending = false;
      return "native-open";
    }
    send(...args) {
      if (!(this instanceof XHR)) throw new TypeError("native send receiver");
      if (this.sendError) throw this.sendError;
      if (this.sending) throw new Error("native already sending");
      this.sendArgs = args;
      this.sending = true;
      return "native-send";
    }
    getResponseHeader() { return this.header; }
    complete(body = fine, { status = 200, responseType = this.responseType, responseURL = this.url } = {}) {
      this.status = status;
      this.responseType = responseType;
      this.responseURL = responseURL;
      this.response = body;
      this.responseText = typeof body === "string" ? body : JSON.stringify(body);
      this.sending = false;
      this.emit("load");
      this.emit("loadend");
    }
    abort() { this.aborts++; this.sending = false; this.emit("abort"); this.emit("loadend"); }
  }
  const events = new Events();
  const environment = {
    URL, Request, Response, TextEncoder, TextDecoder, Promise, XMLHttpRequest: XHR, document,
    Map: class extends Map { constructor(...args) { super(...args); maps.push(this); } },
    location: { href: url, origin },
    Date: { now: () => timestamp },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: timestamp + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    fetch: function (...args) { calls.push({ receiver: this, args }); return fetchImpl ? fetchImpl(...args) : Promise.resolve(new Response(JSON.stringify(fine))); }
  };
  environment.window = environment;
  environment.top = subframe ? {} : environment;
  const context = createContext(environment);
  beforeInstall?.(context);
  const originalFetch = context.fetch;
  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;
  runInContext(source, context);
  return {
    context, calls, document, events, timers, xhrs, maps, originalFetch, originalOpen, originalSend,
    read: (id = video, language = "en") => clone(context.__libituCaptionObserverV1.read(id, language)),
    installAgain: () => runInContext(source, context),
    move: (id) => { context.location.href = id ? watch(id) : "https://www.youtube.com/"; },
    tick: (milliseconds) => {
      timestamp += milliseconds;
      for (let changed = true; changed;) {
        changed = false;
        for (const [id, item] of [...timers]) if (item.at <= timestamp) { timers.delete(id); item.callback(); changed = true; }
      }
    }
  };
}
async function flush() { for (let index = 0; index < 6; index++) await setImmediate(); }
async function request(h, url = timedtext()) { const response = await h.context.fetch(url); await flush(); return response; }
function xhr(h, url = timedtext()) { const value = new h.context.XMLHttpRequest(); value.open("GET", url); value.send(); return value; }

test("installs once in the top YouTube document without issuing any request", () => {
  const h = harness();
  const fetch = h.context.fetch;
  const open = h.context.XMLHttpRequest.prototype.open;
  const api = h.context.__libituCaptionObserverV1;
  h.installAgain();
  assert.equal(api.version, 1);
  assert.equal(h.context.__libituCaptionObserverV1, api);
  assert.equal(h.context.fetch, fetch);
  assert.equal(h.context.XMLHttpRequest.prototype.open, open);
  assert.deepEqual(h.read(), { status: "not_observed" });
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
  for (const options of [{ subframe: true }, { origin: "https://example.com" }]) {
    const other = harness(options);
    assert.equal(other.context.__libituCaptionObserverV1, undefined);
    assert.equal(other.context.fetch, other.originalFetch);
  }
});

test("fetch preserves its exact promise, receiver, arguments and readable original response", async () => {
  const response = new Response(JSON.stringify(fine));
  const promise = Promise.resolve(response);
  const h = harness({ fetchImpl: () => promise });
  const receiver = { receiver: true };
  const init = { credentials: "include" };
  assert.equal(h.context.fetch.call(receiver, timedtext("&pot=private&signature=private"), init), promise);
  assert.equal(h.calls[0].receiver, receiver);
  assert.equal(h.calls[0].args[1], init);
  assert.equal(await promise, response);
  assert.deepEqual(await response.json(), fine);
  await flush();
  const result = h.read();
  assert.equal(result.status, "ready");
  assert.equal(result.captionTrack.events[0].tStartMs, 1040);
  assert.equal(result.captionTrack.events[0].segs[1].tOffsetMs, 300);
  assert.equal("tOffsetMs" in result.captionTrack.events[0].segs[0], false);
  assert.equal(result.captionTrack.events[1].segs[0].utf8, "\n");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("never-copy"), false);
  result.captionTrack.events[0].segs[0].utf8 = "tampered";
  assert.equal(h.read().captionTrack.events[0].segs[0].utf8, "We");
});

test("only GET same-origin current-video English non-translated JSON3 responses are observed", async () => {
  const urls = [
    timedtext().replace("www.youtube.com", "example.com"),
    timedtext().replace("/api/timedtext", "/videoplayback"),
    timedtext().replace(video, other), timedtext().replace("lang=en", "lang=fr"),
    timedtext().replace("fmt=json3", "fmt=srv3"), timedtext("&tlang=en"), timedtext("&tlang="),
    timedtext("&v=" + video), timedtext("&lang=en"), timedtext("&fmt=json3"),
    timedtext("&name=" + "x".repeat(201)), timedtext().replace("https://", "https://user:pass@")
  ];
  for (const url of urls) { const h = harness(); await request(h, url); assert.equal(h.read().status, "not_observed", url); }
  const h = harness();
  await h.context.fetch(timedtext(), { method: "POST" }); await flush();
  assert.equal(h.read().status, "not_observed");
  await request(h, new Request(timedtext()));
  assert.equal(h.read().status, "ready");
  assert.equal(h.read(other).status, "stale");
  assert.equal(h.read(video, "fr").status, "stale");
});

test("coarse captions are valid and rolling duplicates/newlines are not deduplicated", async () => {
  const raw = { events: [...coarse.events, ...coarse.events, fine.events[2]] };
  const h = harness({ fetchImpl: () => Promise.resolve(new Response(JSON.stringify(raw))) });
  await request(h, timedtext().replace("kind=asr", "kind=manual"));
  const result = h.read();
  assert.equal(result.status, "no_word_offsets");
  assert.equal(result.captionTrack.kind, "manual");
  assert.equal(result.captionTrack.events.length, 3);
  assert.equal(result.captionTrack.events[2].segs[0].utf8, "\n");
  assert.equal("tOffsetMs" in result.captionTrack.events[0].segs[0], false);
});

test("safe diagnostics distinguish HTTP failure, empty body, invalid JSON and invalid events", async () => {
  for (const [body, options, status] of [
    ["denied", { status: 403 }, "request_failed"], ["", {}, "empty_response"],
    [null, { status: 204 }, "empty_response"], ["<html>", {}, "invalid_response"],
    [JSON.stringify({ events: [] }), {}, "empty_response"],
    [JSON.stringify({ events: [{ tStartMs: -1, segs: [{ utf8: "bad" }] }] }), {}, "invalid_response"],
    [JSON.stringify({ events: [{ tStartMs: 0, aAppend: 2, segs: [{ utf8: "bad" }] }] }), {}, "invalid_response"],
    [JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: "bad", tOffsetMs: 1.5 }] }] }), {}, "invalid_response"]
  ]) {
    const h = harness({ fetchImpl: () => Promise.resolve(new Response(body, options)) });
    await request(h);
    assert.deepEqual(h.read(), { status });
  }
});

test("fetch rejection and synchronous wrapper errors remain unchanged without observer rejections", async () => {
  const rejection = new Error("player-owned failure");
  const rejected = Promise.reject(rejection);
  const h = harness({ fetchImpl: () => rejected });
  assert.equal(h.context.fetch(timedtext()), rejected);
  await assert.rejects(rejected, (error) => error === rejection);
  await flush();
  assert.deepEqual(h.read(), { status: "request_failed" });
  const thrown = new Error("original synchronous failure");
  const throwing = harness({ fetchImpl: () => { throw thrown; } });
  assert.throws(() => throwing.context.fetch(timedtext()), (error) => error === thrown);
  const odd = {};
  const custom = harness({ fetchImpl: () => odd });
  assert.equal(custom.context.fetch(timedtext()), odd);
});

test("home to watch works, while navigation and A to B to A discard request-start snapshots", async () => {
  const pending = deferred();
  const h = harness({ url: "https://www.youtube.com/", fetchImpl: () => pending.promise });
  assert.equal(h.read().status, "stale");
  h.document.emit("yt-navigate-start"); h.move(video);
  const original = h.context.fetch(timedtext());
  h.document.emit("yt-navigate-start"); h.move(other);
  h.document.emit("yt-navigate-start"); h.move(video);
  pending.resolve(new Response(JSON.stringify(fine)));
  await original; await flush();
  assert.equal(h.read().status, "not_observed");
  const next = new Response(JSON.stringify(fine));
  const ready = harness({ url: "https://www.youtube.com/", fetchImpl: () => Promise.resolve(next) });
  ready.move(video); await request(ready);
  assert.equal(ready.read().status, "ready");
  ready.move(other); assert.equal(ready.read(other).status, "not_observed");
  ready.move(video); assert.equal(ready.read().status, "not_observed");
});

test("popstate/pagehide clear cache and bfcache pageshow permits only new observations", async () => {
  const h = harness(); await request(h);
  h.events.emit("popstate"); assert.equal(h.read().status, "not_observed");
  await request(h); h.events.emit("pagehide");
  assert.equal(h.read().status, "stale");
  assert.equal(h.timers.size, 0);
  h.events.emit("pageshow"); assert.equal(h.read().status, "not_observed");
  await request(h); assert.equal(h.read().status, "ready");
});

test("response URL redirects or a different track cannot be attached to the request", async () => {
  for (const properties of [{ url: timedtext().replace(video, other) }, { url: timedtext("&name=changed") }, { redirected: true }]) {
    const response = new Response(JSON.stringify(fine));
    for (const [key, value] of Object.entries(properties)) Object.defineProperty(response, key, { value });
    const h = harness({ fetchImpl: () => Promise.resolve(response) });
    await request(h); assert.equal(h.read().status, "invalid_response");
  }
});

test("clone deadlines and size caps never cancel the original fetch or its signal", async () => {
  const pending = deferred();
  let cancelled = 0;
  const response = { ok: true, url: "", headers: { get: () => null }, clone: () => ({ body: { getReader: () => ({
    read: () => pending.promise, cancel: () => { cancelled++; return new Promise(() => {}); }, releaseLock() {}
  }) } }) };
  const h = harness({ fetchImpl: () => Promise.resolve(response) });
  const controller = new AbortController();
  assert.equal(await h.context.fetch(timedtext(), { signal: controller.signal }), response);
  h.tick(2000); assert.deepEqual(h.read(), { status: "observer_timeout" });
  assert.equal(cancelled, 1);
  assert.equal(controller.signal.aborted, false);
  pending.resolve({ done: false, value: new TextEncoder().encode(JSON.stringify(fine)) });
  await flush(); assert.equal(h.read().status, "observer_timeout");
  const large = harness({ fetchImpl: () => Promise.resolve(new Response("x".repeat(2 * 1024 * 1024 + 1))) });
  const original = await request(large);
  assert.equal(large.read().status, "response_too_large");
  assert.equal((await original.text()).length, 2 * 1024 * 1024 + 1);
});

test("no more than two clone readers run concurrently; navigation cancels only clones", async () => {
  let clones = 0, cancels = 0;
  const response = { ok: true, headers: { get: () => null }, clone: () => { clones++; return { body: { getReader: () => ({
    read: () => new Promise(() => {}), cancel: () => { cancels++; return Promise.resolve(); }, releaseLock() {}
  }) } }; } };
  const h = harness({ fetchImpl: () => Promise.resolve(response) });
  await Promise.all(Array.from({ length: 5 }, (_, index) => h.context.fetch(timedtext("&name=" + index))));
  assert.equal(clones, 2);
  h.document.emit("yt-navigate-start");
  assert.equal(cancels, 2);
  assert.equal(h.timers.size, 0);
  assert.equal(h.read().status, "not_observed");
});

test("offset tracks outrank newer coarse tracks, failures and older responses; cache expires at 15 minutes", async () => {
  let body = fine;
  const h = harness({ fetchImpl: () => Promise.resolve(new Response(JSON.stringify(body))) });
  await request(h, timedtext("&name=fine"));
  body = coarse;
  for (let index = 0; index < 8; index++) await request(h, timedtext("&name=coarse" + index));
  await request(h, timedtext("&name=fine"));
  assert.equal(h.read().status, "ready");
  h.tick(15 * 60_000);
  assert.equal(h.read().status, "not_observed");
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.length, 10);
});

test("XHR text and json preserve handlers, native results, this and complete original bodies", () => {
  for (const responseType of ["", "text", "json"]) {
    const h = harness();
    const value = new h.context.XMLHttpRequest();
    const onload = () => { value.playerLoads = (value.playerLoads ?? 0) + 1; };
    value.onload = onload;
    const openArgs = ["GET", timedtext(), true, undefined, undefined];
    assert.equal(value.open(...openArgs), "native-open");
    assert.deepEqual(value.openArgs, openArgs);
    assert.equal(value.send(null), "native-send");
    assert.deepEqual(value.sendArgs, [null]);
    value.complete(clone(fine), { responseType });
    assert.equal(value.onload, onload);
    assert.equal(value.playerLoads, 1);
    assert.equal(value.aborts, 0);
    assert.equal(value.count(), 0);
    assert.equal(h.read().status, "ready");
    assert.equal(value.responseText, JSON.stringify(fine));
    assert.deepEqual(value.response, fine);
  }
});

test("XHR abort/error/timeout and reuse never attach an earlier request to a later source", () => {
  const h = harness();
  const value = xhr(h);
  value.abort(); assert.equal(h.read().status, "request_failed");
  assert.equal(value.count(), 0);
  value.open("GET", timedtext()); value.send();
  h.document.emit("yt-navigate-start"); h.move(other);
  assert.equal(value.count(), 0, "navigation releases old XHR observation listeners without aborting it");
  value.complete(); assert.equal(h.read(other).status, "not_observed");
  h.move(video); value.open("GET", timedtext()); value.send(); value.complete();
  assert.equal(h.read().status, "ready");
  for (const event of ["error", "timeout"]) {
    const isolated = harness(); const failed = xhr(isolated); failed.emit(event);
    assert.equal(isolated.read().status, "request_failed"); assert.equal(failed.count(), 0);
  }
});

test("XHR native open/send exceptions and existing wrappers retain their exact behavior", () => {
  let priorOpens = 0, priorSends = 0;
  const h = harness({ beforeInstall: (context) => {
    const prototype = context.XMLHttpRequest.prototype, open = prototype.open, send = prototype.send;
    prototype.open = function (...args) { priorOpens++; return open.apply(this, args); };
    prototype.send = function (...args) { priorSends++; return send.apply(this, args); };
  } });
  const value = new h.context.XMLHttpRequest();
  const openError = new Error("native open"); value.openError = openError;
  assert.throws(() => value.open("GET", timedtext()), (error) => error === openError);
  delete value.openError; value.open("GET", timedtext());
  const sendError = new Error("native send"); value.sendError = sendError;
  assert.throws(() => value.send(), (error) => error === sendError);
  assert.equal(value.count(), 0);
  delete value.sendError; value.open("GET", timedtext()); value.send();
  assert.throws(() => value.send(), /native already sending/);
  value.complete(); assert.equal(h.read().status, "ready");
  assert.equal(priorOpens, 3); assert.equal(priorSends, 3);
});

test("XHR responseType=json enforces decoded size even in ignored style fields and rejects cycles/accessors", () => {
  for (const [body, expected] of [
    [{ ...fine, ignoredStyle: "x".repeat(2 * 1024 * 1024) }, "response_too_large"],
    [{ ...fine, ignoredStyle: "界".repeat(700_000) }, "response_too_large"],
    [{ ...fine, ignoredStyle: "\u0001".repeat(400_000) }, "response_too_large"]
  ]) {
    const h = harness(); const value = xhr(h); value.complete(body, { responseType: "json" });
    assert.equal(h.read().status, expected); assert.equal(value.aborts, 0);
  }
  const h = harness(); const value = xhr(h); const cyclic = { ...fine }; cyclic.loop = cyclic;
  value.status = 200; value.responseType = "json"; value.responseURL = timedtext(); value.response = cyclic; value.emit("load");
  assert.equal(h.read().status, "invalid_response");
  const second = xhr(h, timedtext("&name=accessor")); const getter = { ...fine };
  Object.defineProperty(getter, "unsafe", { enumerable: true, get() { throw new Error("must not invoke"); } });
  second.status = 200; second.responseType = "json"; second.responseURL = timedtext("&name=accessor"); second.response = getter; second.emit("load");
  assert.equal(h.read().status, "invalid_response");
});

test("the four-track and four-MiB cache limits both evict oldest equal-quality tracks", async () => {
  const h = harness();
  for (let index = 0; index < 8; index++) await request(h, timedtext("&name=" + index));
  assert.equal(h.maps[0].size, 4);
  const raw = { events: Array.from({ length: 10_000 }, (_, index) => ({
    tStartMs: index * 50, dDurationMs: 50, aAppend: 0, wWinId: 1,
    segs: [{ utf8: "a", tOffsetMs: 0 }, { utf8: " b", tOffsetMs: 10 }, { utf8: " c", tOffsetMs: 20 }]
  })) };
  const text = JSON.stringify(raw);
  assert.ok(text.length < 2 * 1024 * 1024);
  const large = harness({ fetchImpl: () => Promise.resolve(new Response(text)) });
  for (let index = 0; index < 4; index++) await request(large, timedtext("&name=" + index));
  const records = [...large.maps[0].values()];
  assert.ok(records.length >= 1 && records.length < 4);
  assert.ok(records.reduce((total, record) => total + record.bytes, 0) <= 4 * 1024 * 1024);
  assert.equal(large.read().status, "ready");
});

test("an older same-track response cannot overwrite newer equally detailed content", async () => {
  const old = deferred(), newer = deferred();
  let call = 0;
  const h = harness({ fetchImpl: () => ++call === 1 ? old.promise : newer.promise });
  const first = h.context.fetch(timedtext()); const second = h.context.fetch(timedtext());
  const update = clone(fine); update.events[1].segs[0].utf8 = "New";
  newer.resolve(new Response(JSON.stringify(update))); await second; await flush();
  old.resolve(new Response(JSON.stringify(fine))); await first; await flush();
  assert.equal(h.read().captionTrack.events[0].segs[0].utf8, "New");
});

test("a failed observer side branch cannot create an unhandled rejection or break player reads", async () => {
  const h = harness();
  h.maps[0].set = () => { throw new Error("simulated private cache failure"); };
  const response = await h.context.fetch(timedtext());
  assert.deepEqual(await response.json(), fine);
  await flush();
  assert.deepEqual(h.read(), { status: "not_observed" });
  const reject = new Error("player rejected");
  const failed = harness({ fetchImpl: () => Promise.reject(reject) });
  failed.maps[0].set = h.maps[0].set;
  await assert.rejects(failed.context.fetch(timedtext()), (error) => error === reject);
  await flush();
});

test("readiness needs nonempty text offsets; strict millisecond/event limits remain unchanged", async () => {
  const whitespaceOnlyOffset = { events: [...coarse.events, { tStartMs: 1500, segs: [{ utf8: "\n", tOffsetMs: 0 }] }] };
  const h = harness({ fetchImpl: () => Promise.resolve(new Response(JSON.stringify(whitespaceOnlyOffset))) });
  await request(h); assert.equal(h.read().status, "no_word_offsets");
  for (const patch of [{ tStartMs: 1.5 }, { tStartMs: 604800001 }, { dDurationMs: -1 }, { wWinId: 1.5 },
    { segs: [{ utf8: "x", tOffsetMs: "10" }] }, { segs: [{ utf8: "x", tOffsetMs: 604800001 }] }]) {
    const value = { events: [{ tStartMs: 0, segs: [{ utf8: "x" }], ...patch }] };
    const h = harness({ fetchImpl: () => Promise.resolve(new Response(JSON.stringify(value))) });
    await request(h); assert.equal(h.read().status, "invalid_response");
  }
  const tooMany = harness({ fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ events: Array.from({ length: 10001 }, () => coarse.events[0]) }))) });
  await request(tooMany); assert.equal(tooMany.read().status, "response_too_large");
});

test("XHR request identity is captured at send and reused instances cannot inherit old load handlers", () => {
  const h = harness(); const value = new h.context.XMLHttpRequest();
  value.open("GET", timedtext());
  h.move(other); value.send(); value.complete();
  assert.equal(h.read(other).status, "not_observed");
  h.move(video); value.open("GET", timedtext()); value.send();
  value.onload = () => { value.onload = null; value.open("GET", timedtext("&name=second")); value.send(); };
  value.complete(fine);
  assert.equal(h.read().status, "not_observed", "reusing XHR inside an earlier handler drops the old observation");
  value.complete(coarse);
  assert.equal(h.read().status, "no_word_offsets");
  assert.equal(value.count(), 0);
});

test("pending XHR metadata is bounded and pagehide removes listeners without aborting requests", () => {
  const h = harness(); const values = Array.from({ length: 8 }, (_, index) => xhr(h, timedtext("&name=" + index)));
  assert.equal(values.filter((value) => value.count() > 0).length, 4);
  h.events.emit("pagehide");
  assert.ok(values.every((value) => value.count() === 0 && value.aborts === 0));
});

test("late installation observes only subsequent requests and does not replace another nonwritable hook", async () => {
  let earlierCalls = 0;
  const h = harness({ beforeInstall: (context) => { context.fetch(timedtext()); earlierCalls++; } });
  await flush(); assert.equal(h.read().status, "not_observed");
  assert.equal(earlierCalls, 1);
  await request(h); assert.equal(h.read().status, "ready");
  const fixed = harness({ beforeInstall: (context) => Object.defineProperty(context, "fetch", { value: context.fetch, writable: false }) });
  assert.equal(fixed.context.fetch, fixed.originalFetch);
  const value = xhr(fixed); value.complete();
  assert.equal(fixed.read().status, "ready", "XHR still works when fetch belongs to a nonwritable wrapper");
});
