(() => {
  if (globalThis.__libituBufferBridge || window !== window.top || window.location.origin !== "http://localhost:3000") return;
  globalThis.__libituBufferBridge = true;
  const sessions = new Map();
  const probes = new Set();
  const extracts = new Map();
  const validId = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
  const source = () => {
    const url = new URL(window.location.href);
    if (![null, "1", "2"].includes(url.searchParams.get("stage"))) return null;
    for (const key of ["stage", "segmentId", "sentenceId"]) url.searchParams.delete(key);
    url.hash = ""; url.searchParams.sort(); return url.href;
  };
  const forget = (sessionId) => {
    sessions.delete(sessionId); probes.delete(sessionId);
    for (const [id, owner] of extracts) if (owner === sessionId) extracts.delete(id);
  };
  const reply = (message) => {
    if (message?.type !== "LIBITU_BUFFER_EVENT" || message.version !== 3 || !sessions.has(message.sessionId)
      || sessions.get(message.sessionId) !== source()) return;
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
      || message.version !== 3 || !validId(message.sessionId) || !validId(message.requestId)
      || !["ping", "arm", "heartbeat", "close", "observe", "extract"].includes(message.action)) return;
    const sessionAction = message.action !== "extract";
    if ((message.sessionId === message.requestId) !== sessionAction) return;
    if (["ping", "arm"].includes(message.action)) {
      if (sessions.size >= 8 && !sessions.has(message.sessionId)) return;
      if (message.action === "ping" && !sessions.has(message.sessionId)) probes.add(message.sessionId);
      if (message.action === "arm") probes.delete(message.sessionId);
      sessions.set(message.sessionId, source());
    } else if (!sessions.has(message.sessionId) || sessions.get(message.sessionId) !== source()) return;
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
    chrome.runtime.sendMessage({ type: "LIBITU_BUFFER_REQUEST", version: 3, action: message.action,
      sessionId: message.sessionId, requestId: message.requestId, ...payload }).then(reply).catch(() => reply({
      type: "LIBITU_BUFFER_EVENT", version: 3, sessionId: message.sessionId, requestId: message.sessionId,
      status: "error", error: "The extension connection was lost. Reload the extension and this page."
    }));
  });
  chrome.runtime.onMessage.addListener((message, sender, response) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "LIBITU_BUFFER_VERIFY") response({ available: sessions.has(message.sessionId)
      && sessions.get(message.sessionId) === source(), url: window.location.href });
    else reply(message);
    return false;
  });
  window.addEventListener("pagehide", () => {
    for (const sessionId of sessions.keys()) chrome.runtime.sendMessage({
      type: "LIBITU_BUFFER_REQUEST", version: 3, action: "close", sessionId, requestId: sessionId
    }).catch(() => {});
    sessions.clear(); probes.clear(); extracts.clear();
  });
})();
