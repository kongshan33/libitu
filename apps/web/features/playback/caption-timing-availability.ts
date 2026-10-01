import type { CaptionTimingSource, CaptionWordTiming, TranscriptPart } from "@libitu/types/stage-one";
import { qualifyCaptionWords } from "./caption-word-clock.ts";

export type CaptionTimingText = {
  text?: string;
  parts?: readonly TranscriptPart[];
  sourceTokenStart?: number;
  timingSource?: CaptionTimingSource;
  wordTimings?: readonly CaptionWordTiming[];
};

export type CaptionTimingCoverage = { totalWords: number; timedWords: number };
export type WordTimingNoticeState = {
  status: "unavailable" | "partial" | "off" | "hidden";
  title: string;
  detail: string;
};

/** Use exactly the highlighting gate, not merely the presence of raw offsets. */
export function captionTimingCoverage(rows: readonly CaptionTimingText[]): CaptionTimingCoverage {
  let totalWords = 0;
  let timedWords = 0;
  for (const row of rows) {
    const text = row.text ?? row.parts?.map((part) => typeof part === "string" ? part : part.text).join("") ?? "";
    totalWords += text.match(/\S+/g)?.length ?? 0;
    timedWords += qualifyCaptionWords(text, row.sourceTokenStart, row.timingSource, row.wordTimings).length;
  }
  return { totalWords, timedWords };
}

export function wordTimingNotice(coverage: CaptionTimingCoverage, options: {
  enabled?: boolean;
  concealed?: boolean;
  pending?: boolean;
} = {}): WordTimingNoticeState | null {
  if (!coverage.totalWords) return null;
  if (!coverage.timedWords) return {
    status: "unavailable",
    title: "Word timing unavailable",
    detail: "The current captions have no usable word-level timing. You can still listen and follow the sentences."
      + (options.pending ? " More captions are still loading." : "")
  };
  if (options.concealed) return {
    status: "hidden", title: "Word highlighting is hidden",
    detail: "Reveal the practice text to see timed words highlight during playback."
  };
  if (options.enabled === false) return {
    status: "off", title: "Word highlighting is off",
    detail: "Turn on Highlight active to see timed words highlight during playback."
  };
  if (coverage.timedWords < coverage.totalWords) return {
    status: "partial", title: "Partial word timing",
    detail: "Only words with usable timing will highlight. You can still listen to the full sentences."
      + (options.pending ? " More captions are still loading." : "")
  };
  return null;
}
