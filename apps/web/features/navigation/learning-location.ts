/** Canonical content routes. Root query learning links are no longer supported. */
import type { LearnerLevel } from "@libitu/types/stage-one";

export type HomeSearchParams = Record<string, string | string[] | undefined>;
export type LearningSource = {
  sourceUrl?: string; contentId?: string; jobId?: string; handoffId?: string;
  title?: string; language?: string; learnerLevel?: LearnerLevel; transcriptText?: string;
};
export type LearningLocation =
  | { kind: "landing" }
  | { kind: "invalid"; message: string }
  | { kind: "import"; source: LearningSource }
  | { kind: "reader" | "segments" | "shadow"; source: LearningSource; segmentId?: string; sentenceId?: string; step?: "prepare" };
export const CONTENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,249}$/;
const FIELDS = ["sourceUrl", "contentId", "jobId", "handoffId", "title", "language", "learnerLevel", "level", "transcriptText", "stage", "segmentId", "sentenceId"] as const;
const LEVELS = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);

export function searchParamsFromRecord(input: HomeSearchParams): URLSearchParams {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    for (const part of Array.isArray(value) ? value : value === undefined ? [] : [value]) result.append(key, part);
  }
  return result;
}

export function canonicalVideoSource(input: string): string | null {
  try {
    const url = new URL(input);
    if (!["https:", "http:"].includes(url.protocol) || url.port || url.username || url.password || url.searchParams.getAll("v").length > 1) return null;
    const host = url.hostname.toLowerCase();
    const id = host === "youtu.be" && /^\/[^/]+\/?$/.test(url.pathname) ? url.pathname.split("/")[1]
      : ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)
        ? /^\/shorts\/[^/]+\/?$/.test(url.pathname) ? url.pathname.split("/")[2]
          : url.pathname === "/watch" ? url.searchParams.get("v") : null : null;
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
  } catch { return null; }
}

export function parseLearningLocation(input: URL | HomeSearchParams): LearningLocation {
  const url = input instanceof URL ? input : new URL("/?" + searchParamsFromRecord(input), "https://libitu.invalid");
  const params = url.searchParams;
  const invalid = (message: string): LearningLocation => ({ kind: "invalid", message });
  if (url.pathname === "/") return { kind: "landing" };
  try { decodeURIComponent(url.pathname + url.search + url.hash); } catch { return invalid("The learning link contains invalid encoding."); }
  for (const key of [...FIELDS, "step"]) {
    const value = params.get(key);
    if (params.getAll(key).length > 1 || (value && (value.length > (key === "sourceUrl" ? 2048 : 300) || /[\u0000-\u001f\u007f\uFFFD]/.test(value)))) return invalid(`The learning link has an invalid ${key}.`);
  }
  const learnerLevel = params.get("learnerLevel")?.toUpperCase();
  if (learnerLevel && !LEVELS.has(learnerLevel)) return invalid("The learning link has an invalid learner level.");
  if (["stage", "level", "jobId", "transcriptText"].some(key => params.has(key))) return invalid("This learning link uses an unsupported format.");
  const source: LearningSource = { learnerLevel: learnerLevel as LearnerLevel | undefined };
  if (url.pathname === "/practice/import") {
    const sourceUrl = canonicalVideoSource(params.get("sourceUrl") ?? "");
    if (!sourceUrl) return invalid("Use a supported YouTube video link.");
    const handoffId = params.get("handoffId") || undefined;
    if (handoffId && !IDENTIFIER.test(handoffId)) return invalid("Invalid caption handoff.");
    if (["contentId", "segmentId", "sentenceId", "step"].some(key => params.has(key))) return invalid("Invalid import parameters.");
    return { kind: "import", source: { ...source, sourceUrl, handoffId, title: params.get("title") || undefined } };
  }
  const match = /^\/practice\/([^/]+)(?:\/(segments|shadow))?$/.exec(url.pathname);
  if (!match || !CONTENT_ID.test(match[1])) return invalid("This is not a valid content address.");
  source.contentId = match[1];
  if (["contentId", "sourceUrl", "handoffId", "language", "title"].some(key => params.has(key))) return invalid("Content metadata belongs to the content service.");
  const kind = (match[2] ?? "reader") as "reader" | "segments" | "shadow";
  const segmentId = params.get("segmentId") || undefined;
  const sentenceId = params.get("sentenceId") || undefined;
  const step = params.get("step") || undefined;
  if ((segmentId && !IDENTIFIER.test(segmentId)) || (sentenceId && !IDENTIFIER.test(sentenceId))
    || (step && (kind !== "segments" || step !== "prepare")) || (sentenceId && kind !== "shadow")
    || (kind === "reader" && segmentId) || ((kind === "shadow" || step) && !segmentId)) return invalid("The learning link has an invalid practice selection.");
  return { kind, source, segmentId, sentenceId, step: step as "prepare" | undefined };
}

export function learningHref(source: LearningSource, selection?: { segmentId: string; sentenceId?: string }, hash = ""): string {
  const params = new URLSearchParams();
  if (source.learnerLevel) params.set("learnerLevel", source.learnerLevel);
  let path: string;
  if (source.contentId && CONTENT_ID.test(source.contentId)) {
    path = `/practice/${source.contentId}${selection ? "/shadow" : ""}`;
    if (selection) {
      params.set("segmentId", selection.segmentId);
      if (selection.sentenceId) params.set("sentenceId", selection.sentenceId);
    }
  } else {
    const canonical = source.sourceUrl && canonicalVideoSource(source.sourceUrl);
    if (!canonical) return "/";
    path = "/practice/import";
    params.set("sourceUrl", canonical);
  }
  return path + (params.size ? `?${params}` : "") + (/^#[A-Za-z0-9._:-]{1,250}$/.test(hash) ? hash : "");
}

export function workspaceHref(url: URL, view: "reader" | "picker" | "preparing" | "shadow", segmentId?: string, sentenceId?: string): string {
  const match = /^\/practice\/([^/]+)/.exec(url.pathname);
  if (!match || !CONTENT_ID.test(match[1])) return "/";
  const params = new URLSearchParams();
  const level = url.searchParams.get("learnerLevel");
  if (level && LEVELS.has(level)) params.set("learnerLevel", level);
  if (view !== "reader" && segmentId) params.set("segmentId", segmentId);
  if (view === "preparing") params.set("step", "prepare");
  if (view === "shadow" && sentenceId) params.set("sentenceId", sentenceId);
  return `/practice/${match[1]}${view === "reader" ? "" : view === "shadow" ? "/shadow" : "/segments"}${params.size ? `?${params}` : ""}${url.hash}`;
}
export function withPracticeSelection(url: URL, selection: { segmentId: string; sentenceId?: string } | null): URL {
  return new URL(workspaceHref(url, selection ? "shadow" : "reader", selection?.segmentId, selection?.sentenceId), url.origin);
}
