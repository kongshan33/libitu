import assert from "node:assert/strict";
import test from "node:test";
import { PHONE_IDS } from "../features/stage-two/alignment/assets.ts";
import { alignPhoneLogits, buildAlignmentGraph, normalizeAlignmentAudio } from "../features/stage-two/alignment/engine.ts";

function annotation(words) {
  return { version: "sound-rules-v1", content_id: "content", sentence_id: "sentence", sentence_text: words.map(([text]) => text).join(" "), dialect: "en-US", provider: "cmudict-rules", lexicon_version: "test", candidates: [], warnings: [], coverage: { known: words.length, total: words.length },
    tokens: words.map(([text, pronunciations], index) => ({ index, text, pronunciations, start: index, end: index + 1, ipa: [], status: pronunciations.length > 1 ? "ambiguous" : "known" })) };
}
function run(words, sequence) {
  const graph = buildAlignmentGraph(annotation(words));
  assert.notEqual(typeof graph, "string");
  const logits = new Float32Array(sequence.length * 42).fill(-10);
  sequence.forEach((phone, frame) => { logits[frame * 42 + PHONE_IDS[phone]] = 10; });
  return alignPhoneLogits(logits, sequence.length, 42, graph, sequence.length * 10);
}
const repeat = (phone, count = 10) => Array(count).fill(phone);

test("local phone alignment preserves repeated word identities", () => {
  const result = run([["had", [["HH", "AE1", "D"]]], ["had", [["HH", "AE1", "D"]]]], [...repeat("HH"), ...repeat("AE"), ...repeat("D"), ...repeat("HH"), ...repeat("AE"), ...repeat("D")]);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.words.map((word) => word.tokenIndex), [0, 1]);
  assert.deepEqual(result.words.map((word) => word.phones[0].phone), ["HH", "HH"]);
  assert.equal(result.words[0].endMs, result.words[1].startMs);
  assert.ok(result.words.every((word) => word.endMs > word.startMs));
  assert.equal(result.contentVerification, "not_independently_verified");
  assert.equal(result.phoneLabels, "dictionary_targets");
});

test("adjacent identical phones abstain unless observed silence establishes their boundary", () => {
  const words = [["a", [["AH0"]]], ["a", [["AH1"]]]];
  assert.equal(run(words, repeat("AH", 60)).status, "unreliable");
  const separated = run(words, [...repeat("AH", 30), ...repeat("[SIL]", 10), ...repeat("AH", 30)]);
  assert.equal(separated.status, "ready");
  assert.deepEqual(separated.words.map((word) => [word.tokenIndex, word.startMs, word.endMs]), [[0, 0, 300], [1, 400, 700]]);
});

test("a word compressed to one frame abstains instead of reporting an arbitrary boundary", () => {
  const result = run([["a", [["AH0"]]], ["see", [["S", "IY1"]]]], [...repeat("AH", 1), ...repeat("S", 25), ...repeat("IY", 25)]);
  assert.equal(result.status, "unreliable");
  assert.match(result.reason, /single model frame/);
});

test("acoustic emissions select a supported dictionary alternative without enumerating full sentences", () => {
  const result = run([["the", [["DH", "AH0"], ["DH", "IY1"]]], ["sea", [["S", "IY1"]]]], [...repeat("DH"), ...repeat("IY"), ...repeat("S"), ...repeat("IY")]);
  assert.equal(result.status, "ready");
  assert.equal(result.words[0].pronunciationIndex, 1);
  assert.deepEqual(result.words[0].phones.map((phone) => phone.phone), ["DH", "IY1"]);
  assert.equal(result.words[1].startMs, 200);
});

test("silence keeps its measured gap rather than being distributed into phone durations", () => {
  const result = run([["see", [["S", "IY1"]]], ["me", [["M", "IY1"]]]], [...repeat("S"), ...repeat("IY"), ...repeat("[SIL]", 25), ...repeat("M"), ...repeat("IY")]);
  assert.equal(result.status, "ready");
  assert.equal(result.words[0].endMs, 200);
  assert.equal(result.words[1].startMs, 450);
  assert.equal(result.words[0].phones.at(-1).endMs - result.words[0].phones.at(-1).startMs, 100);
});

test("a phone spanning model silence abstains instead of inventing a continuous phone duration", () => {
  const result = run([["a", [["AH0"]]]], [...repeat("AH", 25), ...repeat("[SIL]", 10), ...repeat("AH", 25)]);
  assert.equal(result.status, "unreliable");
  assert.deepEqual(result.words, []);
});

test("all-silence and acoustically unsupported forced paths do not produce word boundaries", () => {
  const words = [["see", [["S", "IY1"]]]];
  assert.equal(run(words, repeat("[SIL]", 80)).status, "unreliable");
  assert.equal(run(words, repeat("[UNK]", 80)).status, "unreliable");
});

test("OOV, invalid phone symbols and oversized graphs abstain explicitly", () => {
  assert.equal(typeof buildAlignmentGraph(annotation([["xyz", []]])), "string");
  assert.equal(typeof buildAlignmentGraph(annotation([["cat", [["k", "æ", "t"]]]])), "string");
  assert.equal(typeof buildAlignmentGraph(annotation(Array.from({ length: 121 }, () => ["a", [["AH0"]]]))), "string");
});

test("stress-only variants collapse without falsely choosing dictionary stress", () => {
  const graph = buildAlignmentGraph(annotation([["a", [["AH0"], ["AH1"]]]]));
  assert.notEqual(typeof graph, "string");
  assert.equal(graph.states.length, 1);
  assert.equal(graph.states[0].phone, "AH");
  const result = run([["a", [["AH0"], ["AH1"]]]], repeat("AH", 60));
  assert.equal(result.status, "ready");
  assert.equal(result.words[0].phones[0].phone, "AH");
});

test("normalization is finite and removes DC offset; corrupt emissions fail explicitly", () => {
  assert.deepEqual([...normalizeAlignmentAudio(new Float32Array([3, 3]))], [0, 0]);
  assert.throws(() => normalizeAlignmentAudio(new Float32Array([NaN])), /invalid/);
  const graph = buildAlignmentGraph(annotation([["a", [["AH0"]]]]));
  assert.throws(() => alignPhoneLogits(new Float32Array(42).fill(NaN), 1, 42, graph, 100), /invalid logits/);
});
