import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ConversationController } from "../features/speaking/controller.ts";
import { ConversationApiError, runtimeSocketUrl } from "../features/speaking/api.ts";
import { decodePcm, encodePcm } from "../features/speaking/audio.ts";
import { validEvidence, observedItemIds, assistanceLabel } from "../features/speaking/evidence.ts";
import { observeVisible } from "../features/speaking/visibility.ts";
import { currentSupport, reducedSupport, validDemonstrations } from "../features/speaking/support.ts";

const workspace = (version = 0) => ({ version, session: { id: "mission", user_id: "owner", status: "draft", items: [], turn_count: 0 }, messages: [], evidence: [], learning: [], policy: null, hint: null, runtime: null, analysis_status: "idle" });
function setup(overrides = {}, audioOverrides = {}) {
  let saved = workspace(); const sockets = []; const audio = []; const updates = []; let serial = 0;
  const api = { read: async () => structuredClone(saved), connect: async () => ({ ticket: "private-ticket", websocket_path: "/socket", runtime_id: "runtime" }), end: async () => ({ ...saved, version: 10, session: { ...saved.session, status: "completed" } }), delete: async () => {}, ...overrides };
  const controller = new ConversationController("owner", "mission", api, state => updates.push(state), {
    uuid: () => `uuid-${++serial}`, socketUrl: () => "ws://fixture.invalid/socket",
    socket: () => { const socket = { readyState: 1, bufferedAmount: 0, sent: [], send(data) { this.sent.push(JSON.parse(data)); }, close() { this.closed = true; this.onclose?.(); }, message(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }; sockets.push(socket); return socket; },
    audio: (frame, boundary, lost) => { const value = { enabled: false, disposed: false, prepare: async () => {}, async enableMicrophone() { this.enabled = true; }, disableMicrophone() { this.enabled = false; }, clear() { this.cleared = true; boundary("audio-item", 125); }, append() {}, report() { boundary("audio-item", 250); }, dispose() { this.clear(); this.enabled = false; this.disposed = true; }, frame, lost, ...audioOverrides }; audio.push(value); return value; }
  });
  async function connect(voice = false, snapshot = workspace()) { const promise = controller.start(voice); await new Promise(resolve => setImmediate(resolve)); const socket = sockets.at(-1); socket.onopen(); socket.message({ type: "ready", workspace: snapshot }); assert.equal(await promise, true); return socket; }
  return { controller, sockets, audio, updates, api, connect, setSaved: value => { saved = value; } };
}

test("target actions await server snapshots, and visible target receipts are plan-scoped and reconnect-safe", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load();
  const snapshot = { ...workspace(1), session: { ...workspace().session, mission_plan: { targets: [{ session_item_id: "item-1", role: "primary" }] } },
    opportunities: [{ session_item_id: "item-1", role: "primary", status: "planned", sent: false, bound: false, reflected: false, presented: false, skipped_reason: null, skipped_at: null, last_response_id: null }] };
  const socket = await fixture.connect(false, snapshot);
  fixture.controller.targetShown("unknown");
  fixture.controller.targetShown("item-1"); fixture.controller.targetShown("item-1");
  assert.equal(socket.sent.filter(event => event.type === "target.shown").length, 1);
  assert.equal(fixture.controller.skipTarget("unknown"), false);
  assert.equal(fixture.controller.skipTarget("item-1", " "), false);
  assert.equal(fixture.controller.skipTarget("item-1", "x".repeat(201)), false);
  assert.equal(fixture.controller.skipTarget("item-1", " Wrong role "), true);
  assert.deepEqual(socket.sent.at(-1), { type: "target.skip", target_item_id: "item-1", reason: "Wrong role" });
  assert.equal(fixture.controller.state.workspace.opportunities[0].status, "planned", "sending does not fabricate confirmed state");
  socket.message({ type: "snapshot", workspace: { ...snapshot, version: 2, opportunities: [{ ...snapshot.opportunities[0], status: "skipped", skipped_reason: "Wrong role" }] } });
  assert.equal(fixture.controller.skipTarget("item-1"), false);
  assert.equal(fixture.controller.restoreTarget("item-1"), true);
  assert.deepEqual(socket.sent.at(-1), { type: "target.restore", target_item_id: "item-1" });
  fixture.controller.pause();
  assert.equal(fixture.controller.restoreTarget("item-1"), false);
  const second = await fixture.connect(false, { ...snapshot, version: 3 });
  fixture.controller.targetShown("item-1");
  assert.equal(second.sent.filter(event => event.type === "target.shown").length, 1);
});

