import type { StageOneSegment, TranscriptLine } from "@libitu/types/stage-one";
import type { SentenceUnit } from "@libitu/types/stage-two";
import { parseTimestamp } from "../stage-one/timeline.ts";

type SourceToken = { text: string; index: number; row: number; startMs: number; endMs: number };
type CaptionGroup = { startMs: number; tokens: SourceToken[] };

/** Finalized server rows are the same sentence units shown in Stage 1. */
export function buildSentenceUnits(
  contentId: string,
  segment: StageOneSegment,
  transcript: readonly TranscriptLine[]
): SentenceUnit[] {
  const { startMs, endMs } = segment;
  if (startMs === undefined || endMs === undefined || !Number.isFinite(startMs)
    || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) return [];

  if (transcript.some((line) => line.segmentationVersion !== undefined
    || line.sourceTokenStart !== undefined || line.sourceTokenEnd !== undefined)) {
    return buildSharedSentenceUnits(contentId, segment, transcript);
  }

  return buildLegacySentenceUnits(contentId, segment, transcript);
}

function buildSharedSentenceUnits(
  contentId: string,
  segment: StageOneSegment,
  transcript: readonly TranscriptLine[]
): SentenceUnit[] {
  const first = segment.transcriptStartIndex;
  const last = segment.transcriptEndIndex;
  const hasRange = Number.isInteger(first) && Number.isInteger(last)
    && first! >= 0 && last! > first! && last! <= transcript.length;
  let tokenIndex = 0;
  const rows = transcript.map((line, row) => {
    const text = line.parts.map((part) => typeof part === "string" ? part : part.text).join("");
    const count = text.match(/\S+/g)?.length ?? 0;
    const fallbackTokenStart = tokenIndex;
    const validSourceRange = Number.isInteger(line.sourceTokenStart) && line.sourceTokenStart! >= 0
      && Number.isInteger(line.sourceTokenEnd) && line.sourceTokenEnd! > line.sourceTokenStart!;
    tokenIndex = validSourceRange ? line.sourceTokenEnd! : tokenIndex + count;
    const seconds = parseTimestamp(line.time);
    const startMs = Number.isFinite(line.startMs) && line.startMs! >= 0 ? line.startMs!
      : seconds !== null && seconds >= 0 ? seconds * 1000 : null;
    return { line, row, text, count, fallbackTokenStart, validSourceRange, startMs };
  });
  const units: SentenceUnit[] = [];
  const ids = new Set<string>();
  for (const entry of rows) {
    const { line, row, text, count, validSourceRange } = entry;
    const startMs = entry.startMs ?? units.at(-1)?.endMs ?? segment.startMs!;
    const validTiming = Number.isFinite(line.startMs) && line.startMs! >= 0
      && Number.isFinite(line.endMs) && line.endMs! > line.startMs!;
    // Damaged or mixed responses retain whole rows. Only timing is estimated again.
    const endMs = validTiming ? line.endMs! : rows.slice(row + 1)
      .find((next) => next.startMs !== null && next.startMs > startMs)?.startMs ?? segment.endMs!;
    const included = hasRange ? row >= first! && row < last!
      : startMs < segment.endMs! && endMs > segment.startMs!;
    if (!included || !count || endMs <= startMs) continue;

    const sourceTokenStart = validSourceRange ? line.sourceTokenStart! : entry.fallbackTokenStart;
    const sourceTokenEnd = validSourceRange ? line.sourceTokenEnd! : sourceTokenStart + count;
    const version = line.segmentationVersion;
    const validIdentity = typeof line.id === "string" && line.id.length > 0 && !ids.has(line.id);
    const complete = Boolean(version) && validIdentity && validSourceRange && validTiming;
    const id = validIdentity ? line.id! : `sentence-row-${fingerprint(JSON.stringify([
      contentId, version, row, text, sourceTokenStart, sourceTokenEnd, startMs, endMs
    ]))}`;
    ids.add(id);
    units.push({
      id,
      segmentId: segment.id,
      text,
      sourceTokenStart,
      sourceTokenEnd,
      transcriptStartIndex: row,
      transcriptEndIndex: row + 1,
      // Server bounds may extend beyond an older segment estimate; never cut a sentence.
      startMs,
      endMs,
      timingSource: line.timingSource ?? "caption_estimate",
      // A fallback source range must never make sparse provider words appear aligned.
      wordTimings: validSourceRange ? line.wordTimings : undefined,
      timingConfidence: "approximate",
      segmentationVersion: version,
      boundarySource: complete ? line.boundarySource : "unresolved",
      boundaryConfidence: complete ? line.boundaryConfidence : "low"
    });
  }
  return units;
}

