const ORIGIN = "http://localhost:3000";
const OFFSCREEN = "src/reference-offscreen.html";
const KEY = "libituBufferedSession";
const MAX_BASE64 = 32 * 1024 * 1024 + 64;
const validId = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const sessionActions = new Set(["ping", "arm", "heartbeat", "close", "observe"]);

export function bufferedSourceUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== ORIGIN || ![null, "1", "2"].includes(url.searchParams.get("stage"))) return null;
    for (const key of ["stage", "segmentId", "sentenceId"]) url.searchParams.delete(key);
    url.hash = ""; url.searchParams.sort(); return url.href;
  } catch { return null; }
}

export function validBufferedRequest(message) {
  if (message?.type !== "LIBITU_BUFFER_REQUEST" || message.version !== 3 || !validId(message.sessionId) || !validId(message.requestId)) return false;
  if (sessionActions.has(message.action)) {
    if (message.requestId !== message.sessionId) return false;
    if (message.action !== "observe") return true;
    const t = message.telemetry;
    return t && ["epochTime", "wallTime", "time", "rate"].every((key) => Number.isFinite(t[key]))
      && t.epochTime > 0 && t.wallTime >= 0 && t.time >= 0 && t.time <= 86400 && t.rate > 0 && t.rate <= 16
      && [-1, 0, 1, 2, 3, 5].includes(t.state) && Number.isSafeInteger(t.generation) && t.generation >= 0;
  }
  return message.action === "extract" && message.requestId !== message.sessionId
    && Number.isFinite(message.start) && Number.isFinite(message.end) && message.start >= 0
    && message.end > message.start && message.end - message.start <= 60 && message.end <= 86400;
}

