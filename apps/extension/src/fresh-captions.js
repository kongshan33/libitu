import { contentIdAt, contentIdentityMatches, currentContentDocumentMatches, verifyContentSource } from "./content-identity.js";
import { readCurrentYouTubeCaptionTrack } from "./youtube-captions.js";

const WEB_ORIGIN = "http://localhost:3000";
const TIMEOUT = Symbol("fresh-caption-timeout");

/** Independent, read-only recovery for old text-only handoffs and cached pages. */
export function createFreshCaptionReader(chrome, verifySource = verifyContentSource) {
  // One pending request per requesting tab, at most four across the extension.
  // Entries disappear on completion; neither successes nor failures are cached.
  const active = new Map();

  function read(message, sender) {
    const language = typeof message?.language === "string" ? message.language.trim().replaceAll("_", "-").toLowerCase() : "";
    const videoId = message?.videoId;
    if (message?.version !== 4 || !contentIdentityMatches(message, sender) || sender?.frameId !== 0 || !Number.isInteger(sender.tab?.id)
      || typeof sender.documentId !== "string" || !sender.documentId || sender.documentId.length > 128
      || (chrome.runtime.id && sender.id !== chrome.runtime.id)
      || (sender.origin !== undefined && sender.origin !== WEB_ORIGIN)
      || typeof message?.requestId !== "string" || !/^[\w-]{1,100}$/.test(message.requestId)
      || typeof videoId !== "string" || !/^[\w-]{11}$/.test(videoId)
      || youtubeVideoId(message.sourceUrl) !== videoId
      || language.length > 35 || !/^en(?:-[a-z0-9]{2,8})*$/.test(language)) {
      return Promise.resolve({ status: "invalid_request" });
    }
    const ownerTabId = sender.tab.id;
    const previous = active.get(ownerTabId);
    if (previous) {
      return previous.requestId === message.requestId && previous.videoId === videoId
        && previous.language === language && previous.documentId === sender.documentId
        ? previous.work : Promise.resolve({ status: "busy" });
    }
    if (active.size >= 4) return Promise.resolve({ status: "busy" });

    const operation = { ownerTabId, requestId: message.requestId, documentId: sender.documentId,
      contentId: message.contentId, videoId, language, sourceTabId: undefined, stale: false, finished: false, work: undefined };
    const isCurrent = async () => {
      if (operation.stale || operation.finished) return false;
      try {
        const owner = await chrome.tabs.get(ownerTabId);
        if (!webSourceMatches(owner.url, message.contentId) || !await currentContentDocumentMatches(chrome, message, sender)) return false;
        if (operation.sourceTabId !== undefined) {
          const source = await chrome.tabs.get(operation.sourceTabId);
          if (youtubeVideoId(source.url) !== videoId) return false;
        }
        return !operation.stale && !operation.finished;
      } catch { return false; }
    };

    operation.work = withTimeout((async () => {
      if (!await verifySource(message.contentId, videoId)) return { status: "invalid_request" };
      if (!await isCurrent()) return { status: "stale" };
      const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" });
      // A timed-out query must never cause a delayed subtitle request.
      if (!await isCurrent()) return { status: "stale" };
      const matching = tabs.filter((tab) => Number.isInteger(tab.id) && youtubeVideoId(tab.url) === videoId);
      matching.sort((left, right) => Number(right.windowId === sender.tab.windowId) - Number(left.windowId === sender.tab.windowId)
        || Number(Boolean(right.active)) - Number(Boolean(left.active)) || left.id - right.id);
      const source = matching[0];
      if (!source) return { status: "no_matching_tab" };
      operation.sourceTabId = source.id;
      if (!await isCurrent()) return { status: "stale" };
      const injected = await withTimeout(chrome.scripting.executeScript({
        target: { tabId: source.id }, world: "MAIN", args: [videoId, language], func: readCurrentYouTubeCaptionTrack
      }), 2_500);
      if (!await isCurrent()) return { status: "stale" };
      const result = injected?.[0]?.result;
      if (result?.stale) return { status: "stale" };
      if (result?.timeout) return { status: "timeout" };
      if (["observer_missing", "not_observed", "request_failed", "empty_response", "invalid_response",
        "response_too_large", "observer_timeout", "stale"].includes(result?.status)) return { status: result.status };
      const captionTrack = safeCaptionTrack(result?.captionTrack, videoId, language);
      if (!captionTrack) return { status: "unavailable" };
      // Presence is not qualification: API/Web still check exact words,
      // monotonicity, rolling ambiguity and usable estimated intervals.
      const hasOffsets = captionTrack.events.some((event) => event.segs.some((segment) => segment.utf8.trim() && segment.tOffsetMs !== undefined));
      return { status: hasOffsets ? "ready" : "no_word_offsets", captionTrack };
    })(), 3_500).catch((error) => ({ status: error === TIMEOUT ? "timeout" : "bridge_error" })).finally(() => {
      operation.finished = true;
      if (active.get(ownerTabId) === operation) active.delete(ownerTabId);
    });
    active.set(ownerTabId, operation);
    return operation.work;
  }

  function onTabUpdated(tabId, changeInfo) {
    for (const operation of active.values()) {
      if (tabId === operation.ownerTabId && (changeInfo.status === "loading"
        || (changeInfo.url && !webSourceMatches(changeInfo.url, operation.contentId)))) operation.stale = true;
      if (tabId === operation.sourceTabId && (changeInfo.status === "loading"
        || (changeInfo.url && youtubeVideoId(changeInfo.url) !== operation.videoId))) operation.stale = true;
    }
  }
  return { read, onTabUpdated };
}

