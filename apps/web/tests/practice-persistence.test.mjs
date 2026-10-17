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

test("analysis submission keeps retention independent and acknowledges only after upload", async () => {
  let saved, analysis, bytes;
  const acknowledged = [];
  const queue = new PracticeOutbox({
    submit: async (attempt, value, audio) => { saved=attempt;analysis=value;bytes=audio;return {id:"take"}; },
    create: async()=>assert.fail("Use one submission"),
    upload: async()=>assert.fail("Do not retain without consent")
  });
  queue.enqueue(input, blob, false, { referenceId: "reference-a" }, id => {
    assert.equal(bytes, blob);acknowledged.push(id);
  });
  await until(() => queue.state.pending === 0);
  assert.equal(saved.recording,null);
  assert.equal(analysis.consent_version,"practice-analysis-v1");
  assert.equal(analysis.reference_id,"reference-a");
  assert.equal(analysis.sha256.length,64);
  assert.deepEqual(acknowledged,["take"]);queue.dispose();
});

test("submission retry resends identical metadata and bytes with independent retention consent",async()=>{
  const requests=[];let fail=true;
  const queue=new PracticeOutbox({submit:async(attempt,analysis,audio)=>{
    requests.push({attempt:structuredClone(attempt),analysis:structuredClone(analysis)});
    assert.equal(audio,blob);
    if(fail)throw Error("retention interrupted");
    return {id:"take"};
  }});
  queue.enqueue(input,blob,true,{referenceId:"ref"});
  await until(()=>queue.state.errors.length===1);
  fail=false;queue.retry();await until(()=>queue.state.pending===0);
  assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
  assert.equal(requests[0].attempt.recording.sha256,requests[0].analysis.sha256);
  assert.equal(requests[0].attempt.recording.consent_version,"recording-retention-v1");queue.dispose();
});

test("uncertain submission response preserves identity and only acknowledges successful retry",async()=>{
  const requests=[],acknowledged=[];let fail=true;
  const queue=new PracticeOutbox({submit:async(attempt,analysis,audio)=>{
    requests.push(structuredClone({attempt,analysis}));assert.equal(audio,blob);
    if(fail)throw Error("response interrupted");
    return {id:"take"};
  }});
  const choice={referenceId:"reference-a"};
  queue.enqueue(input,blob,false,choice,id=>acknowledged.push(id));choice.referenceId="reference-b";
  await until(()=>queue.state.errors.length===1);assert.deepEqual(acknowledged,[]);
  fail=false;queue.retry();await until(()=>queue.state.pending===0);
  assert.deepEqual(requests[0],requests[1]);assert.equal(requests[0].analysis.reference_id,"reference-a");
  assert.deepEqual(acknowledged,["take"]);queue.dispose();
});

test("take waits for its captured reference and keeps the binding across retry",async()=>{
  let release,fail=true,resolves=0;const requests=[];
  const queue=new PracticeOutbox({submit:async(attempt,analysis)=>{
    requests.push(structuredClone({attempt,analysis}));
    if(fail)throw Error("offline");return {id:"take"};
  }});
  queue.enqueue(input,blob,false,{referenceId:null,resolveReference:()=>{resolves++;return new Promise(r=>release=r);}});
  await until(()=>Boolean(release));assert.equal(requests.length,0);
  release("frozen-reference");await until(()=>queue.state.errors.length===1);
  fail=false;queue.retry();await until(()=>queue.state.pending===0);
  assert.equal(resolves,1);assert.deepEqual(requests[0],requests[1]);
  assert.equal(requests[0].analysis.reference_id,"frozen-reference");queue.dispose();
});

test('text-support arrays are immutable across uncertain saves and settings changes', async () => {
  const created = [];
  let fail = true;
  const queue = new PracticeOutbox({ create: async payload => {
    created.push(structuredClone(payload));
    if (fail) throw Error('offline');
    return { id: 'take', recording_state: 'none' };
  }});
  const source = { ...input, text_support: { version: 'text-support-v1', mode: 'hidden',
    visible_source_indices_at_start: [0], revealed_source_indices: [0, 2] } };
  queue.enqueue(source, blob, false);
  source.text_support.mode = 'full';
  source.text_support.visible_source_indices_at_start.push(1);
  source.text_support.revealed_source_indices.splice(0);
  await until(() => queue.state.errors.length === 1);
  fail = false; queue.retry();
  await until(() => queue.state.pending === 0);
  assert.deepEqual(created[0], created[1]);
  assert.deepEqual(created[1].text_support, { version: 'text-support-v1', mode: 'hidden',
    visible_source_indices_at_start: [0], revealed_source_indices: [0, 2] });
  queue.dispose();
});

test('recognition feedback sends only the marker to the owner-bound take endpoint', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ kind: 'recognition_error', created_at: '2026-10-12T00:00:00Z' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const token = `header.${btoa(JSON.stringify({ sub: 'owner' }))}.signature`;
    const api = createPracticeApi('owner', async () => token);
    const result = await api.markRecognitionError('take/id', new AbortController().signal);
    assert.equal(result.kind, 'recognition_error');
    assert.equal(calls[0].init.method, 'PUT');
    assert.ok(calls[0].url.endsWith('/take%2Fid/recognition-feedback'));
    assert.deepEqual(JSON.parse(calls[0].init.body), { kind: 'recognition_error' });
    const other = createPracticeApi('other', async () => token);
    await assert.rejects(other.markRecognitionError('take', new AbortController().signal), /Account changed/);
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = original; }
});
