"use client";

import { useEffect, useState } from "react";
import type { SoundAnnotation } from "@libitu/types/stage-two";
import { fetchSoundAnnotation, SoundGuideCache, soundSourceKey, type SoundSource } from "./sound-api";

export function useSoundGuide(contentId: string, sentenceId: string | null, text: string | null) {
  const [cache] = useState(() => new SoundGuideCache());
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; attempt: number; data: SoundAnnotation | null; error: string | null } | null>(null);
  const source: SoundSource | null = sentenceId && text ? { contentId, sentenceId, text } : null;
  const key = source ? soundSourceKey(source) : null;
  useEffect(() => () => cache.clear(), [cache]);
  useEffect(() => {
    setResult(null);
    if (!sentenceId || !text) return;
    const current = { contentId, sentenceId, text };
    const currentKey = soundSourceKey(current);
    const cached = cache.get(current);
    if (cached) { setResult({ key: currentKey, attempt, data: cached, error: null }); return; }
    const abort = new AbortController();
    void fetchSoundAnnotation(current, abort.signal).then((data) => {
      if (abort.signal.aborted) return;
      cache.set(current, data);
      setResult({ key: currentKey, attempt, data, error: null });
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) setResult({ key: currentKey, attempt, data: null,
        error: error instanceof Error ? error.message : "The sound guide could not load. Try again." });
    });
    return () => abort.abort();
  }, [contentId, sentenceId, text, attempt, cache]);
  const current = result?.key === key && result?.attempt === attempt ? result : null;
  return { data: current?.data ?? null, error: current?.error ?? null, pending: Boolean(source && !current),
    retry: () => setAttempt((value) => value + 1) };
}