function youtubeVideoId(value) {
  try {
    const url = new URL(value);
    const videoId = url.searchParams.get("v");
    return url.origin === "https://www.youtube.com" && url.pathname === "/watch" && !url.username && !url.password
      && url.searchParams.getAll("v").length === 1 && /^[\w-]{11}$/.test(videoId ?? "") ? videoId : undefined;
  } catch { return undefined; }
}

function webSourceMatches(value, contentId) {
  return contentIdAt(value) === contentId;
}

function withTimeout(work, milliseconds) {
  let timer;
  return Promise.race([work, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(TIMEOUT), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function safeCaptionTrack(value, videoId, language) {
  if (!value || value.version !== "youtube-json3-v1" || value.video_id !== videoId
    || typeof value.language !== "string" || value.language.length > 35
    || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(value.language)
    || value.language.split("-")[0] !== language.split("-")[0]
    || !["asr", "manual", "unknown"].includes(value.kind)
    || !Array.isArray(value.events) || value.events.length > 10_000) return undefined;
  const milliseconds = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 604_800_000;
  let characters = 0;
  let segments = 0;
  let hasText = false;
  const events = [];
  for (const event of value.events) {
    if (!event || !milliseconds(event.tStartMs) || !Array.isArray(event.segs) || event.segs.length > 12_000
      || (event.dDurationMs !== undefined && !milliseconds(event.dDurationMs))
      || (event.aAppend !== undefined && event.aAppend !== 0 && event.aAppend !== 1)
      || (event.wWinId !== undefined && (!Number.isSafeInteger(event.wWinId) || event.wWinId < 0))) return undefined;
    const segs = [];
    for (const segment of event.segs) {
      if (typeof segment?.utf8 !== "string" || (segment.tOffsetMs !== undefined && !milliseconds(segment.tOffsetMs))) return undefined;
      segments += 1;
      characters += segment.utf8.length;
      if (segments > 50_000 || characters > 240_000) return undefined;
      hasText ||= Boolean(segment.utf8.trim());
      segs.push({ utf8: segment.utf8, ...(segment.tOffsetMs !== undefined ? { tOffsetMs: segment.tOffsetMs } : {}) });
    }
    events.push({ tStartMs: event.tStartMs, segs,
      ...(event.dDurationMs !== undefined ? { dDurationMs: event.dDurationMs } : {}),
      ...(event.aAppend !== undefined ? { aAppend: event.aAppend } : {}),
      ...(event.wWinId !== undefined ? { wWinId: event.wWinId } : {}) });
  }
  if (!hasText) return undefined;
  const track = { version: "youtube-json3-v1", video_id: videoId, language: value.language, kind: value.kind, events };
  return new TextEncoder().encode(JSON.stringify(track)).byteLength <= 2 * 1024 * 1024 ? track : undefined;
}
