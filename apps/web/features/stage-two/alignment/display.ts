import type { SentenceUnit } from "@libitu/types/stage-two";
import type { AcousticFeatures } from "../acoustics/types";
import type { LayerAssessment, PracticeAnalysis, WordProsody } from "../persistence/practice-api";
import type { LocalReferenceAlignment } from "./types";

export type LocalReferenceDisplay = {
  source: { contentId: string; sentenceId: string; text: string; startMs: number; endMs: number };
  captureId: string;
  audioSha256: string;
  engineVersion: LocalReferenceAlignment["engineVersion"];
  contentVerification: "not_independently_verified";
  words: WordProsody[];
  phoneTimings: LocalReferenceAlignment["words"][number]["phones"][];
};

type AlignmentSnapshot = {
  phase: string;
  result: LocalReferenceAlignment | null;
  source: LocalReferenceDisplay["source"] | null;
  captureId: string | null;
  audioSha256: string | null;
};

export const lexicalWords = (text: string): string[] => text.toLowerCase().replaceAll("’", "'").match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) ?? [];
const sameWords = (left: string[], right: string[]) => left.length === right.length && left.every((word, index) => word === right[index]);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const rounded = (value: number) => Math.round(value * 100) / 100;

/** Uses only one clip's aligned intervals and measured VAD/F0. No score or content check is inferred. */
export function localReferenceDisplay(contentId: string, sentence: SentenceUnit | null,
  features: AcousticFeatures | null, snapshot: AlignmentSnapshot): LocalReferenceDisplay | null {
  const result = snapshot.result, source = snapshot.source;
  if (!sentence || !features || features.quality.status !== "usable" || snapshot.phase !== "ready"
    || !result || result.status !== "ready" || !source || source.contentId !== contentId
    || source.sentenceId !== sentence.id || source.text !== sentence.text
    || source.startMs !== sentence.startMs || source.endMs !== sentence.endMs
    || !snapshot.captureId || !snapshot.audioSha256 || !/^[a-f0-9]{64}$/i.test(snapshot.audioSha256)
    || !Number.isFinite(result.durationMs) || !Number.isFinite(features.durationMs) || Math.abs(result.durationMs - features.durationMs) > 2
    || result.contentVerification !== "not_independently_verified") return null;
  const expected = lexicalWords(sentence.text);
  if (!expected.length || !sameWords(result.words.map(word => word.token.toLowerCase().replaceAll("’", "'")), expected)) return null;
  // Reject the entire mapping when an interval is invalid; never zip partial word sequences.
  if (result.words.some((word, index) => !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs)
    || word.startMs < 0 || word.endMs <= word.startMs || word.endMs > result.durationMs + 1
    || (index > 0 && word.startMs < result.words[index - 1].endMs - 1))) return null;
  const hasPitch = !features.quality.issues.includes("insufficient_pitch");
  const words = result.words.map((word, index): WordProsody => {
    const following = result.words[index + 1];
    const gap = following ? features.internalPauses.filter(pause => word.endMs <= pause.startMs + 80
      && pause.endMs <= following.startMs + 80 && pause.startMs - word.endMs <= 250
      && following.startMs - pause.endMs <= 250 && pause.endMs - pause.startMs >= 200) : [];
    const continuous = following && following.startMs >= word.endMs && following.startMs - word.endMs <= 150
      && features.speechSegments.some(segment => segment.startMs <= word.endMs && segment.endMs >= following.startMs);
    const pitch = hasPitch ? features.pitchCurve.filter(point => point.timeMs >= word.startMs && point.timeMs < word.endMs
      && point.semitones !== null && Number.isFinite(point.semitones)) : [];
    const enoughPitch = pitch.length >= 5;
    const phoneCoverage = word.phones.length > 0 && Math.abs(word.phones[0].startMs - word.startMs) <= 20
      && Math.abs(word.phones.at(-1)!.endMs - word.endMs) <= 20
      && word.phones.every((phone, phoneIndex) => Number.isFinite(phone.startMs) && Number.isFinite(phone.endMs)
        && phone.endMs > phone.startMs && phone.startMs >= word.startMs - 1 && phone.endMs <= word.endMs + 1
        && (phoneIndex === 0 || Math.abs(phone.startMs - word.phones[phoneIndex - 1].endMs) <= 20));
    return {
      text: word.token, start_sec: word.startMs / 1000, end_sec: word.endMs / 1000,
      duration_ms: rounded(word.endMs - word.startMs),
      pause_after_ms: gap.length === 1 ? rounded(gap[0].endMs - gap[0].startMs) : null,
      boundary_pause_ms: gap.length === 1 ? rounded(gap[0].endMs - gap[0].startMs) : continuous && !gap.length ? 0 : null,
      pitch_st: enoughPitch ? rounded(median(pitch.map(point => point.semitones!))) : null,
      pitch_curve_st: Array.from({ length: 5 }, (_, bin) => {
        if (!enoughPitch) return null;
        const start = word.startMs + (word.endMs - word.startMs) * bin / 5;
        const end = word.startMs + (word.endMs - word.startMs) * (bin + 1) / 5;
        const points = pitch.filter(point => point.timeMs >= start && point.timeMs < end);
        return points.length >= 2 ? rounded(median(points.map(point => point.semitones!))) : null;
      }),
      phones: phoneCoverage ? word.phones.map(phone => ({ label: phone.phone, duration_ms: rounded(phone.endMs - phone.startMs) })) : [],
    };
  });
  return { source, captureId: snapshot.captureId, audioSha256: snapshot.audioSha256,
    engineVersion: result.engineVersion, contentVerification: result.contentVerification, words,
    phoneTimings: result.words.map((word, index) => words[index].phones?.length ? word.phones : []) };
}

