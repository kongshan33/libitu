import assert from "node:assert/strict";
import test from "node:test";
import { buildSentenceUnits, sentenceAtTime } from "../features/stage-two/sentences.ts";
import { readStageTwoLocation, stageTwoLocation } from "../features/stage-two/location.ts";

const segment = { id: "segment-1", startMs: 1000, endMs: 17000, transcriptStartIndex: 0, transcriptEndIndex: 3 };
const transcript = [
  { time: "0:01", parts: ["First sentence. Second sentence!"] },
  { time: "0:09", parts: ["The next sentence"] },
  { time: "0:13", parts: ["continues here."] }
];

const sharedRow = (id, text, sourceTokenStart, startMs, endMs) => ({
  id,
  time: "0:01",
  parts: [text],
  segmentationVersion: "sentence-v2",
  sourceTokenStart,
  sourceTokenEnd: sourceTokenStart + text.split(/\s+/).length,
  startMs,
  endMs,
  boundarySource: "syntax_merge",
  boundaryConfidence: "medium"
});

test("shared server rows preserve full text, identity, source ranges and timing across both stages", () => {
  const longSentence = `Dr. Smith asked, \"Really?\" ${"We can keep reading, ".repeat(25)}and we finally agreed.`;
  const rows = [
    sharedRow("sentence-v2-source-a-0-110", longSentence, 0, 1000.25, 24000.75),
    sharedRow("sentence-v2-source-a-110-111", "Yes.", 110, 24000.75, 27000),
    sharedRow("sentence-v2-source-a-111-112", "Yes.", 111, 27000, 29000)
  ];
  // The row range is authoritative even if an older duration estimate ends mid-sentence.
  const selectedSegment = { ...segment, transcriptEndIndex: 3, endMs: 17000 };
  const units = buildSentenceUnits("content-1", selectedSegment, rows);
  assert.equal(units.length, rows.length);
  rows.forEach((line, index) => {
    const unit = units[index];
    assert.equal(unit.id, line.id);
    assert.equal(unit.text, line.parts.join(""));
    assert.equal(unit.sourceTokenStart, line.sourceTokenStart);
    assert.equal(unit.sourceTokenEnd, line.sourceTokenEnd);
    assert.equal(unit.startMs, line.startMs);
    assert.equal(unit.endMs, line.endMs);
    assert.equal(unit.segmentationVersion, line.segmentationVersion);
    assert.equal(unit.boundarySource, line.boundarySource);
    assert.equal(unit.boundaryConfidence, line.boundaryConfidence);
    assert.equal(unit.timingConfidence, "approximate");
  });
  assert.equal(new Set(units.map((unit) => unit.id)).size, 3);
  assert.equal(sentenceAtTime(units, 24000.75)?.id, rows[1].id);
  assert.equal(sentenceAtTime(units, 27000)?.id, rows[2].id);
});

test("server sentence identity survives different segments and URL recovery", () => {
  const row = sharedRow("sentence-v2-source-b-38-43", "We have reached an agreement.", 38, 5000, 8000);
  row.parts = ["We have ", { text: "reached an agreement", kind: "chunk", tag: "framing" }, "."];
  const first = buildSentenceUnits("content-1", { ...segment, transcriptEndIndex: 1 }, [row])[0];
  const second = buildSentenceUnits("content-1", { ...segment, id: "segment-2", transcriptEndIndex: 1 }, [row])[0];
  assert.equal(first.id, second.id);
  assert.equal(first.text, "We have reached an agreement.");
  assert.equal(first.sourceTokenStart, 38);
  const url = stageTwoLocation(new URL("https://libitu.test/?contentId=c&jobId=j"), {
    segmentId: second.segmentId, sentenceId: second.id
  });
  const restored = readStageTwoLocation(new URL(url.href));
  assert.equal(restored.sentenceId, row.id);
  assert.equal(restored.segmentId, "segment-2");
});

test("partial and mixed sentence metadata falls back to whole rows without punctuation splitting", () => {
  const complete = sharedRow("sentence-v2-source-c-0-2", "First thought.", 0, 1000, 5000);
  const incomplete = { ...sharedRow("sentence-v2-source-c-2-7", "Dr. Smith said, \"Yes!\"", 2, 5000, 9000) };
  delete incomplete.sourceTokenEnd;
  delete incomplete.endMs;
  const mixed = { time: "0:09", parts: ["Still whole. Despite missing metadata."] };
  const units = buildSentenceUnits("content-1", segment, [complete, incomplete, mixed]);
  assert.deepEqual(units.map((unit) => unit.text), [
    "First thought.", "Dr. Smith said, \"Yes!\"", "Still whole. Despite missing metadata."
  ]);
  assert.equal(units[0].boundaryConfidence, "medium");
  assert.equal(units[1].boundaryConfidence, "low");
  assert.equal(units[1].endMs, 9000);
  assert.equal(units[1].sourceTokenStart, 2);
  assert.equal(units[1].sourceTokenEnd, 6);
  assert.equal(units[2].sourceTokenStart, 6);
  assert.ok(units.every((unit) => unit.endMs > unit.startMs));
});

test("versioned invalid bounds and duplicate IDs recover safely without creating child sentences", () => {
  const rows = [
    sharedRow("duplicate", "Same. Full row.", 0, 1000, 5000),
    { ...sharedRow("duplicate", "Same. Full row.", 3, 5000, 9000), startMs: NaN, endMs: -1, time: "0:05" }
  ];
  const units = buildSentenceUnits("content-1", { ...segment, transcriptEndIndex: 2 }, rows);
  assert.equal(units.length, 2);
  assert.notEqual(units[0].id, units[1].id);
  assert.equal(units[1].boundaryConfidence, "low");
  assert.deepEqual(units.map((unit) => unit.text), rows.map((row) => row.parts.join("")));
  assert.deepEqual(buildSentenceUnits("content-1", { ...segment, transcriptEndIndex: 2 }, rows), units);
});

