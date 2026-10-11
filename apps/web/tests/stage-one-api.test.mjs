import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, mock, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { annotateTranscriptLine, readProcessingJob, waitForJob, assertReadyJob, readLearningBlueprint, readContentContext, ensureContentProcessing } from "../features/stage-one/api/stage-one-api.ts";
import { selectCorpusItems } from "@libitu/core/stage-one";
import { buildSentenceUnits } from "../features/stage-two/sentences.ts";

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
const blueprint = (items = [candidate(1)], segments) => ({
  id: "blueprint", content_id: source.contentId, title: source.title, source_url: source.sourceUrl,
  summary: "A test summary.", chapters: ["Opening"],
  logic_flow: [{ id: "logic-1", title: "Framing the idea", subtitle: "An explanation.", time: "0:01" }],
  corpus_items: items.map((item, index) => ({
    ...item, id: `server-id-${index + 50}`, text: item.kind === "structure" ? item.text : `"${item.text}" - ${item.meaning}`,
    meta: "0:01 - B1 - click + to save"
  })),
  transcript: [{ time: "0:01", parts: ["A useful expression 1."] }],
  ...(segments === undefined ? {} : { segments })
});
const response = (body) => new Response(JSON.stringify(body), { status: 200 });

// Exercise the transport chain with an explicit observed job. Entry resolution and
// retry policy are covered by content-workspace.test.mjs, not a legacy loader.
async function observeBlueprint(source, onProgress, options = {}) {
  const initial = await readProcessingJob(source.jobId, options.signal);
  const complete = await waitForJob(initial, onProgress, value => {
    const corpusItems = selectCorpusItems(value.corpusItems, source.learnerLevel);
    options.onPreview?.({ ...value, corpusItems,
      transcriptLines: value.transcriptLines.map(line => annotateTranscriptLine(line, corpusItems)) });
  }, options.signal);
  assertReadyJob(complete);
  return readLearningBlueprint(source, options.signal);
}

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

test("content context is a no-store GET and never ensures a job", async () => {
  const context = JSON.parse(readFileSync(new URL("../../../packages/types/fixtures/content-context.json", import.meta.url)));
  fetch.mock.mockImplementation(async (url, init) => {
    assert.match(url, /\/api\/content\/test-content$/);
    assert.equal(init.cache, "no-store");
    assert.equal(init.method, undefined);
    return response(context);
  });
  assert.deepEqual(await readContentContext(source.contentId), context);
  assert.equal(fetch.mock.callCount(), 1);
});

test("new ensure sends false and lost explicit retries reuse the observed attempt", async () => {
  const bodies = [];
  fetch.mock.mockImplementation(async (_url, init) => { bodies.push(JSON.parse(init.body)); return response(job("failed")); });
  await ensureContentProcessing(source.contentId);
  const observed = { id: source.jobId, content_id: source.contentId, analysis_version: "v1", status: "failed", attempt_count: 4 };
  await ensureContentProcessing(source.contentId, observed);
  await ensureContentProcessing(source.contentId, observed);
  assert.deepEqual(bodies, [
    { content_id: source.contentId, retry_failed: false },
    { content_id: source.contentId, retry_failed: true, expected_attempt_count: 4 },
    { content_id: source.contentId, retry_failed: true, expected_attempt_count: 4 },
  ]);
  await assert.rejects(ensureContentProcessing("other", observed), /Reload the failed/);
  assert.equal(fetch.mock.callCount(), 3);
});

test("content context rejects a task from another content or analysis version", async () => {
  fetch.mock.mockImplementation(async () => response({ content: { content_id: source.contentId }, processing: {
    analysis_version: "current", job: { content_id: source.contentId, analysis_version: "old" }
  } }));
  await assert.rejects(readContentContext(source.contentId), /changed identity/);
});

test("a job response cannot substitute a different job for the same content", async () => {
  fetch.mock.mockImplementation(async () => response({ ...job("ready"), id: "other-job" }));
  const resolved = [];
  await assert.rejects(observeBlueprint(source, undefined, { onResolved: ids => resolved.push(ids) }), /changed identity/);
  assert.deepEqual(resolved, []);
  assert.equal(fetch.mock.callCount(), 1);
});

