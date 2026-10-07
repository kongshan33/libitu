"use client";

import { Button } from "@/components/ui/button";

import { useAuth } from "@clerk/nextjs";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPracticeApi, type PracticeApi } from "./practice-api";
import { PracticeOutbox, type PracticeSaveState } from "./practice-outbox";
import { createReferenceApi, type ReferenceApi } from "../server-reference/api";
import { CaptureUploads } from '../server-reference/capture-uploads';

const Context = createContext<{ api: PracticeApi; referenceApi: ReferenceApi; outbox: PracticeOutbox; state: PracticeSaveState;
  analyze: boolean; setAnalyze(value: boolean): void; captures: CaptureUploads; captureVersion: number;
  analyzeReference: boolean; setAnalyzeReference(value: boolean): void } | null>(null);

type AccountResources = {
  owner: string; api: PracticeApi; referenceApi: ReferenceApi;
  outbox: PracticeOutbox; captures: CaptureUploads;
};

/** Keep children mounted across authentication and client-side route changes. */
export function PracticePersistence({ children }: { children: ReactNode }) {
  const { isLoaded, userId, getToken } = useAuth();
  const [resources, setResources] = useState<AccountResources | null>(null);
  const [state, setState] = useState<PracticeSaveState>({ pending: 0, errors: [], savedVersion: 0 });
  const [captureVersion, setCaptureVersion] = useState(0);
  const [preferences, setPreferences] = useState({ owner: "", analyze: false, analyzeReference: false });
  const active = isLoaded && resources?.owner === userId ? resources : null;
  const analyze = Boolean(active && preferences.owner === active.owner && preferences.analyze);
  const analyzeReference = Boolean(active && preferences.owner === active.owner && preferences.analyzeReference);

  useEffect(() => {
    if (!isLoaded || !userId) return;
    const api = createPracticeApi(userId, getToken);
    const referenceApi = createReferenceApi(userId, getToken);
    const outbox = new PracticeOutbox(api);
    const captures = new CaptureUploads(referenceApi);
    let live = true;
    const offSaves = outbox.subscribe(value => { if (live) setState(value); });
    const offCaptures = captures.subscribe(() => { if (live) setCaptureVersion(value => value + 1); });
    let analyze = false, analyzeReference = false;
    try { analyze = localStorage.getItem(`libitu:analysis-consent:${userId}`) === "practice-analysis-v1"; } catch { /* Session-only preference. */ }
    try { analyzeReference = localStorage.getItem(`libitu:reference-consent:${userId}`) === "reference-analysis-v1"; } catch { /* Session-only preference. */ }
    setPreferences({ owner: userId, analyze, analyzeReference });
    setState(outbox.state);
    setCaptureVersion(0);
    setResources({ owner: userId, api, referenceApi, outbox, captures });
    return () => {
      live = false;
      offSaves(); offCaptures();
      outbox.dispose(); captures.dispose();
    };
  }, [isLoaded, userId, getToken]);

  function setAnalyze(value: boolean) {
    if (!active) return;
    setPreferences(current => ({ ...current, owner: active.owner, analyze: value }));
    try { if (value) localStorage.setItem(`libitu:analysis-consent:${active.owner}`, "practice-analysis-v1");
      else localStorage.removeItem(`libitu:analysis-consent:${active.owner}`); } catch { /* Session-only preference. */ }
  }
  function setAnalyzeReference(value: boolean) {
    if (!active) return;
    setPreferences(current => ({ ...current, owner: active.owner, analyzeReference: value }));
    try { if (value) localStorage.setItem(`libitu:reference-consent:${active.owner}`, "reference-analysis-v1");
      else localStorage.removeItem(`libitu:reference-consent:${active.owner}`); } catch { /* Session-only preference. */ }
  }
  useEffect(() => {
    function warn(event: BeforeUnloadEvent) {
      if (active?.outbox.state.pending || active?.captures.pending) { event.preventDefault(); event.returnValue = ""; }
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  return <Context.Provider value={active ? { api: active.api, referenceApi: active.referenceApi, outbox: active.outbox,
    captures: active.captures, state, analyze, setAnalyze, captureVersion, analyzeReference, setAnalyzeReference } : null}>
    {active?.captures.pending ? <div className="practice-save-banner" role="status">Preparing reference audio… Keep this page open until the upload finishes.</div> : null}
    {active && state.pending ? <div className="practice-save-banner" role={state.errors.length ? "alert" : "status"}>
      {state.errors.length ? `${state.pending} take(s) need saving. ${state.errors[0].message}` : `Saving ${state.pending} practice take(s)…`}
      <span> Keep this page open and stay signed in until saving finishes.</span>
      {state.errors.length ? <Button variant="secondary" size="inherit" type="button" onClick={() => active.outbox.retry()}>Retry saves</Button> : null}
    </div> : null}
    {children}
  </Context.Provider>;
}

export function usePracticePersistence() { return useContext(Context); }
