"use client";

import { useEffect, useRef } from "react";
import { STAGE_TWO_LOCATION_CHANGED } from "../stage-two/location";
import {
  advanceLearningVisit, canRememberLearningVisit, canonicalLearningSource, rememberLearningLocation,
  type LearningVisit
} from "./learning-location";

/** Mounted across reader/Shadow views so account changes cannot adopt the open source. */
export function LearningLocationTracker({ authLoaded, owner, ready, contentId, sourceUrl, title }: {
  authLoaded: boolean; owner: string | null | undefined; ready: boolean;
  contentId: string | null; sourceUrl: string | null | undefined; title: string;
}) {
  const visitRef = useRef<LearningVisit | null>(null);
  useEffect(() => {
    if (!authLoaded) return;
    const source = canonicalLearningSource(sourceUrl);
    const sourceId = contentId && source ? `${contentId}:${source}` : null;
    const visit = advanceLearningVisit(visitRef.current, owner ?? null, sourceId);
    visitRef.current = visit;
    if (!ready || !owner || !contentId || !source || !canRememberLearningVisit(visit)) return;

    function remember() {
      const current = new URL(window.location.href);
      // A stale reader cannot overwrite the destination of a different navigation.
      if (current.pathname !== "/" || (current.searchParams.has("contentId") && current.searchParams.get("contentId") !== contentId)) return;
      current.searchParams.set("contentId", contentId!);
      current.searchParams.set("sourceUrl", source!);
      rememberLearningLocation(owner!, {
        href: current.pathname + current.search, title, updatedAt: new Date().toISOString()
      });
    }
    remember();
    window.addEventListener(STAGE_TWO_LOCATION_CHANGED, remember);
    window.addEventListener("popstate", remember);
    return () => {
      window.removeEventListener(STAGE_TWO_LOCATION_CHANGED, remember);
      window.removeEventListener("popstate", remember);
    };
  }, [authLoaded, contentId, owner, ready, sourceUrl, title]);
  return null;
}
