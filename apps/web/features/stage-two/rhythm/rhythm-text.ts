import type { SentenceUnit, SoundAnnotation } from "@libitu/types/stage-two";
import type { AcousticFeatures } from "../acoustics/types";
import type { SentenceMeasurement } from "../server-reference/api";
import type { LocalReferenceDisplay } from "../alignment/display";
import { qualifyCaptionWords } from "../../playback/caption-word-clock.ts";

export type RhythmWord = { text: string; start: number; end: number; stresses: number[] | null };
export type RhythmPause = { startMs: number; endMs: number; afterWord: number | null };
type WordTime = { index: number; startMs: number; endMs: number };

/** Dictionary stress is within a word, never a claim about emphasis in a recording. */
export function rhythmWords(text: string, guide: SoundAnnotation | null): RhythmWord[] {
  const tokens = guide?.sentence_text === text ? guide.tokens : [];
  return Array.from(text.matchAll(/\S+/g), match => {
    const start = match.index, end = start + match[0].length;
    const candidates = tokens.filter(token => token.start >= start && token.end <= end);
    const token = candidates.length === 1 ? candidates[0] : null;
    const patterns = token?.pronunciations.map(phones => phones.flatMap(phone => {
      const stress = /[012]$/.exec(phone);
      return stress ? [Number(stress[0])] : [];
    })) ?? [];
    // Do not choose between different lexical stress patterns (e.g. noun/verb readings).
    const stresses = patterns[0]?.length && patterns.every(pattern => pattern.join() === patterns[0].join())
      ? patterns[0] : null;
    return { text: match[0], start, end, stresses };
  });
}

const normalize = (text: string) => text.toLowerCase().replaceAll("’", "'");

/** Require the complete lexical sequence; never zip unrelated alignment labels to text. */
function alignedWords(sentence: SentenceUnit, aligned: { start_sec: number; end_sec: number; label: string | null }[], originMs: number): WordTime[] {
  const words = rhythmWords(sentence.text, null);
  const lexical = Array.from(normalize(sentence.text).matchAll(/[a-z0-9]+(?:'[a-z0-9]+)*/g));
  if (lexical.length !== aligned.length || !aligned.length) return [];
  const times: WordTime[] = [];
  for (let i = 0; i < aligned.length; i++) {
    const interval = aligned[i], token = lexical[i];
    if (normalize(interval.label ?? "") !== token[0]) return [];
    const startMs = originMs + interval.start_sec * 1000 - sentence.startMs;
    const endMs = originMs + interval.end_sec * 1000 - sentence.startMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < -1 || endMs <= startMs
      || endMs > sentence.endMs - sentence.startMs + 1 || startMs < (times.at(-1)?.endMs ?? 0) - 1) return [];
    const index = words.findIndex(word => token.index >= word.start && token.index + token[0].length <= word.end);
    if (index < 0) return [];
    const previous = times.at(-1);
    if (previous?.index === index) previous.endMs = endMs;
    else times.push({ index, startMs, endMs });
  }
  return times;
}

export function referenceRhythm(sentence: SentenceUnit, reference: AcousticFeatures | null,
  server: SentenceMeasurement | null, originMs: number | null, localReference: LocalReferenceDisplay | null = null) {
  if (server?.sentence_id !== sentence.id) server = null;
  const duration = sentence.endMs - sentence.startMs;
  const isServer = originMs !== null;
  const isLocalAligned = !isServer && localReference?.source.sentenceId === sentence.id
    && localReference.source.text === sentence.text && localReference.source.startMs === sentence.startMs
    && localReference.source.endMs === sentence.endMs;
  const usable = isServer ? Boolean(server?.measurements
    && !server.measurements.quality_issues.some(issue => ["insufficient_speech", "silent", "too_short"].includes(issue)))
    : reference?.quality.status === "usable";
  const times = isServer ? server?.alignment.status === "aligned" ? alignedWords(sentence, server.alignment.words, originMs) : []
    : isLocalAligned ? alignedWords(sentence, localReference.words.map(word => ({ label: word.text,
      start_sec: word.start_sec, end_sec: word.end_sec })), sentence.startMs)
    : qualifyCaptionWords(sentence.text, sentence.sourceTokenStart, sentence.timingSource, sentence.wordTimings)
      .map(word => ({ index: word.index - sentence.sourceTokenStart,
        startMs: word.startMs - sentence.startMs, endMs: word.endMs - sentence.startMs }))
      .filter(word => word.startMs >= 0 && word.endMs <= duration);
  const orderedTimes = times.every((word, i) => !i || word.index > times[i - 1].index) ? times : [];
  const raw = !usable ? [] : isServer ? server!.measurements!.pauses.map(pause => ({
    startMs: originMs + pause.start_sec * 1000 - sentence.startMs,
    endMs: originMs + pause.end_sec * 1000 - sentence.startMs
  })) : reference!.internalPauses;
  const pauses: RhythmPause[] = raw.filter(pause => Number.isFinite(pause.startMs) && Number.isFinite(pause.endMs)
    && pause.startMs >= 0 && pause.endMs <= duration && pause.endMs - pause.startMs >= 199.9)
    .sort((a, b) => a.startMs - b.startMs)
    .map(pause => {
      const boundaries = orderedTimes.slice(1).flatMap((right, i) => {
        const left = orderedTimes[i];
        if (right.index !== left.index + 1 || left.startMs >= pause.startMs || right.startMs < pause.endMs - 80
          || right.startMs - pause.endMs > 250) return [];
        // Caption ends are next-word estimates, often including silence: never treat them as measured ends.
        if ((isServer || isLocalAligned) && (left.endMs > pause.startMs + 80 || pause.startMs - left.endMs > 250)) return [];
        return [left.index];
      });
      return { ...pause, afterWord: boundaries.length === 1 ? boundaries[0] : null };
    });
  // Two gaps pointing to one boundary are ambiguous; retain their measured times without a text claim.
  for (const pause of pauses) if (pause.afterWord !== null
    && pauses.filter(other => other.afterWord === pause.afterWord).length > 1) {
    const boundary = pause.afterWord;
    for (const other of pauses) if (other.afterWord === boundary) other.afterWord = null;
  }
  return { usable: Boolean(usable), approximate: !isServer && !isLocalAligned, pauses, aligned: orderedTimes.length > 0 };
}
