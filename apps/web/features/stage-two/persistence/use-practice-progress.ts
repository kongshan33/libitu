"use client";

import { useCallback, useEffect, useState } from "react";
import { usePracticePersistence } from "./PracticePersistence";
import type { PracticeApi, WordMatchCounts } from "./practice-api";

export function usePracticeProgress(contentId: string) {
  const persistence = usePracticePersistence();
  const api = persistence?.api;
  const version = persistence?.state.savedVersion ?? 0;
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<{ api: PracticeApi | undefined; content: string; ids: Set<string>; best: Record<string, WordMatchCounts> } | null>(null);
  const [request, setRequest] = useState<{ api: PracticeApi | undefined; content: string; loading: boolean; error: string | null } | null>(null);
  const reload = useCallback(() => setRefresh(value => value + 1), []);
  const markSaved = useCallback((sentence: string) => {
    setSnapshot(current => ({ api, content: contentId,
      best: current && current.api === api && current.content === contentId ? current.best : {},
      ids: new Set([...(current && current.api === api && current.content === contentId ? current.ids : []), sentence]) }));
  }, [api, contentId]);

  useEffect(() => {
    const abort = new AbortController();
    setRequest({ api, content: contentId, loading: Boolean(api), error: null });
    if (api) void api.progress(contentId, abort.signal).then(progress => {
      if (!abort.signal.aborted) setSnapshot({ api, content: contentId, ids: new Set(progress.practiced_sentence_ids), best: progress.best_word_matches ?? {} });
    }).catch(reason => {
      if (!abort.signal.aborted) setRequest({ api, content: contentId, loading: false,
        error: reason instanceof Error ? reason.message : "Practice progress could not load." });
    }).finally(() => {
      if (!abort.signal.aborted) setRequest(current => current ? { ...current, loading: false } : current);
    });
    return () => abort.abort();
  }, [api, contentId, version, refresh]);

  const ids = new Set(snapshot && snapshot.api === api && snapshot.content === contentId ? snapshot.ids : []);
  for (const pending of persistence?.state.pendingSentences ?? []) {
    if (pending.contentId === contentId) ids.add(pending.sentenceId);
  }
  const currentRequest = request && request.api === api && request.content === contentId ? request : null;
  const best = snapshot && snapshot.api === api && snapshot.content === contentId ? snapshot.best : {};
  return { ids, best, loading: Boolean(api && (!currentRequest || currentRequest.loading)),
    error: currentRequest?.error ?? null, reload, markSaved };
}
