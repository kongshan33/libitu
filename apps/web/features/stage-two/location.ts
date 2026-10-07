export const STAGE_TWO_LOCATION_CHANGED = "libitu:stage-two-location";

export function readStageTwoLocation(url: URL): { segmentId: string; sentenceId: string | null } | null {
  const segmentId = url.searchParams.get("segmentId");
  return url.searchParams.get("stage") === "2" && segmentId
    ? { segmentId, sentenceId: url.searchParams.get("sentenceId") }
    : null;
}

/** Preserve source, job, learner level and fragment when entering/leaving practice. */
export function stageTwoLocation(url: URL, selection: { segmentId: string; sentenceId?: string } | null): URL {
  const next = new URL(url);
  for (const key of ["stage", "segmentId", "sentenceId"]) next.searchParams.delete(key);
  if (selection) {
    next.searchParams.set("stage", "2");
    next.searchParams.set("segmentId", selection.segmentId);
    if (selection.sentenceId) next.searchParams.set("sentenceId", selection.sentenceId);
  }
  return next;
}

export function replaceStageTwoLocation(selection: { segmentId: string; sentenceId?: string } | null): void {
  const next = stageTwoLocation(new URL(window.location.href), selection);
  if (next.href !== window.location.href) {
    window.history.replaceState(window.history.state, "", next);
    window.dispatchEvent(new Event(STAGE_TWO_LOCATION_CHANGED));
  }
}