test("a stream identity conflict stops before publishing the changed preview or polling", async () => {
  fetch.mock.mockImplementation(async () => response(job()));
  const previews = [];
  const loading = observeBlueprint(source, undefined, { onPreview: value => previews.push(value) });
  const rejected = assert.rejects(loading, /different video/);
  await nextTurn();
  const stream = FakeEventSource.instances[0];
  const before = previews.length;
  stream.emit({ ...job(), content_id: "different-content" });
  await rejected;
  assert.equal(previews.length, before);
  assert.equal(stream.closed, true);
  assert.equal(fetch.mock.callCount(), 1);
});

test("a disposed load never starts a network request", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(observeBlueprint(source, undefined, { signal: controller.signal }), { name: "AbortError" });
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
  const loading = observeBlueprint(source, undefined, { signal: controller.signal });
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
  const loading = observeBlueprint(source, undefined, { signal: controller.signal, onPreview: (p) => previews.push(p) });
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
  const loading = observeBlueprint(source, undefined, { signal: controller.signal });
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
  const loading = observeBlueprint(source);
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
  await observeBlueprint(source, undefined, { onPreview: (p) => previews.push(p) });
  assert.equal(previews.length, 0);
  assert.equal(FakeEventSource.instances.length, 0);
  assert.equal(fetch.mock.callCount(), 2);
});

test("final blueprint maps playable segments and defaults legacy responses to an empty list", async () => {
  const segments = [{
    id: "segment-1",
    sequence: 1,
    title: "Opening context",
    summary: "The speaker establishes the context.",
    logic_node_id: "logic-1",
    timestamp_ms: 0,
    start_ms: 0,
    end_ms: 105000,
    duration_ms: 105000,
    transcript_start_index: 0,
    transcript_end_index: 4,
    source_text: "The speaker establishes the context.",
    quote: "The speaker establishes the context.",
    word_count: 6,
    phonology_tags: ["wk", "lk"],
    difficulty: "easy",
    recommended: true
  }];
  fetch.mock.mockImplementation(async (url) => response(url.includes("/blueprints/")
    ? blueprint([candidate(1)], segments) : job("ready")));

  const result = await observeBlueprint(source);

  assert.deepEqual(result.segments, [{
    id: "segment-1",
    sequence: 1,
    title: "Opening context",
    summary: "The speaker establishes the context.",
    logicNodeId: "logic-1",
    timestampMs: 0,
    startMs: 0,
    endMs: 105000,
    durationMs: 105000,
    transcriptStartIndex: 0,
    transcriptEndIndex: 4,
    sourceText: "The speaker establishes the context.",
    quote: "The speaker establishes the context.",
    wordCount: 6,
    phonologyTags: ["wk", "lk"],
    difficulty: "easy",
    recommended: true
  }]);
  assert.equal(fetch.mock.callCount(), 2);

  fetch.mock.mockImplementation(async (url) => response(url.includes("/blueprints/")
    ? blueprint() : job("ready")));
  const legacyResult = await observeBlueprint(source);
  assert.deepEqual(legacyResult.segments, []);
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
  const loading = observeBlueprint(source, undefined, { onPreview: (p) => previews.push(p) });
  await nextTurn();
  const stream = FakeEventSource.instances[0];
  stream.emit(job("processing", preview(items)));
  assert.equal(previews.length, 2, "transport delivers complete SSE snapshots");
  stream.emit(job("ready", null));
  const final = await loading;
  assert.equal(previews[0].corpusItems.length, 12);
  assert.deepEqual(previews[0].corpusItems.map((x) => x.id), final.corpusItems.map((x) => x.id));
  assert.deepEqual(previews[0].logicNodes, final.logicNodes);
  assert.deepEqual(previews[0].transcriptLines.map((x) => x.parts), final.transcript.map((x) => x.parts));
  assert.equal(stream.closed, true);
  stream.emit(job());
  assert.equal(previews.length, 2);
});

