import { createPcmReferenceBuffer } from "./buffer-pcm.js";

export function createBufferedRecorder(send, environment = {}) {
  const env = {
    getUserMedia: (streamId) => navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }, video: false
    }),
    createContext: () => new AudioContext(),
    createNode: (context) => new AudioWorkletNode(context, "libitu-pcm-buffer"),
    workletUrl: () => chrome.runtime.getURL("src/buffer-worklet.js"),
    epoch: () => performance.timeOrigin + performance.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (timer) => clearTimeout(timer),
    toBase64: (bytes) => {
      let value = "";
      for (let index = 0; index < bytes.length; index += 0x8000) value += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      return btoa(value);
    }, ...environment
  };
  let current = null;
  const emit = (session, status, extra = {}, requestId = session.sessionId) => Promise.resolve(send({
    type: "LIBITU_BUFFER_OFFSCREEN_EVENT", version: 4, token: session.token, sessionId: session.sessionId,
    requestId, status, ...extra
  })).catch(() => {});
  const owns = (message) => current && current.sessionId === message.sessionId && current.token === message.token;
  const clearTimer = (session, key) => { if (session[key] != null) env.clearTimeout(session[key]); session[key] = null; };
  const coverage = (session) => { if (current === session && session.buffer) void emit(session, "coverage", session.buffer.snapshot()); };
  function dispose() {
    const session = current;
    if (!session) return;
    current = null;
    for (const key of ["stale", "maximum", "setup"]) clearTimer(session, key);
    session.buffer?.clear();
    if (session.node) { session.node.port.onmessage = null; session.node.port.close(); session.node.disconnect(); }
    session.source?.disconnect();
    for (const remove of session.listeners) remove();
    for (const track of session.stream?.getTracks() ?? []) { try { track.stop(); } catch { /* Release every track. */ } }
    void session.context?.close().catch(() => {});
  }
  function fail(session) { if (current !== session) return; dispose(); void emit(session, "error"); }
  async function open(message) {
    if (current) { void emit(message, "error"); return; }
    const session = { token: message.token, sessionId: message.sessionId, listeners: [], stale: null, maximum: null, setup: null };
    current = session;
    session.setup = env.setTimeout(() => fail(session), 10_000);
    session.maximum = env.setTimeout(() => fail(session), 30 * 60_000);
    try {
      const stream = await env.getUserMedia(message.streamId);
      if (current !== session) { for (const track of stream.getTracks()) track.stop(); return; }
      session.stream = stream;
      if (!stream.getAudioTracks().length || stream.getAudioTracks().some((track) => track.readyState === "ended")) throw new Error("Missing audio");
      for (const track of stream.getTracks()) {
        const end = () => fail(session);
        track.addEventListener("ended", end); session.listeners.push(() => track.removeEventListener("ended", end));
      }
      const context = env.createContext(); session.context = context;
      session.source = context.createMediaStreamSource(stream);
      session.source.connect(context.destination);
      await context.audioWorklet.addModule(env.workletUrl());
      if (current !== session) return;
      session.node = env.createNode(context);
      session.buffer = createPcmReferenceBuffer({ sampleRate: context.sampleRate });
      session.node.port.onmessage = ({ data }) => {
        if (current !== session || !(data?.pcm instanceof ArrayBuffer) || data.pcm.byteLength > 8192) return;
        session.buffer.append(data.startFrame, new Int16Array(data.pcm));
      };
      session.source.connect(session.node); session.node.connect(context.destination);
      const changed = () => { if (session.enabled && context.state !== "running") fail(session); };
      context.addEventListener("statechange", changed);
      session.listeners.push(() => context.removeEventListener("statechange", changed));
      await context.resume();
      if (current !== session) return;
      if (context.state !== "running") throw new Error("Audio context did not start");
      session.enabled = true; clearTimer(session, "setup");
      await emit(session, "enabled"); coverage(session);
    } catch { fail(session); }
  }
  function observe(message) {
    if (!owns(message) || !current.enabled) return;
    const session = current;
    const telemetry = message.telemetry;
    const delay = env.epoch() - telemetry.epochTime;
    clearTimer(session, "stale");
    if (delay < -100 || delay > 500) {
      session.buffer.invalidate(); session.node.port.postMessage({ enabled: false }); coverage(session); return;
    }
    const audioTime = session.context.currentTime - Math.max(0, delay) / 1000;
    session.buffer.observe(telemetry, audioTime);
    session.node.port.postMessage({ enabled: telemetry.state === 1 && telemetry.rate === 1 });
    coverage(session);
    session.stale = env.setTimeout(() => {
      if (current !== session) return;
      session.buffer.invalidate(); session.node.port.postMessage({ enabled: false }); coverage(session);
    }, 800);
  }
  async function extract(message) {
    if (!owns(message) || !current.enabled) return;
    const session = current;
    const result = session.buffer.extract(message.start, message.end);
    if (result.status === "missing") { await emit(session, "missing", { reason: result.reason }, message.requestId); return; }
    const { bytes, status, ...details } = result;
    const audioBase64 = await env.toBase64(bytes);
    if (current === session) await emit(session, status, { ...details, audioBase64 }, message.requestId);
  }
  return { open, observe, extract, dispose, close(message) { if (owns(message)) dispose(); } };
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  const recorder = createBufferedRecorder((message) => chrome.runtime.sendMessage(message));
  const validId = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
  window.addEventListener("pagehide", () => recorder.dispose());
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.tab || (sender.url && sender.url !== chrome.runtime.getURL("src/background.js"))
      || message?.type !== "LIBITU_BUFFER_OFFSCREEN_COMMAND" || message.version !== 4 || message.target !== "buffer-offscreen"
      || !validId(message.token) || !validId(message.sessionId) || !validId(message.requestId)) return false;
    if (message.action === "open" && message.requestId === message.sessionId && typeof message.streamId === "string" && message.streamId.length <= 4096) void recorder.open(message);
    else if (message.action === "observe" && message.telemetry && message.requestId === message.sessionId) recorder.observe(message);
    else if (message.action === "extract" && message.requestId !== message.sessionId) void recorder.extract(message).catch(() => {});
    else if (message.action === "close") recorder.close(message);
    else return false;
    reply({ accepted: true }); return false;
  });
}
