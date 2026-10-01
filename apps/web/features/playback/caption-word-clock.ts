import type { CaptionTimingSource, CaptionWordTiming } from "@libitu/types/stage-one";

// An estimate spanning a long gap is unsuitable for karaoke UI. Abstain instead of
// shortening it: this is a display confidence bound, not detection of acoustic silence.
const MAX_ESTIMATED_WORD_INTERVAL_MS = 2000;

export type QualifiedCaptionWord = {
  index: number;
  startMs: number;
  endMs: number;
  charStart: number;
  charEnd: number;
};

/** Map provider tokens to exact displayed text, without estimating any missing word. */
export function qualifyCaptionWords(text: string, sourceTokenStart: number | undefined,
  timingSource: CaptionTimingSource | undefined, timings: readonly CaptionWordTiming[] | undefined): QualifiedCaptionWord[] {
  if (timingSource !== "caption_word_offsets" || !Number.isInteger(sourceTokenStart)
    || sourceTokenStart! < 0 || !timings?.length) return [];
  const tokens = Array.from(text.matchAll(/\S+/g));
  const occurrences = new Map<number, number>();
  for (const word of timings) occurrences.set(word.sourceTokenIndex, (occurrences.get(word.sourceTokenIndex) ?? 0) + 1);
  const words: QualifiedCaptionWord[] = [];
  for (const word of timings) {
    const token = tokens[word.sourceTokenIndex - sourceTokenStart!];
    if (!Number.isInteger(word.sourceTokenIndex) || occurrences.get(word.sourceTokenIndex) !== 1
      || !token || word.text !== token[0] || word.startSource !== "caption_offset"
      || !["next_word_estimate", "event_end_estimate"].includes(word.endSource ?? "")
      || !Number.isInteger(word.sourceEventIndex) || word.sourceEventIndex < 0
      || !Number.isInteger(word.sourceSegIndex) || word.sourceSegIndex < 0
      || !Number.isFinite(word.startMs) || word.startMs < 0
      || word.endMs === null || !Number.isFinite(word.endMs) || word.endMs <= word.startMs
      || word.endMs - word.startMs > MAX_ESTIMATED_WORD_INTERVAL_MS) continue;
    words.push({ index: word.sourceTokenIndex, startMs: word.startMs, endMs: word.endMs,
      charStart: token.index, charEnd: token.index + token[0].length });
  }
  words.sort((a, b) => a.startMs - b.startMs || a.index - b.index);
  // Overlapping provider ranges are ambiguous, including distinct words with equal starts.
  const ambiguous = new Set<QualifiedCaptionWord>();
  let furthest: QualifiedCaptionWord | undefined;
  for (const word of words) {
    if (furthest && word.startMs < furthest.endMs) { ambiguous.add(furthest); ambiguous.add(word); }
    if (!furthest || word.endMs > furthest.endMs) furthest = word;
  }
  return words.filter((word) => !ambiguous.has(word));
}

/** Half-open intervals: a word is no longer active at its end, including in gaps. */
export function captionWordAtTime(words: readonly QualifiedCaptionWord[], timeMs: number): number | null {
  if (!Number.isFinite(timeMs)) return null;
  let left = 0;
  let right = words.length - 1;
  let match: QualifiedCaptionWord | undefined;
  while (left <= right) {
    const middle = (left + right) >>> 1;
    if (words[middle].startMs <= timeMs) { match = words[middle]; left = middle + 1; }
    else right = middle - 1;
  }
  return match && timeMs < match.endMs ? match.index : null;
}

export type CaptionClockSample = { timeMs: number; playing: boolean };

/** A local, imperative clock: its 50 ms samples never become page-level React state. */
export class CaptionWordClock {
  private sample: CaptionClockSample = { timeMs: 0, playing: false };
  private listeners = new Set<(sample: CaptionClockSample) => void>();

  publish(timeSeconds: number, playing: boolean) {
    this.sample = { timeMs: timeSeconds * 1000, playing: playing && Number.isFinite(timeSeconds) };
    for (const listener of this.listeners) listener(this.sample);
  }

  reset() { this.publish(0, false); }

  subscribe(listener: (sample: CaptionClockSample) => void): () => void {
    this.listeners.add(listener);
    listener(this.sample);
    return () => { this.listeners.delete(listener); };
  }
}
