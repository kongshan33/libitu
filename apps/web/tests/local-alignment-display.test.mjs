import assert from "node:assert/strict";
import test from "node:test";
import { localReferenceDisplay, layerEvidence } from "../features/stage-two/alignment/display.ts";

const sentence = { id: "s1", text: "We practice daily.", startMs: 14000, endMs: 15600 };
const source = { contentId: "content", sentenceId: sentence.id, text: sentence.text, startMs: sentence.startMs, endMs: sentence.endMs };
function features() {
  return { durationMs: 1600, quality: { status: "usable", issues: [] },
    speechSegments: [{ startMs: 0, endMs: 800 }, { startMs: 1000, endMs: 1500 }],
    internalPauses: [{ startMs: 800, endMs: 1000 }],
    pitchCurve: Array.from({ length: 160 }, (_, i) => ({ timeMs: i * 10, semitones: i < 80 ? 2 : -2 })) };
}
function snapshot() {
  return { phase: "ready", source: { ...source }, captureId: "capture-1", audioSha256: "a".repeat(64),
    result: { status: "ready", engineVersion: "charsiu-en-fc-10ms-v1", phoneLabels: "dictionary_targets",
      contentVerification: "not_independently_verified", durationMs: 1600,
      words: [
        { tokenIndex: 0, token: "we", startMs: 0, endMs: 300, pronunciationIndex: 0,
          phones: [{ phone: "W", startMs: 0, endMs: 50 }, { phone: "IY1", startMs: 50, endMs: 300 }] },
        { tokenIndex: 1, token: "practice", startMs: 400, endMs: 800, pronunciationIndex: 0,
          phones: [{ phone: "P", startMs: 400, endMs: 450 }, { phone: "AE1", startMs: 450, endMs: 700 }, { phone: "K", startMs: 700, endMs: 800 }] },
        { tokenIndex: 2, token: "daily", startMs: 1000, endMs: 1500, pronunciationIndex: 0,
          phones: [{ phone: "D", startMs: 1000, endMs: 1100 }, { phone: "EY1", startMs: 1100, endMs: 1500 }] },
      ] } };
}
const display = () => localReferenceDisplay("content", sentence, features(), snapshot());
function saved() {
  return { id: "analysis", sentence_id: "s1", state: "completed", result: {
    learner: { content: { status: "matched", transcript: sentence.text }, alignment_status: "aligned", quality_issues: [], words: display().words },
    reference: null, comparison: "unavailable", assessment: null,
  } };
}

test("local display retains exact clip identity, phone intervals, and measured word timing without inventing verification", () => {
  const result = display();
  assert.equal(result.contentVerification, "not_independently_verified");
  assert.equal(result.captureId, "capture-1");
  assert.equal(result.audioSha256, "a".repeat(64));
  assert.deepEqual(result.words.map(word => word.duration_ms), [300, 400, 500]);
  assert.deepEqual(result.words[0].phones, [{ label: "W", duration_ms: 50 }, { label: "IY1", duration_ms: 250 }]);
  assert.deepEqual(result.phoneTimings[0][1], { phone: "IY1", startMs: 50, endMs: 300 });
  assert.equal(result.words[0].boundary_pause_ms, 0);
  assert.equal(result.words[1].boundary_pause_ms, 200);
  assert.equal(result.words[2].boundary_pause_ms, null);
  assert.equal(result.words[0].pitch_st, 2);
  assert.deepEqual(result.words[0].pitch_curve_st, [2, 2, 2, 2, 2]);
});

test("wrong source, sentence, text, bounds, clip duration or word mapping cannot attach reference evidence", () => {
  for (const patch of [{ contentId: "other" }, { sentenceId: "other" }, { text: "We practice rarely." }, { startMs: 14001 }, { endMs: 15601 }]) {
    const value = snapshot(); value.source = { ...value.source, ...patch };
    assert.equal(localReferenceDisplay("content", sentence, features(), value), null);
  }
  for (const modify of [value => { value.captureId = null; }, value => { value.audioSha256 = null; },
    value => { value.result.durationMs = 1800; }, value => { value.result.words[1].token = "read"; },
    value => { value.result.words[1].startMs = 298; }, value => { value.result.words[1].endMs = Infinity; },
    value => { value.phase = "aligning"; }, value => { value.result.status = "unreliable"; }]) {
    const value = snapshot(); modify(value);
    assert.equal(localReferenceDisplay("content", sentence, features(), value), null);
  }
});

