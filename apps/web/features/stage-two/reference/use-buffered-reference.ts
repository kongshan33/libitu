"use client";

import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SentenceUnit } from "@libitu/types/stage-two";
import type { ReferenceRange, ReferenceTelemetry } from "./reference-types";
import { BufferedReferenceController, emptyBufferedReferenceState } from "./buffered-reference";

/** Mount above the Stage 1/picker/Stage 2 branches so one grant and buffer survive navigation. */
export function useBufferedReference(contentId: string | null, sourceUrl: string | null) {
  const sourceKey = contentId && sourceUrl ? JSON.stringify([contentId, sourceUrl]) : null;
  const [state, setState] = useState(emptyBufferedReferenceState);
  const [controller] = useState(() => new BufferedReferenceController(setState));

  useEffect(() => {
    controller.setSource(sourceKey);
    if (!sourceKey) return;
    const [contentId, sourceUrl] = JSON.parse(sourceKey) as [string, string];
    const videoId = new URL(sourceUrl).searchParams.get("v");
    const sessionId = crypto.randomUUID();
    // One independent verified registration records the resolved source for extension tab reuse.
    // It never arms capture or opens a source tab.
    window.postMessage({ type: "LIBITU_BUFFER_REQUEST", version: 4, action: "register", sessionId,
      requestId: sessionId, contentId, videoId }, window.location.origin);
  }, [controller, sourceKey]);

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.source === window && event.origin === window.location.origin) controller.handleMessage(event.data);
    }
    function hide() { controller.disable(); }
    function visibility() { if (document.visibilityState === "hidden") controller.suspend(); }
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
    sample: (telemetry: ReferenceTelemetry, generation: number) => {
      if (document.visibilityState === "hidden") return;
      controller.sample(telemetry, generation);
    },
    suspend: () => controller.suspend(),
    covers: (range: ReferenceRange) => controller.covers(range),
    extract: (sentence: SentenceUnit, signal?: AbortSignal) => controller.extract(sentence, signal)
  }), [controller]);

  return { state: state.sourceKey === sourceKey ? state : emptyBufferedReferenceState(sourceKey), ...actions };
}

export type BufferedReferenceSession = ReturnType<typeof useBufferedReference>;

/**
 * The content workspace owns the reference session, while the preparation and Shadow views
 * consume it. Every Shadow view uses this one content-owned v4 session.
 */
export const BufferedReferenceContext = createContext<BufferedReferenceSession | null>(null);

export function BufferedReferenceProvider({ value, children }: {
  value: BufferedReferenceSession;
  children: ReactNode;
}) {
  return createElement(BufferedReferenceContext.Provider, { value }, children);
}

export function useBufferedReferenceContext() {
  const session = useContext(BufferedReferenceContext);
  if (!session) throw new Error("A content reference session is required.");
  return session;
}