test("wording seen before connection is acknowledged before the first submitted learner turn", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose());
  const snapshot = { ...workspace(1), session: { ...workspace().session, mission_plan: { targets: [{ session_item_id: "item-1" }] } } };
  fixture.setSaved(snapshot); await fixture.controller.load();
  fixture.controller.targetShown("item-1");
  assert.equal(fixture.sockets.length, 0, "a visibility receipt does not start the connection");
  const pending = fixture.controller.submit("My own idea");
  await new Promise(resolve => setImmediate(resolve));
  const socket = fixture.sockets[0]; socket.onopen(); socket.message({ type: "ready", workspace: snapshot });
  assert.equal(await pending, true);
  const receiptIndex = socket.sent.findIndex(event => event.type === "target.shown");
  const learnerIndex = socket.sent.findIndex(event => event.type === "text.submit");
  assert.ok(receiptIndex > 0 && receiptIndex < learnerIndex);
});

test("support changes await a newer confirmed version, preserve old receipts, and reject stale support", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose());
  const snapshot = { ...workspace(1), session: { ...workspace().session, support_level: "model_frame", mission_plan: { targets: [{ session_item_id: "item-1" }] } } };
  fixture.setSaved(snapshot); await fixture.controller.load();
  fixture.controller.targetShown("item-1");
  const socket = await fixture.connect(false, snapshot);
  assert.equal(fixture.controller.setSupport("model_frame"), false);
  assert.equal(fixture.controller.setSupport("model_label"), true);
  const request = socket.sent.at(-1);
  assert.deepEqual(request, { type: "support.set", request_id: "uuid-2", level: "model_label", expected_version: 0 });
  assert.equal(fixture.controller.setSupport("no_hint"), false, "one pending support operation");
  assert.equal(currentSupport(fixture.controller.state.workspace).level, "model_frame");
  socket.message({ type: "snapshot", workspace: { ...snapshot, version: 2 } });
  assert.ok(fixture.controller.state.supportPending, "unrelated workspace updates do not confirm support");
  socket.message({ type: "snapshot", workspace: { ...snapshot, version: 3, support: { level: "model_label", version: 1 } } });
  assert.equal(fixture.controller.state.supportPending, null);
  assert.equal(currentSupport(fixture.controller.state.workspace).level, "model_label");
  socket.message({ type: "snapshot", workspace: { ...snapshot, version: 4, support: { level: "model_frame", version: 0 } } });
  assert.equal(currentSupport(fixture.controller.state.workspace).level, "model_label", "support version cannot regress inside a newer workspace");
  fixture.controller.pause();
  const reconnected = await fixture.connect(false, { ...snapshot, version: 5, support: { level: "no_hint", version: 2 } });
  assert.equal(reconnected.sent.filter(event => event.type === "target.shown").length, 1, "wording already viewed remains an exposure after reducing support");
});

test("legacy sessions opting into explicit support record visible owned labels without a plan", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load();
  const snapshot = { ...workspace(1), session: { ...workspace().session, items: [{ id: "legacy-item" }] } };
  const socket = await fixture.connect(false, snapshot);
  fixture.controller.targetShown("legacy-item");
  assert.equal(socket.sent.some(event => event.type === "target.shown"), false, "unchanged legacy sessions keep old behavior");
  fixture.controller.setSupport("label_only");
  socket.message({ type: "snapshot", workspace: { ...snapshot, version: 2, support: { level: "label_only", version: 1 } } });
  fixture.controller.targetShown("foreign-item");
  fixture.controller.targetShown("legacy-item");
  fixture.controller.targetShown("legacy-item");
  assert.deepEqual(socket.sent.filter(event => event.type === "target.shown"), [{ type: "target.shown", target_item_id: "legacy-item" }]);
});

