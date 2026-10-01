// This function is injected into YouTube's MAIN world. Keep it self-contained.
// It reads the early observer's sanitized response cache, never a signed URL.
export async function readCurrentYouTubeCaptionTrack(expectedVideoId, expectedLanguage, observerWaitMs = 0) {
  const normalizeLanguage = (value) => typeof value === "string"
    ? value.trim().replaceAll("_", "-").toLowerCase() : "";
  const language = normalizeLanguage(expectedLanguage);
  let navigated = false;
  const invalidate = () => { navigated = true; };
  const isCurrent = () => {
    const url = new URL(window.location.href);
    const domVideoId = document.querySelector("ytd-watch-flexy")?.getAttribute("video-id");
    return !navigated && url.origin === "https://www.youtube.com" && url.pathname === "/watch"
      && !url.username && !url.password && url.searchParams.getAll("v").length === 1
      && url.searchParams.get("v") === expectedVideoId && (!domVideoId || domVideoId === expectedVideoId);
  };
  document.addEventListener("yt-navigate-start", invalidate);
  window.addEventListener("popstate", invalidate);
  window.addEventListener("pagehide", invalidate);
  try {
    if (!isCurrent()) return { status: "stale", stale: true };
    if (!/^[\w-]{11}$/.test(expectedVideoId) || language.length > 35 || !/^en(?:-[a-z0-9]{2,8})*$/.test(language)) return { status: "invalid_request" };
    const observer = globalThis.__libituCaptionObserverV1;
    if (observer?.version !== 1 || typeof observer.read !== "function") return { status: "observer_missing" };
    // Read one snapshot: timers in a background YouTube tab can be throttled.
    // A later learner retry can consume a response the player finishes afterward.
    let result = observer.read(expectedVideoId, language);
    if (result?.status === "not_observed" && Number.isFinite(observerWaitMs) && observerWaitMs > 0) {
      result = await new Promise((resolve) => {
        let settled = false;
        const finish = (next) => {
          if (settled) return;
          settled = true;
          window.removeEventListener("libitu-caption-observer-update", onUpdate);
          clearTimeout(timer);
          resolve(next);
        };
        const onUpdate = () => {
          try {
            const next = observer.read(expectedVideoId, language);
            if (next?.status !== "not_observed") finish(next);
          } catch { finish({ status: "invalid_response" }); }
        };
        const timer = setTimeout(() => {
          try { finish(observer.read(expectedVideoId, language)); }
          catch { finish({ status: "invalid_response" }); }
        }, Math.min(observerWaitMs, 10_000));
        window.addEventListener("libitu-caption-observer-update", onUpdate);
        if (!isCurrent()) finish({ status: "stale", stale: true });
      });
    }
    if (!isCurrent()) return { status: "stale", stale: true };
    const failures = new Set(["not_observed", "request_failed", "empty_response", "invalid_response",
      "response_too_large", "observer_timeout", "stale"]);
    if (failures.has(result?.status)) return { status: result.status, ...(result.status === "stale" ? { stale: true } : {}) };
    const json = result?.captionTrack;
    // MAIN-world data is untrusted, even when it came from our observer.
    const invalid = { status: "invalid_response" };
    if (!["ready", "no_word_offsets"].includes(result?.status) || json?.version !== "youtube-json3-v1"
      || json.video_id !== expectedVideoId || typeof json.language !== "string" || json.language.length > 35
      || !/^en(?:-[a-z0-9]{2,8})*$/.test(json.language) || json.language.split("-")[0] !== language.split("-")[0]
      || !["asr", "manual", "unknown"].includes(json.kind)
      || !Array.isArray(json.events) || json.events.length > 10_000) return invalid;
    const validMs = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 604_800_000;
    let segmentCount = 0;
    let textLength = 0;
    let hasText = false;
    const events = [];
    for (const event of json.events) {
      // Window/style events are not captions. Do not deduplicate textual events,
      // even when their text and timestamps repeat in rolling captions.
      if (!Array.isArray(event?.segs) || !event.segs.length) continue;
      if (!validMs(event.tStartMs) || (event.dDurationMs !== undefined && !validMs(event.dDurationMs))
        || event.segs.length > 12_000) return invalid;
      const segs = [];
      for (const segment of event.segs) {
        if (typeof segment?.utf8 !== "string" || (segment.tOffsetMs !== undefined && !validMs(segment.tOffsetMs))) return invalid;
        segmentCount += 1;
        textLength += segment.utf8.length;
        if (segmentCount > 50_000 || textLength > 240_000) return invalid;
        hasText ||= Boolean(segment.utf8.trim());
        segs.push({ utf8: segment.utf8, ...(segment.tOffsetMs !== undefined ? { tOffsetMs: segment.tOffsetMs } : {}) });
      }
      const item = { tStartMs: event.tStartMs, ...(event.dDurationMs !== undefined ? { dDurationMs: event.dDurationMs } : {}), segs };
      for (const key of ["aAppend", "wWinId"]) {
        if (event[key] !== undefined) {
          if (!Number.isSafeInteger(event[key]) || event[key] < 0 || (key === "aAppend" && event[key] > 1)) return invalid;
          item[key] = event[key];
        }
      }
      events.push(item);
    }
    if (!isCurrent()) return { status: "stale", stale: true };
    if (!hasText) return invalid;
    const captionTrack = { version: "youtube-json3-v1", video_id: expectedVideoId, language: json.language, kind: json.kind, events };
    if (new TextEncoder().encode(JSON.stringify(captionTrack)).byteLength > 2 * 1024 * 1024) return { status: "response_too_large" };
    const offsets = events.some((event) => event.segs.some((segment) => segment.utf8.trim() && segment.tOffsetMs !== undefined));
    return { status: offsets ? "ready" : "no_word_offsets", captionTrack };
  } catch {
    return navigated || !isCurrent() ? { status: "stale", stale: true } : { status: "invalid_response" };
  } finally {
    document.removeEventListener("yt-navigate-start", invalidate);
    window.removeEventListener("popstate", invalidate);
    window.removeEventListener("pagehide", invalidate);
  }
}

export function captionTrackToTranscript(captionTrack) {
  return captionTrack.events.map((event) => {
    const text = event.segs.map((segment) => segment.utf8).join("").replace(/\s+/g, " ").trim();
    if (!text) return undefined;
    const hours = Math.floor(event.tStartMs / 3_600_000);
    const minutes = Math.floor(event.tStartMs % 3_600_000 / 60_000);
    const seconds = (event.tStartMs % 60_000 / 1_000).toFixed(3).padStart(6, "0");
    const timestamp = hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
    return `${timestamp}\t${text}`;
  }).filter(Boolean).join("\n") || undefined;
}