/** Compatibility for cached blueprints without server sentence metadata. */
function buildLegacySentenceUnits(
  contentId: string,
  segment: StageOneSegment,
  transcript: readonly TranscriptLine[]
): SentenceUnit[] {
  const startMs = segment.startMs!;
  const endMs = segment.endMs!;

  const first = segment.transcriptStartIndex;
  const last = segment.transcriptEndIndex;
  const hasRange = Number.isInteger(first) && Number.isInteger(last)
    && first! >= 0 && last! > first! && last! <= transcript.length;
  const groups: CaptionGroup[] = [];
  let tokenIndex = 0;
  for (const [row, line] of transcript.entries()) {
    const words = line.parts.flatMap((part) => [typeof part === "string" ? part : part.text])
      .join("").match(/\S+/g) ?? [];
    const seconds = parseTimestamp(line.time);
    const time = seconds !== null && seconds >= 0 ? seconds * 1000 : null;
    const included = hasRange ? row >= first! && row < last!
      : time !== null && time >= startMs && time < endMs;
    if (included && words.length && (time === null || time < endMs)) {
      const previous = groups.at(-1);
      const anchor = Math.max(startMs, time ?? previous?.startMs ?? startMs);
      let group = previous;
      // Same-timestamp rows and untimed continuations share one estimated interval.
      if (!group || anchor > group.startMs) {
        group = { startMs: anchor, tokens: [] };
        groups.push(group);
      }
      group.tokens.push(...words.map((text, offset) => ({
        text, index: tokenIndex + offset, row, startMs: 0, endMs: 0
      })));
    }
    tokenIndex += words.length;
  }

  const tokens: SourceToken[] = [];
  for (const [index, group] of groups.entries()) {
    const nextStart = groups[index + 1]?.startMs ?? endMs;
    const duration = nextStart - group.startMs;
    if (duration <= 0) continue;
    group.tokens.forEach((token, offset) => {
      token.startMs = group.startMs + duration * offset / group.tokens.length;
      token.endMs = group.startMs + duration * (offset + 1) / group.tokens.length;
      tokens.push(token);
    });
  }
  if (!tokens.length) return [];

  const text = tokens.map((token) => token.text).join(" ");
  const spans = splitSentences(text);
  // Version the exact source and timing inputs. Repeated sentences have distinct token ranges.
  const version = fingerprint(JSON.stringify([contentId, segment.id, startMs, endMs,
    groups.map((group) => [group.startMs, group.tokens.map((token) => [token.text, token.index, token.row])])
  ]));
  let cursor = 0;
  return spans.map((sentence) => {
    const count = sentence.split(/\s+/).length;
    const sentenceTokens = tokens.slice(cursor, cursor + count);
    cursor += count;
    const beginning = sentenceTokens[0];
    const ending = sentenceTokens.at(-1)!;
    return {
      id: `sentence-v1-${version}-${beginning.index}-${ending.index + 1}`,
      segmentId: segment.id,
      text: sentence,
      sourceTokenStart: beginning.index,
      sourceTokenEnd: ending.index + 1,
      transcriptStartIndex: beginning.row,
      transcriptEndIndex: ending.row + 1,
      startMs: beginning.startMs,
      endMs: ending.endMs,
      timingSource: "caption_estimate",
      timingConfidence: "approximate"
    };
  });
}

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const endings = /[.!?]+["'”’)\]]*(?=\s|$)/g;
  let start = 0;
  for (const match of text.matchAll(endings)) {
    const end = match.index + match[0].length;
    const prefix = text.slice(start, end);
    const next = text.slice(end).trimStart();
    const lastWord = prefix.trim().split(/\s+/).at(-1) ?? "";
    if (next && match[0] === "." && (
      /^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|e\.g|i\.e)\.$/i.test(lastWord)
      || /^[A-Z]\.$/.test(lastWord)
      || (/^(?:[A-Za-z]\.){2,}$/.test(lastWord) && /^[a-z]/.test(next))
    )) continue;
    sentences.push(prefix.trim());
    start = end;
  }
  const remainder = text.slice(start).trim();
  if (remainder) sentences.push(remainder);
  return sentences;
}

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

export function sentenceAtTime(sentences: readonly SentenceUnit[], milliseconds: number): SentenceUnit | null {
  return sentences.find((sentence) => milliseconds >= sentence.startMs && milliseconds < sentence.endMs) ?? null;
}
