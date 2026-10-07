export type LearningLocation = { href: string; title: string; updatedAt: string };
export type LearningVisit = { owner: string | null; sourceId: string | null; blockedSourceId: string | null };

const STORAGE_PREFIX = "libitu:learning-location:v1:";
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const CONTROL_CHARACTERS = /\p{Cc}/u;

function storageKey(owner: string | null | undefined): string | null {
  return owner && IDENTIFIER.test(owner) ? STORAGE_PREFIX + owner : null;
}

/** Keep only a public video identity; discard source query strings and credentials. */
export function canonicalLearningSource(value: string | null | undefined): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    const videoId = host === "youtu.be" ? url.pathname.slice(1)
      : ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host) && url.pathname === "/watch"
        ? url.searchParams.get("v") : null;
    return videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)
      ? `https://www.youtube.com/watch?v=${videoId}` : null;
  } catch { return null; }
}

/** The saved destination can only reopen a ready reader or its Shadow sentence. */
export function safeLearningHref(value: string): string | null {
  if (value.length > 4096 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || CONTROL_CHARACTERS.test(value)) return null;
  try {
    const url = new URL(value, "https://libitu.local");
    if (url.origin !== "https://libitu.local" || url.pathname !== "/") return null;
    const contentId = url.searchParams.get("contentId");
    if (!contentId || !IDENTIFIER.test(contentId)) return null;
    const params = new URLSearchParams({ contentId });
    const source = url.searchParams.get("sourceUrl");
    const canonical = canonicalLearningSource(source);
    if (!canonical) return null;
    params.set("sourceUrl", canonical);
    const stage = url.searchParams.get("stage");
    if (stage === "2") {
      const segmentId = url.searchParams.get("segmentId");
      const sentenceId = url.searchParams.get("sentenceId");
      if (!segmentId || !IDENTIFIER.test(segmentId) || (sentenceId !== null && !IDENTIFIER.test(sentenceId))) return null;
      params.set("stage", "2");
      params.set("segmentId", segmentId);
      if (sentenceId) params.set("sentenceId", sentenceId);
    } else if (stage && stage !== "1") return null;
    return `/?${params}`;
  } catch { return null; }
}

/** A mounted source belongs to the identity that first viewed it, never its next account. */
export function advanceLearningVisit(previous: LearningVisit | null, owner: string | null, sourceId: string | null): LearningVisit {
  let blockedSourceId = previous?.blockedSourceId ?? null;
  if (previous && previous.owner !== owner) blockedSourceId = sourceId ?? previous.sourceId;
  else if (sourceId && sourceId !== blockedSourceId) blockedSourceId = null;
  return { owner, sourceId, blockedSourceId };
}

export function canRememberLearningVisit(visit: LearningVisit): boolean {
  return Boolean(visit.owner && visit.sourceId && visit.sourceId !== visit.blockedSourceId);
}

export function readLearningLocation(owner: string | null | undefined, storage?: Pick<Storage, "getItem">): LearningLocation | null {
  const key = storageKey(owner);
  if (!key) return null;
  try {
    const target = storage ?? (typeof window === "undefined" ? null : window.localStorage);
    const raw = target?.getItem(key);
    if (!raw || raw.length > 8192) return null;
    const saved = JSON.parse(raw) as Partial<LearningLocation> & { version?: number; owner?: string };
    if (!saved || saved.version !== 1 || saved.owner !== owner || typeof saved.href !== "string"
      || typeof saved.title !== "string" || !saved.title.trim() || saved.title.length > 300 || CONTROL_CHARACTERS.test(saved.title)
      || typeof saved.updatedAt !== "string" || saved.updatedAt.length > 32 || !Number.isFinite(Date.parse(saved.updatedAt))) return null;
    const href = safeLearningHref(saved.href);
    return href ? { href, title: saved.title, updatedAt: saved.updatedAt } : null;
  } catch { return null; }
}

/** Storage is optional convenience; quota/private-mode failures never block practice. */
export function rememberLearningLocation(owner: string, location: LearningLocation, storage?: Pick<Storage, "setItem">): boolean {
  const key = storageKey(owner);
  const href = safeLearningHref(location.href);
  const title = location.title.replace(/\p{Cc}/gu, " ").trim().slice(0, 300);
  if (!key || !href || !title || !Number.isFinite(Date.parse(location.updatedAt))) return false;
  try {
    const target = storage ?? (typeof window === "undefined" ? null : window.localStorage);
    if (!target) return false;
    target.setItem(key, JSON.stringify({ version: 1, owner, href, title, updatedAt: location.updatedAt }));
    return true;
  } catch { return false; }
}
