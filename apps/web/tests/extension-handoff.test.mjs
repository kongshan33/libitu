import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { readExtensionTranscript } from "../features/stage-one/api/extension-handoff.ts";
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
  reply({ phase: "ready", transcriptText: "0:01\tFrom the browser." });
  assert.equal((await loading).contentId, "content");
  assert.equal(calls[0][1].transcript_text, "0:01\tFrom the browser.");
  assert.deepEqual(calls.map(([path]) => path), ["/api/content/resolve", "/api/jobs", "/api/blueprints/content"]);
  assert.deepEqual(resolved, [{ contentId: "content", jobId: "job" }]);
});
