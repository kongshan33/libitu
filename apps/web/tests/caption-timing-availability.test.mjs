import assert from "node:assert/strict";
import { test } from "node:test";
import { captionTimingCoverage, wordTimingNotice } from "../features/playback/caption-timing-availability.ts";

const row = (extra = {}) => ({
  text: "We agree.", sourceTokenStart: 5, timingSource: "caption_word_offsets",
  wordTimings: ["We", "agree."].map((text, index) => ({
    text, sourceTokenIndex: 5 + index, startMs: 1000 + index * 500, endMs: 1500 + index * 500,
    startSource: "caption_offset", endSource: "next_word_estimate", sourceEventIndex: 0, sourceSegIndex: index
  })), ...extra
});

test("empty/loading text does not prematurely announce unavailable timing", () => {
  for (const rows of [[], [{ text: " \n " }], [{}]]) {
    const coverage = captionTimingCoverage(rows);
    assert.deepEqual(coverage, { totalWords: 0, timedWords: 0 });
    assert.equal(wordTimingNotice(coverage, { pending: true }), null);
  }
});

test("legacy/block captions explicitly explain that normal listening remains usable", () => {
  for (const input of [row({ wordTimings: undefined }), row({ timingSource: "caption_event_estimate" }), row({ sourceTokenStart: undefined })]) {
    const coverage = captionTimingCoverage([input]);
    assert.deepEqual(coverage, { totalWords: 2, timedWords: 0 });
    const notice = wordTimingNotice(coverage);
    assert.equal(notice.status, "unavailable");
    assert.equal(notice.title, "Word timing unavailable");
    assert.match(notice.detail, /still listen/);
  }
});

test("complete usable coverage needs no warning, independently of playback position", () => {
  const coverage = captionTimingCoverage([row()]);
  assert.deepEqual(coverage, { totalWords: 2, timedWords: 2 });
  assert.equal(wordTimingNotice(coverage), null);
  assert.equal(wordTimingNotice(coverage, { pending: true }), null);
});

test("sparse timing, including unknown word ends, is partial rather than fully available", () => {
  const input = row();
  input.wordTimings[1].endMs = null;
  input.wordTimings[1].endSource = null;
  const coverage = captionTimingCoverage([input]);
  assert.deepEqual(coverage, { totalWords: 2, timedWords: 1 });
  assert.equal(wordTimingNotice(coverage).status, "partial");
  assert.match(wordTimingNotice(coverage).detail, /Only words with usable timing/);
});

test("invalid, ambiguous and excessively long estimates use the same gate as highlighting", () => {
  for (const change of [
    (words) => words.forEach((word) => { word.text = "mismatch"; }),
    (words) => words.forEach((word) => { word.endMs = null; }),
    (words) => words.forEach((word) => { word.endMs = word.startMs + 2001; }),
    (words) => words.forEach((word) => { word.startMs = 1000; word.endMs = 1900; })
  ]) {
    const input = row();
    change(input.wordTimings);
    assert.equal(wordTimingNotice(captionTimingCoverage([input])).status, "unavailable");
  }
});

test("Stage 1 aggregates mixed rows and corpus parts without losing exact text", () => {
  const first = row({ text: undefined, parts: ["We ", { text: "agree.", kind: "chunk", tag: "acknowledging" }] });
  const coverage = captionTimingCoverage([first, { text: "They disagree." }]);
  assert.deepEqual(coverage, { totalWords: 4, timedWords: 2 });
  assert.equal(wordTimingNotice(coverage).status, "partial");
});

test("Stage 2 selected sentence coverage does not inherit another sentence's availability", () => {
  assert.equal(wordTimingNotice(captionTimingCoverage([row()])), null);
  assert.equal(wordTimingNotice(captionTimingCoverage([row({ wordTimings: [] })])).status, "unavailable");
  assert.equal(wordTimingNotice(captionTimingCoverage([row()])), null);
});

test("display switches are distinguished from missing data and never reveal source text", () => {
  const input = row();
  for (const words of [input.wordTimings, input.wordTimings.slice(0, 1)]) {
    const coverage = captionTimingCoverage([row({ wordTimings: words })]);
    const off = wordTimingNotice(coverage, { enabled: false });
    const hidden = wordTimingNotice(coverage, { concealed: true });
    assert.equal(off.status, "off");
    assert.match(off.detail, /Highlight active/);
    assert.equal(hidden.status, "hidden");
    assert.match(hidden.detail, /Reveal/);
    assert.doesNotMatch(JSON.stringify(hidden), /We agree/);
  }
  const unavailable = captionTimingCoverage([{ text: "We agree." }]);
  assert.equal(wordTimingNotice(unavailable, { enabled: false }).status, "unavailable");
  assert.equal(wordTimingNotice(unavailable, { concealed: true }).status, "unavailable");
});

test("streaming notices describe current evidence without promising later word timing", () => {
  for (const input of [row({ wordTimings: [] }), row({ wordTimings: row().wordTimings.slice(0, 1) })]) {
    const coverage = captionTimingCoverage([input]);
    assert.match(wordTimingNotice(coverage, { pending: true }).detail, /More captions are still loading/);
    assert.doesNotMatch(wordTimingNotice(coverage).detail, /still loading/);
  }
});
