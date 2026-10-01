import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptionWordClock, captionWordAtTime, qualifyCaptionWords } from "../features/playback/caption-word-clock.ts";

const timing = (index, text, start, end, extra = {}) => ({
  sourceTokenIndex: index, text, startMs: start, endMs: end, startSource: "caption_offset",
  endSource: "next_word_estimate", sourceEventIndex: 0, sourceSegIndex: index, ...extra
});
const qualify = (text, words, start = 10, source = "caption_word_offsets") => qualifyCaptionWords(text, start, source, words);

test("provider tokens retain whitespace and punctuation offsets, including several words within one second", () => {
  const words = qualify("We  think\nabout.", [timing(10, "We", 1000, 1100), timing(11, "think", 1100, 1450), timing(12, "about.", 1500, 1800)]);
  assert.deepEqual(words.map((word) => [word.index, word.charStart, word.charEnd]), [[10, 0, 2], [11, 4, 9], [12, 10, 16]]);
  for (const [time, expected] of [[999, null], [1000, 10], [1099, 10], [1100, 11], [1450, null], [1500, 12], [1800, null]]) {
    assert.equal(captionWordAtTime(words, time), expected, `half-open boundary at ${time}`);
  }
});

test("sparse timing never fills untimed words or estimates a missing last-word end", () => {
  const words = qualify("We think about.", [timing(10, "We", 1000, 1100), timing(12, "about.", 1500, null, { endSource: null })]);
  assert.equal(words.length, 1);
  assert.equal(captionWordAtTime(words, 1300), null);
  assert.equal(captionWordAtTime(words, 1600), null);
  assert.deepEqual(qualify("We", [timing(10, "We", 1000, 1100)], 10, "caption_event_estimate"), []);
  assert.deepEqual(qualifyCaptionWords("We", undefined, "caption_word_offsets", [timing(10, "We", 1000, 1100)]), []);
});

test("unmatched, duplicate, reversed, nonfinite or ambiguous provider times cannot claim word alignment", () => {
  assert.deepEqual(qualify("We", [timing(10, "They", 1000, 1200)]), []);
  assert.deepEqual(qualify("We", [timing(10, "We", 1000, 1000)]), []);
  assert.deepEqual(qualify("We", [timing(10, "We", NaN, 1100)]), []);
  assert.deepEqual(qualify("We", [timing(10, "We", 1000, Infinity)]), []);
  assert.deepEqual(qualify("We", [timing(10, "We", 1000, 1100, { startSource: "interpolated" })]), []);
  assert.deepEqual(qualify("We", [timing(10, "We", 1000, 1100), timing(10, "We", 1000, 1100)]), []);
  assert.deepEqual(qualify("We think", [timing(10, "We", 1000, 1200), timing(11, "think", 1000, 1300)]), []);
});

test("a long next-word/event-end estimate abstains without shortening or inventing acoustic silence", () => {
  const provider = [timing(10, "Hello.", 1000, 13000), timing(11, "Goodbye.", 13000, 15000, { endSource: "event_end_estimate" })];
  const words = qualify("Hello. Goodbye.", provider);
  assert.deepEqual(words.map((word) => word.index), [11]);
  assert.equal(captionWordAtTime(words, 5000), null);
  assert.equal(provider[0].endMs, 13000, "source metadata is never rewritten by the display gate");
});

test("clock follows actual seek/pause samples, clears on reset, and unsubscribes without retained callbacks", () => {
  const words = qualify("We think", [timing(10, "We", 1000, 1100), timing(11, "think", 1100, 1500)]);
  const clock = new CaptionWordClock();
  const observed = [];
  const unsubscribe = clock.subscribe(({ timeMs, playing }) => observed.push(playing ? captionWordAtTime(words, timeMs) : null));
  clock.publish(1.05, true);
  clock.publish(1.3, true); // Speed changes require no extrapolation.
  clock.publish(1.3, false);
  clock.publish(1.05, false); // A paused seek cannot light a word.
  clock.publish(1.05, true);
  clock.reset(); // Hidden tab, source replacement or unmount.
  assert.deepEqual(observed, [null, 10, 11, null, null, 10, null]);
  unsubscribe();
  clock.publish(1.3, true);
  assert.equal(observed.length, 7);
});

test("selection does not determine the playing word; a different sentence remains unhighlighted", () => {
  const first = qualify("We think", [timing(10, "We", 1000, 1100), timing(11, "think", 1100, 1500)]);
  const second = qualify("They agree", [timing(12, "They", 2000, 2200), timing(13, "agree", 2200, 2600)], 12);
  assert.equal(captionWordAtTime(first, 2250), null);
  assert.equal(captionWordAtTime(second, 2250), 13);
});
