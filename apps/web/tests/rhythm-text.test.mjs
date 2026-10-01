import assert from "node:assert/strict";
import { test } from "node:test";
import { referenceRhythm, rhythmWords } from "../features/stage-two/rhythm/rhythm-text.ts";

const text = "We practice together, then pause.";
const sentence = { id: "s1", text, startMs: 14000, endMs: 17000, sourceTokenStart: 8, timingSource: "caption_word_offsets" };
const labels = ["we", "practice", "together", "then", "pause"];
const starts = [0, .2, .7, 1.55, 1.8], ends = [.2, .7, 1.2, 1.8, 2.3];
function server() {
  return { sentence_id: "s1", alignment: { status: "aligned", words: labels.map((label, i) => ({ label,
    start_sec: 4 + starts[i], end_sec: 4 + ends[i] })) },
    measurements: { quality_issues: [], pauses: [{ start_sec: 5.2, end_sec: 5.55 }] } };
}
function local() {
  return { quality: { status: "usable", issues: [] }, internalPauses: [{ startMs: 1200, endMs: 1550 }] };
}
function captions() {
  return { ...sentence, wordTimings: text.split(" ").map((word, i) => ({ text: word, sourceTokenIndex: 8 + i,
    startMs: 14000 + starts[i] * 1000, endMs: 14000 + (starts[i + 1] ?? 2.3) * 1000,
    startSource: "caption_offset", endSource: "next_word_estimate", sourceEventIndex: 1, sourceSegIndex: i })) };
}
function guide(patterns = [["P", "R", "AE1", "K", "T", "AH0", "S"]]) {
  return { sentence_text: text, tokens: [{ text: "practice", start: 3, end: 11, pronunciations: patterns }] };
}

test("syllable dots preserve punctuation and require a common dictionary stress pattern", () => {
  const words = rhythmWords(text, guide());
  assert.deepEqual(words.map(word => word.text), text.split(" "));
  assert.deepEqual(words[1].stresses, [1, 0]);
  assert.equal(words[0].stresses, null);
  assert.equal(rhythmWords(text, guide([["AE1", "AH0"], ["AE0", "AH1"]]))[1].stresses, null);
  assert.deepEqual(rhythmWords(text, guide([["AE1", "AH0"], ["EH1", "AH0"]]))[1].stresses, [1, 0]);
  assert.equal(rhythmWords("Changed text.", guide())[0].stresses, null);
});

test("server segment clock converts to sentence clock, placing a measured pause after the right word", () => {
  const result = referenceRhythm(sentence, null, server(), 10000);
  assert.equal(result.approximate, false);
  assert.equal(result.pauses[0].afterWord, 2);
  assert.equal(result.pauses[0].startMs, 1200);
  assert.equal(result.pauses[0].endMs, 1550);
});

test("local acoustic word boundaries place pauses without requiring caption word offsets", () => {
  const aligned = { source: { sentenceId: sentence.id, text, startMs: sentence.startMs, endMs: sentence.endMs },
    words: labels.map((label, i) => ({ text: label, start_sec: starts[i], end_sec: ends[i] })) };
  const result = referenceRhythm(sentence, local(), null, null, aligned);
  assert.equal(result.approximate, false);
  assert.equal(result.aligned, true);
  assert.equal(result.pauses[0].afterWord, 2);
  // A gap inside an acoustically aligned word cannot be relabelled a word boundary.
  aligned.words[2].end_sec = 1.4;
  assert.equal(referenceRhythm(sentence, local(), null, null, aligned).pauses[0].afterWord, null);
});

test("local alignment from a different sentence snapshot cannot override caption fallback", () => {
  const aligned = { source: { sentenceId: sentence.id, text: "Changed words.", startMs: sentence.startMs, endMs: sentence.endMs },
    words: labels.map((label, i) => ({ text: label, start_sec: starts[i], end_sec: ends[i] })) };
  const result = referenceRhythm(sentence, local(), null, null, aligned);
  assert.equal(result.approximate, true);
  assert.equal(result.pauses[0].afterWord, null);
});

test("caption end estimates never become pauses; measured pauses use approximate caption positions", () => {
  assert.deepEqual(referenceRhythm(captions(), { ...local(), internalPauses: [] }, null, null).pauses, []);
  const result = referenceRhythm(captions(), local(), null, null);
  assert.equal(result.approximate, true);
  assert.equal(result.pauses[0].afterWord, 2);
  assert.equal(result.pauses[0].endMs - result.pauses[0].startMs, 350);
});

test("wrong alignment, missing caption words, wrong sentence, and uncertain boundaries abstain", () => {
  const mismatch = server(); mismatch.alignment.words[0].label = "they";
  assert.equal(referenceRhythm(sentence, null, mismatch, 10000).pauses[0].afterWord, null);
  const missing = captions(); missing.wordTimings.splice(2, 1);
  assert.equal(referenceRhythm(missing, local(), null, null).pauses[0].afterWord, null);
  assert.equal(referenceRhythm({ ...sentence, id: "other" }, null, server(), 10000).usable, false);
  const inside = server(); inside.measurements.pauses = [{ start_sec: 4.8, end_sec: 5.05 }];
  assert.equal(referenceRhythm(sentence, null, inside, 10000).pauses[0].afterWord, null);
  assert.equal(referenceRhythm(sentence, local(), null, null).pauses[0].afterWord, null);
});

test("low speech quality suppresses pause claims; missing pitch alone does not", () => {
  const result = server(); result.measurements.quality_issues = ["insufficient_speech"];
  assert.equal(referenceRhythm(sentence, null, result, 10000).usable, false);
  result.measurements.quality_issues = ["insufficient_pitch"];
  assert.equal(referenceRhythm(sentence, null, result, 10000).pauses[0].afterWord, 2);
  assert.equal(referenceRhythm(captions(), { ...local(), quality: { status: "insufficient" } }, null, null).pauses.length, 0);
});

test("caption time order cannot reorder the displayed sentence", () => {
  const s = captions();
  Object.assign(s.wordTimings[0], { startMs: 16500, endMs: 16800 });
  const result = referenceRhythm(s, local(), null, null);
  assert.equal(result.aligned, false);
  assert.equal(result.pauses[0].afterWord, null);
});

test("invalid/outside sentence pauses are excluded; duplicate boundary matches keep timing without a text claim", () => {
  const result = server();
  result.measurements.pauses.push({ start_sec: 3, end_sec: 4.5 }, { start_sec: 6.8, end_sec: 8 },
    { start_sec: 5.2, end_sec: 5.4 }, { start_sec: NaN, end_sec: 5 }, { start_sec: 5, end_sec: 5.1 });
  const mapped = referenceRhythm(sentence, null, result, 10000);
  assert.equal(mapped.pauses.length, 2);
  assert.ok(mapped.pauses.every(pause => pause.afterWord === null));
});

test("alignment retains contractions, repeat words, punctuation and hyphenated words in source order", () => {
  const s = { ...sentence, text: "We—we don't. We pause." };
  const r = server();
  r.alignment.words.forEach((word, i) => { word.label = ["we", "we", "don't", "we", "pause"][i]; });
  assert.equal(referenceRhythm(s, null, r, 10000).pauses[0].afterWord, 1);
  r.alignment.words[2].start_sec = 4.1;
  assert.equal(referenceRhythm(s, null, r, 10000).pauses[0].afterWord, null);
});
