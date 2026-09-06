(() => {
  if (globalThis.__libituStageOneBridge) return;
  globalThis.__libituStageOneBridge = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== "LIBITU_HANDOFF_REQUEST") return;
    const { handoffId, requestId } = event.data;
    if (typeof requestId !== "string" || handoffId !== new URLSearchParams(window.location.search).get("handoffId")) return;
    const reply = (payload) => window.postMessage({ type: "LIBITU_HANDOFF_RESPONSE", handoffId, requestId, ...payload }, window.location.origin);
    reply({ phase: "connected" });
    chrome.runtime.sendMessage({ type: "LIBITU_READ_HANDOFF", handoffId })
      .then((result) => reply({ phase: "ready", transcriptText: result?.transcriptText }))
      .catch(() => reply({ phase: "ready" }));
  });
})();
