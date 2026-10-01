"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { YouTubePlayerHandle } from "../../playback/youtube-controller";
import {
  ReferenceCaptureController, type ReferenceCaptureState, type ReferenceClip, type ReferenceRange, type ReferenceTelemetry
} from "./reference-capture";

export function useReferenceCapture(
  sentenceId: string | null,
  range: ReferenceRange | null,
  playerRef: RefObject<YouTubePlayerHandle | null>,
  beforeStart: () => void
) {
  const beforeStartRef = useRef(beforeStart);
  const [state, setState] = useState<ReferenceCaptureState>({
    sessionPhase: "idle", phase: "idle", sentenceId: null, clip: null, elapsedMs: 0, error: null, sessionError: null
  });
  const [controller] = useState(() => new ReferenceCaptureController({
    change: setState,
    prepare: (selectedRange) => {
      beforeStartRef.current();
      const player = playerRef.current;
      if (!player) throw new Error("Player unavailable");
      player.pause();
      player.setRange({ ...selectedRange, loop: false });
      player.setPlaybackRate(1);
      player.seekTo(selectedRange.start);
    },
    play: () => playerRef.current?.play(),
    pause: () => playerRef.current?.pause()
  }));

  useEffect(() => { beforeStartRef.current = beforeStart; }, [beforeStart]);
  const rangeStart = range?.start;
  const rangeEnd = range?.end;
  useEffect(() => {
    controller.setSentence(sentenceId, rangeStart !== undefined && rangeEnd !== undefined
      ? { start: rangeStart, end: rangeEnd } : null);
  }, [controller, sentenceId, rangeStart, rangeEnd]);

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      controller.handleMessage(event.data);
    }
    function hide() { controller.clear(); }
    function visibility() { if (document.visibilityState === "hidden") controller.cancel(); }
    window.addEventListener("message", receive);
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("message", receive);
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", visibility);
      controller.dispose();
    };
  }, [controller]);

  const actions = useMemo(() => ({
    enable: () => controller.enable(),
    disable: () => controller.disable(),
    play: () => controller.play(),
    cancel: () => controller.cancel(),
    clear: () => controller.clear(),
    isBusy: () => controller.isBusy(),
    setEligible: (eligible: boolean) => controller.setEligible(eligible),
    setReferenceReady: (ready: boolean) => controller.setReferenceReady(ready),
    releaseClip: (clip?: ReferenceClip) => controller.releaseClip(clip),
    sample: (telemetry: ReferenceTelemetry) => controller.sample(telemetry),
    changeSentence: (next: string | null, nextRange: ReferenceRange | null = null) => controller.setSentence(next, nextRange)
  }), [controller]);

  return { state, ...actions };
}
