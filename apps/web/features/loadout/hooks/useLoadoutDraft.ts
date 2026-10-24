"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useClerk } from "@clerk/nextjs";
import { acknowledgeSubmission, adoptDeviceDraft, DraftConflictError, draftSignature, emptyDraft, LOADOUT_STORAGE_KEY, openDraft, saveDraft, type LoadoutDraft } from "../draft";

type State = { owner: string | null; ready: boolean; draft: LoadoutDraft; deviceDrafts: LoadoutDraft[]; error: string | null };
function message(error: unknown) { return error instanceof Error ? error.message : "Your loadout could not be saved on this device. Please retry."; }

export function useLoadoutDraft(owner: string | null, authLoaded: boolean) {
  const clerk = useClerk();
  const [state, setState] = useState<State>({ owner: null, ready: false, draft: emptyDraft(), deviceDrafts: [], error: null });
  const [reload, setReload] = useState(0);
  const [pendingWrites, setPendingWrites] = useState(0);
  const stateRef = useRef(state);
  const generation = useRef(0);
  const revision = useRef(0);
  const pendingSaves = useRef(0);
  const lifetime = useRef<{ mounted: boolean; warn: ((event: BeforeUnloadEvent) => void) | null }>({ mounted: false, warn: null });
  const publish = useCallback((value: State) => { stateRef.current = value; setState(value); }, []);

  useEffect(() => {
    const currentLifetime = lifetime.current;
    currentLifetime.mounted = true;
    function warn(event: BeforeUnloadEvent) {
      if (pendingSaves.current) { event.preventDefault(); event.returnValue = ""; }
    }
    currentLifetime.warn = warn;
    window.addEventListener("beforeunload", warn);
    return () => {
      currentLifetime.mounted = false;
      // Keep the unload warning while a route-independent queued write finishes.
      if (!pendingSaves.current) window.removeEventListener("beforeunload", warn);
    };
  }, []);

  useEffect(() => {
    if (!authLoaded) return;
    let active = true;
    const currentGeneration = ++generation.current;
    revision.current++;
    publish({ owner, ready: false, draft: emptyDraft(), deviceDrafts: [], error: null });
    async function read() {
      try {
        const result = await openDraft(window.localStorage, owner, true, { isCurrent: () => active && generation.current === currentGeneration });
        if (result && active) publish({ owner, ready: true, ...result, error: null });
      } catch (error) { if (active) publish({ owner, ready: false, draft: emptyDraft(), deviceDrafts: [], error: message(error) }); }
    }
    void read();
    async function onStorage(event: StorageEvent) {
      if (event.key !== LOADOUT_STORAGE_KEY || !active) return;
      // An external write must not replace a field edit that is waiting for its lock.
      if (pendingSaves.current) return;
      const currentRevision = revision.current;
      try {
        const result = await openDraft(window.localStorage, owner, false, { isCurrent: () => active });
        if (result && active && revision.current === currentRevision && !pendingSaves.current) {
          // Another account can change the envelope without changing this draft.
          const stableDraft = JSON.stringify(result.draft) === JSON.stringify(stateRef.current.draft) ? stateRef.current.draft : result.draft;
          publish({ owner, ready: true, ...result, draft: stableDraft, error: null });
        }
      } catch (error) { if (active && revision.current === currentRevision) publish({ ...stateRef.current, error: message(error) }); }
    }
    window.addEventListener("storage", onStorage);
    return () => { active = false; generation.current = currentGeneration + 1; window.removeEventListener("storage", onStorage); };
  }, [owner, authLoaded, reload, publish]);

  const current = authLoaded && state.owner === owner;
  function finishWrite() {
    pendingSaves.current -= 1;
    if (lifetime.current.mounted) setPendingWrites((value) => value - 1);
    else if (!pendingSaves.current && lifetime.current.warn) window.removeEventListener("beforeunload", lifetime.current.warn);
  }
  async function update(draft: LoadoutDraft, expectedDraft?: LoadoutDraft, optimistic = true): Promise<boolean> {
    const previous = stateRef.current;
    if (!authLoaded || previous.owner !== owner || !previous.ready) return false;
    // Async planning must not overwrite an edit delivered by another tab before
    // React has rendered that new state.
    if (expectedDraft && previous.draft !== expectedDraft) return false;
    const currentGeneration = generation.current;
    const currentRevision = ++revision.current;
    const isCurrent = () => generation.current === currentGeneration && stateRef.current.owner === owner;
    if (optimistic) publish({ ...previous, draft, error: null });
    pendingSaves.current += 1;
    setPendingWrites((value) => value + 1);
    try {
      // The owner is fixed when an edit is queued. Route unmounts may finish that
      // write; an actual account change cancels it. UI updates have a stricter fence.
      const saved = await saveDraft(window.localStorage, owner, draft, { expectedDraft, isCurrent: () => clerk.loaded && (clerk.user?.id ?? null) === owner });
      if (!saved || !isCurrent()) return false;
      if (revision.current === currentRevision) publish({ ...stateRef.current, draft, error: null });
      return revision.current === currentRevision;
    } catch (error) {
      if (error instanceof DraftConflictError) {
        const latest = await openDraft(window.localStorage, owner, false, { isCurrent }).catch(() => null);
        if (latest && isCurrent() && revision.current === currentRevision) publish({ owner, ready: true, ...latest, error: null });
        return false;
      }
      if (isCurrent() && revision.current === currentRevision) publish({ ...stateRef.current, error: "Your loadout could not be saved on this device. Free some browser storage, then retry saving." });
      return false;
    } finally { finishWrite(); }
  }
  async function confirmSubmission(expectedDraft: LoadoutDraft, clientId: string): Promise<LoadoutDraft | null> {
    const confirmed = acknowledgeSubmission(expectedDraft, clientId);
    // Keep the exact retry request in memory as well as storage until its
    // acknowledgement has been durably saved under the owner/draft lock.
    return await update(confirmed, expectedDraft, false) ? confirmed : null;
  }
  async function adopt(index: number) {
    if (!owner || !current) return;
    const currentGeneration = generation.current;
    const currentRevision = ++revision.current;
    const isCurrent = () => generation.current === currentGeneration && revision.current === currentRevision;
    pendingSaves.current += 1;
    setPendingWrites((value) => value + 1);
    try {
      const result = await adoptDeviceDraft(window.localStorage, owner, index, {
        isCurrent, expectedSignature: state.deviceDrafts[index] ? draftSignature(state.deviceDrafts[index]) : "unavailable"
      });
      if (result && isCurrent()) publish({ owner, ready: true, ...result, error: null });
    } catch (error) {
      if (isCurrent()) {
        const latest = await openDraft(window.localStorage, owner, false, { isCurrent }).catch(() => null);
        if (isCurrent()) publish({ ...stateRef.current, deviceDrafts: latest?.deviceDrafts ?? stateRef.current.deviceDrafts, error: message(error) });
      }
    } finally { finishWrite(); }
  }
  return {
    draft: current ? state.draft : emptyDraft(),
    ready: current && state.ready,
    pending: current && pendingWrites > 0,
    deviceDrafts: current ? state.deviceDrafts : [],
    error: current ? state.error : null,
    update,
    confirmSubmission,
    isCurrentDraft: (expected: LoadoutDraft) => stateRef.current.owner === owner && stateRef.current.draft === expected,
    adopt,
    retry: () => stateRef.current.ready ? update(stateRef.current.draft) : setReload((value) => value + 1)
  };
}
