import assert from "node:assert/strict";
import test from "node:test";
import { practiceDraft, secondRoundSupport, validMissedOpportunities } from "../features/analytics/model.ts";
import { adoptDeviceDraft, emptyDraft, importMissionDraft, openDraft, preparePlannedSubmission, saveDraft, toggleMissionSelection, validPlan } from "../features/loadout/draft.ts";
import { createSpeakingApi } from "../features/loadout/api/speaking-api.ts";

const uuid = "a0000000-0000-4000-8000-000000000001";
const records = [{ key: "saved", serverId: "corpus", item: { id: "item", kind: "structure", text: "If {condition}, we can {action}", meaning: "An option", slots: { condition: "A condition", action: "An action" }, tags: [] } }];
function fixture() {
  const item = { ...records[0].item, id: "session-item", corpus_item_id: "corpus", ordinal: 0 };
  const message = { id: "reply", role: "user", status: "final", revision: 2, text: "🙂 We can wait." };
  const original = { message_id: "reply", transcript_revision: 2, start: 3, end: 15, quote: "We can wait." };
  const report = { session_id: "parent", effective_support_level: "model_label", session: {
    id: "parent", scenario_type: "workplace", goal: "Make a plan", difficulty: "standard", feedback_level: "balanced", logic_template: null,
    mission_plan: { targets: [{ session_item_id: item.id, role: "primary" }], user_role: "Lead", ai_role: "Colleague" }, items: [item]
  }, messages: [message], result: { missed_opportunities: [{ id: "missed", session_item_id: item.id, original, suggested: "If we need more time, we can wait.", reason: "Frame an option.", basis: "ai_suggestion" }] } };
  const target = { corpus_item_id: "corpus", role: "primary", communicative_function: "Suggest an option", fit: "high", fit_reason: "A planning choice", trigger_question: "What can we do?", skip_when: "No decision needed", metadata_status: "available" };
  const plan = { id: "plan", version: 1, scenario_type: "workplace", brief: "A second round", created_at: "2026-10-20T00:00:00Z",
    practice_source: { parent_session_id: "parent", root_session_id: "parent", variation: "details", parent_snapshot_hash: "a".repeat(64) },
    candidates: [0, 1].map(index => ({ id: `candidate-${index}`, title: "Planning", setting: "A new launch", goal: "Choose the date", user_role: "Lead", ai_role: "Colleague", register: "professional", targets: [target], changes: [{ field: "setting", before: "A launch", after: "A new launch" }] })) };
  return { report, plan };
}
function storage() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }

