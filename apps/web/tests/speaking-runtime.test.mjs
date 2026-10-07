import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ConversationController } from "../features/speaking/controller.ts";
import { ConversationApiError, runtimeSocketUrl } from "../features/speaking/api.ts";
import { decodePcm, encodePcm } from "../features/speaking/audio.ts";
import { validEvidence, observedItemIds } from "../features/speaking/evidence.ts";

const workspace = (version = 0) => ({ version, session: { id: "mission", user_id: "owner", status: "draft", items: [], turn_count: 0 }, messages: [], evidence: [], learning: [], policy: null, hint: null, runtime: null, analysis_status: "idle" });
function setup(overrides = {}) {
  let saved = workspace(); const sockets = []; const audio = []; const updates = []; let serial = 0;
  const api = { read: async () => structuredClone(saved), connect: async () => ({ ticket: "private-ticket", websocket_path: "/socket", runtime_id: "runtime" }), end: async () => ({ ...saved, version: 10, session: { ...saved.session, status: "completed" } }), delete: async () => {}, ...overrides };
  const controller = new ConversationController("owner", "mission", api, state => updates.push(state), {
    uuid: () => `uuid-${++serial}`, socketUrl: () => "ws://fixture.invalid/socket",
    socket: () => { const socket = { readyState: 1, bufferedAmount: 0, sent: [], send(data) { this.sent.push(JSON.parse(data)); }, close() { this.closed = true; this.onclose?.(); }, message(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }; sockets.push(socket); return socket; },
    audio: (frame, boundary, lost) => { const value = { enabled: false, disposed: false, prepare: async () => {}, async enableMicrophone() { this.enabled = true; }, disableMicrophone() { this.enabled = false; }, clear() { this.cleared = true; boundary("audio-item", 125); }, append() {}, report() { boundary("audio-item", 250); }, dispose() { this.clear(); this.enabled = false; this.disposed = true; }, frame, lost }; audio.push(value); return value; }
  });
  async function connect(voice = false, snapshot = workspace()) { const promise = controller.start(voice); await new Promise(resolve => setImmediate(resolve)); const socket = sockets.at(-1); socket.onopen(); socket.message({ type: "ready", workspace: snapshot }); assert.equal(await promise, true); return socket; }
  return { controller, sockets, audio, updates, api, connect, setSaved: value => { saved = value; } };
}

test("authenticates only in first frame; views are absent from transport; snapshots are owner/version fenced", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load();
  const socket = await fixture.connect();
  assert.deepEqual(socket.sent.slice(0, 2), [{ type: "authenticate", ticket: "private-ticket" }, { type: "microphone", enabled: false }]);
  socket.message({ type: "snapshot", workspace: workspace(4) });
  socket.message({ type: "snapshot", workspace: workspace(2) }); assert.equal(fixture.controller.state.workspace.version, 4);
  socket.message({ type: "snapshot", workspace: { ...workspace(8), session: { ...workspace().session, user_id: "another" } } }); assert.equal(fixture.controller.state.workspace.version, 4);
});

test("unconfirmed text retries the same turn ID and hydrate acknowledgement avoids resubmission", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load(); const socket = await fixture.connect();
  assert.equal(await fixture.controller.submit("  to be fair  "), true);
  const sent = socket.sent.find(value => value.type === "text.submit"); assert.equal(sent.text, "to be fair");
  fixture.controller.disconnect("lost"); assert.equal(fixture.controller.state.pending.status, "unconfirmed");
  const retry = fixture.controller.retryText(); await new Promise(resolve => setImmediate(resolve)); const next = fixture.sockets.at(-1); next.onopen(); next.message({ type: "ready", workspace: workspace(1) }); await retry;
  assert.deepEqual(next.sent.find(value => value.type === "text.submit"), sent);
  fixture.controller.disconnect("lost again");
  const recovered = fixture.controller.retryText(); await new Promise(resolve => setImmediate(resolve)); const third = fixture.sockets.at(-1); third.onopen(); third.message({ type: "ready", workspace: { ...workspace(2), messages: [{ id: "msg", client_turn_id: sent.client_turn_id, provider_item_id: "provider-item" }] } }); await recovered;
  assert.equal(fixture.controller.state.pending, null); assert.equal(third.sent.some(value => value.type === "text.submit"), false);
});