test("support busy/conflict errors do not alter text delivery, and unknown changes can recover", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load();
  const socket = await fixture.connect();
  assert.equal(currentSupport(fixture.controller.state.workspace), null);
  assert.equal(fixture.controller.setSupport("no_hint"), true, "legacy sessions can explicitly choose support");
  const request = socket.sent.at(-1);
  socket.message({ type: "error", code: "support_busy", request_id: "unrelated", message: "Busy", retryable: true });
  assert.ok(fixture.controller.state.supportPending);
  await fixture.controller.submit("My current idea");
  socket.message({ type: "error", code: "support_busy", request_id: request.request_id, message: "Busy", retryable: true });
  assert.equal(fixture.controller.state.supportPending, null);
  assert.equal(fixture.controller.state.pending.status, "sending");
  assert.match(fixture.controller.state.supportError, /current reply to finish/);
  assert.equal(fixture.controller.setSupport("no_hint"), true);
  const second = socket.sent.at(-1);
  socket.message({ type: "error", code: "support_changed", request_id: second.request_id, message: "Conflict", retryable: true });
  socket.message({ type: "snapshot", workspace: { ...workspace(2), support: { level: "label_only", version: 1 } } });
  assert.equal(currentSupport(fixture.controller.state.workspace).level, "label_only");
  assert.match(fixture.controller.state.supportError, /changed elsewhere/);
  assert.equal(socket.sent.filter(event => event.type === "support.set").length, 2, "no automatic retry loop");
});

test("confirmed support changes retire old hints and no-hint still allows explicit requested help", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load();
  const snapshot = { ...workspace(1), session: { ...workspace().session, support_level: "model_frame", items: [{ id: "language" }] } };
  const socket = await fixture.connect(false, snapshot);
  fixture.controller.hint("usage", "language");
  const old = structuredClone(fixture.controller.state.workspace.help);
  fixture.controller.setSupport("no_hint");
  const hidden = { ...snapshot, version: 2, support: { level: "no_hint", version: 1 }, help: null };
  socket.message({ type: "snapshot", workspace: hidden });
  assert.equal(fixture.controller.state.workspace.help, null);
  socket.message({ type: "snapshot", workspace: { ...hidden, version: 3, help: { ...old, version: 2, status: "ready", expression: "Late old hint" } } });
  assert.equal(fixture.controller.state.workspace.help, null, "old pending hint cannot be revived");
  socket.message({ type: "snapshot", workspace: { ...hidden, version: 4, help: { ...old, id: "automatic", source: "automatic", version: 2, status: "ready", expression: "Automatic hint" } } });
  assert.equal(fixture.controller.state.workspace.help, null);
  fixture.controller.hint("usage", "language");
  const requested = structuredClone(fixture.controller.state.workspace.help);
  socket.message({ type: "snapshot", workspace: { ...hidden, version: 5, help: { ...requested, version: 1, status: "ready", expression: "Explicitly requested words" } } });
  assert.equal(fixture.controller.state.workspace.help.expression, "Explicitly requested words");
  fixture.controller.hintShown(requested.id, 1, "usage");
  assert.equal(socket.sent.at(-1).type, "hint.shown");
});

test("unconfirmed support reports a bounded timeout without applying the proposed level", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load();
  await fixture.connect(false, { ...workspace(1), support: { level: "model_frame", version: 0 } });
  fixture.controller.setSupport("no_hint");
  t.mock.timers.tick(10_001);
  assert.equal(fixture.controller.state.supportPending, null);
  assert.equal(currentSupport(fixture.controller.state.workspace).level, "model_frame");
  assert.match(fixture.controller.state.supportError, /not confirmed/);
  fixture.sockets.at(-1).message({ type: "snapshot", workspace: { ...workspace(2), support: { level: "no_hint", version: 1 } } });
  assert.equal(currentSupport(fixture.controller.state.workspace).level, "no_hint");
  assert.equal(fixture.controller.state.supportError, null, "a late canonical confirmation resolves the timeout");
});