test("splits multiple sentences in a caption and joins continuations across captions", () => {
  const sentences = buildSentenceUnits("content-1", segment, transcript);
  assert.deepEqual(sentences.map((s) => s.text), ["First sentence.", "Second sentence!", "The next sentence continues here."]);
  assert.deepEqual(sentences.map((s) => [s.startMs, s.endMs]), [[1000, 5000], [5000, 9000], [9000, 17000]]);
  assert.deepEqual(sentences[2].transcriptStartIndex, 1);
  assert.deepEqual(sentences[2].transcriptEndIndex, 3);
  assert.ok(sentences.every((s) => s.timingSource === "caption_estimate" && s.timingConfidence === "approximate"));
});

test("same-timestamp rows and missing timing retain text and get positive, ordered intervals", () => {
  const rows = [
    { time: "0:01", parts: ["Yes."] },
    { time: "0:01", parts: ["Yes."] },
    { time: "unavailable", parts: ["Another thought."] }
  ];
  const sentences = buildSentenceUnits("content-1", segment, rows);
  assert.equal(sentences.length, 3);
  assert.equal(new Set(sentences.map((s) => s.id)).size, 3);
  assert.ok(sentences.every((s, i) => s.endMs > s.startMs && (i === 0 || s.startMs === sentences[i - 1].endMs)));
  assert.equal(sentences.at(-1).endMs, segment.endMs);
});

test("IDs survive reloads and unrelated metadata, but invalidate changed source/timing", () => {
  const original = buildSentenceUnits("content-1", segment, transcript);
  assert.deepEqual(buildSentenceUnits("content-1", { ...segment, title: "New title" }, structuredClone(transcript)), original);
  const edited = structuredClone(transcript);
  edited[0].parts = ["Changed sentence. Second sentence!"];
  assert.notEqual(buildSentenceUnits("content-1", segment, edited)[0].id, original[0].id);
  assert.notEqual(buildSentenceUnits("content-2", segment, transcript)[0].id, original[0].id);
  assert.notEqual(buildSentenceUnits("content-1", { ...segment, endMs: 18000 }, transcript)[0].id, original[0].id);
});

test("source token ranges distinguish repeated sentences and include preceding transcript tokens", () => {
  const rows = [{ time: "0:00", parts: ["Outside this segment."] }, ...transcript];
  const sentences = buildSentenceUnits("content-1", { ...segment, transcriptStartIndex: 1, transcriptEndIndex: 4 }, rows);
  assert.equal(sentences[0].sourceTokenStart, 3);
  assert.equal(sentences[0].sourceTokenEnd, 5);
  assert.equal(sentences.at(-1).sourceTokenEnd, 12);
});

test("preserves highlighted source text, abbreviations, decimals, and closing quotes", () => {
  const rows = [{ time: "0:01", parts: ["Dr. Smith paid ", { text: "3.5 dollars", kind: "chunk", tag: "framing" }, '. "Really?" Yes!'] }];
  const sentences = buildSentenceUnits("content-1", { ...segment, transcriptEndIndex: 1 }, rows);
  assert.deepEqual(sentences.map((s) => s.text), ["Dr. Smith paid 3.5 dollars.", '"Really?"', "Yes!"]);
});

test("legacy segments use caption timestamps and stay inside their playable range", () => {
  const rows = [{ time: "0:00", parts: ["Before."] }, ...transcript, { time: "0:17", parts: ["After."] }];
  const legacy = { ...segment };
  delete legacy.transcriptStartIndex;
  delete legacy.transcriptEndIndex;
  const sentences = buildSentenceUnits("content-1", legacy, rows);
  assert.equal(sentences.length, 3);
  assert.ok(sentences.every((s) => s.startMs >= 1000 && s.endMs <= 17000));
  assert.equal(sentenceAtTime(sentences, 4999)?.id, sentences[0].id);
  assert.equal(sentenceAtTime(sentences, 5000)?.id, sentences[1].id);
  assert.equal(sentenceAtTime(sentences, 17000), null);
});

test("empty, invalid and single-sentence segments fail safely without invented content", () => {
  assert.deepEqual(buildSentenceUnits("content", segment, []), []);
  assert.deepEqual(buildSentenceUnits("content", { ...segment, endMs: 1000 }, transcript), []);
  assert.deepEqual(buildSentenceUnits("content", { ...segment, startMs: NaN }, transcript), []);
  const sentences = buildSentenceUnits("content", { ...segment, transcriptEndIndex: 1 }, [{ time: "0:01", parts: ["Just one"] }]);
  assert.equal(sentences.length, 1);
  assert.equal(sentences[0].text, "Just one");
});

test("practice URLs restore a sentence without losing the source, job, level or fragment", () => {
  const url = new URL("https://libitu.test/?contentId=c&jobId=j&learnerLevel=B2&sourceUrl=https%3A%2F%2Fyoutu.be%2Fx#transcript");
  const next = stageTwoLocation(url, { segmentId: "segment-1", sentenceId: "sentence-2" });
  assert.deepEqual(readStageTwoLocation(next), { segmentId: "segment-1", sentenceId: "sentence-2" });
  assert.equal(next.searchParams.get("sourceUrl"), "https://youtu.be/x");
  assert.equal(next.hash, url.hash);
  assert.equal(stageTwoLocation(next, null).href, url.href);
  assert.equal(readStageTwoLocation(new URL("https://libitu.test/?stage=2")), null);
});
