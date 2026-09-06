"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { createCorpusRemote } from "../api/corpus-api";
import type { CorpusSelectionAnalysis, CorpusSelectionContext } from "@libitu/types/stage-one";
import { CORPUS_STORAGE_KEY, CorpusStorage, type SavedCorpusRecord } from "../api/corpus-storage";

export function useSavedCorpus() {
  const { isLoaded, userId, getToken } = useAuth();
  const [storage] = useState(() => new CorpusStorage(() => window.localStorage));
  const [state, setState] = useState(storage.state);
  const [retry, setRetry] = useState(0);
  const owner = userId ?? null;

  useEffect(() => storage.subscribe(setState), [storage]);
  useEffect(() => {
    if (!isLoaded) return;
    const open = () => storage.open(owner, owner ? createCorpusRemote(owner, getToken) : null);
    // Avoid duplicate imports during development's setup/cleanup probe.
    let disposed = false;
    Promise.resolve().then(() => { if (!disposed) void open(); });
    const changed = (event: StorageEvent) => {
      if (event.key === CORPUS_STORAGE_KEY && !storage.state.busy) void open();
    };
    window.addEventListener("storage", changed);
    return () => {
      disposed = true;
      storage.close();
      window.removeEventListener("storage", changed);
    };
  }, [storage, owner, isLoaded, getToken, retry]);

  const current = isLoaded && state.owner === owner;
  return {
    records: current ? state.records : [],
    ready: Boolean(current && state.ready),
    busy: Boolean(!current || state.busy),
    error: current ? state.error : null,
    signedIn: Boolean(owner),
    save: (record: SavedCorpusRecord) => current ? storage.save(record) : Promise.resolve(false),
    hydrate: (
      record: SavedCorpusRecord,
      context: CorpusSelectionContext,
      analyze: () => Promise<CorpusSelectionAnalysis>,
    ) => current ? storage.hydrate(record, context, analyze) : Promise.resolve(null),
    remove: (record: SavedCorpusRecord) => current ? storage.remove(record) : Promise.resolve(false),
    retry: () => setRetry((value) => value + 1)
  };
}
