"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AcousticFeatures } from "../acoustics/types";

type Result = {
  source: Blob | string | null;
  startMs?: number;
  endMs?: number;
  attempt: number;
  features: AcousticFeatures | null;
  error: string | null;
};

/** Object URLs refer only to this page's temporary microphone recordings. */
export function useAudioFeatures(source: Blob | string | null, window?: { startMs: number; endMs: number }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const startMs = window?.startMs;
  const endMs = window?.endMs;
  useEffect(() => {
    // Drop the previous Blob/features as well as hiding them when the source is cleared.
    setResult(null);
    if (!source) return;
    const abort = new AbortController();
    async function analyze() {
      try {
        if (typeof source === "string" && !source.startsWith("blob:")) throw new Error("Only a local recording can be analyzed.");
        const blob = typeof source === "string"
          ? await (await fetch(source, { signal: abort.signal })).blob() : source!;
        const { analyzeLocalAudio } = await import("../acoustics/client");
        if (abort.signal.aborted) return;
        const features = await analyzeLocalAudio(blob, abort.signal,
          startMs !== undefined && endMs !== undefined ? { startMs, endMs } : undefined);
        if (!abort.signal.aborted) setResult({ source, startMs, endMs, attempt, features, error: null });
      } catch (error) {
        if (!abort.signal.aborted) setResult({ source, startMs, endMs, attempt, features: null,
          error: error instanceof Error ? error.message : "Local analysis failed. Try again." });
      }
    }
    void analyze();
    return () => abort.abort();
  }, [source, startMs, endMs, attempt]);
  const current = source && result?.source === source && result.startMs === startMs
    && result.endMs === endMs && result.attempt === attempt ? result : null;
  const pending = Boolean(source && !current);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return useMemo(() => ({ features: current?.features ?? null, error: current?.error ?? null, pending, retry }),
    [current, pending, retry]);
}