test("pause and disposal stop mic and playback; late socket events cannot republish another owner", async () => {
  const fixture = setup(); await fixture.controller.load(); const socket = await fixture.connect(true); assert.equal(fixture.controller.state.microphone, true);
  fixture.controller.interrupt(); assert.deepEqual(socket.sent.slice(-2), [{ type: "playback", item_id: "audio-item", played_ms: 125 }, { type: "interrupt" }]);
  const callback = socket.onmessage; fixture.controller.pause(); assert.equal(fixture.audio[0].disposed, true); assert.equal(socket.closed, true); assert.equal(fixture.controller.state.connection, "paused");
  const count = fixture.updates.length; callback({ data: JSON.stringify({ type: "snapshot", workspace: workspace(40) }) }); assert.equal(fixture.updates.length, count);
  fixture.controller.dispose();
});

test("explicit takeover follows 409; no automatic reconnect; end is HTTP-owned", async t => {
  const calls = []; const fixture = setup({ connect: async (_id, takeover) => { calls.push(takeover); throw new ConversationApiError("Already open", 409); } }); t.after(() => fixture.controller.dispose()); await fixture.controller.load();
  assert.equal(await fixture.controller.start(false), false); assert.equal(fixture.controller.state.conflict, true); assert.deepEqual(calls, [false]);
  await fixture.controller.start(false, true); assert.deepEqual(calls, [false, true]);
  assert.equal(await fixture.controller.end(), true); assert.equal(fixture.controller.state.connection, "ended"); assert.equal(await fixture.controller.start(true), false);
});

test("pending microphone permission does not block text ready and late permission is fenced", async t => {
  let allow; let disposed = false; const sockets = [];
  const controller = new ConversationController("owner", "mission", { read: async () => workspace(), connect: async () => ({ ticket: "ticket", websocket_path: "/socket" }) }, () => {}, { socketUrl: () => "ws://fixture", audio: () => ({ enableMicrophone: () => new Promise(resolve => { allow = resolve; }), disableMicrophone() {}, dispose() { disposed = true; }, report() {}, clear() {}, append() {} }), socket: () => { const socket = { readyState: 1, bufferedAmount: 0, sent: [], send(text) { this.sent.push(JSON.parse(text)); }, close() {} }; sockets.push(socket); return socket; } });
  t.after(() => controller.dispose()); await controller.load(); const starting = controller.start(true); await new Promise(resolve => setImmediate(resolve)); sockets[0].onopen(); sockets[0].onmessage({ data: JSON.stringify({ type: "ready", workspace: workspace() }) }); assert.equal(await starting, true); assert.equal(controller.state.microphone, false); assert.equal(controller.state.microphoneBusy, true);
  controller.pause(); allow(); await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, true); assert.equal(controller.state.microphone, false); assert.equal(controller.state.connection, "paused");
});

test("evidence only highlights exact UTF-16 spans on final user revisions", () => {
  const message = { id: "m", role: "user", status: "final", revision: 2, text: "🙂 To be fair, yes." };
  const good = { id: "e", message_id: "m", transcript_revision: 2, session_item_id: "language", start: 3, end: 13, quote: "To be fair" };
  assert.equal(validEvidence(message, [good]).length, 1);
  for (const invalid of [{ ...good, transcript_revision: 1 }, { ...good, start: 2 }, { ...good, quote: "to be fair" }, { ...good, end: 200 }]) assert.equal(validEvidence(message, [invalid]).length, 0);
  assert.equal(validEvidence({ ...message, role: "assistant" }, [good]).length, 0);
  assert.equal(observedItemIds({ messages: [message], evidence: [good, { ...good, id: "e2" }] }).size, 1);
});

test("PCM roundtrip is signed little endian, rejects malformed/oversized data", () => {
  const bytes = Uint8Array.from([0, 128, 0, 0, 255, 127]).buffer;
  assert.deepEqual([...decodePcm(encodePcm(bytes))], [-1, 0, 32767 / 32768]);
  assert.throws(() => decodePcm("YQ==")); assert.throws(() => decodePcm("A".repeat(100001)));
});

