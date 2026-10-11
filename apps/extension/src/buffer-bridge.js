(() => {
  if (globalThis.__libituBufferBridge || window !== window.top || window.location.origin !== "http://localhost:3000") return;
  globalThis.__libituBufferBridge = true;
  const sessions = new Map();
  const probes = new Set();
  const extracts = new Map();
  const validId = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
  const documentNonce = crypto.randomUUID();
  const source = () => /^\/practice\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(?:segments|shadow))?$/.exec(window.location.pathname)?.[1] ?? null;
  const identity = (message) => message.contentId === source() && /^[\w-]{11}$/.test(message.videoId ?? "")
    ? `${message.contentId}:${message.videoId}` : null;
  const forget = (sessionId) => {
    sessions.delete(sessionId); probes.delete(sessionId);
    for (const [id, owner] of extracts) if (owner === sessionId) extracts.delete(id);
  };
  const reply = (message) => {
    if (message?.type !== "LIBITU_BUFFER_EVENT" || message.version !== 4 || !sessions.has(message.sessionId)
      || sessions.get(message.sessionId)?.contentId !== source()) return;
    const sessionEvent = message.requestId === message.sessionId;
    if (!sessionEvent && extracts.get(message.requestId) !== message.sessionId) return;
    if (!(sessionEvent ? ["available", "armed", "enabled", "coverage", "closed", "error"] : ["complete", "missing", "error"]).includes(message.status)) return;
    window.postMessage(message, window.location.origin);
    if (sessionEvent && ((message.status === "available" && probes.has(message.sessionId)) || ["closed", "error"].includes(message.status))) forget(message.sessionId);
    else if (!sessionEvent) extracts.delete(message.requestId);
  };
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== window.location.origin || !source() || message?.type !== "LIBITU_BUFFER_REQUEST"
      || message.version !== 4 || !identity(message) || !validId(message.sessionId) || !validId(message.requestId)
      || !["ping", "register", "arm", "heartbeat", "close", "observe", "extract"].includes(message.action)) return;
    const sessionAction = message.action !== "extract";
    if ((message.sessionId === message.requestId) !== sessionAction) return;
    if (["ping", "register", "arm"].includes(message.action)) {
      if (sessions.size >= 8 && !sessions.has(message.sessionId)) return;
      if (["ping", "register"].includes(message.action) && !sessions.has(message.sessionId)) probes.add(message.sessionId);
      if (message.action === "arm") probes.delete(message.sessionId);
      sessions.set(message.sessionId, { contentId: message.contentId, videoId: message.videoId });
    } else if (!sessions.has(message.sessionId) || sessions.get(message.sessionId)?.contentId !== source() || sessions.get(message.sessionId).videoId !== message.videoId) return;
    if (message.action === "extract") {
      if (extracts.size >= 4 || extracts.has(message.requestId)) return;
      extracts.set(message.requestId, message.sessionId);
    }
    let payload = {};
    if (message.action === "extract") payload = { start: message.start, end: message.end };
    if (message.action === "observe") {
      const t = message.telemetry;
      if (!t || typeof t !== "object") return;
      const { epochTime, wallTime, time, rate, state, generation } = t;
      payload = { telemetry: { epochTime, wallTime, time, rate, state, generation } };
    }
    chrome.runtime.sendMessage({ type: "LIBITU_BUFFER_REQUEST", version: 4, action: message.action,
      sessionId: message.sessionId, requestId: message.requestId, contentId: message.contentId, videoId: message.videoId, documentNonce, ...payload }).then(reply).catch(() => reply({
      type: "LIBITU_BUFFER_EVENT", version: 4, sessionId: message.sessionId, requestId: message.sessionId,
      status: "error", error: "The extension connection was lost. Reload the extension and this page."
    }));
  });
  chrome.runtime.onMessage.addListener((message, sender, response) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "LIBITU_BUFFER_VERIFY") response({ available: sessions.has(message.sessionId)
      && sessions.get(message.sessionId).contentId === source(), url: window.location.href, documentNonce, ...sessions.get(message.sessionId) });
    else reply(message);
    return false;
  });
  window.addEventListener("pagehide", () => {
    for (const sessionId of sessions.keys()) chrome.runtime.sendMessage({
      type: "LIBITU_BUFFER_REQUEST", version: 4, action: "close", sessionId, requestId: sessionId, documentNonce, ...sessions.get(sessionId)
    }).catch(() => {});
    sessions.clear(); probes.clear(); extracts.clear();
  });
})();