test("support reduction is a manual sequence and demonstration marks require exact final assistant spans", () => {
  assert.equal(currentSupport(workspace()), null);
  assert.deepEqual(currentSupport({ ...workspace(), session: { ...workspace().session, support_level: "model_frame" } }), { level: "model_frame", version: 0 });
  assert.deepEqual(["model_frame", "model_label", "label_only", "no_hint"].map(reducedSupport), ["model_label", "label_only", "no_hint", null]);
  const message = { id: "assistant", role: "assistant", status: "final", revision: 2, text: "🙂 To be fair, the testing takes time." };
  const span = { target_item_id: "language", message_id: message.id, revision: 2, start: 3, end: 13, quote: "To be fair" };
  assert.equal(validDemonstrations(message, [span]).length, 1);
  for (const bad of [{ ...span, revision: 1 }, { ...span, start: 2 }, { ...span, quote: "to be fair" }, { ...span, end: 100 }]) assert.equal(validDemonstrations(message, [bad]).length, 0);
  assert.equal(validDemonstrations({ ...message, role: "user" }, [span]).length, 0);
  assert.equal(validDemonstrations({ ...message, status: "interrupted" }, [span]).length, 0);
});

test("a confirmed target skip retires its pending help without cancelling another target's request", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load();
  const snapshot = { ...workspace(1), session: { ...workspace().session, items: [{ id: "item-1" }, { id: "item-2" }] },
    opportunities: [{ session_item_id: "item-1", status: "planned" }, { session_item_id: "item-2", status: "planned" }], help: null };
  const socket = await fixture.connect(false, snapshot);
  fixture.controller.hint("usage", "item-1");
  const oldHelp = structuredClone(fixture.controller.state.workspace.help);
  assert.equal(fixture.controller.skipTarget("item-1"), true);
  assert.equal(fixture.controller.state.workspace.help.status, "loading", "sending skip alone does not confirm cancellation");
  const skipped = { ...snapshot, version: 2, opportunities: [{ session_item_id: "item-1", status: "skipped" }, snapshot.opportunities[1]] };
  socket.message({ type: "snapshot", workspace: skipped });
  assert.equal(fixture.controller.state.workspace.help, null);
  socket.message({ type: "snapshot", workspace: { ...skipped, version: 3, help: { ...oldHelp, version: 2, status: "ready", expression: "Old target" } } });
  assert.equal(fixture.controller.state.workspace.help, null, "late skipped-target provider result is ignored");
  assert.equal(fixture.controller.restoreTarget("item-1"), true);
  socket.message({ type: "snapshot", workspace: { ...snapshot, version: 4, help: { ...oldHelp, version: 3, status: "ready" } } });
  assert.equal(fixture.controller.state.workspace.help, null, "undo does not revive a retired help request");
  fixture.controller.hint("usage", "item-2");
  const otherId = fixture.controller.state.workspace.help.id;
  socket.message({ type: "snapshot", workspace: { ...skipped, version: 5 } });
  assert.equal(fixture.controller.state.workspace.help.id, otherId, "another target's pending help survives unrelated skip");
});

test("generic help is unavailable while every planned target is skipped and resumes after restore", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load();
  const snapshot = { ...workspace(1), session: { ...workspace().session, mission_plan: { targets: [{ session_item_id: "item-1" }] }, items: [{ id: "item-1" }] },
    opportunities: [{ session_item_id: "item-1", status: "skipped" }], help: null };
  const socket = await fixture.connect(false, snapshot);
  fixture.controller.hint(); fixture.controller.hint("usage", "item-1");
  assert.equal(socket.sent.some(event => event.type === "hint"), false);
  assert.equal(fixture.controller.state.workspace.help, null);
  socket.message({ type: "snapshot", workspace: { ...snapshot, version: 2, opportunities: [{ session_item_id: "item-1", status: "planned" }] } });
  fixture.controller.hint();
  assert.equal(socket.sent.filter(event => event.type === "hint").length, 1);
});

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

for (const granted of [true, false]) {
  test(`voice startup announces mode only after microphone permission ${granted ? "succeeds" : "fails"}`, async t => {
    let allow, deny;
    const fixture = setup({}, { enableMicrophone: () => new Promise((resolve, reject) => { allow = resolve; deny = reject; }) });
    t.after(() => fixture.controller.dispose()); await fixture.controller.load();
    const socket = await fixture.connect(true);
    assert.equal(fixture.controller.state.microphoneBusy, true);
    assert.deepEqual(socket.sent.filter(event => event.type === "microphone"), []);
    if (granted) allow(); else deny(new Error("Permission denied"));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(socket.sent.filter(event => event.type === "microphone"), [{ type: "microphone", enabled: granted }]);
    assert.equal(fixture.controller.state.microphone, granted);
    assert.equal(fixture.controller.state.microphoneBusy, false);
  });
}

