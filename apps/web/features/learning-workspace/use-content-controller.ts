"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ContentJobSummary, StageOneBlueprint } from "@libitu/types/stage-one";
import { parseLearningLocation } from "../navigation/learning-location";
import { useCurrentLocation } from "../navigation/use-current-location";
import { StageOneApiError, type StageOneAnalysisPreview } from "../stage-one/api/stage-one-api";
import { loadContentWorkspace, type WorkspaceSource } from "./controller";

function sourceAt(href: string): WorkspaceSource | null {
  const location = parseLearningLocation(new URL(href, "https://libitu.invalid"));
  if (location.kind === "invalid") throw new Error(location.message);
  if (location.kind === "landing" || location.kind === "import") return null;
  return { kind: "youtube", ...location.source, contentId: location.source.contentId!, sourceUrl: location.source.sourceUrl ?? "",
    title: location.source.title ?? "", learnerLevel: location.source.learnerLevel ?? "B1" };
}
function identity(source: WorkspaceSource | null) { return JSON.stringify(source); }

export function useContentController() {
  const location = useCurrentLocation();
  const [activation, setActivation] = useState<{ source: WorkspaceSource; retry?: ContentJobSummary } | null>(null);
  const acceptedLocation = useRef<string | null>(null);
  const resolved = useRef<WorkspaceSource | null>(null);
  const observed = useRef<ContentJobSummary | null>(null);
  const pendingRetry = useRef<ContentJobSummary | undefined>(undefined);
  const activeRequest = useRef<AbortController | null>(null);
  const [source, setSource] = useState<WorkspaceSource | null>(null);
  const [blueprint, setBlueprint] = useState<StageOneBlueprint | null>(null);
  const [analysisPreview, setAnalysisPreview] = useState<StageOneAnalysisPreview | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed" | "unsupported">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    try {
      const next = sourceAt(location);
      if (!next || identity(next) === acceptedLocation.current) return;
      acceptedLocation.current = identity(next);
      activeRequest.current?.abort();
      const sameContent = Boolean(next.contentId && next.contentId === resolved.current?.contentId
        && (!next.sourceUrl || next.sourceUrl === resolved.current?.sourceUrl));
      resolved.current = next;
      observed.current = null;
      pendingRetry.current = undefined;
      if (!sameContent) setSource(null);
      setBlueprint(null); setAnalysisPreview(null);
      setActivation({ source: next });
    } catch (error) {
      activeRequest.current?.abort();
      acceptedLocation.current = null;
      resolved.current = null;
      observed.current = null;
      pendingRetry.current = undefined;
      setActivation(null);
      setAnalysisPreview(null);
      setBlueprint(null); setSource(null); setStatus("failed");
      setErrorMessage(error instanceof Error ? error.message : "Invalid learning location.");
    }
  }, [location]);

  useEffect(() => {
    if (!activation) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    const live = () => !controller.signal.aborted;
    async function load() {
      await Promise.resolve(); // Strict Mode's discarded setup must not activate processing.
      if (!live()) return;
      setStatus("loading"); setErrorMessage(null); setAnalysisPreview(null);
      try {
        const result = await loadContentWorkspace(activation!.source, {
          signal: controller.signal, retry: activation!.retry,
          onRetryAccepted: () => { if (live()) pendingRetry.current = undefined; },
          onSource: next => {
            if (!live()) return;
            resolved.current = next;
            setSource(next);
          },
          onJob: job => { if (live()) observed.current = job; },
          onProgress: message => { if (live()) setErrorMessage(message); },
          onPreview: preview => { if (live()) setAnalysisPreview(preview); }
        });
        if (!live()) return;
        setBlueprint(result); setAnalysisPreview(null); setStatus("ready"); setErrorMessage(null);
      } catch (error) {
        if (!live()) return;
        if (error instanceof StageOneApiError && error.status === 409) pendingRetry.current = undefined;
        setStatus(error instanceof StageOneApiError ? error.kind : "failed");
        setErrorMessage(error instanceof Error ? error.message : "Unable to load this content.");
      }
    }
    void load();
    return () => { controller.abort(); };
  }, [activation]);

  const retryLoad = useCallback(() => {
    if (!resolved.current) return;
    activeRequest.current?.abort();
    pendingRetry.current ??= observed.current?.status === "failed" ? { ...observed.current } : undefined;
    setActivation({ source: resolved.current, retry: pendingRetry.current });
  }, []);
  return { source, blueprint, setBlueprint, analysisPreview, status, errorMessage, retryLoad };
}
