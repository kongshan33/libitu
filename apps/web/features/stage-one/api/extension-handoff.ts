import type { CaptionTrack } from "@libitu/types/stage-one";

const BRIDGE_CONNECT_TIMEOUT_MS = 1_500;
const CAPTION_TIMEOUT_MS = 10_000;

export type ExtensionCaptions = { transcriptText?: string; captionTrack?: CaptionTrack };

/** Ignore an invalid optional track without losing the existing text-only handoff. */
export function readCaptionTrack(value: unknown): CaptionTrack | undefined {
  if (!value || typeof value !== "object") return undefined;
  const track = value as CaptionTrack;
  if (!["youtube-json3-v1", "youtube-snippets-v1"].includes(track.version)
    || typeof track.video_id !== "string" || !/^[\w-]{11}$/.test(track.video_id)
    || (track.language !== null && (typeof track.language !== "string" || track.language.length > 35))
    || !["asr", "manual", "unknown"].includes(track.kind)
    || !Array.isArray(track.events) || track.events.length > 10_000) return undefined;
  let characters = 0;
  let segments = 0;
  const events: CaptionTrack["events"] = [];
  const integer = (number: unknown) => typeof number === "number" && Number.isSafeInteger(number) && number >= 0;
  const timestamp = (number: unknown) => integer(number) && (number as number) <= 604_800_000;
  for (const event of track.events) {
    if (!event || !timestamp(event.tStartMs) || !Array.isArray(event.segs) || event.segs.length > 12_000
      || (event.dDurationMs !== undefined && !timestamp(event.dDurationMs))
      || (event.aAppend !== undefined && event.aAppend !== 0 && event.aAppend !== 1)
      || (event.wWinId !== undefined && !integer(event.wWinId))) return undefined;
    segments += event.segs.length;
    if (segments > 50_000) return undefined;
    for (const seg of event.segs) {
      if (!seg || typeof seg.utf8 !== "string"
        || (seg.tOffsetMs !== undefined && !timestamp(seg.tOffsetMs))) return undefined;
      characters += seg.utf8.length;
      if (characters > 240_000) return undefined;
    }
    events.push({ tStartMs: event.tStartMs,
      ...(event.dDurationMs === undefined ? {} : { dDurationMs: event.dDurationMs }),
      ...(event.aAppend === undefined ? {} : { aAppend: event.aAppend }),
      ...(event.wWinId === undefined ? {} : { wWinId: event.wWinId }),
      segs: event.segs.map((seg) => ({ utf8: seg.utf8, ...(seg.tOffsetMs === undefined ? {} : { tOffsetMs: seg.tOffsetMs }) }))
    });
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(track)).byteLength > 2 * 1024 * 1024) return undefined;
  } catch { return undefined; }
  // Forward only caption payload fields, never provider URLs or extension-only data.
  return { version: track.version, video_id: track.video_id, language: track.language, kind: track.kind, events };
}

export function readExtensionCaptions(handoffId: string, signal?: AbortSignal): Promise<ExtensionCaptions> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    let connected = false;
    let settled = false;
    let timer = window.setTimeout(() => finish(), BRIDGE_CONNECT_TIMEOUT_MS);

    function cleanup() {
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", abort);
    }

    function finish(captions: ExtensionCaptions = {}) {
      if (settled) return;
      cleanup();
      resolve(captions);
    }

    function abort() {
      if (settled) return;
      cleanup();
      reject(signal?.reason ?? new DOMException("Loading cancelled", "AbortError"));
    }

    function onMessage(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (data?.type !== "LIBITU_HANDOFF_RESPONSE" || data.requestId !== requestId || data.handoffId !== handoffId) return;
      if (data.phase === "connected" && !connected) {
        connected = true;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => finish(), CAPTION_TIMEOUT_MS);
      } else if (data.phase === "ready") {
        finish({
          transcriptText: typeof data.transcriptText === "string" && data.transcriptText.trim() ? data.transcriptText : undefined,
          captionTrack: readCaptionTrack(data.captionTrack)
        });
      }
    }

    window.addEventListener("message", onMessage);
    signal?.addEventListener("abort", abort, { once: true });
    window.postMessage({ type: "LIBITU_HANDOFF_REQUEST", handoffId, requestId }, window.location.origin);
  });
}

/** Compatibility for callers that only need the transcript. */
export async function readExtensionTranscript(handoffId: string, signal?: AbortSignal): Promise<string | undefined> {
  return (await readExtensionCaptions(handoffId, signal)).transcriptText;
}
