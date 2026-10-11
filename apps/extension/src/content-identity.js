const ORIGIN = "http://localhost:3000";
export function contentIdAt(value) {
  try {
    const url = new URL(value);
    if (url.origin !== ORIGIN || url.username || url.password) return null;
    return /^\/practice\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(?:segments|shadow))?$/.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
}
export function contentIdentityMatches(message, sender) {
  // Chrome keeps the content script's initial URL across History API navigation.
  // Only its origin is stable here; current content/document checks happen below.
  let origin;
  try { origin = new URL(sender.url).origin; } catch { return false; }
  return contentIdAt(sender.tab?.url) === message.contentId && origin === ORIGIN
    && typeof message.contentId === "string" && /^[\w-]{11}$/.test(message.videoId ?? "")
    && /^[\w-]{16,100}$/.test(message.documentNonce ?? "");
}
/** Resolve the live top-level document, never trust an initial sender URL as its current route. */
export async function currentContentDocumentMatches(chromeApi, message, sender) {
  try {
    const frame = await chromeApi.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
    return Boolean(frame && sender.frameId === 0 && typeof sender.documentId === "string" && sender.documentId
      && frame.documentId === sender.documentId && contentIdAt(frame.url) === message.contentId
      && (!frame.documentLifecycle || frame.documentLifecycle === "active"));
  } catch { return false; }
}

/** Public API establishes content → video; a page claim alone is insufficient. */
export async function verifyContentSource(contentId, videoId, fetcher = fetch) {
  const response = await fetcher(`http://localhost:8000/api/content/${encodeURIComponent(contentId)}/identity`, {
    cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) return false;
  const body = await response.json();
  return body?.content_id === contentId && body.kind === "youtube"
    && body.source_url === `https://www.youtube.com/watch?v=${videoId}`;
}