test("sparse pitch keeps gaps and missing phone coverage does not invent intervals", () => {
  const measured = features(); measured.pitchCurve = [{ timeMs: 20, semitones: 2 }];
  const aligned = snapshot(); aligned.result.words[0].phones[0].endMs = 5;
  const result = localReferenceDisplay("content", sentence, measured, aligned);
  assert.equal(result.words[0].pitch_st, null);
  assert.deepEqual(result.words[0].pitch_curve_st, [null, null, null, null, null]);
  assert.deepEqual(result.words[0].phones, []);
  assert.deepEqual(result.phoneTimings[0], []);
  assert.equal(result.words[0].duration_ms, 300);
  measured.quality.issues = ["insufficient_pitch"];
  measured.pitchCurve = features().pitchCurve;
  assert.equal(localReferenceDisplay("content", sentence, measured, snapshot()).words[0].pitch_st, null);
  measured.quality.status = "insufficient";
  assert.equal(localReferenceDisplay("content", sentence, measured, snapshot()), null);
});

test("a gap between forced word intervals alone is not a measured pause", () => {
  const measured = features(); measured.internalPauses = [];
  const result = localReferenceDisplay("content", sentence, measured, snapshot());
  assert.equal(result.words[1].pause_after_ms, null);
  assert.equal(result.words[1].boundary_pause_ms, null);
});

test("reference-only and learner-only evidence remain available independently", () => {
  const refOnly = layerEvidence(null, display(), "s1", sentence.text);
  assert.equal(refOnly.reference.length, 3);
  assert.equal(refOnly.learner, null);
  assert.equal(refOnly.assessment, null);
  const learnerOnly = layerEvidence(saved(), null, "s1", sentence.text);
  assert.equal(learnerOnly.reference, null);
  assert.equal(learnerOnly.learner.length, 3);
});

test("matching local reference and saved learner combine for display without inheriting any score", () => {
  const data = saved(); data.result.assessment = { version: "old", rhythm: { value: 100 } };
  const evidence = layerEvidence(data, display(), "s1", sentence.text);
  assert.equal(evidence.reference.length, 3);
  assert.equal(evidence.learner.length, 3);
  assert.equal(evidence.localReference, true);
  assert.equal(evidence.assessment, null);
  assert.equal(data.result.reference, null);
  assert.equal(data.result.comparison, "unavailable");
});

test("validated server pairing takes priority over a local capture", () => {
  const data = saved(); data.result.reference = structuredClone(data.result.learner);
  data.result.reference.words[0].duration_ms = 777;
  data.result.comparison = "available";
  data.result.assessment = { version: "saved", rhythm: { value: 90 } };
  const evidence = layerEvidence(data, display(), "s1", sentence.text);
  assert.equal(evidence.reference[0].duration_ms, 777);
  assert.equal(evidence.assessment, data.result.assessment);
  assert.equal(evidence.localReference, false);
});

test("different words, uncertain learner content and stale sentence results are never paired", () => {
  const mismatch = saved(); mismatch.result.learner.words[0].text = "they";
  const evidence = layerEvidence(mismatch, display(), "s1", sentence.text);
  assert.equal(evidence.reference, null);
  assert.equal(evidence.learner[0].text, "they");
  assert.equal(evidence.unpairedLocalReference[0].text, "we");
  assert.equal(evidence.reason, "word_mismatch");
  const uncertain = saved(); uncertain.result.learner.content.status = "uncertain";
  assert.equal(layerEvidence(uncertain, display(), "s1", sentence.text).reason, "learner_not_verified");
  const poor = saved(); poor.result.learner.quality_issues = ["clipping"];
  assert.equal(layerEvidence(poor, display(), "s1", sentence.text).reference, null);
  const stale = layerEvidence(saved(), display(), "other", "Different sentence.");
  assert.equal(stale.reference, null);
  assert.equal(stale.learner, null);
});