test("text remains usable while voice permission is pending", async t => {
  let allow;
  const fixture = setup({}, { enableMicrophone: () => new Promise(resolve => { allow = resolve; }) });
  t.after(() => fixture.controller.dispose()); await fixture.controller.load();
  const socket = await fixture.connect(true);
  assert.equal(await fixture.controller.submit("Let us start here."), true);
  assert.equal(socket.sent.some(event => event.type === "text.submit"), true);
  assert.equal(socket.sent.some(event => event.type === "microphone"), false);
  fixture.controller.pause(); allow(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.sent.some(event => event.type === "microphone"), false);
});

const help = (id, version = 1, changes = {}) => ({ id, version, target_item_id: "language", level: "usage", status: "ready", direction: "Explain your preference.", expression: "To be fair", meaning: "Consider another point of view", pattern: null, example: null, substitution: null, source: "requested", source_message_id: null, error: null, ...changes });

test("hint requests do not stop microphone, playback, or typed turns and reject stale results", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load();
  const socket = await fixture.connect(true, { ...workspace(), session: { ...workspace().session, items: [{ id: "language", text: "To be fair" }] } });
  const played = []; fixture.audio[0].append = (item, audio) => played.push([item, audio]);
  socket.message({ type: "audio.delta", item_id: "audio", response_id: "reply", audio: "before" });
  fixture.controller.hint("usage", "language");
  const first = socket.sent.find(event => event.type === "hint");
  assert.equal(first.level, "usage"); assert.equal(first.target_item_id, "language");
  fixture.controller.hint("example", "language");
  const second = socket.sent.filter(event => event.type === "hint").at(-1);
  assert.notEqual(first.request_id, second.request_id);
  socket.message({ type: "audio.delta", item_id: "audio", response_id: "reply", audio: "during-help" });
  assert.equal(fixture.controller.state.workspace.help.status, "loading");
  assert.deepEqual(played.at(-1), ["audio", "during-help"]);
  socket.message({ type: "snapshot", workspace: { ...workspace(1), help: help(first.request_id) } });
  assert.equal(fixture.controller.state.workspace.help.id, second.request_id);
  socket.message({ type: "snapshot", workspace: { ...workspace(2), help: help(second.request_id, 2, { level: "example", example: "To be fair, Friday is realistic." }) } });
  socket.message({ type: "snapshot", workspace: { ...workspace(3), help: help(second.request_id, 1, { status: "loading" }) } });
  assert.equal(fixture.controller.state.workspace.help.version, 2);
  socket.message({ type: "snapshot", workspace: { ...workspace(4), help: help(first.request_id, 2) } });
  assert.equal(fixture.controller.state.workspace.help.id, second.request_id);
  assert.equal(fixture.controller.state.workspace.version, 4);
  socket.message({ type: "audio.delta", item_id: "audio", response_id: "reply", audio: "after" });
  assert.equal(await fixture.controller.submit("Friday works."), true);
  assert.deepEqual(played, [["audio", "before"], ["audio", "during-help"], ["audio", "after"]]);
  assert.equal(fixture.controller.state.microphone, true);
  assert.equal(fixture.controller.state.busy, false);
  assert.equal(fixture.audio[0].cleared, undefined);
  assert.equal(socket.sent.some(event => event.type === "interrupt"), false);
});