test("sentence metadata and text survive streamed preview, annotation reconstruction, finalization and Stage 2", async () => {
  const rows = [
    {
      id: "sentence-v2-source-0-9", segmentation_version: "sentence-v2",
      time: "0:01", text: "A useful expression 1. Even with a candidate stop.",
      source_token_start: 0, source_token_end: 10, start_ms: 1000.5, end_ms: 7800.25,
      boundary_source: "syntax_merge", boundary_confidence: "medium", timing_source: "caption_word_offsets",
      word_timings: [
        { source_token_index: 0, text: "A", start_ms: 1000.5, end_ms: 1150, start_source: "caption_offset",
          end_source: "next_word_estimate", source_event_index: 0, source_seg_index: 0 },
        { source_token_index: 1, text: "useful", start_ms: 1150, end_ms: null, start_source: "caption_offset",
          end_source: null, source_event_index: 0, source_seg_index: 1 }
      ]
    },
    {
      id: "sentence-v2-source-10-12", segmentation_version: "sentence-v2",
      time: "0:01", text: "We agree.",
      source_token_start: 10, source_token_end: 12, start_ms: 7800.25, end_ms: 9500,
      boundary_source: "source_punctuation", boundary_confidence: "high"
    }
  ];
  const streamed = { ...preview(), segmentation_version: "sentence-v2", transcript_lines: rows };
  const finished = {
    ...blueprint(), segmentation_version: "sentence-v2",
    transcript: rows.map(({ text, ...metadata }) => ({
      ...metadata,
      parts: [text]
    }))
  };
  fetch.mock.mockImplementation(async (url) => response(url.includes("/blueprints/")
    ? finished : job("processing", streamed)));
  const previews = [];
  const loading = observeBlueprint(source, undefined, { onPreview: (value) => previews.push(value) });
  await nextTurn();
  FakeEventSource.instances[0].emit(job("ready", null));
  const final = await loading;
  assert.equal(previews[0].segmentationVersion, "sentence-v2");
  assert.equal(final.segmentationVersion, "sentence-v2");
  assert.deepEqual(previews[0].transcriptLines, final.transcript);
  assert.equal(typeof final.transcript[0].parts[1], "object", "corpus highlight was reconstructed");
  const units = buildSentenceUnits(source.contentId, {
    id: "segment-1", startMs: 1000, endMs: 9500, transcriptStartIndex: 0, transcriptEndIndex: 2
  }, final.transcript);
  assert.equal(units.length, 2);
  rows.forEach((row, index) => {
    assert.equal(final.transcript[index].id, row.id);
    assert.equal(units[index].id, row.id);
    assert.equal(units[index].text, row.text);
    assert.equal(units[index].sourceTokenStart, row.source_token_start);
    assert.equal(units[index].sourceTokenEnd, row.source_token_end);
    assert.equal(units[index].startMs, row.start_ms);
    assert.equal(units[index].endMs, row.end_ms);
    assert.equal(units[index].boundarySource, row.boundary_source);
    assert.equal(units[index].boundaryConfidence, row.boundary_confidence);
    assert.deepEqual(units[index].wordTimings, final.transcript[index].wordTimings);
  });
  assert.equal(units[0].timingSource, "caption_word_offsets");
  assert.deepEqual(final.transcript[0].wordTimings[0], {
    sourceTokenIndex: 0, text: "A", startMs: 1000.5, endMs: 1150, startSource: "caption_offset",
    endSource: "next_word_estimate", sourceEventIndex: 0, sourceSegIndex: 0
  });
  assert.equal(final.transcript[0].wordTimings[1].endMs, null, "a missing end is not invented by either stage");
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

test("SSE omitted words inherit only from the same complete identity and explicit clears survive later omissions", async () => {
  const word = { source_token_index: 0, text: "Hello.", start_ms: 1000, end_ms: 1500,
    start_source: "caption_offset", end_source: "event_end_estimate", source_event_index: 0, source_seg_index: 0 };
  const row = { id: "sentence-v3-a", segmentation_version: "sentence-v3", time: "0:01", text: "Hello.",
    source_token_start: 0, source_token_end: 1, start_ms: 1000, end_ms: 1500,
    timing_source: "caption_word_offsets" };
  fetch.mock.mockImplementation(async (url) => response(url.includes("/blueprints/") ? blueprint()
    : job("processing", { ...preview(), transcript_lines: [] })));
  const previews = [];
  const loading = observeBlueprint(source, undefined, { onPreview: (value) => previews.push(value) });
  await nextTurn();
  const stream = FakeEventSource.instances[0];
  let output = 1;
  assert.equal(new URL(stream.url).searchParams.get("compact_word_timings"), "true");
  const emit = (line) => stream.emit(job("processing", { ...preview(), output_chars: output++, transcript_lines: [line] }));
  const latest = () => previews.at(-1).transcriptLines[0].wordTimings;
  emit({ ...row, word_timings: [word] });
  const expected = latest();
  emit(row);
  assert.deepEqual(latest(), expected);
  emit({ ...row, word_timings: null });
  assert.equal(latest(), undefined);
  emit(row);
  assert.equal(latest(), undefined);
  emit({ ...row, word_timings: [word] });
  emit({ ...row, word_timings: [] });
  assert.deepEqual(latest(), []);
  emit(row);
  assert.equal(latest(), undefined);
  for (const change of [{ id: "sentence-v3-b" }, { segmentation_version: "sentence-v4" },
    { text: "Goodbye." }, { source_token_start: 1, source_token_end: 2 }, { timing_source: "caption_event_estimate" }]) {
    emit({ ...row, word_timings: [word] });
    emit({ ...row, ...change });
    assert.equal(latest(), undefined, `changed identity never inherits: ${JSON.stringify(change)}`);
  }
  emit({ ...row, word_timings: [word] });
  stream.emit(job("ready", null));
  const final = await loading;
  assert.equal(final.transcript[0].wordTimings, undefined, "final blueprint is authoritative, not merged with SSE");
});

test("aborted/reconnected loads cannot reuse another connection's word timing cache", async () => {
  const row = { id: "sentence-v3-a", segmentation_version: "sentence-v3", time: "0:01", text: "Hello.",
    source_token_start: 0, source_token_end: 1, start_ms: 1000, end_ms: 1500, timing_source: "caption_word_offsets" };
  const full = { ...row, word_timings: [{ source_token_index: 0, text: "Hello.", start_ms: 1000, end_ms: 1500,
    start_source: "caption_offset", end_source: "event_end_estimate", source_event_index: 0, source_seg_index: 0 }] };
  fetch.mock.mockImplementation(async (url) => response(url.includes("/blueprints/") ? blueprint()
    : job("processing", { ...preview(), transcript_lines: [] })));
  const abort = new AbortController();
  const first = observeBlueprint(source, undefined, { signal: abort.signal, onPreview() {} });
  await nextTurn();
  FakeEventSource.instances[0].emit(job("processing", { ...preview(), transcript_lines: [full] }));
  const rejected = assert.rejects(first, { name: "AbortError" });
  abort.abort();
  await rejected;
  const previews = [];
  const second = observeBlueprint(source, undefined, { onPreview: (value) => previews.push(value) });
  await nextTurn();
  const fresh = FakeEventSource.instances[1];
  fresh.emit(job("processing", { ...preview(), transcript_lines: [row] }));
  assert.equal(previews.at(-1).transcriptLines[0].wordTimings, undefined);
  fresh.emit(job("processing", { ...preview(), transcript_lines: [full] }));
  assert.equal(previews.at(-1).transcriptLines[0].wordTimings.length, 1, "reconnection's first complete snapshot restores words");
  fresh.emit(job("ready", null));
  await second;
});

test("compact SSE restores every word row through the API's 2000-row preview maximum", async () => {
  const rows = Array.from({ length: 2000 }, (_, index) => ({
    id: `sentence-v3-large-${index}`, segmentation_version: "sentence-v3", time: "0:01", text: `Word${index}.`,
    source_token_start: index, source_token_end: index + 1,
    start_ms: 1000 + index * 1000, end_ms: 1500 + index * 1000, timing_source: "caption_word_offsets",
    word_timings: [{ source_token_index: index, text: `Word${index}.`, start_ms: 1000 + index * 1000,
      end_ms: 1500 + index * 1000, start_source: "caption_offset", end_source: "event_end_estimate",
      source_event_index: index, source_seg_index: 0 }]
  }));
  fetch.mock.mockImplementation(async (url) => response(url.includes("/blueprints/") ? blueprint()
    : job("processing", { ...preview(), transcript_lines: [] })));
  const previews = [];
  const loading = observeBlueprint(source, undefined, { onPreview: (value) => previews.push(value) });
  await nextTurn();
  const stream = FakeEventSource.instances[0];
  stream.emit(job("processing", { ...preview(), output_chars: 1, transcript_lines: rows }));
  const full = previews.at(-1).transcriptLines;
  stream.emit(job("processing", { ...preview(), output_chars: 2,
    transcript_lines: rows.map((row) => {
      const compact = { ...row };
      delete compact.word_timings;
      return compact;
    }) }));
  const compact = previews.at(-1).transcriptLines;
  assert.equal(compact.length, 2000);
  assert.equal(compact[1000].wordTimings?.[0].sourceTokenIndex, 1000, "row 1001 survives field omission");
  assert.equal(compact[1999].wordTimings?.[0].sourceTokenIndex, 1999, "the last allowed preview row survives field omission");
  assert.deepEqual(compact, full);
  stream.emit(job("ready", null));
  await loading;
});

test("polling fallback is a complete snapshot and cannot inherit compact SSE words", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const row = { id: "sentence-v3-a", segmentation_version: "sentence-v3", time: "0:01", text: "Hello.",
    source_token_start: 0, source_token_end: 1, start_ms: 1000, end_ms: 1500, timing_source: "caption_word_offsets" };
  let reads = 0;
  fetch.mock.mockImplementation(async (url) => response(url.includes("/blueprints/") ? blueprint()
    : job(++reads === 1 ? "processing" : "ready", { ...preview(), transcript_lines: [row] })));
  const previews = [];
  const loading = observeBlueprint(source, undefined, { onPreview: (value) => previews.push(value) });
  await nextTurn();
  const stream = FakeEventSource.instances[0];
  stream.emit(job("processing", { ...preview(), transcript_lines: [{ ...row, word_timings: [{
    source_token_index: 0, text: "Hello.", start_ms: 1000, end_ms: 1500,
    start_source: "caption_offset", end_source: "event_end_estimate", source_event_index: 0, source_seg_index: 0
  }] }] }));
  assert.equal(previews.at(-1).transcriptLines[0].wordTimings.length, 1);
  stream.onerror();
  await nextTurn();
  assert.equal(previews.at(-1).transcriptLines[0].wordTimings, undefined);
  mock.timers.tick(1500);
  await loading;
});


test("cached captions clean cues across parts before annotation", async () => {
  const cached = blueprint();
  cached.transcript = [{ id: "existing-sentence", time: "0:21", parts: [">> A [clears ", "throat] useful expression 1."], word_timings: [{source_token_index: 0, text: "clears", start_ms: 21000}] }];
  fetch.mock.mockImplementation(async (url) => response(String(url).includes("/blueprints/") ? cached : job("ready")));
  const result = await observeBlueprint(source);
  assert.equal(result.transcript[0].parts.map(part => typeof part === "string" ? part : part.text).join(""), "A useful expression 1.");
  assert.equal(result.transcript[0].id, "existing-sentence");
  assert.equal(result.transcript[0].time, "0:21");
  assert.equal(result.transcript[0].wordTimings, undefined);
});


test("saved source wording annotates independently of edited card text and preserves caption metadata", () => {
  const line = { id: "sentence-1", time: "0:01", startMs: 1000, endMs: 4000,
    sourceTokenStart: 0, wordTimings: [{ sourceTokenIndex: 0, text: "Keep" }],
    parts: ["Keep an eye on the plan."] };
  const item = { id: "manual-1", kind: "structure", text: "Keep an eye on [something]",
    sourceText: "Keep an eye on", tags: ["framing"], meta: "0:01" };
  const annotated = annotateTranscriptLine(line, [item]);
  assert.deepEqual(annotated.parts, [{ text: "Keep an eye on", kind: "structure", tag: "framing", corpusItemId: "manual-1" }, " the plan."]);
  assert.equal(annotated.wordTimings, line.wordTimings);
  assert.equal(annotated.id, line.id);
  assert.equal(annotated.startMs, line.startMs);
  assert.deepEqual(annotateTranscriptLine(annotated, []).parts, line.parts);
});


test("annotations link exact source wording to a card without fragment or inside-word matches", () => {
  const item = { id: "card-1", kind: "structure", text: "What matters is [priority]",
    sourceText: "What matters is how we respond", tags: ["framing"] };
  const annotate = (text, entry = item) => annotateTranscriptLine({ time: "0:01", parts: [text] }, [entry]).parts;
  assert.deepEqual(annotate("What matters is the price."), ["What matters is the price."]);
  assert.equal(annotate("What matters is how we respond.")[0].corpusItemId, "card-1");
  assert.deepEqual(annotate("They planned it.", { ...item, sourceText: "plan" }), ["They planned it."]);
});

test("ready blueprint must belong to the requested content and source", async () => {
  let result = { ...blueprint(), content_id: "another-content" };
  mock.method(globalThis, "fetch", async () => response(result));
  const contentOnly = { ...source, jobId: undefined };
  await assert.rejects(readLearningBlueprint(contentOnly), /does not match/);
  result = { ...blueprint(), source_url: "https://www.youtube.com/watch?v=another0001" };
  await assert.rejects(readLearningBlueprint(contentOnly), /does not match/);
});
