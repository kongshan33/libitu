"use client";

import { useCurrentLocation } from "../navigation/use-current-location";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { rememberProfileVideo } from "./api";
import styles from "./Profile.module.css";
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
  const location = useCurrentLocation();
  const { getToken } = useAuth();
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
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
      if (current.pathname.split("/")[2] !== contentId) return;
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
  }, [authLoaded, contentId, owner, ready, sourceUrl, title, location]);
  useEffect(() => {
    const visit = visitRef.current;
    if (!authLoaded || !ready || !owner || !contentId || !visit || !canRememberLearningVisit(visit)) return;
    const key = `${owner}:${contentId}`;
    const controller = new AbortController();
    setFailure(null);
    void rememberProfileVideo(contentId, owner, getToken, controller.signal).catch(() => {
      if (!controller.signal.aborted) setFailure(key);
    });
    return () => controller.abort();
  }, [authLoaded, ready, owner, contentId, sourceUrl, getToken, attempt]);

  return failure === `${owner}:${contentId}` ? <div className={styles.visitError} role="status">
    <span>Video history could not be saved.</span><Button variant="secondary" size="sm" onClick={() => setAttempt(value => value + 1)}>Retry</Button>
  </div> : null;
}
