import test from "node:test";
import assert from "node:assert/strict";
import { FeedbackController } from "../features/analytics/controller.ts";
import { createFeedbackApi, FeedbackApiError } from "../features/analytics/api.ts";
import { validReference, draftFromMission, retryMissionRequest, suggestionRecord } from "../features/analytics/model.ts";
import { emptyDraft, importMissionDraft, readDraftEnvelope, saveDraft } from "../features/loadout/draft.ts";
const delay = () => new Promise(resolve => setImmediate(resolve));
const message = { id: "user-1", role: "user", status: "final", revision: 2, text: "🙂 To be fair, we need time." };
const quote = { message_id: "user-1", transcript_revision: 2, quote: "To be fair", start: 3, end: 13 };
const mission = { id: "mission", user_id: "owner", scenario_type: "workplace", goal: "Agree on a plan", difficulty: "guided", feedback_level: "light", logic_template: { id: "persuasive_pitch" }, items: [{ id: "first", ordinal: 1, corpus_item_id: "corpus-2" }, { id: "second", ordinal: 0, corpus_item_id: "corpus-1" }] };
const records = [{ serverId: "corpus-1", key: "key-1" }, { serverId: "corpus-2", key: "key-2" }];
const report = (status = "ready", extra = {}) => ({ id: "report", session_id: "mission", session: mission, status, messages: [message], retryable: status === "failed", ...extra });
function memoryStorage() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }

