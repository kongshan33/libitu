import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { loadStageOneBlueprint } from "../features/stage-one/api/stage-one-api.ts";
import { selectCorpusItems } from "@libitu/core/stage-one";

const source = {
  kind: "youtube", sourceUrl: "https://www.youtube.com/watch?v=test-video",
  title: "Test video", contentId: "test-content", jobId: "test-job", learnerLevel: "B1"
};
const candidate = (index, kind = "chunk") => ({
  kind, text: `useful expression ${index}`, source_text: `useful expression ${index}`,
  meaning: "A useful expression.", tags: ["framing"], timestamp: "0:01", level: "B1",
  naturalness_score: 4, transferability_score: 4, learning_value_score: 4
});
const preview = (items = [candidate(1)]) => ({
  output_chars: 1234, summary: "A test summary.", chapters: ["Opening"],
  logic_flow: [{ title: "Framing the idea", subtitle: "An explanation.", timestamp: "0:01" }],
  corpus_items: items, transcript_lines: [{ time: "0:01", text: "A useful expression 1." }]
});
const job = (status = "processing", analysis = preview()) => ({
  id: source.jobId, content_id: source.contentId, status, analysis_version: "mvp-v6",
  blueprint_id: status === "ready" ? "blueprint" : null,
  processing_stage: status === "ready" ? "completed" : "analyzing",
  error_message: null, analysis_preview: analysis
});
const blueprint = (items = [candidate(1)]) => ({
  id: "blueprint", content_id: source.contentId, title: source.title, source_url: source.sourceUrl,
  summary: "A test summary.", chapters: ["Opening"],
  logic_flow: [{ id: "logic-1", title: "Framing the idea", subtitle: "An explanation.", time: "0:01" }],
  corpus_items: items.map((item, index) => ({
    ...item, id: `server-id-${index + 50}`, text: item.kind === "structure" ? item.text : `"${item.text}" - ${item.meaning}`,
    meta: "0:01 - B1 - click + to save"
  })),
  transcript: [{ time: "0:01", parts: ["A useful expression 1."] }]
});
const response = (body) => new Response(JSON.stringify(body), { status: 200 });

class FakeEventSource extends EventTarget {
  static instances = [];
  closed = false;
  onerror = null;
  constructor(url) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  emit(body) {
    this.dispatchEvent(Object.assign(new Event("job"), { data: JSON.stringify(body) }));
  }
  close() { this.closed = true; }
}

beforeEach(() => {
  globalThis.window = globalThis;
  globalThis.EventSource = FakeEventSource;
  FakeEventSource.instances = [];
  mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request"); });
});
afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  delete globalThis.window;
  delete globalThis.EventSource;
});

test("a disposed load never starts a network request", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadStageOneBlueprint(source, undefined, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(FakeEventSource.instances.length, 0);
});

test("aborting an in-flight request reaches fetch", async () => {
  let requestSignal;
  fetch.mock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    requestSignal = init.signal;
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const loading = loadStageOneBlueprint(source, undefined, { signal: controller.signal });
  const rejected = assert.rejects(loading, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(requestSignal.aborted, true);
  assert.equal(fetch.mock.callCount(), 1);
});

test("aborting SSE closes it without starting polling or accepting late events", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  fetch.mock.mockImplementation(async () => response(job()));
  const controller = new AbortController();
  const previews = [];
  const loading = loadStageOneBlueprint(source, undefined, { signal: controller.signal, onPreview: (p) => previews.push(p) });
  await nextTurn();
  const stream = FakeEventSource.instances[0];
  const rejected = assert.rejects(loading, { name: "AbortError" });
  controller.abort();
  await rejected;
  stream.emit(job("processing", { ...preview(), summary: "A late response" }));
  mock.timers.tick(5000);
  await nextTurn();
  assert.equal(stream.closed, true);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(previews.length, 1);
});

