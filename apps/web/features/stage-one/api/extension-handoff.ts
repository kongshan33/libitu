const BRIDGE_CONNECT_TIMEOUT_MS = 1_500;
const CAPTION_TIMEOUT_MS = 10_000;

export function readExtensionTranscript(handoffId: string, signal?: AbortSignal): Promise<string | undefined> {
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

    function finish(transcriptText?: string) {
      if (settled) return;
      cleanup();
      resolve(transcriptText);
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
        finish(typeof data.transcriptText === "string" && data.transcriptText.trim() ? data.transcriptText : undefined);
      }
    }

    window.addEventListener("message", onMessage);
    signal?.addEventListener("abort", abort, { once: true });
    window.postMessage({ type: "LIBITU_HANDOFF_REQUEST", handoffId, requestId }, window.location.origin);
  });
}
