const WEB_ORIGIN = "http://localhost:3000";
const OFFSCREEN_PATH = "src/reference-offscreen.html";
const SESSION_KEY = "libituReferenceSession";
const MAX_BASE64_LENGTH = 8 * 1024 * 1024;
const validId = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const sessionActions = new Set(["ping", "arm", "close", "heartbeat"]);

export function practiceUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== WEB_ORIGIN || url.searchParams.get("stage") !== "2") return null;
    url.searchParams.delete("sentenceId");
    url.searchParams.sort();
    url.hash = "";
    return url.href;
  } catch { return null; }
}

export const isStageTwoUrl = (value) => practiceUrl(value) !== null;

function isWebDocumentUrl(value) {
  try { return new URL(value).origin === WEB_ORIGIN; }
  catch { return false; }
}

export function validReferenceRequest(message) {
  if (message?.type !== "LIBITU_REFERENCE_REQUEST" || message.version !== 2 ||
    !validId(message.sessionId) || !validId(message.requestId)) return false;
  if (sessionActions.has(message.action)) return message.requestId === message.sessionId;
  if (!["begin", "stop", "cancel"].includes(message.action) || message.requestId === message.sessionId) return false;
  return message.action !== "begin" || (
    validId(message.sentenceId) && Number.isFinite(message.start) && Number.isFinite(message.end) &&
    message.start >= 0 && message.end > message.start && message.end - message.start <= 60
  );
}

