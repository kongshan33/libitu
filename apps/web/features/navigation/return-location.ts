import { learningHref, parseLearningLocation, type HomeSearchParams } from "./learning-location.ts";

const ORIGIN = "https://libitu.invalid";
function localUrl(value: string | null | undefined): URL | null {
  if (!value || value.length > 8192 || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, ORIGIN);
    const path = decodeURIComponent(url.pathname);
    if (url.origin !== ORIGIN || path.startsWith("//") || /[\\\u0000-\u0020\u007f%]/.test(path)) return null;
    return url;
  } catch { return null; }
}

/** A learning origin, never a nested mission return chain or transient handoff. */
export function safeReturnPath(value: string | null | undefined): string {
  const url = localUrl(value);
  if (!url || url.searchParams.has("returnTo")) return "/";
  if (["/corpus", "/profile", "/profile/history"].includes(url.pathname)) {
    for (const key of ["jobId", "handoffId", "transcriptText"]) url.searchParams.delete(key);
    return url.pathname + url.search + url.hash;
  }
  if (!url.pathname.startsWith("/practice/")) return "/";
  const location = parseLearningLocation(url);
  if (location.kind === "landing" || location.kind === "invalid") return "/";
  if (location.kind === "import") return "/";
  if (location.kind === "segments") {
    const params = new URLSearchParams();
    if (location.source.learnerLevel) params.set("learnerLevel", location.source.learnerLevel);
    if (location.segmentId) params.set("segmentId", location.segmentId);
    if (location.step) params.set("step", location.step);
    return `/practice/${location.source.contentId}/segments${params.size ? `?${params}` : ""}${url.hash}`;
  }
  return learningHref(location.source, location.kind === "shadow" && location.segmentId
    ? { segmentId: location.segmentId, sentenceId: location.sentenceId } : undefined, url.hash);
}

/** Auth must also return to missions/reports; retain the initiating query and hash. */
export function safeAuthReturnPath(value: string | null | undefined): string {
  const url = localUrl(value);
  if (!url) return "/";
  if (url.pathname.startsWith("/practice/")) {
    const location = parseLearningLocation(url);
    return location.kind === "invalid" ? "/" : url.pathname + url.search + url.hash;
  }
  if (!["/", "/corpus", "/profile", "/profile/history", "/loadout"].includes(url.pathname)
    && !/^\/speaking\/[A-Za-z0-9][A-Za-z0-9._:-]{0,249}(?:\/analytics)?$/.test(url.pathname)) return "/";
  return url.pathname + url.search + url.hash;
}

export function currentAuthReturnUrl(): string {
  const url = new URL(window.location.href);
  return url.origin + safeAuthReturnPath(url.pathname + url.search + url.hash);
}

export function readReturnPath(params: HomeSearchParams): string {
  return safeReturnPath(typeof params.returnTo === "string" ? params.returnTo : null);
}

export function missionHref(target: "loadout" | "session" | "analytics", returnTo: string | null = null, sessionId?: string,
  options: { reportImport?: "saved" | "active"; replaceMissing?: boolean } = {}): string {
  if (target !== "loadout" && !sessionId) throw new Error("A session link requires a session ID.");
  const path = target === "loadout" ? "/loadout" : `/speaking/${encodeURIComponent(sessionId!)}${target === "analytics" ? "/analytics" : ""}`;
  const params = new URLSearchParams();
  if (options.reportImport) params.set("reportImport", options.reportImport);
  if (options.replaceMissing) params.set("replaceMissing", "1");
  const origin = safeReturnPath(returnTo);
  if (origin !== "/") params.set("returnTo", origin);
  return path + (params.size ? `?${params}` : "");
}