test("shown acknowledgements use exact card versions and actual exposed levels", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load();
  const socket = await fixture.connect(false, { ...workspace(), help: help("hint", 1, { status: "loading", level: "example" }) });
  fixture.controller.hintShown("hint", 0, "usage");
  fixture.controller.hintShown("hint", 1, "example");
  assert.equal(socket.sent.some(event => event.type === "hint.shown"), false);
  fixture.controller.hintShown("hint", 1, "usage"); fixture.controller.hintShown("hint", 1, "usage");
  assert.equal(socket.sent.filter(event => event.type === "hint.shown").length, 1);
  socket.message({ type: "snapshot", workspace: { ...workspace(1), help: help("hint", 2, { level: "example", example: "To be fair, Friday is realistic." }) } });
  fixture.controller.hintShown("hint", 1, "example"); fixture.controller.hintShown("hint", 2, "example");
  assert.equal(socket.sent.filter(event => event.type === "hint.shown").length, 2);
  socket.message({ type: "snapshot", workspace: { ...workspace(2), help: help("auto", 1, { level: "direction", source: "automatic" }) } });
  socket.message({ type: "user.activity", speaking: true });
  fixture.controller.hintShown("auto", 1, "direction");
  assert.equal(socket.sent.filter(event => event.type === "hint.shown").length, 2);
  socket.message({ type: "user.activity", speaking: false });
  // A new opportunity is required after speech; the old automatic card stays retired.
  socket.message({ type: "snapshot", workspace: { ...workspace(3), help: help("auto-new", 1, { level: "direction", source: "automatic" }) } });
  fixture.controller.hintShown("auto-new", 1, "usage"); fixture.controller.hintShown("auto-new", 1, "direction");
  assert.deepEqual(socket.sent.filter(event => event.type === "hint.shown").at(-1), { type: "hint.shown", hint_id: "auto-new", version: 1, level: "direction" });
});

test("an automatic card cannot reappear between speech end and its finalized transcript", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load();
  const card = help("old-auto", 1, { source: "automatic", level: "direction" });
  const socket = await fixture.connect(false, { ...workspace(), help: card });
  socket.message({ type: "user.activity", speaking: true });
  assert.equal(fixture.controller.state.workspace.help, null);
  socket.message({ type: "user.activity", speaking: false });
  socket.message({ type: "snapshot", workspace: { ...workspace(1), help: card } });
  assert.equal(fixture.controller.state.workspace.help, null);
  socket.message({ type: "snapshot", workspace: { ...workspace(2), help: help("new-auto", 1, { source: "automatic", level: "direction" }) } });
  assert.equal(fixture.controller.state.workspace.help.id, "new-auto");
  socket.message({ type: "transcript.delta", role: "user", item_id: "voice", delta: "Let me explain" });
  assert.equal(fixture.controller.state.workspace.help, null);
});

test("assistance labels preserve uncertain overlap and distinguish examples from independent use", () => {
  assert.equal(assistanceLabel({ assistance: "overlap", prompted: false }), "Assistance uncertain");
  assert.equal(assistanceLabel({ assistance: "unknown", prompted: false }), "Assistance uncertain");
  assert.equal(assistanceLabel({ assistance: "example", prompted: true }), "With an example");
  assert.equal(assistanceLabel({ assistance: "usage", prompted: true }), "With a hint");
  assert.equal(assistanceLabel({ assistance: "direction", prompted: false }), "With a direction cue");
  assert.equal(assistanceLabel({ assistance: "independent", prompted: false }), "Independent");
  assert.equal(assistanceLabel({ prompted: true }), "Prompted");
});

test("AI text visibility is version fenced and can be acknowledged idempotently after reconnect", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load();
  const snapshot = { ...workspace(1), messages: [{ id: "reply", role: "assistant", status: "final", revision: 2, text: "What would make Friday realistic?" }] };
  const socket = await fixture.connect(false, snapshot);
  fixture.controller.messageShown("reply", 1); fixture.controller.messageShown("reply", 2); fixture.controller.messageShown("reply", 2);
  assert.deepEqual(socket.sent.filter(event => event.type === "message.shown"), [{ type: "message.shown", message_id: "reply", revision: 2 }]);
  fixture.controller.pause(); fixture.controller.messageShown("reply", 2);
  const reconnected = await fixture.connect(false, snapshot); fixture.controller.messageShown("reply", 2);
  assert.equal(reconnected.sent.filter(event => event.type === "message.shown").length, 1);
});

test("a recovered loading card can retry after the old generation disappeared", async t => {
  const fixture = setup(); t.after(() => fixture.controller.dispose()); await fixture.controller.load();
  const snapshot = { ...workspace(1), session: { ...workspace().session, items: [{ id: "language", text: "To be fair" }] }, help: help("abandoned-request", 1, { status: "loading" }) };
  const socket = await fixture.connect(false, snapshot);
  fixture.controller.hint();
  const request = socket.sent.find(event => event.type === "hint");
  assert.ok(request);
  assert.notEqual(request.request_id, "abandoned-request");
  assert.equal(request.target_item_id, "language");
  fixture.controller.hint();
  assert.equal(socket.sent.filter(event => event.type === "hint").length, 1);
});

