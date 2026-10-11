"use client";

import { useCallback, useEffect, useState } from "react";
import { MISSING_REFERENCE_ANALYSIS, type ReferenceAnalysisCache } from "./reference-analysis-cache";

/** Observe the content-owned cache; buffered acquisition owns clip ingestion. */
export function useReferenceAnalysis(key: string | null, cache: ReferenceAnalysisCache) {
  const [, setRevision] = useState(0);
  useEffect(() => cache.subscribe(() => setRevision(value => value + 1)), [cache]);

  const retry = useCallback(() => key ? cache.retry(key) : false, [cache, key]);
  const retryAlignment = useCallback(() => key ? cache.retryAlignment(key) : false, [cache, key]);
  const invalidate = useCallback((targetKey: string | null = key) => {
    if (targetKey) cache.invalidate(targetKey);
  }, [cache, key]);
  const get = useCallback((targetKey: string) => cache.get(targetKey), [cache]);
  const has = useCallback((targetKey: string) => cache.has(targetKey), [cache]);
  const isReady = useCallback((targetKey: string) => cache.isReady(targetKey), [cache]);
  const current = key ? cache.get(key) : MISSING_REFERENCE_ANALYSIS;
  return { ...current, pending: current.phase === "analyzing", retry, retryAlignment, invalidate, get, has, isReady, cache };
}