test("a genuine SSE error falls back to polling, whose delay is cancellable", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  fetch.mock.mockImplementation(async () => response(job()));
  const controller = new AbortController();
  const loading = loadStageOneBlueprint(source, undefined, { signal: controller.signal });
  await nextTurn();
  const stream = FakeEventSource.instances[0];
  stream.onerror();
  await nextTurn();
  assert.equal(stream.closed, true);
  const rejected = assert.rejects(loading, { name: "AbortError" });
  controller.abort();
  await rejected;
  mock.timers.tick(5000);
  await nextTurn();
  assert.equal(fetch.mock.callCount(), 1);
});

test("SSE failure still completes through polling when not cancelled", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let jobReads = 0;
  fetch.mock.mockImplementation(async (url) => response(url.includes("/blueprints/")
    ? blueprint() : job(++jobReads === 1 ? "processing" : "ready", null)));
  const loading = loadStageOneBlueprint(source);
  await nextTurn();
  FakeEventSource.instances[0].onerror();
  await nextTurn();
  mock.timers.tick(1500);
  const result = await loading;
  assert.equal(result.id, "blueprint");
  assert.equal(jobReads, 2);
});

test("cached ready jobs skip stale previews and never open SSE", async () => {
  const previews = [];
  fetch.mock.mockImplementation(async (url) => response(url.includes("/blueprints/") ? blueprint() : job("ready")));
  await loadStageOneBlueprint(source, undefined, { onPreview: (p) => previews.push(p) });
  assert.equal(previews.length, 0);
  assert.equal(FakeEventSource.instances.length, 0);
  assert.equal(fetch.mock.callCount(), 2);
});

test("preview and final result share identities, selected order, and annotations", async () => {
  const items = [
    ...Array.from({ length: 8 }, (_, i) => candidate(i)),
    ...Array.from({ length: 3 }, (_, i) => candidate(i + 8, "idiom")),
    ...Array.from({ length: 5 }, (_, i) => candidate(i + 11, "structure"))
  ];
  // Equal scores: 6 chunks, 2 idioms, 4 structures, preserving provider order.
  const selected = [...items.slice(0, 6), ...items.slice(8, 10), ...items.slice(11, 15)];
  fetch.mock.mockImplementation(async (url) => response(url.includes("/blueprints/")
    ? blueprint(selected) : job("processing", preview(items))));
  const previews = [];
  const loading = loadStageOneBlueprint(source, undefined, { onPreview: (p) => previews.push(p) });
  await nextTurn();
  const stream = FakeEventSource.instances[0];
  stream.emit(job("processing", preview(items)));
  assert.equal(previews.length, 1, "identical SSE snapshots do not trigger another preview render");
  stream.emit(job("ready", null));
  const final = await loading;
  assert.equal(previews[0].corpusItems.length, 12);
  assert.deepEqual(previews[0].corpusItems.map((x) => x.id), final.corpusItems.map((x) => x.id));
  assert.deepEqual(previews[0].logicNodes, final.logicNodes);
  assert.deepEqual(previews[0].transcriptLines.map((x) => x.parts), final.transcript.map((x) => x.parts));
  assert.equal(stream.closed, true);
  stream.emit(job());
  assert.equal(previews.length, 1);
});

test("ranking follows learner level without modifying the source pool", () => {
  const items = ["B1", "B2", "C1"].flatMap((level) => ["chunk", "structure"].map((kind) => ({
    id: `${kind}-${level}`, kind, level, text: kind, tags: [], meta: "",
    naturalnessScore: 3, transferabilityScore: 3, learningValueScore: 3
  })));
  assert.deepEqual(selectCorpusItems(items, "B1", 4).map((x) => x.level), ["B1", "B1", "B2", "B2"]);
  assert.deepEqual(selectCorpusItems(items, "C1", 4).map((x) => x.level), ["C1", "C1", "B2", "B2"]);
  assert.equal(items[0].level, "B1");
});
