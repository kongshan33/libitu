import type { HistoryItem } from "./types";
import { CONTENT_ID, learningHref } from "../navigation/learning-location.ts";

export function recordedDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (!seconds && milliseconds > 0) return "<1 sec";
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ${seconds % 60} sec` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

export function historyHref(item: HistoryItem): string | null {
  if (item.kind === "speaking" && item.session_id && item.status === "completed" && item.feedback?.unavailable_reason !== "legacy_report") return `/speaking/${encodeURIComponent(item.session_id)}/analytics`;
  if (item.kind === "speaking" && item.session_id) return `/speaking/${encodeURIComponent(item.session_id)}?returnTo=%2Fprofile`;
  // Old attempts do not carry segment identity. Return to the source safely;
  // never invent a Stage 2 segment or imply the exact historical take is selected.
  if (item.kind === "shadowing" && item.content_id) return profileSourceHref(item.content_id, item.source_url);
  return null;
}

export function historyAction(item: HistoryItem): string {
  if (!historyHref(item)) return "Source unavailable";
  if (item.kind === "shadowing") return "View source";
  if (item.status !== "completed") return item.status === "active" ? "Continue" : "View conversation";
  const report = item.feedback;
  if (report?.unavailable_reason === "legacy_report") return "View conversation";
  if (report?.available) return report.status === "partial" ? "Partial report" : "View report";
  if (report?.unavailable_reason === "version_mismatch") return "View earlier report";
  if (report?.unavailable_reason === "invalid_result") return "Check report";
  return report ? ({ queued: "Report queued", processing: "Report in progress", failed: "Report needs retry", insufficient_data: "Limited evidence", partial: "Partial report", ready: "View report" })[report.status] : "View report";
}

export function profileSourceHref(contentId: string, _sourceUrl: string | null | undefined): string | null {
  void _sourceUrl; // Display metadata cannot override the server-owned content source.
  return CONTENT_ID.test(contentId) ? learningHref({ contentId }) : null;
}

export function activityDate(value: string, month = false): string {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString("en", {
    timeZone: "UTC", month: "short", ...(month ? { year: "numeric" } : { day: "numeric" })
  });
}
