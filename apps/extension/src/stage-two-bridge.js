(() => {
  if (globalThis.__libituStageTwoBridge || window !== window.top || window.location.origin !== "http://localhost:3000") return;
  globalThis.__libituStageTwoBridge = true;
  const sessions = new Set();
  const probes = new Set();
  const clips = new Map();
  const validId = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
  const currentStage = () => new URLSearchParams(window.location.search).get("stage") === "2";
  const reply = (message) => {
    if (!currentStage() || !sessions.has(message?.sessionId) || message.type !== "LIBITU_REFERENCE_EVENT" || message.version !== 2) return;
    const sessionEvent = message.requestId === message.sessionId;
    if (!sessionEvent && clips.get(message.requestId) !== message.sessionId) return;
    const statuses = sessionEvent ? ["available", "armed", "enabled", "closed", "error"] : ["recording", "complete", "cancelled", "error"];
    if (!statuses.includes(message.status)) return;
    window.postMessage(message, window.location.origin);
    if (sessionEvent && message.status === "available" && probes.delete(message.sessionId)) {
      sessions.delete(message.sessionId);
    } else if (sessionEvent && ["closed", "error"].includes(message.status)) {
      sessions.delete(message.sessionId);
      probes.delete(message.sessionId);
      for (const [requestId, sessionId] of clips) if (sessionId === message.sessionId) clips.delete(requestId);
    } else if (!sessionEvent && ["complete", "cancelled", "error"].includes(message.status)) clips.delete(message.requestId);
  };
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== window.location.origin || !currentStage() ||
      message?.type !== "LIBITU_REFERENCE_REQUEST" || message.version !== 2 || !validId(message.sessionId) || !validId(message.requestId) ||
      !["ping", "arm", "begin", "stop", "cancel", "close", "heartbeat"].includes(message.action)) return;
    const sessionAction = ["ping", "arm", "close", "heartbeat"].includes(message.action);
    if ((message.requestId === message.sessionId) !== sessionAction) return;
    if (["ping", "arm"].includes(message.action)) {
      if (sessions.size >= 8 && !sessions.has(message.sessionId)) return;
      if (message.action === "ping" && !sessions.has(message.sessionId)) probes.add(message.sessionId);
      if (message.action === "arm") probes.delete(message.sessionId);
      sessions.add(message.sessionId);
    } else if (!sessions.has(message.sessionId)) return;
    if (message.action === "begin") {
      if (clips.size >= 8 && !clips.has(message.requestId)) return;
      clips.set(message.requestId, message.sessionId);
    }
    if (["stop", "cancel"].includes(message.action) && clips.get(message.requestId) !== message.sessionId) return;
    chrome.runtime.sendMessage({
      type: "LIBITU_REFERENCE_REQUEST", version: 2, sessionId: message.sessionId, requestId: message.requestId, action: message.action,
      ...(message.action === "begin" ? { sentenceId: message.sentenceId, start: message.start, end: message.end } : {})
    }).then(reply).catch(() => reply({
      type: "LIBITU_REFERENCE_EVENT", version: 2, sessionId: message.sessionId, requestId: message.sessionId, status: "error",
      error: "The extension connection was lost. Reload the extension and this page, then try again."
    }));
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "LIBITU_REFERENCE_VERIFY") {
      sendResponse({ available: currentStage() && sessions.has(message.sessionId), url: window.location.href });
    } else reply(message);
    return false;
  });
  window.addEventListener("pagehide", () => {
    for (const sessionId of sessions) {
      chrome.runtime.sendMessage({ type: "LIBITU_REFERENCE_REQUEST", version: 2, sessionId, requestId: sessionId, action: "close" }).catch(() => {});
    }
    sessions.clear();
    probes.clear();
    clips.clear();
  });
})();
