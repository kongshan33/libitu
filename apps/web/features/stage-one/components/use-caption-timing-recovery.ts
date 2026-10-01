"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LearnerLevel, StageOneBlueprint } from "@libitu/types/stage-one";
import { captionTimingCoverage } from "../../playback/caption-timing-availability";
import { captionVideoId, freshCaptionSourceMatches, requestFreshCaptions, freshCaptionFailureMessages as failureMessage } from "../api/fresh-captions";
import { updateCaptionTiming } from "../api/stage-one-api";

export type CaptionRecoveryState = { phase: "idle" | "checking" | "updating" | "failed" | "ready" | "applied"; message?: string };
type State = CaptionRecoveryState & { key: string; blueprint?: StageOneBlueprint };

/** One automatic attempt per source visit, independent of page load and practice selection. */
export function useCaptionTimingRecovery(blueprint: StageOneBlueprint | null, options: {
  ready: boolean; applyWhenPaused: boolean; language?: string; learnerLevel?: LearnerLevel;
  onApply(blueprint: StageOneBlueprint): boolean;
}) {
  const { applyWhenPaused, onApply } = options;
  const videoId = captionVideoId(blueprint?.sourceUrl);
  const key = blueprint && videoId ? JSON.stringify([blueprint.contentId, videoId]) : "";
  const coverage = useMemo(() => captionTimingCoverage(blueprint?.transcript ?? []), [blueprint?.transcript]);
  const eligible = options.ready && Boolean(key) && coverage.totalWords > 0 && coverage.timedWords === 0;
  const [state, setState] = useState<State>({ key: "", phase: "idle" });
  const [retryVersion, setRetryVersion] = useState(0);
  const attempted = useRef<{ key: string; retry: number } | null>(null);
  const current = useRef({ blueprint, options, videoId });
  useEffect(() => { current.current = { blueprint, options, videoId }; });

  useEffect(() => {
    if (!eligible || attempted.current?.key === key && attempted.current.retry === retryVersion) return;
    const controller = new AbortController();
    async function recover() {
      // Strict Mode cleanup can cancel the disposable first setup before any bridge request.
      await Promise.resolve();
      if (controller.signal.aborted) return;
      const { blueprint: original, options: latest, videoId: video } = current.current;
      if (!original?.sourceUrl || !video) return;
      const source = { contentId: original.contentId, sourceUrl: original.sourceUrl, videoId: video, language: latest.language };
      attempted.current = { key, retry: retryVersion };
      setState({ key, phase: "checking" });
      try {
        const captions = await requestFreshCaptions(source, controller.signal);
        controller.signal.throwIfAborted();
        if (captions.status !== "ready" || !captions.captionTrack) {
          setState({ key, phase: "failed", message: failureMessage[captions.status === "ready" ? "unavailable" : captions.status] });
          return;
        }
        if (!freshCaptionSourceMatches(source)) throw new Error(failureMessage.stale);
        setState({ key, phase: "updating" });
        const result = await updateCaptionTiming(source.contentId, captions.captionTrack,
          { signal: controller.signal, learnerLevel: latest.learnerLevel });
        controller.signal.throwIfAborted();
        if (!freshCaptionSourceMatches(source) || result.blueprint.contentId !== source.contentId
          || captionVideoId(result.blueprint.sourceUrl) !== source.videoId) throw new Error(failureMessage.stale);
        if (!captionTimingCoverage(result.blueprint.transcript).timedWords) {
          throw new Error("These captions still have no usable word timing. You can continue sentence playback and retry later.");
        }
        setState({ key, phase: "ready", blueprint: result.blueprint });
      } catch (error) {
        if (!controller.signal.aborted) setState({ key, phase: "failed", message: error instanceof Error ? error.message : "Word timing could not be recovered. Please retry." });
      }
    }
    void recover();
    return () => controller.abort();
  }, [eligible, key, retryVersion]);

  useEffect(() => {
    if (!applyWhenPaused || state.key !== key || state.phase !== "ready" || !state.blueprint) return;
    const { blueprint: active, videoId: video } = current.current;
    if (!active?.sourceUrl || !video || !freshCaptionSourceMatches({ contentId: active.contentId, sourceUrl: active.sourceUrl, videoId: video })) return;
    if (onApply(state.blueprint)) setState({ key, phase: "applied" });
  }, [key, applyWhenPaused, onApply, state]);

  const retry = useCallback(() => setRetryVersion((version) => version + 1), []);
  return { state: state.key === key ? state : { phase: "idle" as const }, retry };
}
