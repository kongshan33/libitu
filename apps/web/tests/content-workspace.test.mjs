import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { loadContentWorkspace } from "../features/learning-workspace/controller.ts";

const source = { kind: "youtube", sourceUrl: "https://www.youtube.com/watch?v=loadout1234", title: "Old title", contentId: "content", learnerLevel: "B1" };
const job = (status = "ready", count = 1) => ({ id: "job", content_id: "content", status, analysis_version: "v1", attempt_count: count, blueprint_id: "bp", error_message: "Analysis failed" });
const context = (available, current = job()) => ({ content: { content_id: "content", source_url: source.sourceUrl, title: "Current title", language: "en", kind: "youtube" }, processing: { analysis_version: "v1", blueprint_available: available, job: current } });
const blueprint = { id: "bp", content_id: "content", source_url: source.sourceUrl, title: "Current title", summary: "Summary", logic_flow: [], chapters: [], corpus_items: [], transcript: [], segments: [] };
let requests;
const response = body => new Response(JSON.stringify(body));
function network(ctx, custom = () => undefined) {
  fetch.mock.mockImplementation(async (url, init) => {
    const path = new URL(url).pathname;
    requests.push({ path, body: init.body && JSON.parse(init.body) });
    const special = custom(path, init);
    if (special) return special;
    if (path === "/api/content/content") return response(ctx);
    if (path === "/api/jobs/job") return response(ctx.processing.job ?? job());
    if (path === "/api/blueprints/content") return response(blueprint);
    throw new Error(`Unexpected ${path}`);
  });
}
const options = extra => ({ signal: new AbortController().signal, ...extra });
beforeEach(() => { globalThis.window = globalThis; requests = []; mock.method(globalThis, "fetch", () => { throw new Error("No fixture"); }); });
afterEach(() => { mock.restoreAll(); delete globalThis.window; });

test("available blueprint wins over failed job; metadata is authoritative; GET activation has no writes", async () => {
  network(context(true, job("failed")));
  let resolved;
  const result = await loadContentWorkspace(source, options({ onSource: value => resolved = value }));
  assert.equal(result.contentId, "content"); assert.equal(resolved.title, "Current title");
  assert.deepEqual(requests.map(r => r.path), ["/api/content/content", "/api/blueprints/content"]);
});
test("opening a failed job does not retry it", async () => {
  network(context(false, job("failed", 4)));
  let observed;
  await assert.rejects(loadContentWorkspace(source, options({ onJob: value => observed = value })), /Analysis failed/);
  assert.equal(observed.attempt_count, 4); assert.ok(requests.every(r => !r.body));
});
test("missing work is ensured once with false; immediate ready is handled", async () => {
  network(context(false, null), path => path === "/api/jobs" ? response(job()) : undefined);
  await loadContentWorkspace(source, options());
  assert.deepEqual(requests.filter(r => r.body).map(r => r.body), [{ content_id: "content", retry_failed: false }]);
});
test("explicit retry carries the observed generation and surfaces immediate failure", async () => {
  network(context(false, job("failed", 5)), path => path === "/api/jobs" ? response(job("failed", 5)) : undefined);
  let accepted = 0, observed;
  await assert.rejects(loadContentWorkspace(source, options({ retry: job("failed", 4), onRetryAccepted: () => accepted++, onJob: value => observed = value })), /Analysis failed/);
  assert.equal(accepted, 1); assert.equal(observed.attempt_count, 5);
  assert.deepEqual(requests.find(r => r.body).body, { content_id: "content", retry_failed: true, expected_attempt_count: 4 });
});
test("a lost retry response can be replayed with its original count after another failure", async () => {
  network(context(false, job("failed", 7)), path => path === "/api/jobs" ? Promise.reject(new TypeError("offline")) : undefined);
  let acknowledged = false;
  const opts = options({ retry: job("failed", 6), onRetryAccepted: () => acknowledged = true });
  await assert.rejects(loadContentWorkspace(source, opts), /offline/);
  assert.equal(acknowledged, false);
  network(context(false, job("failed", 7)), path => path === "/api/jobs" ? response(job("failed", 7)) : undefined);
  await assert.rejects(loadContentWorkspace(source, opts), /Analysis failed/);
  assert.deepEqual(requests.filter(r => r.body).map(r => r.body.expected_attempt_count), [6, 6]);
});
test("ready but missing blueprint is bounded and never creates processing", async () => {
  network(context(true), path => path.startsWith("/api/blueprints") ? new Response('{"detail":"Not published"}', { status: 404 }) : undefined);
  await assert.rejects(loadContentWorkspace(source, options()), /Not published/);
  assert.equal(requests.filter(r => r.path.startsWith("/api/blueprints")).length, 3);
  assert.ok(requests.every(r => !r.body));
});
test("source and job conflicts stop before publishing content or ensuring work", async () => {
  network(context(false, null));
  let published = false;
  await assert.rejects(loadContentWorkspace({ ...source, sourceUrl: "https://youtu.be/abcdefghijk" }, options({ onSource: () => published = true })), /does not match/);
  assert.equal(published, false); assert.ok(requests.every(r => !r.body));
  network(context(false), path => path === "/api/jobs/job" ? response({ ...job(), content_id: "other" }) : undefined);
  await assert.rejects(loadContentWorkspace(source, options()), /changed identity/);
});
test("workspace rejects unresolved imports and job-only input without requests", async () => {
  network(context(true));
  for (const input of [{ kind: "youtube", sourceUrl: source.sourceUrl, title: "" }, { jobId: "job" }]) {
    await assert.rejects(loadContentWorkspace(input, options()), /Open a content page/);
  }
  assert.equal(requests.length, 0);
});
test("already aborted activation sends no requests", async () => {
  network(context(false, null));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadContentWorkspace(source, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(requests.length, 0);
});

test("late content reads after cancellation cannot publish a source or start processing", async () => {
  let finish;
  fetch.mock.mockImplementation(() => new Promise(resolve => finish = resolve));
  const abort = new AbortController(); let published = 0;
  const loading = loadContentWorkspace(source, { signal: abort.signal, onSource: () => published++ });
  abort.abort(); finish(response(context(false, null)));
  await assert.rejects(loading, { name: "AbortError" });
  assert.equal(published, 0); assert.equal(fetch.mock.callCount(), 1);
});