export function installBufferedCapture(chromeApi, clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id)
}, { mediaLease = { owner: null }, ready } = {}) {
  let current = null;
  let creating = null;
  const offscreenUrl = chromeApi.runtime.getURL(OFFSCREEN);
  const event = (sessionId, requestId, status, extra = {}) => ({ type: "LIBITU_BUFFER_EVENT", version: 3, sessionId, requestId, status, ...extra });
  const deliver = (session, status, extra = {}, requestId = session.sessionId) => chromeApi.tabs.sendMessage(session.tabId,
    event(session.sessionId, requestId, status, extra), { documentId: session.documentId }).catch(() => {});
  const badge = (session, text, title) => {
    chromeApi.action.setBadgeText({ tabId: session.tabId, text }); chromeApi.action.setTitle({ tabId: session.tabId, title });
  };
  const clearTimer = (session, key) => { if (session[key] != null) clock.clearTimeout(session[key]); session[key] = null; };
  const hasOffscreen = async () => (await chromeApi.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [offscreenUrl] })).length > 0;
  const closeOffscreen = async () => {
    await creating?.catch(() => {});
    if (await hasOffscreen()) await chromeApi.offscreen.closeDocument();
  };
  const command = (session, action, requestId = session.sessionId, extra = {}) => chromeApi.runtime.sendMessage({
    type: "LIBITU_BUFFER_OFFSCREEN_COMMAND", version: 3, target: "buffer-offscreen", action,
    sessionId: session.sessionId, requestId, token: session.token, ...extra
  });
  function finish(session, status = "closed", error) {
    if (current !== session) return Promise.resolve();
    if (session.closing) return session.closing;
    session.terminal = true;
    for (const key of ["timer", "lease", "maximum"]) clearTimer(session, key);
    for (const pending of session.pending.values()) clock.clearTimeout(pending.timer);
    session.pending.clear();
    session.closing = (async () => {
      try { await closeOffscreen(); } catch { /* Document closure releases all tracks. */ }
      await session.storageWrite?.catch(() => {});
      await chromeApi.storage.session.remove(KEY).catch(() => {});
      if (current !== session) return;
      current = null;
      if (mediaLease.owner === session) mediaLease.owner = null;
      badge(session, "", "Open Libitu"); await deliver(session, status, error ? { error } : {});
    })();
    return session.closing;
  }
  const expire = (session, key, ms, error) => {
    clearTimer(session, key); session[key] = clock.setTimeout(() => { void finish(session, "error", error); }, ms);
  };
  const renew = (session) => expire(session, "lease", 45_000, "The page stopped responding. Enable practice audio again.");
  const boot = (async () => {
    await ready;
    // The v2 controller owns shared offscreen recovery when installed together.
    if (!ready) await closeOffscreen();
    const previous = (await chromeApi.storage.session.get(KEY))[KEY];
    await chromeApi.storage.session.remove(KEY);
    if (previous && Number.isInteger(previous.tabId) && validId(previous.sessionId) && typeof previous.documentId === "string") {
      badge(previous, "", "Open Libitu"); await deliver(previous, "error", { error: "The extension restarted. Enable practice audio again." });
    }
  })().catch(() => {});
  const owns = (session, sender, id) => session && session.sessionId === id && session.tabId === sender.tab?.id
    && session.documentId === sender.documentId && session.url === bufferedSourceUrl(sender.tab.url);
  const validSender = (sender) => {
    try { return sender.id === chromeApi.runtime.id && sender.frameId === 0 && Number.isInteger(sender.tab?.id)
      && typeof sender.documentId === "string" && sender.documentId.length > 0 && sender.documentId.length <= 200
      && new URL(sender.url).origin === ORIGIN && bufferedSourceUrl(sender.tab.url) !== null; }
    catch { return false; }
  };

  async function request(message, sender) {
    await boot;
    if (!validBufferedRequest(message) || !validSender(sender)) throw new Error("Invalid buffered audio request.");
    if (message.action === "ping") return event(message.sessionId, message.sessionId, "available");
    if (message.action === "arm") {
      if (current?.closing) await current.closing;
      if (current) {
        if (owns(current, sender, message.sessionId) && !current.terminal) return event(message.sessionId, message.sessionId, current.phase === "enabled" ? "enabled" : "armed");
        throw new Error("Practice audio is enabled in another session. End it first.");
      }
      if (mediaLease.owner) throw new Error("Practice audio is already enabled. End the other session first.");
      const session = { tabId: sender.tab.id, documentId: sender.documentId, url: bufferedSourceUrl(sender.tab.url),
        sessionId: message.sessionId, token: crypto.randomUUID(), phase: "armed", terminal: false, closing: null,
        timer: null, lease: null, maximum: null, pending: new Map(), seen: new Set() };
      current = session; mediaLease.owner = session;
      try {
        session.storageWrite = chromeApi.storage.session.set({ [KEY]: { tabId: session.tabId, documentId: session.documentId, sessionId: session.sessionId } });
        await session.storageWrite;
      } catch { await finish(session, "error", "The extension could not prepare this session."); return { accepted: true }; }
      if (current !== session || session.terminal) return { accepted: true };
      badge(session, "ON?", "Click Libitu to enable practice audio for this video");
      expire(session, "timer", 30_000, "Authorization expired. Enable practice audio, then click the Libitu toolbar icon.");
      return event(session.sessionId, session.sessionId, "armed");
    }
    const session = current;
    if (!owns(session, sender, message.sessionId) || session.terminal) return event(message.sessionId, message.sessionId, "closed");
    if (message.action === "close") { await finish(session); return { accepted: true }; }
    if (message.action === "heartbeat") { if (session.phase === "enabled") renew(session); return { accepted: true }; }
    if (session.phase !== "enabled") return { accepted: false };
    if (message.action === "observe") {
      const { epochTime, wallTime, time, rate, state, generation } = message.telemetry;
      await command(session, "observe", session.sessionId, { telemetry: { epochTime, wallTime, time, rate, state, generation } });
    } else {
      if (session.pending.size >= 4 || session.seen.has(message.requestId)) throw new Error("This audio request is already running or has ended.");
      if (session.seen.size >= 512) { await finish(session, "error", "This session reached its request limit. Enable practice audio again."); return { accepted: true }; }
      const pending = { start: message.start, end: message.end, timer: null };
      session.seen.add(message.requestId); session.pending.set(message.requestId, pending);
      pending.timer = clock.setTimeout(() => {
        if (current !== session || !session.pending.delete(message.requestId)) return;
        void deliver(session, "missing", { reason: "timeout" }, message.requestId);
      }, 10_000);
      await command(session, "extract", message.requestId, { start: message.start, end: message.end });
    }
    return { accepted: true };
  }

  async function onToolbarClick(tab) {
    await boot;
    const session = current;
    if (!session || session.terminal || session.tabId !== tab.id || session.url !== bufferedSourceUrl(tab.url)) return;
    if (session.phase === "enabled") { await finish(session); return; }
    if (session.phase !== "armed") return;
    session.phase = "starting";
    expire(session, "timer", 10_000, "The browser could not enable practice audio. Try again.");
    try {
      const check = await chromeApi.tabs.sendMessage(session.tabId, { type: "LIBITU_BUFFER_VERIFY", sessionId: session.sessionId }, { documentId: session.documentId });
      if (current !== session || session.terminal) return;
      if (!check?.available || bufferedSourceUrl(check.url) !== session.url) { await finish(session, "error", "The source page changed. Enable practice audio again."); return; }
      if (!await hasOffscreen()) {
        creating = chromeApi.offscreen.createDocument({ url: OFFSCREEN, reasons: ["USER_MEDIA"],
          justification: "Keep explicitly enabled reference audio local while the learner plays this video." });
        await creating; creating = null;
      }
      if (current !== session || session.terminal) return;
      const streamId = await chromeApi.tabCapture.getMediaStreamId({ targetTabId: session.tabId });
      if (current !== session || session.terminal) return;
      await command(session, "open", session.sessionId, { streamId });
    } catch { await finish(session, "error", "Tab audio could not be enabled. Reload the extension and try again."); }
  }

  async function offscreenEvent(message, sender) {
    const session = current;
    if (!session || session.terminal || sender.id !== chromeApi.runtime.id || sender.tab || sender.url !== offscreenUrl
      || message.token !== session.token || message.sessionId !== session.sessionId) return;
    if (message.requestId === session.sessionId) {
      if (message.status === "enabled" && session.phase === "starting") {
        session.phase = "enabled"; clearTimer(session, "timer"); renew(session);
        expire(session, "maximum", 30 * 60_000, "Practice audio reached its time limit. Enable it again.");
        badge(session, "REC", "Practice audio enabled. Click Libitu to stop and clear it."); await deliver(session, "enabled");
      } else if (message.status === "coverage" && session.phase === "enabled") {
        if (!Array.isArray(message.ranges) || message.ranges.length > 4096 || !message.ranges.every((range) =>
          Number.isFinite(range.start) && Number.isFinite(range.end) && range.start >= 0 && range.end > range.start)
          || !Number.isSafeInteger(message.retainedBytes) || message.retainedBytes < 0 || message.retainedBytes > 64 * 1024 * 1024
          || typeof message.recording !== "boolean") return;
        await deliver(session, "coverage", { ranges: message.ranges.map(({ start, end }) => ({ start, end })),
          retainedBytes: message.retainedBytes, recording: message.recording });
      } else if (message.status === "error") await finish(session, "error", "Practice audio was interrupted. Enable it again.");
      return;
    }
    const pending = session.pending.get(message.requestId);
    if (!pending || !["complete", "missing"].includes(message.status)) return;
    clock.clearTimeout(pending.timer); session.pending.delete(message.requestId);
    if (message.status === "missing") { await deliver(session, "missing", { reason: "not_covered" }, message.requestId); return; }
    if (message.mimeType !== "audio/wav" || message.start !== pending.start || message.end !== pending.end || !validId(message.captureId)
      || !Number.isFinite(message.durationMs) || message.durationMs <= 0 || Math.abs(message.durationMs - (pending.end - pending.start) * 1000) > 150
      || typeof message.audioBase64 !== "string" || !message.audioBase64.length || message.audioBase64.length > MAX_BASE64
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(message.audioBase64)) {
      await deliver(session, "missing", { reason: "invalid_audio" }, message.requestId); return;
    }
    await deliver(session, "complete", { audioBase64: message.audioBase64, mimeType: message.mimeType, durationMs: message.durationMs,
      start: message.start, end: message.end, captureId: message.captureId }, message.requestId);
  }

  chromeApi.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type === "LIBITU_BUFFER_REQUEST" && message.version === 3) {
      request(message, sender).then(reply).catch((error) => reply(event(message.sessionId, message.requestId, "error", { error: error.message }))); return true;
    }
    if (message?.type === "LIBITU_BUFFER_OFFSCREEN_EVENT" && message.version === 3) {
      offscreenEvent(message, sender).then(() => reply({ accepted: true })).catch(() => reply({ accepted: false })); return true;
    }
    return false;
  });
  chromeApi.tabs.onUpdated.addListener((tabId, change) => {
    if (current?.tabId !== tabId) return;
    // A same-document Stage 1 → Stage 2 history update can be reported with a
    // transient loading status. Keep the source-owned stream alive while the
    // normalized Libitu URL is unchanged; a real reload without a URL still
    // closes the document-bound session.
    if (change.url && bufferedSourceUrl(change.url) !== current.url) void finish(current);
    else if (!change.url && change.status === "loading") void finish(current);
  });
  chromeApi.tabs.onRemoved.addListener((tabId) => { if (current?.tabId === tabId) void finish(current); });
  return { ready: boot, handlesTab: (tab) => current?.tabId === tab.id && current.url === bufferedSourceUrl(tab.url), onToolbarClick };
}
