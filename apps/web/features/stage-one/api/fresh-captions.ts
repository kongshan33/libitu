import type { CaptionTrack } from "@libitu/types/stage-one";
import { readCaptionTrack } from "./extension-handoff.ts";

export type FreshCaptionSource = { contentId: string; sourceUrl: string; videoId: string; language?: string };
export type FreshCaptionStatus = "ready" | "no_matching_tab" | "no_word_offsets" | "unavailable" | "timeout" | "stale" | "invalid_request" | "busy"
  | "observer_missing" | "not_observed" | "request_failed" | "empty_response" | "invalid_response" | "response_too_large" | "observer_timeout" | "bridge_error";
export type FreshCaptionResult = { status: FreshCaptionStatus; captionTrack?: CaptionTrack };
const STATUSES = new Set<FreshCaptionStatus>(["ready", "no_matching_tab", "no_word_offsets", "unavailable", "timeout", "stale", "invalid_request", "busy",
  "observer_missing", "not_observed", "request_failed", "empty_response", "invalid_response", "response_too_large", "observer_timeout", "bridge_error"]);

/** Safe protocol explanations, without exposing response bodies or guessing a failure's cause. */
export const freshCaptionFailureMessages: Record<Exclude<FreshCaptionStatus, "ready">, string> = {
  no_matching_tab: "Open this video in a YouTube tab, then retry word timing.",
  no_word_offsets: "The currently observed caption track has no word offsets. If English (auto-generated) is available on YouTube, select it and retry word timing. Word timing may still be unavailable; sentence playback is still available.",
  unavailable: "Usable caption timing could not be read from YouTube. Keep the matching video open and retry.",
  timeout: "The caption check timed out. Check the matching YouTube tab and the Libitu extension, then retry word timing.",
  stale: "The source changed during the caption check. Return to the matching content before retrying.",
  invalid_request: "The extension could not match this content to its video. Reload this page and the updated extension before retrying.",
  busy: "The extension is checking captions for another request. Try again shortly.",
  observer_missing: "The caption observer is not active on the YouTube source page. If you just updated Libitu, reload the extension first. Refresh that YouTube page once, then retry word timing.",
  not_observed: "No caption response has been observed yet. Turn on English captions in the matching YouTube tab, then retry word timing.",
  request_failed: "YouTube's caption request failed. Turn English captions off and back on in the matching YouTube tab so the player can request captions again, then retry word timing in Libitu.",
  empty_response: "YouTube returned an empty caption JSON response. Turn English captions off and back on in the matching YouTube tab so the player can request captions again, then retry word timing in Libitu.",
  invalid_response: "The caption response was not valid JSON3. Sentence playback is still available.",
  response_too_large: "The caption response exceeded the supported size limit. Sentence playback is still available.",
  observer_timeout: "Reading the observed captions timed out. Turn English captions off and back on in the matching YouTube tab so the player can request captions again, then retry word timing in Libitu.",
  bridge_error: "Communication with the Libitu extension was interrupted. Check the extension and retry word timing."
};

export function captionVideoId(sourceUrl: string | undefined): string | null {
  if (!sourceUrl) return null;
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.searchParams.getAll("v").length > 1) return null;
    const host = url.hostname.toLowerCase();
    const id = host === "youtu.be" ? url.pathname.split("/")[1]
      : ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)
        ? url.pathname.startsWith("/shorts/") ? url.pathname.split("/")[2]
          : url.pathname === "/watch" ? url.searchParams.get("v") : null : null;
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

/** Bind old content-only links before asking the extension to inspect a matching tab. */
export function bindFreshCaptionSource(source: FreshCaptionSource): boolean {
  const url = new URL(window.location.href);
  const contentId = url.searchParams.get("contentId");
  const sourceUrl = url.searchParams.get("sourceUrl");
  if ((contentId && contentId !== source.contentId) || (sourceUrl && captionVideoId(sourceUrl) !== source.videoId)
    || captionVideoId(source.sourceUrl) !== source.videoId) return false;
  const canonical = `https://www.youtube.com/watch?v=${source.videoId}`;
  if (!contentId || sourceUrl !== canonical) {
    url.searchParams.set("contentId", source.contentId);
    url.searchParams.set("sourceUrl", canonical);
    window.history.replaceState(window.history.state, "", url);
  }
  return true;
}

export function freshCaptionSourceMatches(source: FreshCaptionSource): boolean {
  const url = new URL(window.location.href);
  return url.searchParams.get("contentId") === source.contentId
    && captionVideoId(url.searchParams.get("sourceUrl") ?? undefined) === source.videoId;
}

/** Independent of the expiring launch handoff. It cannot create tabs, content or jobs. */
export function requestFreshCaptions(source: FreshCaptionSource, signal?: AbortSignal): Promise<FreshCaptionResult> {
  signal?.throwIfAborted();
  if (!bindFreshCaptionSource(source)) return Promise.resolve({ status: "stale" });
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let settled = false;
    const timer = window.setTimeout(() => finish({ status: "timeout" }), 4500);
    function cleanup() {
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", abort);
    }
    function finish(result: FreshCaptionResult) {
      if (settled) return;
      cleanup();
      resolve(result);
    }
    function abort() {
      if (settled) return;
      cleanup();
      reject(signal?.reason ?? new DOMException("Caption recovery cancelled", "AbortError"));
    }
    function onMessage(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (data?.type !== "LIBITU_FRESH_CAPTIONS_RESPONSE" || data.requestId !== requestId || data.videoId !== source.videoId) return;
      if (!freshCaptionSourceMatches(source)) { finish({ status: "stale" }); return; }
      if (!STATUSES.has(data.status)) return;
      const captionTrack = readCaptionTrack(data.captionTrack);
      if (data.status === "ready" && (!captionTrack || captionTrack.video_id !== source.videoId)) {
        finish({ status: "unavailable" }); return;
      }
      finish({ status: data.status, captionTrack });
    }
    window.addEventListener("message", onMessage);
    signal?.addEventListener("abort", abort, { once: true });
    window.postMessage({ type: "LIBITU_FRESH_CAPTIONS_REQUEST", requestId,
      sourceUrl: `https://www.youtube.com/watch?v=${source.videoId}`, videoId: source.videoId, language: source.language ?? "en" }, window.location.origin);
  });
}