export function installReferenceCapture(chromeApi, clock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (id) => clearTimeout(id)
}, mediaLease = { owner: null }) {
  let current = null;
  let creating = null;
  const offscreenUrl = chromeApi.runtime.getURL(OFFSCREEN_PATH);
  const event = (sessionId, requestId, status, extra = {}) => ({
    type: "LIBITU_REFERENCE_EVENT", version: 2, sessionId, requestId, status, ...extra
  });
  const badge = (tabId, text, title) => {
    chromeApi.action.setBadgeText({ tabId, text });
    chromeApi.action.setTitle({ tabId, title });
  };
  const deliver = (session, requestId, status, extra) => chromeApi.tabs.sendMessage(
    session.tabId, event(session.sessionId, requestId, status, extra), { documentId: session.documentId }
  ).catch(() => {});
  const hasOffscreen = async () => (await chromeApi.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [offscreenUrl]
  })).length > 0;
  const closeOffscreen = async () => {
    if (creating) await creating.catch(() => {});
    if (await hasOffscreen()) await chromeApi.offscreen.closeDocument();
  };
  const clearTimer = (owner, key = "timer") => {
    if (owner[key] !== null) clock.clearTimeout(owner[key]);
    owner[key] = null;
  };
  const command = (session, action, requestId = session.sessionId, extra = {}) => chromeApi.runtime.sendMessage({
    type: "LIBITU_REFERENCE_OFFSCREEN_COMMAND", version: 2, target: "reference-offscreen",
    action, token: session.token, sessionId: session.sessionId, requestId, ...extra
  });

  function finishSession(session, status = "closed", extra = {}) {
    if (current !== session) return Promise.resolve();
    if (session.closing) return session.closing;
    session.terminal = true;
    clearTimer(session);
    clearTimer(session, "lease");
    if (session.clip) clearTimer(session.clip);
    session.clip = null;
    session.closing = (async () => {
      try { await closeOffscreen(); }
      catch { /* Closing the owning document releases its media even after worker loss. */ }
      await session.storageWrite?.catch(() => {});
      await chromeApi.storage.session.remove(SESSION_KEY).catch(() => {});
      if (current !== session) return;
      current = null;
      if (mediaLease.owner === session) mediaLease.owner = null;
      badge(session.tabId, "", "Open Libitu");
      await deliver(session, session.sessionId, status, extra);
    })();
    return session.closing;
  }
  const expireSession = (session, ms, error, key = "timer") => {
    clearTimer(session, key);
    session[key] = clock.setTimeout(() => { void finishSession(session, "error", { error }); }, ms);
  };
  const renewLease = (session) => expireSession(session, 45_000,
    "The practice page stopped responding. Enable reference audio again.", "lease");

  async function finishClip(session, clip, status, extra = {}) {
    if (current !== session || session.terminal || session.clip !== clip) return;
    session.clip = null;
    clearTimer(clip);
    if (status !== "complete") {
      const cleanup = command(session, "cancel", clip.requestId);
      session.clipCleanup = cleanup;
      try { await cleanup; }
      catch { await finishSession(session, "error", { error: "The reference audio connection was lost. Enable it again." }); return; }
      finally { if (session.clipCleanup === cleanup) session.clipCleanup = null; }
    }
    if (current === session && !session.terminal) await deliver(session, clip.requestId, status, extra);
  }
  const expireClip = (session, clip, ms, error) => {
    clearTimer(clip);
    clip.timer = clock.setTimeout(() => { void finishClip(session, clip, "error", { error }); }, ms);
  };

  // Only ownership metadata survives a worker restart. Never restore a raw-media session.
  const boot = (async () => {
    const previous = (await chromeApi.storage.session.get(SESSION_KEY))[SESSION_KEY];
    await closeOffscreen();
    await chromeApi.storage.session.remove(SESSION_KEY);
    if (previous && Number.isInteger(previous.tabId) && validId(previous.sessionId) && typeof previous.documentId === "string") {
      badge(previous.tabId, "", "Open Libitu");
      await deliver(previous, previous.sessionId, "error", { error: "The extension restarted. Enable reference audio again." });
    }
  })().catch(() => {});

  async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    if (!creating) {
      creating = chromeApi.offscreen.createDocument({
        url: OFFSCREEN_PATH, reasons: ["USER_MEDIA"],
        justification: "Keep the explicitly authorized practice tab stream local and record only requested reference sentences."
      }).finally(() => { creating = null; });
    }
    await creating;
  }

  function validSender(sender) {
    return sender.id === chromeApi.runtime.id && sender.frameId === 0 && Number.isInteger(sender.tab?.id) &&
      typeof sender.documentId === "string" && sender.documentId.length > 0 && sender.documentId.length <= 200 &&
      isWebDocumentUrl(sender.url) && isStageTwoUrl(sender.tab.url);
  }
  const owns = (session, sender, sessionId) => session && session.sessionId === sessionId &&
    session.tabId === sender.tab.id && session.documentId === sender.documentId &&
    session.url === practiceUrl(sender.tab.url);

  async function handleRequest(message, sender) {
    await boot;
    if (!validReferenceRequest(message) || !validSender(sender)) throw new Error("Invalid reference audio request.");
    if (message.action === "ping") return event(message.sessionId, message.sessionId, "available");
    if (message.action === "arm") {
      if (current?.closing) await current.closing;
      if (current) {
        if (owns(current, sender, message.sessionId) && !current.terminal) {
          return event(message.sessionId, message.sessionId, current.phase === "enabled" ? "enabled" : "armed");
        }
        throw new Error("Reference audio is enabled in another practice session. End that session first.");
      }
      if (mediaLease.owner) throw new Error("Reference audio is already enabled. End that session first.");
      const session = {
        tabId: sender.tab.id, documentId: sender.documentId, url: practiceUrl(sender.tab.url), sessionId: message.sessionId,
        token: crypto.randomUUID(), phase: "armed", terminal: false, closing: null, timer: null, lease: null,
        clip: null, clipCleanup: null, storageWrite: null, seen: new Set()
      };
      current = session;
      mediaLease.owner = session;
      try {
        session.storageWrite = chromeApi.storage.session.set({ [SESSION_KEY]: {
          tabId: session.tabId, documentId: session.documentId, sessionId: session.sessionId
        } });
        await session.storageWrite;
      } catch {
        if (current === session) current = null;
        if (mediaLease.owner === session) mediaLease.owner = null;
        throw new Error("The extension could not prepare this session. Reload it and try again.");
      }
      if (current !== session || session.terminal) return { accepted: true };
      badge(session.tabId, "ON?", "Click Libitu to enable reference audio for this practice session");
      expireSession(session, 30_000, "Authorization expired. Enable reference audio again, then click the Libitu toolbar icon.");
      return event(message.sessionId, message.sessionId, "armed");
    }
    const session = current;
    if (!owns(session, sender, message.sessionId) || session.terminal) {
      return event(message.sessionId, message.sessionId, "closed", { error: "Reference audio is no longer enabled. Enable it again." });
    }
    if (message.action === "close") {
      await finishSession(session);
      return { accepted: true };
    }
    if (message.action === "heartbeat") {
      if (session.phase === "enabled") renewLease(session);
      return { accepted: true };
    }
    if (session.phase !== "enabled") {
      await finishSession(session, "error", { error: "Click the Libitu toolbar icon to enable reference audio first." });
      return { accepted: true };
    }
    if (message.action === "begin") {
      if (session.clipCleanup) await session.clipCleanup.catch(() => {});
      if (current !== session || session.terminal) {
        return event(session.sessionId, session.sessionId, "closed", { error: "Reference audio ended. Enable it again." });
      }
      const old = session.clip;
      if (old?.requestId === message.requestId && old.sentenceId === message.sentenceId && old.start === message.start && old.end === message.end) {
        return { accepted: true };
      }
      if (session.seen.has(message.requestId)) throw new Error("This reference request has ended. Start a new request.");
      if (old) throw new Error("Another reference sentence is still being captured.");
      if (session.seen.size >= 512) {
        await finishSession(session, "error", { error: "This practice session reached its request limit. Enable reference audio again." });
        return { accepted: true };
      }
      const clip = { requestId: message.requestId, sentenceId: message.sentenceId, start: message.start, end: message.end,
        phase: "starting", timer: null, captureStartedAt: null };
      session.seen.add(clip.requestId);
      session.clip = clip;
      expireClip(session, clip, 10_000, "The sentence recorder could not start. Try this sentence again.");
      try { await command(session, "begin", clip.requestId); }
      catch { await finishSession(session, "error", { error: "The reference audio connection was lost. Enable it again." }); }
      return { accepted: true };
    }
    const clip = session.clip;
    if (!clip || clip.requestId !== message.requestId) {
      return event(session.sessionId, message.requestId, message.action === "cancel" ? "cancelled" : "error",
        message.action === "cancel" ? {} : { error: "This sentence capture is no longer active." });
    }
    if (message.action === "cancel") {
      await finishClip(session, clip, "cancelled");
    } else if (clip.phase === "recording") {
      clip.phase = "stopping";
      expireClip(session, clip, 5_000, "The browser could not finish this sentence. Try it again.");
      try { await command(session, "stop", clip.requestId); }
      catch { await finishSession(session, "error", { error: "The reference audio connection was lost. Enable it again." }); }
    } else if (clip.phase !== "stopping") {
      await finishClip(session, clip, "error", { error: "Reference playback did not start. Try the sentence again." });
    }
    return { accepted: true };
  }

  async function onToolbarClick(tab) {
    await boot;
    const session = current;
    if (!session || session.tabId !== tab.id || session.url !== practiceUrl(tab.url)) {
      badge(tab.id, "!", "Choose Enable reference audio in Stage 2 before clicking Libitu.");
      return;
    }
    if (session.terminal) return;
    if (session.phase === "enabled") { await finishSession(session); return; }
    if (session.phase !== "armed") return;
    session.phase = "starting";
    expireSession(session, 10_000, "The browser could not enable tab audio. Try enabling reference audio again.");
    try {
      const verification = await chromeApi.tabs.sendMessage(session.tabId, {
        type: "LIBITU_REFERENCE_VERIFY", sessionId: session.sessionId
      }, { documentId: session.documentId });
      if (current !== session || session.terminal) return;
      if (!verification?.available || practiceUrl(verification.url) !== session.url) {
        await finishSession(session, "error", { error: "The practice page changed. Enable reference audio again." });
        return;
      }
      await ensureOffscreen();
      if (current !== session || session.terminal) return;
      const streamId = await chromeApi.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      if (current !== session || session.terminal) return;
      await command(session, "open", session.sessionId, { streamId });
    } catch {
      await finishSession(session, "error", { error: "Tab audio could not be enabled. Reload the extension and Stage 2, then try again." });
    }
  }

  async function handleOffscreen(message, sender) {
    await boot;
    if (sender.id !== chromeApi.runtime.id || sender.tab || sender.url !== offscreenUrl) return;
    const session = current;
    if (!session || session.terminal || message.token !== session.token || message.sessionId !== session.sessionId) return;
    if (message.requestId === session.sessionId) {
      if (message.status === "heartbeat") return;
      if (message.status === "enabled" && session.phase === "starting") {
        session.phase = "enabled";
        clearTimer(session);
        renewLease(session);
        badge(session.tabId, "ON", "Reference audio enabled · Click Libitu to end this session");
        await deliver(session, session.sessionId, "enabled");
      } else if (["error", "closed"].includes(message.status)) {
        await finishSession(session, "error", { error: "Reference audio ended or became unavailable. Enable it again." });
      }
      return;
    }
    const clip = session.clip;
    if (!clip || message.requestId !== clip.requestId) return;
    if (message.status === "recording" && clip.phase === "starting" && Number.isFinite(message.captureStartedAt)) {
      clip.phase = "recording";
      clip.captureStartedAt = message.captureStartedAt;
      expireClip(session, clip, 65_000, "This reference reached its time limit. Try a shorter sentence.");
      await deliver(session, clip.requestId, "recording", { captureStartedAt: message.captureStartedAt });
    } else if (message.status === "complete" && clip.phase === "stopping") {
      if (typeof message.audioBase64 !== "string" || !message.audioBase64.length || message.audioBase64.length > MAX_BASE64_LENGTH ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(message.audioBase64) || typeof message.mimeType !== "string" ||
        !/^audio\/[a-z0-9.+-]+(?:;[^\r\n]{0,100})?$/i.test(message.mimeType) ||
        !Number.isFinite(message.durationMs) || message.durationMs <= 0 || message.durationMs > 70_000) {
        await finishClip(session, clip, "error", { error: "The reference recording was empty or too large. Try a shorter sentence." });
        return;
      }
      await finishClip(session, clip, "complete", { audioBase64: message.audioBase64, mimeType: message.mimeType,
        durationMs: message.durationMs, captureStartedAt: clip.captureStartedAt });
    } else if (message.status === "error") {
      await finishClip(session, clip, "error", { error: "This reference recording was interrupted. Try the sentence again." });
    }
  }

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "LIBITU_REFERENCE_REQUEST" && message.version === 2) {
      handleRequest(message, sender).then(sendResponse).catch((error) => sendResponse(
        event(message.sessionId, message.requestId, "error", { error: error.message })
      ));
      return true;
    }
    if (message?.type === "LIBITU_REFERENCE_OFFSCREEN_EVENT" && message.version === 2) {
      handleOffscreen(message, sender).then(() => sendResponse({ accepted: true })).catch(() => sendResponse({ accepted: false }));
      return true;
    }
    return false;
  });
  chromeApi.tabs.onUpdated.addListener((tabId, change) => {
    if (current?.tabId === tabId && (change.status === "loading" || (change.url && practiceUrl(change.url) !== current.url))) {
      void finishSession(current);
    }
  });
  chromeApi.tabs.onRemoved.addListener((tabId) => {
    if (current?.tabId === tabId) void finishSession(current);
  });
  return { handlesTab: (tab) => isStageTwoUrl(tab.url), onToolbarClick, ready: boot };
}
