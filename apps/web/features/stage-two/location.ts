import { withPracticeSelection } from "../navigation/learning-location.ts";

export const STAGE_TWO_LOCATION_CHANGED = "libitu:stage-two-location";

export function readStageTwoLocation(url: URL): { segmentId: string; sentenceId: string | null } | null {
  const segmentId = url.searchParams.get("segmentId");
  return url.pathname.endsWith("/shadow") && segmentId
    ? { segmentId, sentenceId: url.searchParams.get("sentenceId") }
    : null;
}

/** Sentence changes replace the selection within the content workspace. */
export function stageTwoLocation(url: URL, selection: { segmentId: string; sentenceId?: string } | null): URL {
  const next = withPracticeSelection(url, selection);
  const mode = url.searchParams.get("shadowMode");
  if (selection && mode && ["quick", "detailed", "review"].includes(mode)) next.searchParams.set("shadowMode", mode);
  return next;
}

export function replaceStageTwoLocation(selection: { segmentId: string; sentenceId?: string } | null): void {
  const next = stageTwoLocation(new URL(window.location.href), selection);
  if (next.href !== window.location.href) {
    // Next copies its internal state itself; passing __NA back would bypass its URL subscribers.
    window.history.replaceState(null, "", next);
    window.dispatchEvent(new Event(STAGE_TWO_LOCATION_CHANGED));
  }
}
