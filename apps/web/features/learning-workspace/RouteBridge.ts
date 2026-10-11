"use client";
import { useCallback, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { StageOneBlueprint } from "@libitu/types/stage-one";
import { parseLearningLocation, workspaceHref } from "../navigation/learning-location";
import { useCurrentLocation } from "../navigation/use-current-location";
import type { WorkspaceView } from "./ContentWorkspaceProvider";
import { useRoutePrefetch } from "../navigation/use-route-prefetch";

export function useWorkspaceRoute(blueprint: StageOneBlueprint | null) {
  const href = useCurrentLocation();
  const router = useRouter();
  const warm = useRoutePrefetch();
  const [isNavigating, startNavigation] = useTransition();
  const location = parseLearningLocation(new URL(href, "https://libitu.invalid"));
  const stageOneView: WorkspaceView = location.kind === "shadow" ? "shadow" : location.kind === "segments" ? location.step === "prepare" ? "preparing" : "picker" : "reader";
  const selectedSegmentId = "segmentId" in location ? location.segmentId ?? null : null;
  const navigate = useCallback((view: WorkspaceView, segmentId?: string, sentenceId?: string, replace = false) => {
    const target = workspaceHref(new URL(window.location.href), view, segmentId, sentenceId);
    startNavigation(() => router[replace ? "replace" : "push"](target, { scroll: false }));
    return target;
  }, [router]);
  const prefetch = useCallback((view: WorkspaceView, segmentId?: string, sentenceId?: string) => {
    warm(workspaceHref(new URL(window.location.href), view, segmentId, sentenceId));
  }, [warm]);
  useEffect(() => {
    if (!blueprint) return;
    if (stageOneView === "reader" && blueprint.segments.some(segment => typeof segment.startMs === "number" && typeof segment.endMs === "number" && segment.endMs > segment.startMs)) prefetch("picker");
    else if (stageOneView === "picker" && selectedSegmentId) prefetch("preparing", selectedSegmentId);
    if (stageOneView !== "reader") prefetch("reader");
  }, [blueprint, stageOneView, selectedSegmentId, prefetch]);
  const setSelectedSegmentId = useCallback((segmentId: string | null) => {
    navigate(stageOneView, segmentId ?? undefined, undefined, true);
  }, [navigate, stageOneView]);
  useEffect(() => {
    if (!blueprint || !selectedSegmentId) return;
    if (!blueprint.segments.some(segment => segment.id === selectedSegmentId && typeof segment.startMs === "number" && typeof segment.endMs === "number" && segment.endMs > segment.startMs)) navigate("reader", undefined, undefined, true);
  }, [blueprint, selectedSegmentId, navigate]);
  return { stageOneView, selectedSegmentId, setSelectedSegmentId, navigate, prefetch, isNavigating };
}
