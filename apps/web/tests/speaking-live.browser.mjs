// Opt-in paid-provider integration harness. Only Clerk identity and microphone
// input are fixtures; every speaking HTTP/WebSocket response comes from the API.
// The API must be an isolated test server configured for the supplied owner.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installLoadoutFixture } from "./helpers/loadout-fixture.mjs";

const configPath = process.env.LIBITU_LIVE_CONFIG ?? "/tmp/libitu-live-teaching-config.json";
const config = JSON.parse(await readFile(configPath, "utf8"));
const { sessionId, owner, uiOrigin, apiOrigin, artifactDir, commandPath, resultPath } = config;
for (const value of [sessionId, owner, uiOrigin, apiOrigin, artifactDir, commandPath, resultPath]) assert.equal(typeof value, "string");
assert.match(new URL(apiOrigin).hostname, /^(localhost|127\.0\.0\.1)$/);
await mkdir(artifactDir, { recursive: true });
const eventPath = join(artifactDir, "browser-events.jsonl");
let writes = Promise.resolve();
const append = (path, entry) => {
  writes = writes.then(() => appendFile(path, `${JSON.stringify(entry)}\n`));
  return writes;
};
const result = (command, status, data = {}) => append(resultPath, { at: new Date().toISOString(), command_id: command?.id ?? null, status, ...data });
const { chromium } = createRequire(import.meta.url)(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const waitForVoiceReply = async previousFrames => {
  await page.waitForFunction(previous => window.__live.fatalError || window.__live.closed || window.__live.audioFrames > previous, previousFrames, { timeout: 60_000 });
  await page.waitForFunction(() => window.__live.fatalError || window.__live.closed || (window.__live.audioNodes === 0 && window.__live.phase === "listening" && Date.now() - window.__live.lastAudioAt > 400), null, { timeout: 60_000 });
  const failure = await page.evaluate(() => window.__live.fatalError?.code ?? (window.__live.closed ? "socket_closed" : null));
  assert.equal(failure, null, `Voice reply did not complete: ${failure}`);
};
const apiRequests = [];
let stopped = false;
try {
  const fixture = await installLoadoutFixture(page, { origin: uiOrigin, initialOwner: owner, records: [], seedCorpus: false });
  // Registered last, so no speaking request reaches the loadout fixture routes.
  await page.route("**/api/speaking/**", async route => {
    const request = route.request();
    const incoming = new URL(request.url());
    const target = new URL(incoming.pathname + incoming.search, apiOrigin).href;
    const response = await route.fetch({ url: target, timeout: 45_000 });
    const metadata = { at: new Date().toISOString(), kind: "http", method: request.method(), path: incoming.pathname, status: response.status() };
    apiRequests.push(metadata);
    await append(eventPath, metadata);
    await route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": uiOrigin, "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" } });
  });
  await page.exposeFunction("__liveEmit", entry => append(eventPath, entry));
  await page.addInitScript(({ backend }) => {
    const state = window.__live = { events: [], workspace: null, phase: null, audioNodes: 0, audioFrames: 0, micFrames: 0, lastAudioAt: 0, lastAudioItem: null, lastResponseId: null, ready: false, sockets: [], microphone: null, fatalError: null, closed: false };
    const emit = (kind, data = {}) => {
      const event = { at: new Date().toISOString(), epoch_ms: Date.now(), performance_ms: performance.now(), kind, ...data };
      state.events.push(event);
      void window.__liveEmit(event);
    };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class LiveSocket extends NativeWebSocket {
      constructor(address, protocols) {
        const url = new URL(address, location.href);
        const speaking = url.pathname.startsWith("/api/speaking/");
        if (speaking) {
          const target = new URL(backend); url.host = target.host; url.protocol = target.protocol === "https:" ? "wss:" : "ws:";
        }
        super(url.href, protocols);
        if (!speaking) return;
        state.sockets.push(this);
        emit("socket.created", { path: url.pathname });
        this.addEventListener("close", event => { state.closed = true; emit("socket.closed", { code: event.code, reason: event.reason }); });
        this.addEventListener("error", () => emit("socket.error"));
        this.addEventListener("message", event => {
          if (typeof event.data !== "string") return;
          let value; try { value = JSON.parse(event.data); } catch { return; }
          if (value.workspace) state.workspace = value.workspace;
          if (value.type === "ready") state.ready = true;
          if (value.type === "error" && value.retryable === false) state.fatalError = value;
          if (value.type === "state") state.phase = value.state;
          if (value.type === "audio.delta") {
            state.audioFrames++; state.lastAudioAt = Date.now(); state.lastAudioItem = value.item_id; state.lastResponseId = value.response_id;
            emit("server.audio.delta", { item_id: value.item_id, response_id: value.response_id, pcm_bytes: atob(value.audio).length, frame: state.audioFrames });
          } else emit(`server.${value.type}`, { event: value });
        });
      }
      send(raw) {
        const speaking = this.url.includes("/api/speaking/");
        if (speaking && typeof raw === "string") {
          let value; try { value = JSON.parse(raw); } catch { value = {}; }
          if (value.type === "audio.append") {
            state.micFrames++;
            if (state.micFrames % 25 === 1) emit("client.audio.append", { frame: state.micFrames, pcm_bytes: atob(value.audio).length });
          } else if (value.type === "authenticate") emit("client.authenticate", { ticket: "[redacted]" });
          else emit(`client.${value.type}`, { event: value });
        }
        return super.send(raw);
      }
    };
    // Observe the application's real WebAudio graph. No PCM or playback ACK is
    // manufactured here. A running audio clock proves playback, not audibility
    // through a physical speaker on this headless machine.
    const microphoneNodes = new WeakSet();
    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when = 0, ...args) {
      if (microphoneNodes.has(this)) return originalStart.call(this, when, ...args);
      const context = this.context;
      const id = crypto.randomUUID();
      const item_id = state.lastAudioItem;
      const response_id = state.lastResponseId;
      const delay = Math.max(0, when - context.currentTime) * 1000;
      let ended = false;
      state.audioNodes++;
      emit("audio.scheduled", { id, item_id, response_id, context_state: context.state, context_time: context.currentTime, start_at: when, duration_ms: (this.buffer?.duration ?? 0) * 1000 });
      const startProbe = setTimeout(() => {
        if (!ended && context.state === "running" && context.currentTime >= when) emit("audio.clock_started", { id, item_id, response_id, context_time: context.currentTime });
      }, delay + 5);
      this.addEventListener("ended", () => {
        ended = true; clearTimeout(startProbe); state.audioNodes--;
        emit("audio.ended", { id, item_id, response_id, context_state: context.state, context_time: context.currentTime, ended_before_scheduled_start: context.currentTime < when });
      }, { once: true });
      return originalStart.call(this, when, ...args);
    };
    // A virtual microphone carries supplied spoken WAV samples at their native
    // rate through the existing MediaStream + product AudioWorklet path.
    // It never accesses the physical microphone and never touches model output.
    navigator.mediaDevices.getUserMedia = async options => {
      if (!options?.audio) throw new DOMException("Audio-only integration fixture", "NotSupportedError");
      const audio = new AudioContext();
      await audio.resume();
      const destination = audio.createMediaStreamDestination();
      state.microphone = { audio, destination };
      emit("microphone.virtual_ready", { sample_rate: audio.sampleRate, context_state: audio.state });
      return destination.stream;
    };
    window.__liveSpeak = async (base64, command_id) => {
      if (!state.microphone) throw new Error("Start voice before sending microphone input");
      const { audio, destination } = state.microphone;
      await audio.resume();
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const buffer = await audio.decodeAudioData(bytes.buffer);
      const source = audio.createBufferSource();
      microphoneNodes.add(source); source.buffer = buffer; source.connect(destination);
      emit("microphone.speak_started", { command_id, duration_ms: buffer.duration * 1000, sample_rate: buffer.sampleRate });
      return new Promise(resolve => {
        source.addEventListener("ended", () => { source.disconnect(); emit("microphone.speak_ended", { command_id }); resolve({ duration_ms: buffer.duration * 1000 }); }, { once: true });
        source.start();
      });
    };
  }, { backend: apiOrigin });
  await page.goto(`${uiOrigin}/speaking/${sessionId}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByRole("region", { name: "Speaking mission", exact: true }).waitFor();
  await page.waitForFunction(() => !document.body.textContent.includes("Loading mission") && !!document.querySelector("h1"));
  await result(null, "ready", { session_id: sessionId, event_path: eventPath, boundary: "fixture Clerk identity; real speaking API and providers; WAV virtual microphone via product worklet; real browser WebAudio graph" });
  console.log(`Ready: ${commandPath}`);
  let consumed = 0;
  while (!stopped) {
    let lines;
    try { lines = (await readFile(commandPath, "utf8")).split("\n").filter(Boolean); }
    catch (error) { if (error.code !== "ENOENT") throw error; lines = []; }
    for (const line of lines.slice(consumed)) {
      consumed++;
      let command;
      try {
        command = JSON.parse(line);
        await result(command, "started", { action: command.action });
        if (command.action === "connect") {
          await page.getByRole("button", { name: "Start conversation", exact: true }).click();
          await page.waitForFunction(() => window.__live.ready, null, { timeout: 60_000 });
          await page.waitForFunction(() => window.__live.audioFrames > 0, null, { timeout: 60_000 });
          await page.waitForFunction(() => window.__live.audioNodes === 0 && window.__live.phase === "listening" && Date.now() - window.__live.lastAudioAt > 400, null, { timeout: 60_000 });
          await page.getByRole("button", { name: "Chat", exact: true }).click();
        } else if (command.action === "speak") {
          const wav = (await readFile(command.wavPath)).toString("base64");
          const previousFrames = await page.evaluate(() => window.__live.audioFrames);
          const playback = page.evaluate(({ wav, id }) => window.__liveSpeak(wav, id), { wav, id: command.id });
          await result(command, "speak_started");
          const played = await playback;
          await result(command, "speak_ended", played);
          if (command.wait_for_reply) await waitForVoiceReply(previousFrames);
        } else if (command.action === "submit") {
          const previousFrames = await page.evaluate(() => window.__live.audioFrames);
          await page.getByRole("textbox", { name: "Message your AI partner" }).fill(command.text);
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          if (command.wait_for_reply) await waitForVoiceReply(previousFrames);
        } else if (command.action === "hint") {
          const card = page.getByRole("region", { name: "Speaking hint", exact: true });
          const use = card.getByRole("button", { name: "How can I use it?", exact: true });
          if (await use.count()) await use.click();
          else await page.getByRole("button", { name: "Need a hint?", exact: true }).click();
          await card.waitFor(); await card.scrollIntoViewIfNeeded();
          await page.waitForFunction(() => {
            const request = window.__live.events.findLast(event => event.kind === "client.hint")?.event;
            const help = window.__live.workspace?.help;
            return request && help?.id === request.request_id && help.status !== "loading";
          }, null, { timeout: 45_000 });
          await card.scrollIntoViewIfNeeded();
          await page.waitForFunction(() => {
            const help = window.__live.workspace?.help;
            return window.__live.events.some(event => event.kind === "client.hint.shown" && event.event.hint_id === help?.id && event.event.version === help.version && event.event.level === "usage");
          });
          await page.screenshot({ path: join(artifactDir, `${command.id}-usage.png`), fullPage: true });
        } else if (command.action === "example") {
          const card = page.getByRole("region", { name: "Speaking hint", exact: true });
          await card.getByRole("button", { name: "Show an example", exact: true }).click();
          await card.scrollIntoViewIfNeeded();
          await page.waitForFunction(() => {
            const request = window.__live.events.findLast(event => event.kind === "client.hint")?.event;
            const help = window.__live.workspace?.help;
            return request && help?.id === request.request_id && help.level === "example" && help.status !== "loading";
          }, null, { timeout: 45_000 });
          await card.scrollIntoViewIfNeeded();
          await page.waitForFunction(() => {
            const help = window.__live.workspace?.help;
            return help?.status === "unavailable" || window.__live.events.some(event => event.kind === "client.hint.shown" && event.event.hint_id === help?.id && event.event.version === help.version && event.event.level === "example");
          });
          await page.screenshot({ path: join(artifactDir, `${command.id}-example.png`), fullPage: true });
        } else if (command.action === "wait_audio") {
          await page.waitForFunction(() => window.__live.audioNodes === 0 && window.__live.phase === "listening" && Date.now() - window.__live.lastAudioAt > 400, null, { timeout: command.timeout_ms ?? 60_000 });
        } else if (command.action === "snapshot") {
          const workspace = await page.evaluate(() => window.__live.workspace);
          await writeFile(join(artifactDir, `${command.id}-workspace.json`), JSON.stringify(workspace, null, 2));
          await page.screenshot({ path: join(artifactDir, `${command.id}-page.png`), fullPage: true });
        } else if (command.action === "stop") stopped = true;
        else throw new Error(`Unknown command ${command.action}`);
        const state = await page.evaluate(() => ({ ready: window.__live.ready, phase: window.__live.phase, audio_nodes: window.__live.audioNodes, audio_frames: window.__live.audioFrames, microphone_frames: window.__live.micFrames, turn_count: window.__live.workspace?.session.turn_count, messages: window.__live.workspace?.messages, help: window.__live.workspace?.help }));
        await result(command, "done", { state, page_errors: fixture.errors });
      } catch (error) {
        await result(command, "failed", { error: error.message });
        await page.screenshot({ path: join(artifactDir, `${command?.id ?? "unknown"}-failure.png`), fullPage: true });
        if (["connect", "speak", "submit"].includes(command?.action)) stopped = true;
      }
      if (stopped) break;
    }
    if (!stopped) await new Promise(resolve => setTimeout(resolve, 200));
  }
  await writeFile(join(artifactDir, "browser-summary.json"), JSON.stringify({ session_id: sessionId, api_requests: apiRequests, page_errors: fixture.errors, ended_at: new Date().toISOString() }, null, 2));
} finally {
  await context.close();
  await browser.close();
  await writes;
}