test("real worklet averages stereo and outputs bounded 24kHz PCM frames at 48k and 44.1k", () => {
  const code = readFileSync(new URL("../public/audio/speaking-capture.worklet.js", import.meta.url), "utf8");
  for (const rate of [48000, 44100]) {
    let Processor; const frames = [];
    vm.runInNewContext(code, { AudioWorkletProcessor: class { port = { postMessage: frame => frames.push(new Int16Array(frame)) }; }, sampleRate: rate, registerProcessor: (_name, value) => { Processor = value; }, Int16Array, Math });
    const processor = new Processor(); for (let offset = 0; offset < rate; offset += 128) { const length = Math.min(128, rate - offset); processor.process([[new Float32Array(length).fill(1), new Float32Array(length).fill(0)]]); }
    assert.equal(frames.length, 10); assert.equal(frames.every(frame => frame.length === 2400 && frame.every(value => value === 16384)), true);
  }
});

test("socket URL never accepts another origin or query-string credentials", () => {
  assert.match(runtimeSocketUrl("/api/speaking/sessions/one/realtime/two"), /^ws[s]?:/);
  assert.throws(() => runtimeSocketUrl("https://attacker.invalid/api/speaking/sessions/one"));
  assert.throws(() => runtimeSocketUrl("/api/speaking/sessions/one?ticket=secret"));
});

test("cleanup remains finite when the last playback boundary discovers socket backpressure", async () => {
  const fixture = setup(); await fixture.controller.load(); const socket = await fixture.connect(true);
  socket.bufferedAmount = 300000; fixture.controller.pause();
  assert.equal(fixture.audio[0].disposed, true); assert.equal(socket.closed, true); assert.equal(fixture.controller.state.microphone, false);
  fixture.controller.dispose();
});

test("local interruption fences late audio from the cancelled response but permits a new response", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load(); const socket = await fixture.connect(true);
  const played = []; fixture.audio[0].append = (item, audio) => played.push([item, audio]);
  socket.message({ type: "audio.delta", item_id: "one", response_id: "old", audio: "first" });
  fixture.controller.interrupt();
  socket.message({ type: "audio.delta", item_id: "one", response_id: "old", audio: "late" });
  socket.message({ type: "audio.clear", item_id: "one" });
  socket.message({ type: "audio.delta", item_id: "two", response_id: "new", audio: "second" });
  assert.deepEqual(played, [["one", "first"], ["two", "second"]]);
});

test("send failure while enabling mic cannot publish a live-mic state after disposal", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load(); const socket = await fixture.connect(false);
  socket.bufferedAmount = 300000; await fixture.controller.setMicrophone(true);
  assert.equal(fixture.controller.state.microphone, false); assert.equal(fixture.controller.state.microphoneBusy, false); assert.equal(fixture.controller.state.connection, "disconnected"); assert.equal(fixture.audio[0].disposed, true);
});

test("send failure during ready rejects connection without leaving a heartbeat", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load(); const starting = fixture.controller.start(false);
  await new Promise(resolve => setImmediate(resolve)); const socket = fixture.sockets[0]; socket.onopen(); socket.bufferedAmount = 300000; socket.message({ type: "ready", workspace: workspace() });
  assert.equal(await starting, false); assert.equal(fixture.controller.state.connection, "disconnected"); assert.equal(fixture.controller.heartbeat, null); assert.equal(fixture.controller.boundary, null);
});

test("interrupt before first audio delta drops queued output until server clear acknowledgement", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load(); const socket = await fixture.connect(true);
  const played = []; fixture.audio[0].append = item => played.push(item);
  fixture.controller.interrupt(); socket.message({ type: "audio.delta", item_id: "cancelled", response_id: "old", audio: "old" });
  assert.deepEqual(played, []); socket.message({ type: "audio.clear", item_id: null }); socket.message({ type: "audio.delta", item_id: "next", response_id: "new", audio: "new" }); assert.deepEqual(played, ["next"]);
});

test("unavailable voice placeholder cannot clear a transient live transcript", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load(); const socket = await fixture.connect(false);
  socket.message({ type: "transcript.delta", item_id: "voice", role: "user", delta: "A live phrase" });
  socket.message({ type: "snapshot", workspace: { ...workspace(1), messages: [{ id: "m", provider_item_id: "voice", status: "unavailable", text: "" }] } }); assert.equal(fixture.controller.state.partials.voice.text, "A live phrase");
  socket.message({ type: "snapshot", workspace: { ...workspace(2), messages: [{ id: "m", provider_item_id: "voice", status: "final", text: "A live phrase" }] } }); assert.equal(fixture.controller.state.partials.voice, undefined);
});