function visibilityFixture() {
  const document = new EventTarget(); const view = new EventTarget(); let intersectionCallback; let covered = false; let hidden = false; let frameId = 0;
  const frames = new Map();
  Object.assign(view, {
    IntersectionObserver: class { constructor(callback) { intersectionCallback = callback; } observe(target) { this.target = target; } disconnect() { this.closed = true; } },
    requestAnimationFrame: callback => { const id = ++frameId; frames.set(id, callback); return id; }, cancelAnimationFrame: id => frames.delete(id),
    getComputedStyle: () => ({ opacity: "1", visibility: "visible", display: hidden ? "none" : "block" })
  });
  const element = { ownerDocument: document, isConnected: true, parentElement: null, hidden: false, getAttribute: () => null, getBoundingClientRect: () => ({ left: 10, top: 10, width: 200, height: 80 }), contains: value => value === element };
  Object.assign(document, { defaultView: view, visibilityState: "visible", elementFromPoint: () => covered ? {} : element });
  return { document, view, element, intersect: (ratio = 1) => intersectionCallback([{ target: element, isIntersecting: ratio > 0, intersectionRatio: ratio }]), painted: () => { for (let step = 0; step < 2; step++) { const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback()); } }, cover: value => { covered = value; }, hide: value => { hidden = value; } };
}

test("visibility acknowledgement waits for paint, visible tab, viewport, and no covering overlay", () => {
  const fixture = visibilityFixture(); let shown = 0;
  const stop = observeVisible(fixture.element, () => shown++);
  fixture.intersect(0.3); fixture.painted(); assert.equal(shown, 0);
  fixture.document.visibilityState = "hidden"; fixture.intersect(); fixture.painted(); assert.equal(shown, 0);
  fixture.document.visibilityState = "visible"; fixture.cover(true); fixture.document.dispatchEvent(new Event("visibilitychange")); fixture.painted(); assert.equal(shown, 0);
  fixture.cover(false); fixture.hide(true); fixture.view.dispatchEvent(new Event("resize")); fixture.painted(); assert.equal(shown, 0);
  fixture.hide(false); fixture.view.dispatchEvent(new Event("pointerup")); assert.equal(shown, 0); fixture.painted(); assert.equal(shown, 1);
  fixture.view.dispatchEvent(new Event("resize")); fixture.painted(); assert.equal(shown, 1); stop();
});

test("unmounting or replacing a hint before paint cannot record exposure", () => {
  const fixture = visibilityFixture(); let shown = 0;
  const stop = observeVisible(fixture.element, () => shown++);
  fixture.intersect(); stop(); fixture.painted(); assert.equal(shown, 0);
});

test("ending an overlay animation rechecks visible wording only after paint", () => {
  for (const event of ["animationend", "transitionend"]) {
    const fixture = visibilityFixture(); let shown = 0;
    const stop = observeVisible(fixture.element, () => shown++);
    fixture.cover(true); fixture.intersect(); fixture.painted(); assert.equal(shown, 0);
    fixture.view.dispatchEvent(new Event(event)); fixture.painted(); assert.equal(shown, 0, "animation end is not itself exposure");
    fixture.cover(false); fixture.view.dispatchEvent(new Event(event));
    assert.equal(shown, 0, "the uncovered surface must paint");
    fixture.painted(); assert.equal(shown, 1);
    fixture.view.dispatchEvent(new Event(event)); fixture.painted(); assert.equal(shown, 1, "the receipt remains one-shot");
    stop();
  }
});

test("stopped visibility observers ignore subsequent overlay animations", () => {
  const fixture = visibilityFixture(); let shown = 0;
  const stop = observeVisible(fixture.element, () => shown++);
  fixture.cover(true); fixture.intersect(); fixture.painted(); stop();
  fixture.cover(false); fixture.view.dispatchEvent(new Event("animationend")); fixture.painted();
  assert.equal(shown, 0);
});
