const MAX_BYTES = 6 * 1024 * 1024;
const validId = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const browserEnvironment = {
  getUserMedia: (streamId) => navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }, video: false
  }),
  createContext: () => new AudioContext(),
  createRecorder: (stream) => {
    for (const mimeType of ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"]) {
      if (!MediaRecorder.isTypeSupported(mimeType)) continue;
      try { return new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128_000 }); }
      catch { /* Try the next format or native default. */ }
    }
    return new MediaRecorder(stream);
  },
  toBase64: async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  },
  now: () => performance.now(), epoch: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (id) => clearTimeout(id)
};

/** Retains one authorized stream. An encoder and audio chunks exist only during a requested clip. */
export function createReferenceRecorder(send, overrides = {}) {
  const environment = { ...browserEnvironment, ...overrides };
  let current = null;
  const emit = (session, requestId, status, extra = {}) => Promise.resolve(send({
    type: "LIBITU_REFERENCE_OFFSCREEN_EVENT", version: 2, token: session.token,
    sessionId: session.sessionId, requestId, status, ...extra
  })).catch(() => {});
  const clearTimer = (owner, name) => {
    if (owner[name] !== null) environment.clearTimeout(owner[name]);
    owner[name] = null;
  };
  const cleanupClip = (clip) => {
    clearTimer(clip, "timeout");
    for (const remove of clip.listeners.splice(0)) remove();
    try { if (clip.recorder?.state !== "inactive") clip.recorder?.stop(); }
    catch { /* Listener removal and buffer cleanup remain required after encoder failure. */ }
    clip.chunks.length = 0;
    clip.recorder = null;
  };
  const cleanupSession = (session) => {
    for (const name of ["setup", "maximum", "heartbeat"]) clearTimer(session, name);
    if (session.clip) cleanupClip(session.clip);
    session.clip = null;
    for (const remove of session.listeners.splice(0)) remove();
    const stream = session.stream;
    session.stream = null;
    for (const track of stream?.getTracks() ?? []) {
      try { track.stop(); } catch { /* Release every returned track. */ }
    }
    try { session.source?.disconnect(); } catch { /* Already disconnected. */ }
    session.source = null;
    const context = session.context;
    session.context = null;
    if (context) void context.close().catch(() => {});
  };
  const failSession = (session) => {
    if (current !== session) return;
    current = null;
    cleanupSession(session);
    void emit(session, session.sessionId, "error");
  };
  const failClip = (session, clip) => {
    if (current !== session || session.clip !== clip) return;
    session.clip = null;
    cleanupClip(clip);
    void emit(session, clip.requestId, "error");
  };
  const clipTimeout = (session, clip, ms) => {
    clearTimer(clip, "timeout");
    clip.timeout = environment.setTimeout(() => failClip(session, clip), ms);
  };
  const heartbeat = (session) => {
    session.heartbeat = environment.setTimeout(() => {
      if (current !== session) return;
      void emit(session, session.sessionId, "heartbeat");
      heartbeat(session);
    }, 10_000);
  };
  const owns = (session, message) => session && session.token === message.token && session.sessionId === message.sessionId;

  async function open(message) {
    if (current) { void emit(message, message.sessionId, "error"); return; }
    const session = {
      token: message.token, sessionId: message.sessionId, phase: "starting", stream: null, context: null,
      source: null, listeners: [], setup: null, maximum: null, heartbeat: null, clip: null, seen: new Set()
    };
    current = session;
    session.setup = environment.setTimeout(() => failSession(session), 10_000);
    session.maximum = environment.setTimeout(() => failSession(session), 30 * 60_000);
    try {
      const stream = await environment.getUserMedia(message.streamId);
      if (current !== session) {
        for (const track of stream.getTracks()) {
          try { track.stop(); } catch { /* Release all late tracks. */ }
        }
        return;
      }
      session.stream = stream;
      if (!stream.getAudioTracks().length || stream.getAudioTracks().some((track) => track.readyState === "ended")) {
        failSession(session); return;
      }
      for (const track of stream.getTracks()) {
        const ended = () => failSession(session);
        track.addEventListener("ended", ended);
        session.listeners.push(() => track.removeEventListener("ended", ended));
      }
      const context = environment.createContext();
      session.context = context;
      session.source = context.createMediaStreamSource(stream);
      session.source.connect(context.destination);
      if (context.addEventListener) {
        const changed = () => { if (session.phase === "enabled" && context.state !== "running") failSession(session); };
        context.addEventListener("statechange", changed);
        session.listeners.push(() => context.removeEventListener("statechange", changed));
      }
      await context.resume();
      if (current !== session) return;
      if (context.state !== "running") { failSession(session); return; }
      session.phase = "enabled";
      clearTimer(session, "setup");
      heartbeat(session);
      await emit(session, session.sessionId, "enabled");
    } catch { failSession(session); }
  }

  async function finish(session, clip) {
    if (current !== session || session.clip !== clip) return;
    if (clip.phase !== "stopping") { failClip(session, clip); return; }
    try {
      const mimeType = clip.recorder.mimeType || clip.chunks.find((chunk) => chunk.type)?.type || "";
      const blob = new Blob(clip.chunks, { type: mimeType });
      if (!blob.size || blob.size > MAX_BYTES || !mimeType.startsWith("audio/")) { failClip(session, clip); return; }
      const audioBase64 = await environment.toBase64(blob);
      if (current !== session || session.clip !== clip) return;
      const durationMs = clip.stoppedAt - clip.startedAt;
      session.clip = null;
      cleanupClip(clip);
      await emit(session, clip.requestId, "complete", { audioBase64, mimeType, durationMs, captureStartedAt: clip.captureStartedAt });
    } catch { failClip(session, clip); }
  }

  function begin(message) {
    const session = current;
    if (!owns(session, message) || session.phase !== "enabled") {
      void emit(message, message.sessionId, "error"); return;
    }
    if (session.clip || session.seen.has(message.requestId)) {
      void emit(session, message.requestId, "error"); return;
    }
    if (session.seen.size >= 512) { failSession(session); return; }
    session.seen.add(message.requestId);
    const clip = { requestId: message.requestId, phase: "starting", recorder: null, chunks: [], bytes: 0,
      timeout: null, listeners: [], startedAt: null, stoppedAt: null, captureStartedAt: null };
    session.clip = clip;
    clipTimeout(session, clip, 10_000);
    try {
      const recorder = environment.createRecorder(session.stream);
      clip.recorder = recorder;
      const handlers = {
        start: () => {
          if (current !== session || session.clip !== clip || clip.phase !== "starting") return;
          clip.phase = "recording";
          clip.startedAt = environment.now();
          clip.captureStartedAt = environment.epoch();
          clipTimeout(session, clip, 65_000);
          void emit(session, clip.requestId, "recording", { captureStartedAt: clip.captureStartedAt });
        },
        dataavailable: (event) => {
          if (current !== session || session.clip !== clip || !event.data.size) return;
          clip.bytes += event.data.size;
          if (clip.bytes > MAX_BYTES) { failClip(session, clip); return; }
          clip.chunks.push(event.data);
        },
        stop: () => { void finish(session, clip); },
        error: () => failClip(session, clip)
      };
      for (const [type, handler] of Object.entries(handlers)) {
        recorder.addEventListener(type, handler);
        clip.listeners.push(() => recorder.removeEventListener(type, handler));
      }
      recorder.start(250);
    } catch { failClip(session, clip); }
  }

  function stop(message) {
    const session = current;
    if (!owns(session, message) || session.clip?.requestId !== message.requestId) return;
    const clip = session.clip;
    if (clip.phase === "stopping") return;
    if (clip.phase !== "recording") { failClip(session, clip); return; }
    clip.phase = "stopping";
    clip.stoppedAt = environment.now();
    clipTimeout(session, clip, 5_000);
    try { clip.recorder.stop(); } catch { failClip(session, clip); }
  }

  function cancel(message) {
    const session = current;
    if (!owns(session, message) || session.clip?.requestId !== message.requestId) return;
    const clip = session.clip;
    session.clip = null;
    cleanupClip(clip);
  }

  function close(message) {
    if (!owns(current, message)) return;
    dispose();
  }

  function dispose() {
    if (!current) return;
    const session = current;
    current = null;
    cleanupSession(session);
  }

  return { open, begin, stop, cancel, close, dispose };
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  const recorder = createReferenceRecorder((message) => chrome.runtime.sendMessage(message));
  window.addEventListener("pagehide", () => recorder.dispose());
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || sender.tab ||
      (sender.url && sender.url !== chrome.runtime.getURL("src/background.js")) ||
      message?.type !== "LIBITU_REFERENCE_OFFSCREEN_COMMAND" || message.version !== 2 || message.target !== "reference-offscreen" ||
      !validId(message.token) || !validId(message.sessionId) || !validId(message.requestId)) return false;
    if (message.action === "open" && message.requestId === message.sessionId && typeof message.streamId === "string" && message.streamId.length > 0 && message.streamId.length <= 4096) {
      void recorder.open(message);
    } else if (message.action === "close" && message.requestId === message.sessionId) recorder.close(message);
    else if (["begin", "stop", "cancel"].includes(message.action) && message.requestId !== message.sessionId) recorder[message.action](message);
    else return false;
    sendResponse({ accepted: true });
    return false;
  });
}