export type LayerEvidence = {
  reference: WordProsody[] | null;
  learner: WordProsody[] | null;
  assessment: LayerAssessment | null;
  localReference: boolean;
  unpairedLocalReference: WordProsody[] | null;
  reason: "word_mismatch" | "learner_not_verified" | null;
};

/** Display composition only. It never changes or persists the server analysis. */
export function layerEvidence(data: PracticeAnalysis | null, local: LocalReferenceDisplay | null,
  sentenceId: string | null, sentenceText: string | null): LayerEvidence {
  const result = data?.sentence_id === sentenceId && ["completed", "needs_review"].includes(data.state) ? data.result : null;
  const learner = result?.learner.words.length ? result.learner.words : null;
  const expected = lexicalWords(sentenceText ?? "");
  const validWords = (words: WordProsody[]) => sameWords(words.flatMap(word => lexicalWords(word.text)), expected)
    && words.every(word => lexicalWords(word.text).length === 1);
  const serverReference = result?.comparison === "available" && result.reference?.words.length ? result.reference.words : null;
  if (learner && serverReference && validWords(learner) && validWords(serverReference)
    && learner.length === serverReference.length) return { reference: serverReference, learner,
    assessment: result?.assessment ?? null, localReference: false, unpairedLocalReference: null, reason: null };
  const reference = local?.source.sentenceId === sentenceId && local.source.text === sentenceText ? local.words : null;
  if (reference && learner) {
    const mismatch = !validWords(learner) || learner.length !== reference.length;
    const unverified = result?.learner.content.status !== "matched" || result.learner.alignment_status !== "aligned"
      || result.learner.quality_issues.some(issue => ["insufficient_speech", "low_energy", "clipping", "silent", "too_short"].includes(issue));
    if (mismatch || unverified) return { reference: null, learner, assessment: null, localReference: false,
      unpairedLocalReference: reference, reason: mismatch ? "word_mismatch" : "learner_not_verified" };
  }
  return { reference, learner, assessment: null, localReference: Boolean(reference), unpairedLocalReference: null, reason: null };
}
