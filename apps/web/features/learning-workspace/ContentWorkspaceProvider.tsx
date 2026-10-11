"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import type { StageOneBlueprint } from "@libitu/types/stage-one";
import { BufferedReferenceProvider, useBufferedReference } from "../stage-two/reference/use-buffered-reference";
import { ReferenceAnalysisCache } from "../stage-two/analysis/reference-analysis-cache";
import { useCaptionTimingRecovery } from "../stage-one/components/use-caption-timing-recovery";
import { useContentController } from "./use-content-controller";
import { useWorkspaceRoute } from "./RouteBridge";
import { LearningLocationTracker } from "../profile/LearningLocationTracker";
import { MediaHost } from "./MediaHost";

export type WorkspaceView = "reader" | "picker" | "preparing" | "shadow";
function useWorkspace() {
  const content = useContentController();
  const { setBlueprint } = content;
  const { userId } = useAuth();
  const route = useWorkspaceRoute(content.blueprint);
  const { stageOneView } = route;
  const [isPlayerPlaying, setIsPlayerPlaying] = useState(false);
  const playing = useRef(false);
  const view = useRef(stageOneView);
  view.current = stageOneView;
  const handlePlaybackChange = useCallback((value: boolean) => { playing.current = value; setIsPlayerPlaying(value); }, []);
  const apply = useCallback((next: StageOneBlueprint) => {
    if (playing.current || view.current !== "reader") return false;
    setBlueprint(next); return true;
  }, [setBlueprint]);
  const timingRecovery = useCaptionTimingRecovery(content.blueprint, {
    ready: content.status === "ready", applyWhenPaused: stageOneView === "reader" && !isPlayerPlaying,
    language: content.source?.language, learnerLevel: content.source?.learnerLevel, onApply: apply
  });
  const contentId = content.blueprint?.contentId ?? content.source?.contentId ?? null;
  const sourceUrl = content.blueprint?.sourceUrl ?? content.source?.sourceUrl ?? null;
  const bufferedReference = useBufferedReference(contentId, sourceUrl);
  const referenceScope = useMemo(() => ({ identity: [contentId, sourceUrl, userId], cache: new ReferenceAnalysisCache() }), [contentId, sourceUrl, userId]);
  const sharedReferenceCache = referenceScope.cache;
  useEffect(() => () => sharedReferenceCache.dispose(), [sharedReferenceCache]);
  const captureGeneration = useRef(0);
  const suspend = bufferedReference.suspend;
  const disable = bufferedReference.disable;
  const suspendReference = useCallback(() => { suspend(); captureGeneration.current++; }, [suspend]);
  useEffect(() => { sharedReferenceCache.clear(); suspendReference(); }, [contentId, sourceUrl, sharedReferenceCache, suspendReference]);
  const previousOwner = useRef(userId);
  useEffect(() => {
    if (previousOwner.current && previousOwner.current !== userId) {
      disable(); sharedReferenceCache.clear(); captureGeneration.current++;
    }
    previousOwner.current = userId;
  }, [userId, disable, sharedReferenceCache]);
  return { ...content, ...route,
    isPlayerPlaying, handlePlaybackChange, timingRecovery, bufferedReference, sharedReferenceCache,
    captureGeneration, suspendReference };
}
const Context = createContext<ReturnType<typeof useWorkspace> | null>(null);

export function ContentWorkspaceProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const { isLoaded, userId } = useAuth();
  const sourceUrl = workspace.blueprint?.sourceUrl ?? workspace.source?.sourceUrl;
  return <Context.Provider value={workspace}>
    <LearningLocationTracker authLoaded={isLoaded} owner={userId} ready={workspace.status === "ready"}
      contentId={workspace.source?.contentId ?? null} sourceUrl={sourceUrl} title={workspace.blueprint?.title ?? workspace.source?.title ?? ""} />
    <BufferedReferenceProvider value={workspace.bufferedReference}>
      <MediaHost key={workspace.source?.contentId ?? "entry"} sourceUrl={sourceUrl} title={workspace.blueprint?.title ?? workspace.source?.title ?? "YouTube video"}>
        {children}
      </MediaHost>
    </BufferedReferenceProvider>
  </Context.Provider>;
}
export function useContentWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error("A content workspace is required.");
  return value;
}
