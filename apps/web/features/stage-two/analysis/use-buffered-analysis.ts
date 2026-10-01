"use client";

import { useEffect, useRef, useState } from "react";
import type { SentenceUnit } from "@libitu/types/stage-two";
import type { useBufferedReference } from "../reference/use-buffered-reference";
import { buildReferenceKey, type ReferenceAnalysisCache } from "./reference-analysis-cache";

/** Demand only a few sentences. A long segment must not churn the bounded LRU forever. */
export function useBufferedAnalysis(contentId: string, sourceUrl: string,
  sentences: SentenceUnit[], capture: ReturnType<typeof useBufferedReference> | undefined,
  cache: ReferenceAnalysisCache) {
  const [, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const rejected = useRef(new Set<string>());
  const source = JSON.stringify([contentId, sourceUrl]);
  useEffect(() => cache.subscribe(() => setRevision((value) => value + 1)), [cache]);
  useEffect(() => { rejected.current.clear(); setError(null); }, [source]);
  const phase = capture?.state.phase;
  const extract = capture?.extract;
  const covers = capture?.covers;
  const usage = cache.getUsage();
  const rawBytes = usage.rawBytes;

  // Three cheap checks per render keep coverage/cache updates visible, without
  // making an in-flight request depend on the identity of each coverage event.
  const sentence = covers && phase === "enabled" && usage.rawBlobs < 2
    ? sentences.slice(0, 3).find((item) => {
      const key = buildReferenceKey(contentId, sourceUrl, item.id, item.startMs, item.endMs);
      return item.endMs - item.startMs <= 60_000 && !cache.has(key) && !rejected.current.has(key)
        && covers({ start: item.startMs / 1000, end: item.endMs / 1000 });
    }) : undefined;

  useEffect(() => {
    if (!sentence || !extract) return;
    const key = buildReferenceKey(contentId, sourceUrl, sentence.id, sentence.startMs, sentence.endMs);
    const abort = new AbortController();
    void extract(sentence, abort.signal).then((clip) => {
      if (abort.signal.aborted) return;
      if (clip) { cache.ingest(key, clip, { contentId, sentenceId: sentence.id, text: sentence.text,
        startMs: sentence.startMs, endMs: sentence.endMs }); setError(null); }
      // The ring may have evicted data since its last coverage event. Never invent a clip.
    }).catch((cause: unknown) => {
      if (abort.signal.aborted) return;
      rejected.current.add(key);
      setError(cause instanceof Error ? cause.message : "Reference audio could not be prepared.");
    });
    return () => abort.abort();
  }, [contentId, sourceUrl, sentence, extract, cache, retryEpoch, rawBytes]);

  return { error, retry: () => { rejected.current.clear(); setError(null); setRetryEpoch((value) => value + 1); } };
}
