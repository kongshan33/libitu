(() => {
  if (globalThis.__libituStageOneBridge) return;
  globalThis.__libituStageOneBridge = true;
  const freshRequests = new Set();
  const freshStatuses = new Set(["ready", "no_matching_tab", "no_word_offsets", "unavailable", "timeout", "stale", "invalid_request", "busy",
    "observer_missing", "not_observed", "request_failed", "empty_response", "invalid_response", "response_too_large", "observer_timeout", "bridge_error"]);
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.type === "LIBITU_FRESH_CAPTIONS_REQUEST") {
      void readFreshCaptions(event.data);
      return;
    }
    if (event.data?.type !== "LIBITU_HANDOFF_REQUEST") return;
    const { handoffId, requestId } = event.data;
    if (typeof requestId !== "string" || handoffId !== new URLSearchParams(window.location.search).get("handoffId")) return;
    const reply = (payload) => window.postMessage({ type: "LIBITU_HANDOFF_RESPONSE", handoffId, requestId, ...payload }, window.location.origin);
    reply({ phase: "connected" });
    chrome.runtime.sendMessage({ type: "LIBITU_READ_HANDOFF", handoffId })
      .then((result) => reply({ phase: "ready", transcriptText: result?.transcriptText, captionTrack: result?.captionTrack }))
      .catch(() => reply({ phase: "ready" }));
  });

  async function readFreshCaptions(message) {
    if (window !== window.top || window.location.origin !== "http://localhost:3000"
      || typeof message.requestId !== "string" || !/^[\w-]{1,100}$/.test(message.requestId)
      || typeof message.videoId !== "string" || !/^[\w-]{11}$/.test(message.videoId)) return;
    const { requestId, videoId, sourceUrl, language } = message;
    const matchesSource = () => {
      try {
        const current = new URL(window.location.href);
        const source = new URL(sourceUrl);
        const bound = new URL(current.searchParams.get("sourceUrl"));
        return current.pathname === "/" && current.searchParams.getAll("sourceUrl").length === 1
          && [source, bound].every((url) => url.origin === "https://www.youtube.com" && url.pathname === "/watch"
            && !url.username && !url.password && url.searchParams.getAll("v").length === 1 && url.searchParams.get("v") === videoId);
      } catch { return false; }
    };
    const reply = (result) => window.postMessage({ type: "LIBITU_FRESH_CAPTIONS_RESPONSE", requestId, videoId, ...result }, window.location.origin);
    if (!matchesSource()) { reply({ status: "invalid_request" }); return; }
    if (freshRequests.has(requestId)) return;
    if (freshRequests.size >= 4) { reply({ status: "busy" }); return; }
    freshRequests.add(requestId);
    let timer;
    try {
      const result = await Promise.race([
        chrome.runtime.sendMessage({ type: "LIBITU_READ_FRESH_CAPTIONS", requestId, sourceUrl, videoId, language }),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ status: "timeout" }), 4_000); })
      ]);
      if (!matchesSource()) { reply({ status: "stale" }); return; }
      const status = freshStatuses.has(result?.status) ? result.status : "unavailable";
      reply({ status, ...(["ready", "no_word_offsets"].includes(status) && result?.captionTrack ? { captionTrack: result.captionTrack } : {}) });
    } catch { if (matchesSource()) reply({ status: "bridge_error" }); }
    finally { clearTimeout(timer); freshRequests.delete(requestId); }
  }
})();