test("missed suggestions need exact final UTF-16 user references and retain AI provenance", () => {
  const { report } = fixture();
  assert.equal(validMissedOpportunities(report).length, 1);
  for (const patch of [{ transcript_revision: 1 }, { start: 2 }, { quote: "we can wait." }]) {
    const changed = structuredClone(report); Object.assign(changed.result.missed_opportunities[0].original, patch);
    assert.deepEqual(validMissedOpportunities(changed), []);
  }
  const changed = structuredClone(report); changed.result.missed_opportunities[0].basis = "observed";
  assert.deepEqual(validMissedOpportunities(changed), []);
});
test("second round uses final support only and never silently reintroduces hints", () => {
  const { report } = fixture();
  assert.equal(secondRoundSupport(report), "label_only");
  report.session.support_level = "no_hint";
  assert.equal(secondRoundSupport(report), "label_only", "initial support is not substituted for final evidence");
  report.effective_support_level = "no_hint";
  assert.equal(secondRoundSupport(report), "no_hint");
});
test("linked draft retains identity, roles, plan and chosen support while preserving old drafts", async () => {
  const { report, plan } = fixture();
  assert.equal(validPlan(plan), true);
  const linked = practiceDraft(report, plan, "label_only", records);
  assert.deepEqual(linked.targetRoles, { saved: "primary" });
  assert.equal(toggleMissionSelection(linked, records[0]), linked, "unlink is required before editing linked targets");
  const store = storage(); const old = { ...emptyDraft(), selectedKeys: ["old"], goal: "Keep this work" };
  await saveDraft(store, "owner", old);
  assert.equal(await importMissionDraft(store, "owner", linked), "saved");
  assert.deepEqual((await openDraft(store, "owner")).draft, old);
  const adopted = await adoptDeviceDraft(store, "owner", 0);
  assert.deepEqual(adopted.deviceDrafts, [old], "opening the linked draft also keeps previous work");
  const prepared = preparePlannedSubmission(adopted.draft, records, () => uuid);
  assert.equal(prepared.submission.request.plan_id, plan.id);
  assert.equal(prepared.submission.request.support_level, "label_only");
  await saveDraft(store, "owner", prepared);
  const restored = (await openDraft(store, "owner")).draft;
  assert.deepEqual(preparePlannedSubmission(restored, [], () => assert.fail("no new request")).submission, prepared.submission);
  await assert.rejects(adoptDeviceDraft(store, "owner", 0), /Recover the pending/);
});
test("changed language, unavailable targets and changed target roles cannot become linked practice", () => {
  const { report, plan } = fixture();
  for (const patch of [{ text: "A changed expression" }, { meaning: "Changed" }, { slots: { condition: "Other" } }, { kind: "chunk" }]) {
    const changed = structuredClone(records); Object.assign(changed[0].item, patch);
    assert.throws(() => practiceDraft(report, plan, "no_hint", changed), /language has changed/);
  }
  assert.throws(() => practiceDraft(report, plan, "no_hint", []), /unavailable/);
  const changed = structuredClone(plan); changed.candidates[0].targets[0].role = "opportunity";
  assert.throws(() => practiceDraft(report, changed, "no_hint", records), /targets and roles/);
  const noSupport = { ...practiceDraft(report, plan, "no_hint", records), supportLevel: null };
  assert.throws(() => preparePlannedSubmission(noSupport, records, () => uuid), /support level/);
});
test("linked practice compares saved expression wording rather than its decorated corpus label", () => {
  const { report, plan } = fixture();
  const changed = structuredClone(records);
  Object.assign(report.session.items[0], { kind: "chunk", text: "to be fair", meaning: "Acknowledge a perspective", slots: {} });
  Object.assign(changed[0].item, { kind: "chunk", text: '"to be fair" - Acknowledge a perspective', meaning: "Acknowledge a perspective", slots: {} });
  const draft = practiceDraft(report, plan, "no_hint", changed);
  assert.equal(draft.plan.value.id, plan.id);
  changed[0].item.text = '"a different expression" - Acknowledge a perspective';
  assert.throws(() => practiceDraft(report, plan, "no_hint", changed), /language has changed/);
});
test("practice APIs post only explicit variation, read comparisons, and fence recommendation identity", async t => {
  const { plan } = fixture(); const calls = [];
  let result = plan;
  t.mock.method(globalThis, "fetch", async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(result)); });
  const token = `header.${btoa(JSON.stringify({ sub: "owner" }))}.fixture`;
  const api = createSpeakingApi("owner", async () => token);
  await api.practicePlan("parent", "details", new AbortController().signal);
  assert.deepEqual(JSON.parse(calls[0].init.body), { variation: "details" });
  result = { child_session_id: "child", parent_session_id: null, status: "unavailable", reason: "Original deleted", items: [] };
  assert.equal((await api.comparison("child", new AbortController().signal)).parent_session_id, null);
  assert.equal(calls[1].init.method, undefined); assert.equal(calls[1].init.body, undefined);
  result = { current_level: "model_frame", targets: [{ corpus_item_id: "other", role: "primary" }] };
  await assert.rejects(api.supportRecommendation({ current_level: "model_frame", targets: [{ corpus_item_id: "corpus", role: "primary" }] }, new AbortController().signal), /no longer matches/);
});
test("practice planning rejects a late result after account unmount", async t => {
  const { plan } = fixture(); let finish;
  t.mock.method(globalThis, "fetch", () => new Promise(resolve => { finish = resolve; }));
  const token = `header.${btoa(JSON.stringify({ sub: "owner" }))}.fixture`;
  const abort = new AbortController();
  const task = createSpeakingApi("owner", async () => token).practicePlan("parent", "details", abort.signal);
  await new Promise(resolve => setImmediate(resolve)); abort.abort();
  finish(new Response(JSON.stringify(plan)));
  await assert.rejects(task, error => error.name === "AbortError");
});
