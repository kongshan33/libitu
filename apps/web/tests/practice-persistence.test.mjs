import assert from "node:assert/strict";
import { test } from "node:test";
import { PracticeOutbox, MAX_PENDING_TAKES } from "../features/stage-two/persistence/practice-outbox.ts";
import { createPracticeApi } from "../features/stage-two/persistence/practice-api.ts";

const input = { content_id: "content", sentence_id: "sentence-a", duration_ms: 1000, playback_rate: 1, text_visible: true };
const blob = new Blob(["OggS audio"], { type: "audio/ogg;codecs=opus" });
const until = async (predicate) => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("condition did not resolve");
};

test("retry uses same attempt and bytes after uncertain upload; sentence changes cannot retarget it", async () => {
  const created = [], uploaded = [];
  let fail = true;
  const queue = new PracticeOutbox({
    create: async (payload) => { created.push(structuredClone(payload)); return { id: "server-id", recording_state: "pending" }; },
    upload: async (id, bytes) => { uploaded.push({ id, bytes }); if (fail) throw Error("offline"); }
  });
  const source = { ...input };
  queue.enqueue(source, blob, true);
  source.sentence_id = "sentence-b";
  await until(() => queue.state.errors.length === 1);
  assert.equal(queue.state.savedVersion, 0);
  fail = false; queue.retry(); queue.retry();
  await until(() => queue.state.pending === 0);
  assert.equal(created.length, 2);
  assert.deepEqual(created[0], created[1]);
  assert.equal(created[0].sentence_id, "sentence-a");
  assert.equal(created[0].recording.mime_type, "audio/ogg");
  assert.equal(created[0].recording.sha256.length, 64);
  assert.equal(uploaded[0].bytes, blob); assert.equal(uploaded[1].bytes, blob);
  assert.equal(queue.state.savedVersion, 1);
  queue.dispose();
});

test("record only saves no audio without explicit retention", async () => {
  let saved;
  const queue = new PracticeOutbox({ create: async (payload) => { saved = payload; return { id: "id", recording_state: "none" }; },
    upload: async () => assert.fail("unconsented upload") });
  queue.enqueue(input, blob, false);
  await until(() => queue.state.pending === 0);
  assert.equal(saved.recording, null); queue.dispose();
});

test("account disposal aborts pending operations and never uploads with a new owner", async () => {
  let release, signal;
  const queue = new PracticeOutbox({ create: async (_input, abort) => {
    signal = abort; return new Promise((resolve) => { release = resolve; });
  }, upload: async (_id, _blob, abort) => { abort.throwIfAborted(); assert.fail("late upload"); } });
  queue.enqueue(input, blob, true);
  await until(() => Boolean(release));
  queue.dispose();
  assert.equal(signal.aborted, true);
  release({ id: "old-owner", recording_state: "pending" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(queue.state.savedVersion, 0);
});

test("pending audio is bounded and recording resumes after saves", async () => {
  const queue = new PracticeOutbox({ create: async () => { throw Error("offline"); } });
  for (let i = 0; i < MAX_PENDING_TAKES; i++) queue.enqueue(input, blob, false);
  assert.equal(queue.canRecord(), false);
  assert.throws(() => queue.enqueue(input, blob, false), /pending saves/);
  queue.dispose();
});

test("API refuses a token for another account before sending bytes", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("must not send");
  try {
    const token = `header.${btoa(JSON.stringify({ sub: "other" }))}.signature`;
    const api = createPracticeApi("owner", async () => token);
    await assert.rejects(api.upload("id", blob, new AbortController().signal), /Account changed/);
  } finally { globalThis.fetch = original; }
});

test("analysis consent uploads temporary audio without granting recording retention", async () => {
  let saved, analysis, bytes;
  const acknowledged = [];
  const queue = new PracticeOutbox({
    create: async value => { saved = value; return { id: "take", recording_state: "none" }; },
    upload: async () => assert.fail("analysis consent must not retain audio"),
    prepareAnalysis: async (id, value) => { assert.equal(id, "take"); analysis = value; return { state: "awaiting_upload" }; },
    uploadAnalysis: async (id, value) => { assert.equal(id, "take"); bytes = value; }
  });
  queue.enqueue(input, blob, false, { referenceId: "reference-a" }, id => {
    assert.equal(bytes, blob, "the workspace must not select the take before its analysis upload is acknowledged");
    acknowledged.push(id);
  });
  await until(() => queue.state.pending === 0);
  assert.equal(saved.recording, null);
  assert.equal(analysis.consent_version, "practice-analysis-v1");
  assert.equal(analysis.reference_id, "reference-a");
  assert.equal(analysis.sha256.length, 64);
  assert.equal(bytes, blob);
  assert.deepEqual(acknowledged, ["take"]);
  queue.dispose();
});

test("uncertain analysis upload retries the same identity and does not reupload a completed job", async () => {
  const inputs = [];
  const acknowledged = [];
  let uploads = 0, registered = false;
  const queue = new PracticeOutbox({
    create: async () => ({ id: "take", recording_state: "none" }),
    prepareAnalysis: async (_id, value) => { inputs.push(structuredClone(value)); return { state: registered ? "completed" : "awaiting_upload" }; },
    uploadAnalysis: async () => { uploads++; registered = true; throw Error("response interrupted"); }
  });
  const choice = { referenceId: "reference-a" };
  queue.enqueue(input, blob, false, choice, id => acknowledged.push(id));
  choice.referenceId = "reference-b";
  await until(() => queue.state.errors.length === 1);
  assert.deepEqual(acknowledged, [], "failed saves cannot publish a completed take to the workspace");
  queue.retry();
  await until(() => queue.state.pending === 0);
  assert.equal(uploads, 1);
  assert.deepEqual(inputs[0], inputs[1]);
  assert.equal(inputs[0].reference_id, "reference-a");
  assert.deepEqual(acknowledged, ["take"], "retries notify the workspace once with the durable identity");
  queue.dispose();
});

test('take waits for its captured reference upload and keeps its immutable binding across retry', async()=>{
  let release,fail=true,resolves=0;const prepared=[],created=[];
  const queue=new PracticeOutbox({create:async payload=>{created.push(payload.client_id);return {id:'take',recording_state:'none'};},
    prepareAnalysis:async(_id,payload)=>{prepared.push(structuredClone(payload));if(fail)throw Error('offline');return {state:'awaiting_upload'};},
    uploadAnalysis:async()=>{}});
  queue.enqueue(input,blob,false,{referenceId:null,resolveReference:()=>{resolves++;return new Promise(r=>release=r);}});
  await until(()=>Boolean(release));assert.equal(prepared.length,0);assert.equal(queue.state.pending,1);
  release('frozen-reference');await until(()=>queue.state.errors.length===1);
  fail=false;queue.retry();await until(()=>queue.state.pending===0);
  assert.equal(resolves,1);assert.deepEqual(created,[created[0],created[0]]);
  assert.deepEqual(prepared.map(p=>p.reference_id),['frozen-reference','frozen-reference']);queue.dispose();
});