test("evidence is bound to final USER revision and exact UTF-16 offsets", () => {
  assert.equal(validReference(quote, [message]), message);
  for (const changed of [{ role: "assistant" }, { status: "unavailable" }, { status: "interrupted" }, { revision: 3 }]) assert.equal(validReference(quote, [{ ...message, ...changed }]), null);
  for (const changed of [{ start: 2 }, { start: -1 }, { end: 99 }, { end: 3 }, { start: 3.5 }, { quote: "to be fair" }]) assert.equal(validReference({ ...quote, ...changed }, [message]), null);
});
test("retry uses original settings and ordered owned IDs with a new explicit request ID", () => {
  const payload = retryMissionRequest(mission, records, "new-request");
  assert.deepEqual(payload, { client_id: "new-request", scenario_type: "workplace", goal: "Agree on a plan", difficulty: "guided", feedback_level: "light", logic_template_id: "persuasive_pitch", corpus_item_ids: ["corpus-1", "corpus-2"] });
  assert.throws(() => retryMissionRequest(mission, records.slice(1), "another"), /no longer/);
  assert.deepEqual(draftFromMission(mission, records.slice(1)).draft.selectedKeys, ["missing-session-item:second", "key-2"]);
});
test("explicit mission import preserves a current draft and deduplicates additional drafts", async () => {
  const storage = memoryStorage(); const current = { ...emptyDraft(), goal: "Do not replace my current work", selectedKeys: ["old"] };
  await saveDraft(storage, "owner", current);
  const imported = draftFromMission(mission, records).draft;
  assert.equal(await importMissionDraft(storage, "owner", imported), "saved");
  assert.equal(await importMissionDraft(storage, "owner", imported), "saved");
  const saved = readDraftEnvelope(storage).accounts.owner;
  assert.deepEqual(saved.draft, current); assert.equal(saved.deviceDrafts.length, 1); assert.deepEqual(saved.deviceDrafts[0], imported);
  assert.equal(await importMissionDraft(storage, "other", imported), "active");
  assert.deepEqual(readDraftEnvelope(storage).accounts.owner.draft, current);
});
test("mission import checks account fence inside lock and never damages malformed storage", async () => {
  const storage = memoryStorage(); let active = true;
  const result = await importMissionDraft(storage, "owner", emptyDraft(), { lock: async operation => { active = false; return operation(); }, isCurrent: () => active });
  assert.equal(result, null); assert.deepEqual(readDraftEnvelope(storage).accounts, {});
  storage.setItem("libitu:loadout:v1", "broken");
  await assert.rejects(importMissionDraft(storage, "owner", emptyDraft()), /not been overwritten/);
  assert.equal(storage.getItem("libitu:loadout:v1"), "broken");
});
test("saved suggestions preserve AI provenance, source quote, stable dedup key and report link", () => {
  const refactor = { id: "refactor-1", original: quote, save_text: "to be fair", save_kind: "chunk", save_meaning: "Acknowledge another perspective", reason: "Acknowledge the concern." };
  const value = suggestionRecord(report(), refactor, "https://libitu.example");
  assert.equal(value.key, "speaking-feedback:report:refactor-1"); assert.match(value.sourceUrl, /\/speaking\/mission\/analytics$/); assert.match(value.item.usageNote, /AI-generated.*report/); assert.equal(value.item.sourceText, "To be fair");
  assert.throws(() => suggestionRecord(report(), { ...refactor, original: { ...quote, transcript_revision: 1 } }, "https://libitu.example"), /verified source/);
});
test("first missing report is created once; polling and refresh never request paid retries", async t => {
  let reads = 0; const creates = []; const updates = [];
  const controller = new FeedbackController({ read: async () => { if (++reads === 1) throw new FeedbackApiError("missing", 404); return report(); }, create: async retry => { creates.push(retry); return report("queued"); } }, value => updates.push(value), 1);
  t.after(() => controller.dispose()); await controller.load(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(creates, [false]); assert.equal(controller.state.report.status, "ready");
  await controller.refresh(); assert.deepEqual(creates, [false]); assert.equal(updates.at(-1).loading, false);
});
test("bounded pending polling pauses without recreating report", async t => {
  let reads = 0; const controller = new FeedbackController({ read: async () => { reads++; return report("processing"); }, create: async () => assert.fail("read-only polling") }, () => {}, 1, 2);
  t.after(() => controller.dispose()); await controller.load(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reads, 3); assert.equal(controller.state.pollingPaused, true);
});
test("only explicit retry on a retryable report POSTs retry=true", async t => {
  const creates = []; const controller = new FeedbackController({ read: async () => report("failed"), create: async retry => { creates.push(retry); return report(); } }, () => {});
  t.after(() => controller.dispose()); await controller.load(); assert.deepEqual(creates, []); await controller.retry(); assert.deepEqual(creates, [true]); await controller.retry(); assert.deepEqual(creates, [true]);
});
test("disposed account cannot publish late report or create after a late 404", async () => {
  let finish; let publishes = 0;
  const controller = new FeedbackController({ read: () => new Promise(resolve => { finish = resolve; }), create: async () => assert.fail("must not create") }, () => { publishes++; });
  const task = controller.load(); controller.dispose(); const before = publishes; finish(report()); await task; assert.equal(publishes, before);
});
test("failed reads keep the existing verified report and do not regenerate", async t => {
  let fail = false; const controller = new FeedbackController({ read: async () => { if (fail) throw new FeedbackApiError("offline", 0); return report(); }, create: async () => assert.fail("no generation") }, () => {});
  t.after(() => controller.dispose()); await controller.load(); fail = true; await controller.refresh(); assert.equal(controller.state.report.id, "report"); assert.equal(controller.state.error, "offline");
});
test("API rejects a stale account before fetch and mismatched report owner after fetch", async t => {
  let fetches = 0; t.mock.method(globalThis, "fetch", async () => { fetches++; return new Response(JSON.stringify(report("ready", { session: { ...mission, user_id: "other" } }))); });
  const token = owner => `header.${btoa(JSON.stringify({ sub: owner }))}.fixture`;
  await assert.rejects(createFeedbackApi("owner", "mission", async () => token("other")).read(new AbortController().signal), /Sign in/); assert.equal(fetches, 0);
  await assert.rejects(createFeedbackApi("owner", "mission", async () => token("owner")).read(new AbortController().signal), /account or mission changed/); assert.equal(fetches, 1);
});
test("API cancellation after token lookup prevents network mutation", async t => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("aborted account must not POST"));
  const abort = new AbortController(); const api = createFeedbackApi("owner", "mission", async () => { await delay(); abort.abort(); return `h.${btoa(JSON.stringify({ sub: "owner" }))}.s`; });
  await assert.rejects(api.create(true, abort.signal), /abort/i);
});
test("explicit refresh recovers a failed initial create without trapping a missing report", async t => {
  let creates = 0; const controller = new FeedbackController({ read: async () => { throw new FeedbackApiError("missing", 404); }, create: async retry => { assert.equal(retry, false); if (++creates === 1) throw new FeedbackApiError("storage unavailable", 503); return report(); } }, () => {});
  t.after(() => controller.dispose()); await controller.load(); assert.equal(controller.state.report, null); await controller.refresh(); assert.equal(controller.state.report.status, "ready"); assert.equal(creates, 2);
});
test("explicit retry starts a fresh poll budget after an earlier pending run", async t => {
  let phase = "processing", reads = 0;
  const controller = new FeedbackController({ read: async () => { reads++; return report(phase); }, create: async () => { phase = "processing"; return report(phase); } }, () => {}, 1, 1);
  t.after(() => controller.dispose()); await controller.load(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(controller.state.pollingPaused, true);
  phase = "failed"; await controller.refresh(); const before = reads; await controller.retry(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(reads, before + 1); assert.equal(controller.state.pollingPaused, true);
});
test("known deleted report is cleared without automatic recreation", async t => {
  let removed = false; const controller = new FeedbackController({ read: async () => { if (removed) throw new FeedbackApiError("deleted", 404); return report(); }, create: async () => assert.fail("deleted reports must not regenerate") }, () => {});
  t.after(() => controller.dispose()); await controller.load(); removed = true; await controller.refresh(); assert.equal(controller.state.report, null); assert.equal(controller.state.errorStatus, 404); await controller.refresh(); assert.equal(controller.state.report, null);
});
