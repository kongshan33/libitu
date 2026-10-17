'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PracticeAnalysis, PracticeApi, PracticeAttempt } from '../persistence/practice-api';
import { loadHistoryPages } from '../persistence/history-pages';

export type QuickTake = {
  key: string; id: string | null; sentenceId: string; createdAt: string; requested: boolean;
  url?: string; recordingState?: PracticeAttempt['recording_state']; analysis?: PracticeAnalysis | null;
  loaded?: boolean; error?: string;
};
const pending = (take: QuickTake) => !take.loaded || Boolean(take.analysis && ['awaiting_upload', 'queued', 'processing'].includes(take.analysis.state));

/** Poll only the latest take per sentence and the selected historical take, with bounded concurrency. */
export function useQuickTakes(api: PracticeApi | undefined, content: string, review: boolean, selectedKey: string | null, sentences: readonly {id: string}[]) {
  const [takes, setTakes] = useState<QuickTake[]>([]);
  const current = useRef(takes);
  useEffect(() => { current.current = takes; }, [takes]);
  const [history, setHistory] = useState({ loading: false, error: '', revision: 0 });
  const live = useRef(true);
  const urls = useRef(new Map<string, {url: string; size: number}>());
  useEffect(() => {
    live.current = true;
    const cache = urls.current;
    return () => { live.current = false; for (const entry of cache.values()) URL.revokeObjectURL(entry.url); cache.clear(); };
  }, []);
  const add = useCallback((take: QuickTake, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urls.current.set(take.key, {url, size: blob.size});
    // A bounded session replay cache; retained recordings remain replayable from the account.
    while (urls.current.size > 30 || [...urls.current.values()].reduce((sum, entry) => sum + entry.size, 0) > 64 * 1024 * 1024) {
      const oldest = urls.current.keys().next().value!;
      URL.revokeObjectURL(urls.current.get(oldest)!.url); urls.current.delete(oldest);
    }
    setTakes(old => [{...take, url}, ...old.map(item => urls.current.has(item.key) ? item : {...item, url: undefined})]);
  }, []);
  const acknowledge = useCallback((key: string, id: string) => {
    if (live.current) setTakes(old => old.map(take => take.key === key ? {...take, id} : take));
  }, []);
  const refresh = useCallback((key?: string) => {
    setTakes(old => old.map(take => !key || take.key === key ? {...take, loaded: false} : take));
  }, []);
  useEffect(() => {
    if (!api || !review) return;
    const abort = new AbortController();
    setHistory(old => ({...old, loading: true, error: ''}));
    void (async () => {
      const progress = await api.progress(content, abort.signal);
      const allowed = new Set(sentences.map(sentence => sentence.id));
      const ids = progress.practiced_sentence_ids.filter(id => allowed.has(id));
      await Promise.all(Array.from({length: Math.min(4, ids.length)}, async () => {
        for (let sentence = ids.shift(); sentence; sentence = ids.shift()) {
          const page = await loadHistoryPages(api, content, sentence, Number.POSITIVE_INFINITY, null, abort.signal);
          if (abort.signal.aborted) return;
          setTakes(old => {
            const known = new Set(old.flatMap(take => take.id ? [take.id] : []));
            return [...old, ...page.items.filter(item => !known.has(item.id)).map(item => ({
              key: item.id, id: item.id, sentenceId: item.sentence_id, createdAt: item.created_at,
              requested: true, recordingState: item.recording_state,
            }))].sort((a,b) => b.createdAt.localeCompare(a.createdAt));
          });
        }
      }));
    })().catch(error => { if (!abort.signal.aborted) setHistory(old => ({...old, error: error instanceof Error ? error.message : 'History could not load.'})); })
      .finally(() => { if (!abort.signal.aborted) setHistory(old => ({...old, loading: false})); });
    return () => abort.abort();
  }, [api, content, review, history.revision, sentences]);
  useEffect(() => {
    if (!api) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const seen = new Set<string>();
      const jobs = current.current.filter(take => {
        const latest = !seen.has(take.sentenceId); seen.add(take.sentenceId);
        return take.id && (latest || take.key === selectedKey) && pending(take);
      });
      await Promise.all(Array.from({length: Math.min(4, jobs.length)}, async () => {
        for (let take = jobs.shift(); take; take = jobs.shift()) {
          const key = take.key;
          try {
            const analysis = await api!.analysis(take.id!, abort.signal);
            if (!abort.signal.aborted) setTakes(old => old.map(item => item.key === key ? {...item, analysis, requested: analysis !== null && item.requested, loaded: true, error: undefined} : item));
          } catch (error) {
            if (!abort.signal.aborted) setTakes(old => old.map(item => item.key === key ? {...item, error: error instanceof Error ? error.message : 'Analysis could not load.'} : item));
          }
        }
      }));
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 1800);
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [api, selectedKey]);
  return {takes, add, acknowledge, refresh, history, retryHistory: () => setHistory(old => ({...old, revision: old.revision + 1}))};
}
