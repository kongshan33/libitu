"use client";

import { useEffect, useState } from "react";
import type { PracticeAnalysis, PracticeApi } from "./practice-api";

export function usePracticeAnalysis(api: PracticeApi | undefined, attemptId: string | null, savedVersion = 0) {
  const [state, setState] = useState<{ id: string; value: PracticeAnalysis | null; error: string | null } | null>(null);
  const [revision, refresh] = useState(0);
  useEffect(() => {
    if (!api || !attemptId) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await api!.analysis(attemptId!, abort.signal);
        if (abort.signal.aborted) return;
        setState({ id: attemptId!, value, error: null });
        if (value && ["awaiting_upload", "queued", "processing"].includes(value.state)) timer = setTimeout(poll, 2500);
      } catch (error) {
        if (!abort.signal.aborted) setState({ id: attemptId!, value: null, error: error instanceof Error ? error.message : "Analysis could not load." });
      }
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [api, attemptId, revision, savedVersion]);
  const current = state?.id === attemptId ? state : null;
  return { data: current?.value ?? null, error: current?.error ?? null, loading: Boolean(attemptId && !current),
    reload: () => refresh(value => value + 1) };
}
