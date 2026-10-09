"use client";

import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { CaptionTimingSource, CaptionWordTiming, TranscriptPart } from "@libitu/types/stage-one";
import { CaptionWordClock, captionWordAtTime, qualifyCaptionWords, type QualifiedCaptionWord } from "./caption-word-clock";

type Props = {
  text?: string;
  parts?: TranscriptPart[];
  sourceTokenStart?: number;
  timingSource?: CaptionTimingSource;
  wordTimings?: CaptionWordTiming[];
  clock: CaptionWordClock;
  className?: string;
  enabled?: boolean;
  onCorpusSelect?: (id: string) => void;
};

/** Text nodes retain exact source spelling/whitespace, including inside corpus buttons. */
export const CaptionTimedText = memo(function CaptionTimedText({ text, parts, sourceTokenStart, timingSource, wordTimings, clock, className, enabled = true, onCorpusSelect }: Props) {
  const root = useRef<HTMLSpanElement>(null);
  const displayText = text ?? parts?.map((part) => typeof part === "string" ? part : part.text).join("") ?? "";
  const words = useMemo(() => qualifyCaptionWords(displayText, sourceTokenStart, timingSource, wordTimings),
    [displayText, sourceTokenStart, timingSource, wordTimings]);
  useEffect(() => {
    const element = root.current;
    if (!element || !words.length || !enabled) return;
    const nodes = new Map<number, HTMLElement[]>();
    element.querySelectorAll<HTMLElement>("[data-caption-word-index]").forEach((node) => {
      const index = Number(node.dataset.captionWordIndex);
      nodes.set(index, [...nodes.get(index) ?? [], node]);
    });
    let active: number | null = null;
    const clear = () => { if (active !== null) nodes.get(active)?.forEach((node) => node.classList.remove("caption-word-active")); };
    const unsubscribe = clock.subscribe((sample) => {
      const next = sample.playing ? captionWordAtTime(words, sample.timeMs) : null;
      if (next === active) return;
      clear();
      active = next;
      if (active !== null) nodes.get(active)?.forEach((node) => node.classList.add("caption-word-active"));
    });
    return () => { unsubscribe(); clear(); };
  }, [clock, words, parts, enabled]);

  let offset = 0;
  return <span ref={root} className={className} data-caption-timing={words.length ? "word" : undefined}>
    {(parts ?? [displayText]).map((part, index) => {
      const value = typeof part === "string" ? part : part.text;
      const content = renderWords(value, offset, words);
      offset += value.length;
      return typeof part === "string" ? <span key={index}>{content}</span> : (
        <button className={`highlight ${part.kind}`} data-tag={part.tag} key={`${part.text}-${index}`}
          onClick={onCorpusSelect && part.corpusItemId ? (event) => {
            event.stopPropagation();
            onCorpusSelect(part.corpusItemId!);
          } : undefined}
          type="button" aria-label={`${part.kind}: ${part.text}. ${part.tag}`}>{content}</button>
      );
    })}
  </span>;
});

function renderWords(text: string, offset: number, words: readonly QualifiedCaptionWord[]): ReactNode {
  if (!words.length) return text;
  const spans = words.filter((word) => word.charStart < offset + text.length && word.charEnd > offset)
    .sort((a, b) => a.charStart - b.charStart);
  const pieces: ReactNode[] = [];
  let cursor = 0;
  for (const word of spans) {
    const start = Math.max(0, word.charStart - offset);
    const end = Math.min(text.length, word.charEnd - offset);
    if (cursor < start) pieces.push(text.slice(cursor, start));
    pieces.push(<span className="caption-word" data-caption-word-index={word.index} key={word.index}>{text.slice(start, end)}</span>);
    cursor = end;
  }
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return pieces;
}
