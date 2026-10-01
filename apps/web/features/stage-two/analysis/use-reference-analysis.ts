"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReferenceClip } from "../reference/reference-capture";
import { MISSING_REFERENCE_ANALYSIS, ReferenceAnalysisCache, referenceKeyMatchesClip, type ReferenceAlignmentSource } from "./reference-analysis-cache";

/** The cache belongs to this practice view, independently of the currently selected sentence. */
export function useReferenceAnalysis(key: string | null, clip: ReferenceClip | null, onAccepted?: (clip: ReferenceClip) => void,
  sharedCache?: ReferenceAnalysisCache, alignmentSource?: ReferenceAlignmentSource) {
  const [revision, setRevision] = useState(0);
  const [ownedCache] = useState(() => new ReferenceAnalysisCache());
  const cache = sharedCache ?? ownedCache;
  const accepted = useRef(onAccepted);
  const notified = useRef(new WeakSet<ReferenceClip>());
  const active = useRef(true);
  const sourceKey = alignmentSource ? JSON.stringify(alignmentSource) : null;
  useEffect(() => { accepted.current = onAccepted; }, [onAccepted]);

  useEffect(() => {
    active.current = true;
    const unsubscribe = cache.subscribe(() => setRevision((value) => value + 1));
    const clear = () => { active.current = false; if (!sharedCache) cache.clear(); };
    const resume = () => { active.current = true; setRevision((value) => value + 1); };
    window.addEventListener("pagehide", clear);
    window.addEventListener("pageshow", resume);
    return () => {
      active.current = false;
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("pageshow", resume);
      unsubscribe();
      if (!sharedCache) cache.dispose();
    };
  }, [cache, sharedCache]);

  useEffect(() => {
    if (!active.current || !key || !clip || !referenceKeyMatchesClip(key, clip)) return;
    const source = sourceKey ? JSON.parse(sourceKey) as ReferenceAlignmentSource : undefined;
    if (cache.ingest(key, clip, source) && !notified.current.has(clip)) {
      notified.current.add(clip);
      accepted.current?.(clip);
    }
    // A full two-clip queue can accept this clip when an older analysis finishes.
  }, [cache, key, clip, revision, sourceKey]);

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
