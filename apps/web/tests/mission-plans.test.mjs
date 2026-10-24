import assert from "node:assert/strict";
import test from "node:test";
import { acknowledgeSubmission, adjustSceneTarget, automaticCandidate, changeDraftSupport, currentCandidate, draftSignature, DraftConflictError, emptyDraft, missionInputSignature, missionPlanError, missionSelectionError, openDraft, preparePlannedSubmission, prepareSubmission, saveDraft, sceneAdjustmentError, sceneFitAdvice, targetRole, toggleMissionSelection, validPlan } from "../features/loadout/draft.ts";
import { createSpeakingApi, SpeakingApiError } from "../features/loadout/api/speaking-api.ts";
import { missionProblem } from "../features/loadout/problems.ts";

const uuid = "a0000000-0000-4000-8000-000000000001";
const records = Array.from({ length: 8 }, (_, index) => ({ key: `key-${index}`, serverId: `corpus-${index}`, item: { id: `${index}`, kind: index < 4 ? "structure" : "chunk", text: `target-${index}`, tags: [], meta: "Saved" } }));
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; };
function planned(draft = { ...emptyDraft(), selectedKeys: ["key-0", "key-4", "key-5"] }) {
  const targets = draft.selectedKeys.map(key => ({ corpus_item_id: records.find(record => record.key === key).serverId, role: targetRole(draft, key), communicative_function: "Explain a viewpoint", fit: "high", fit_reason: "The task needs a viewpoint.", trigger_question: "What would you recommend?", skip_when: "No decision is needed.", metadata_status: "partial" }));
  const value = { id: "plan-a", version: 1, scenario_type: draft.scenarioType, brief: draft.goal.trim(), created_at: "2026-10-20T00:00:00Z", candidates: [0, 1].map(index => ({ id: `scene-${index}`, title: `Scene ${index}`, setting: "A planning discussion", goal: "Agree on the next step", user_role: "Project lead", ai_role: "Colleague", register: "professional", targets: structuredClone(targets) })) };
  return { ...draft, plan: { signature: missionInputSignature(draft, records), value }, selectedCandidateId: value.candidates[0].id };
}

test("conversation settings reuse a scene while scene inputs and saved language invalidate it", () => {
  const draft = planned();
  for (const patch of [{ difficulty: "guided" }, { feedbackLevel: "detailed" }, { logicTemplateId: "status_update" }, { supportLevel: "no_hint" }]) {
    const changed = { ...draft, ...patch };
    assert.equal(missionInputSignature(changed, records), draft.plan.signature);
    assert.equal(automaticCandidate(changed, records).id, draft.selectedCandidateId);
    assert.notEqual(draftSignature(changed), draftSignature(draft), "create settings keep their own immutable request signature");
  }
  for (const patch of [{ goal: "Different task" }, { scenarioType: "everyday" }, { selectedKeys: ["key-0", "key-4"] }, { targetRoles: { "key-0": "opportunity" } }]) {
    assert.equal(automaticCandidate({ ...draft, ...patch }, records), undefined);
  }
  for (const patch of [{ text: "Changed target" }, { meaning: "Changed meaning" }, { usageNote: "Different usage" }, { tags: ["suggestion"] },
    { slots: { topic: "a subject" } }, { register: "casual" }, { scenarioTags: ["travel"] }, { patternFamily: "different-pattern" }]) {
    const changedRecords = structuredClone(records);
    Object.assign(changedRecords[0].item, patch);
    assert.equal(automaticCandidate(draft, changedRecords), undefined, JSON.stringify(patch));
  }
  const unchanged = structuredClone(records);
  unchanged[0].updatedAt = "2026-10-24T00:00:00Z";
  unchanged[0].item.meta = "Different display metadata";
  assert.equal(automaticCandidate(draft, unchanged).id, draft.selectedCandidateId, "presentation-only data is not a scene input");
  const plain = structuredClone(records); plain[4].item.meaning = "A target meaning";
  const decorated = structuredClone(plain); decorated[4].item.text = '"target-4" - A target meaning';
  assert.equal(missionInputSignature(draft, decorated), missionInputSignature(draft, plain), "corpus label decoration does not change saved expression wording");
});

test("one-scene plans persist and create while legacy three-scene plans remain readable", async () => {
  const draft = planned(); draft.plan.value.candidates = draft.plan.value.candidates.slice(0, 1);
  assert.equal(validPlan(draft.plan.value), true);
  const prepared = preparePlannedSubmission(draft, records, () => uuid);
  const store = storage(); await saveDraft(store, "owner", prepared);
  assert.deepEqual((await openDraft(store, "owner")).draft.submission, prepared.submission);
  const legacy = planned().plan.value;
  legacy.candidates.push({ ...legacy.candidates[0], id: "scene-legacy" });
  assert.equal(validPlan(legacy), true);
  assert.equal(validPlan({ ...legacy, candidates: [] }), false);
  assert.equal(validPlan({ ...legacy, candidates: [...legacy.candidates, { ...legacy.candidates[0], id: "scene-extra" }] }), false);
});

test("acknowledged planned Missions retain the selected scene and support for a new conversation", async () => {
  const before = planned({ ...emptyDraft(), selectedKeys: ["key-0", "key-4", "key-5"], difficulty: "guided", feedbackLevel: "detailed", supportLevel: "label_only" });
  const pending = preparePlannedSubmission(before, records, () => uuid);
  const acknowledged = acknowledgeSubmission(pending, uuid);
  assert.deepEqual(acknowledged, { ...pending, submission: undefined });
  assert.equal(currentCandidate(acknowledged, records).id, before.selectedCandidateId);
  const nextId = "b0000000-0000-4000-8000-000000000002";
  const next = preparePlannedSubmission(acknowledged, records, () => nextId);
  assert.deepEqual(next.submission.request, { ...pending.submission.request, client_id: nextId });
});

test("API honors explicit single-scene generation and rejects an unexpected candidate count", async t => {
  const draft = planned();
  const payload = { scenario_type: "workplace", brief: "", candidate_count: 1,
    targets: draft.plan.value.candidates[0].targets.map(({ corpus_item_id, role }) => ({ corpus_item_id, role })) };
  const api = createSpeakingApi("owner", async () => `header.${btoa(JSON.stringify({ sub: "owner" }))}.sig`);
  const single = { ...draft.plan.value, candidates: draft.plan.value.candidates.slice(0, 1) };
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(JSON.parse(init.body).candidate_count, 1);
    return new Response(JSON.stringify(single));
  });
  assert.equal((await api.plan(payload, new AbortController().signal)).candidates.length, 1);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(draft.plan.value)));
  await assert.rejects(api.plan(payload, new AbortController().signal), /did not match/);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(single)));
  await assert.rejects(api.plan({ ...payload, candidate_count: 2 }, new AbortController().signal), /did not match/);
});

test("support is independent of scene fit and only explicit changes replace the create snapshot", async () => {
  assert.equal(emptyDraft().supportLevel, "model_frame");
  const original = preparePlannedSubmission(planned(), records, () => uuid);
  assert.equal(original.submission.request.support_level, "model_frame");
  assert.equal(changeDraftSupport(original, "model_frame"), original, "unchanged settings retain uncertain requests");
  const changed = changeDraftSupport(original, "no_hint");
  assert.equal(changed.plan, original.plan, "a different support level reuses the already generated plan");
  assert.equal(changed.selectedCandidateId, original.selectedCandidateId);
  assert.equal(changed.submission, undefined);
  assert.equal(missionInputSignature(changed, records), missionInputSignature(original, records));
  assert.notEqual(draftSignature(changed), draftSignature(original));
  assert.equal(currentCandidate(changed, records).id, "scene-0");
  const prepared = preparePlannedSubmission(changed, records, () => "a0000000-0000-4000-8000-000000000002");
  assert.equal(prepared.submission.request.support_level, "no_hint");
  assert.equal(prepared.submission.request.plan_id, original.submission.request.plan_id);
  const store = storage(); await saveDraft(store, "owner", prepared);
  assert.equal((await openDraft(store, "owner")).draft.supportLevel, "no_hint");
});

test("old support-free drafts keep their exact signature and uncertain request through reload", async () => {
  const legacy = { scenarioType: "workplace", goal: "Original goal", difficulty: "standard", feedbackLevel: "balanced", logicTemplateId: null, selectedKeys: ["key-4"] };
  const originalSignature = JSON.stringify(["workplace", "Original goal", "standard", "balanced", null, ["key-4"]]);
  assert.equal(draftSignature(legacy), originalSignature);
  const prepared = prepareSubmission(legacy, records, () => uuid);
  assert.equal(Object.hasOwn(prepared.submission.request, "support_level"), false);
  const store = storage(); await saveDraft(store, "owner", prepared);
  const restored = (await openDraft(store, "owner")).draft;
  assert.equal(restored.supportLevel, undefined, "reload does not silently adopt the new default");
  assert.equal(restored.submission.signature, originalSignature);
  assert.deepEqual(preparePlannedSubmission(restored, [], () => assert.fail("must replay")).submission.request, prepared.submission.request);
});

test("new missions share five target slots across kinds, with explicit primary and opportunity roles", () => {
  let draft = emptyDraft();
  for (const record of [...records.slice(0, 3), ...records.slice(4), records[3]]) draft = toggleMissionSelection(draft, record);
  assert.equal(draft.selectedKeys.length, 5);
  assert.deepEqual(draft.selectedKeys.map(key => targetRole(draft, key)), ["primary", "primary", "opportunity", "opportunity", "primary"]);
  assert.equal(missionSelectionError(draft, records, true), null, "three structures and two chunks fit the shared target budget");
  assert.match(missionSelectionError({ ...draft, targetRoles: Object.fromEntries(draft.selectedKeys.map(key => [key, "opportunity"])) }, records, true), /1–3 primary/);
  assert.match(missionPlanError(draft, records), /Generate matching scenes/);
});

test("more than three structures stays preserved but blocks generation before a paid request", () => {
  const draft = { ...emptyDraft(), selectedKeys: records.slice(0, 4).map(record => record.key) };
  assert.match(missionSelectionError(draft, records, true), /up to 3 structures/);
  assert.equal(draft.selectedKeys.length, 4);
});

test("automatic choice reuses a suitable explicit scene then ranks high primary fits stably", () => {
  const draft = planned();
  draft.plan.value.candidates[0].targets[0].fit = "medium";
  assert.equal(automaticCandidate(draft, records).id, "scene-0", "a suitable manual choice wins over ranking");
  draft.selectedCandidateId = undefined;
  assert.equal(automaticCandidate(draft, records).id, "scene-1", "most high primary fits wins");
  draft.plan.value.candidates[0].targets[0].fit = "high";
  draft.plan.value.candidates[1].targets[2].fit = "unknown";
  assert.equal(automaticCandidate(draft, records).id, "scene-0", "opportunity fit does not change the stable primary ranking");
  for (const candidate of draft.plan.value.candidates) candidate.targets[0].fit = "low";
  assert.equal(automaticCandidate(draft, records), undefined);
  draft.plan.value.candidates[1].targets[0].fit = "high";
  draft.plan.value.candidates[1].targets.reverse();
  assert.equal(automaticCandidate(draft, records), undefined, "mismatched order cannot be selected");
  assert.equal(automaticCandidate({ ...planned(), goal: "Changed input" }, records), undefined);
});

test("fit advice explains a single scene, with explicit choice then fewest gaps and most high fits", () => {
  const draft = planned({ ...emptyDraft(), selectedKeys: ["key-4", "key-5", "key-6"], targetRoles: { "key-4": "primary", "key-5": "primary", "key-6": "primary" } });
  const [first, second] = draft.plan.value.candidates;
  first.targets[0].fit = "low"; first.targets[0].fit_reason = "Only Scene 0 asks for a ceremonial greeting.";
  first.targets[1].fit = "unknown"; first.targets[1].fit_reason = "Only Scene 0 lacks a clear decision.";
  second.targets[2].fit = "unknown"; second.targets[2].fit_reason = "Only Scene 1 has an uncertain transition.";
  assert.equal(sceneFitAdvice(draft, records).candidate.id, first.id, "explicit selection takes precedence");
  assert.deepEqual(sceneFitAdvice(draft, records).targets.map(target => target.reason), [first.targets[0].fit_reason, first.targets[1].fit_reason]);
  draft.selectedCandidateId = undefined;
  let advice = sceneFitAdvice(draft, records);
  assert.equal(advice.candidate.id, second.id, "fewest unsuitable primaries wins");
  assert.deepEqual(advice.targets, [{ key: "key-6", text: "target-6", fit: "unknown", reason: second.targets[2].fit_reason }]);
  first.targets[1].fit = "medium";
  assert.equal(sceneFitAdvice(draft, records).candidate.id, second.id, "high fits break equal gap counts");
  first.targets[1].fit = "high";
  assert.equal(sceneFitAdvice(draft, records).candidate.id, first.id, "equal counts keep stable candidate order");
  assert.equal(sceneFitAdvice({ ...draft, goal: "Changed preference" }, records), undefined, "stale plans cannot diagnose targets");
  for (const candidate of draft.plan.value.candidates) candidate.targets.reverse();
  assert.equal(sceneFitAdvice(draft, records), undefined, "unverified target order cannot supply advice");
});

test("opportunity gaps never become primary fit advice", () => {
  const draft = planned();
  for (const candidate of draft.plan.value.candidates) candidate.targets[2].fit = "unknown";
  assert.equal(sceneFitAdvice(draft, records), undefined);
  assert.ok(automaticCandidate(draft, records));
});

test("explicit fit adjustments preserve other selections and invalidate the prepared scene", () => {
  const original = planned();
  const demoted = adjustSceneTarget(original, "key-0", "opportunity");
  assert.deepEqual(demoted.selectedKeys, original.selectedKeys);
  assert.deepEqual(demoted.selectedKeys.map(key => targetRole(demoted, key)), ["opportunity", "primary", "opportunity"]);
  assert.equal(demoted.plan, undefined);
  assert.equal(demoted.selectedCandidateId, undefined);
  assert.equal(demoted.submission, undefined);
  assert.ok(original.plan, "the source draft is unchanged");
  const removed = adjustSceneTarget(original, "key-0", "remove");
  assert.deepEqual(removed.selectedKeys, ["key-4", "key-5"]);
  assert.deepEqual(removed.selectedKeys.map(key => targetRole(removed, key)), ["primary", "opportunity"], "removing one must not silently reassign the remaining opportunity");
  assert.equal(removed.plan, undefined);
  assert.equal(missionSelectionError(removed, records, true), null, "one primary remains a valid recommendation");
});

test("adjustments never swap full opportunity slots, remove the last primary, or replace uncertain create", () => {
  const full = planned({ ...emptyDraft(), selectedKeys: ["key-0", "key-4", "key-5", "key-6"] });
  assert.match(sceneAdjustmentError(full, "key-0", "opportunity"), /already have two opportunity/);
  assert.equal(adjustSceneTarget(full, "key-0", "opportunity"), full);
  assert.deepEqual(adjustSceneTarget(full, "key-0", "remove").selectedKeys, ["key-4", "key-5", "key-6"], "explicit removal stays available");
  const single = planned({ ...emptyDraft(), selectedKeys: ["key-4"] });
  for (const action of ["opportunity", "remove"]) {
    assert.match(sceneAdjustmentError(single, "key-4", action), /at least one primary/);
    assert.equal(adjustSceneTarget(single, "key-4", action), single);
  }
  const pending = preparePlannedSubmission(planned(), records, () => uuid);
  assert.match(sceneAdjustmentError(pending, "key-0", "remove"), /Recover the pending mission/);
  assert.equal(adjustSceneTarget(pending, "key-0", "remove"), pending);
  assert.equal(pending.submission.request.client_id, uuid);
});

test("async draft persistence checks the stored draft under the lock including another tab's retry ID", async () => {
  const store = storage(); const original = planned();
  await saveDraft(store, "owner", original);
  const generated = { ...original, selectedCandidateId: "scene-1" };
  await assert.rejects(saveDraft(store, "owner", generated, { expectedDraft: original, lock: async operation => {
    await saveDraft(store, "owner", { ...original, goal: "Edited elsewhere" });
    return operation();
  } }), DraftConflictError);
  assert.equal((await openDraft(store, "owner")).draft.goal, "Edited elsewhere");
  await saveDraft(store, "owner", original);
  const uncertain = preparePlannedSubmission(original, records, () => uuid);
  await assert.rejects(saveDraft(store, "owner", generated, { expectedDraft: original, lock: async operation => {
    await saveDraft(store, "owner", uncertain);
    return operation();
  } }), DraftConflictError);
  assert.equal((await openDraft(store, "owner")).draft.submission.request.client_id, uuid);
  assert.equal(await saveDraft(store, "owner", uncertain, { expectedDraft: uncertain }), true);
});

test("legacy eight-item drafts retain every item and require explicit target adjustment", async () => {
  const store = storage();
  const legacy = { ...emptyDraft(), selectedKeys: records.map(record => record.key) };
  await saveDraft(store, "owner", legacy);
  const recovered = (await openDraft(store, "owner")).draft;
  assert.deepEqual(recovered.selectedKeys, legacy.selectedKeys);
  assert.match(missionSelectionError(recovered, records, true), /previous selections are kept/);
});

test("a chosen scene freezes exact plan, goal, order and role contract and survives reload", async () => {
  const draft = planned();
  assert.equal(missionPlanError(draft, records), null, "no user brief is required");
  const prepared = preparePlannedSubmission(draft, records, () => uuid);
  assert.equal(prepared.submission.request.goal, "Agree on the next step");
  assert.equal(prepared.submission.request.plan_id, "plan-a");
  assert.equal(prepared.submission.request.candidate_id, "scene-0");
  assert.deepEqual(prepared.submission.request.corpus_item_ids, ["corpus-0", "corpus-4", "corpus-5"]);
  const store = storage(); await saveDraft(store, "owner", prepared);
  const recovered = (await openDraft(store, "owner")).draft;
  assert.equal(currentCandidate(recovered, records).id, "scene-0");
  assert.deepEqual(preparePlannedSubmission(recovered, [], () => { throw Error("must replay"); }).submission.request, prepared.submission.request);
});

test("changing inputs, role, source identity or candidate order invalidates a scene", () => {
  const draft = planned();
  for (const changed of [{ ...draft, goal: "New preference" }, { ...draft, scenarioType: "everyday" }, { ...draft, targetRoles: { "key-0": "opportunity" } }]) {
    assert.equal(currentCandidate(changed, records), undefined);
    assert.throws(() => preparePlannedSubmission(changed, records, () => uuid), /Generate matching scenes/);
  }
  assert.equal(currentCandidate(draft, records.map(record => ({ ...record, serverId: `${record.serverId}-replaced` }))), undefined);
  const reversed = structuredClone(draft); reversed.plan.value.candidates[0].targets.reverse();
  assert.throws(() => preparePlannedSubmission(reversed, records, () => uuid), /no longer matches/);
  assert.equal(toggleMissionSelection(draft, records[0]).plan, undefined);
});

test("low or unknown primary fit blocks start; an opportunity target can remain uncertain", () => {
  for (const fit of ["low", "unknown"]) {
    const draft = planned(); draft.plan.value.candidates[0].targets[0].fit = fit;
    assert.match(missionPlanError(draft, records), /does not yet fit every primary/);
  }
  const draft = planned(); draft.plan.value.candidates[0].targets[2].fit = "unknown";
  assert.equal(missionPlanError(draft, records), null);
});

test("legacy uncertain session requests can still replay without a generated plan", async () => {
  const old = prepareSubmission({ ...emptyDraft(), goal: "Original goal", selectedKeys: ["key-4"] }, records, () => uuid);
  const store = storage(); await saveDraft(store, "owner", old);
  const recovered = (await openDraft(store, "owner")).draft;
  assert.deepEqual(preparePlannedSubmission(recovered, [], () => { throw Error("must replay"); }).submission.request, old.submission.request);
});

test("plan API rejects mismatched or malformed model results without returning fabricated scenes", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const draft = planned();
  const payload = { scenario_type: "workplace", brief: "", targets: draft.plan.value.candidates[0].targets.map(({ corpus_item_id, role }) => ({ corpus_item_id, role })) };
  const api = createSpeakingApi("owner", async () => `header.${btoa(JSON.stringify({ sub: "owner" }))}.sig`);
  globalThis.fetch = async () => new Response(JSON.stringify(draft.plan.value), { status: 200 });
  assert.equal((await api.plan(payload, new AbortController().signal)).id, "plan-a");
  const wrong = structuredClone(draft.plan.value); wrong.candidates[0].targets[0].corpus_item_id = "another-item";
  globalThis.fetch = async () => new Response(JSON.stringify(wrong), { status: 200 });
  await assert.rejects(api.plan(payload, new AbortController().signal), /did not match your targets/);
  globalThis.fetch = async () => new Response(JSON.stringify({ ...draft.plan.value, candidates: [] }), { status: 200 });
  await assert.rejects(api.plan(payload, new AbortController().signal), /did not match your targets/);
});

test("scene planning has a bounded two-minute request window while saving keeps twenty seconds", async t => {
  const timeouts = [];
  t.mock.method(AbortSignal, "timeout", milliseconds => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  });
  const draft = planned();
  const plan = draft.plan.value;
  const payload = { scenario_type: draft.scenarioType, brief: draft.goal.trim(),
    targets: plan.candidates[0].targets.map(({ corpus_item_id, role }) => ({ corpus_item_id, role })) };
  const parentId = "a0000000-0000-4000-8000-000000000003";
  const practicePlan = { ...plan, practice_source: { parent_session_id: parentId,
    root_session_id: parentId, variation: "details", parent_snapshot_hash: "a".repeat(64) } };
  t.mock.method(globalThis, "fetch", async url => new Response(JSON.stringify(
    String(url).endsWith("/practice-plans") ? practicePlan
      : String(url).endsWith("/plans") ? plan : { id: uuid, client_id: uuid, user_id: "owner" }
  ), { status: 201 }));
  const api = createSpeakingApi("owner", async () => `header.${btoa(JSON.stringify({ sub: "owner" }))}.sig`);
  const signal = new AbortController().signal;
  await api.plan(payload, signal);
  await api.practicePlan(parentId, "details", signal);
  await api.create(preparePlannedSubmission(draft, records, () => uuid).submission.request, signal);
  assert.deepEqual(timeouts, [120_000, 120_000, 20_000]);
});

test("the longer planning window still aborts immediately when its caller cancels", async t => {
  t.mock.method(AbortSignal, "timeout", () => new AbortController().signal);
  const api = createSpeakingApi("owner", async () => `header.${btoa(JSON.stringify({ sub: "owner" }))}.sig`);
  const draft = planned();
  const payload = { scenario_type: draft.scenarioType, brief: draft.goal.trim(),
    targets: draft.plan.value.candidates[0].targets.map(({ corpus_item_id, role }) => ({ corpus_item_id, role })) };
  for (const request of [signal => api.plan(payload, signal), signal => api.practicePlan(uuid, "details", signal)]) {
    const controller = new AbortController();
    const reason = new DOMException("The account changed.", "AbortError");
    t.mock.method(globalThis, "fetch", (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      controller.abort(reason);
    }));
    await assert.rejects(request(controller.signal), error => error === reason);
  }
});

test("plan API normalizes invalid JSON, null and scalar results into a recoverable system error", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const api = createSpeakingApi("owner", async () => `header.${btoa(JSON.stringify({ sub: "owner" }))}.sig`);
  const payload = { scenario_type: "workplace", brief: "", targets: [{ corpus_item_id: "corpus-4", role: "primary" }] };
  const blankReason = planned(); blankReason.plan.value.candidates[0].targets[0].fit_reason = "  ";
  for (const body of ["{", "null", "42", "\"untrusted\"", "[]", JSON.stringify(blankReason.plan.value), JSON.stringify({ ...planned().plan.value, candidates: [null, {}] })]) {
    globalThis.fetch = async () => new Response(body, { status: 200 });
    await assert.rejects(api.plan(payload, new AbortController().signal), error => {
      assert.ok(error instanceof SpeakingApiError);
      assert.equal(error.status, 502);
      assert.ok(["invalid_output", "invalid_output_schema"].includes(error.code));
      assert.equal(missionProblem(error, "preparing").kind, "system", "invalid output must never imply a poor learner selection");
      return true;
    });
  }
});

test("planning errors allowlist diagnostics while safely handling missing or forged headers", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const api = createSpeakingApi("owner", async () => `header.${btoa(JSON.stringify({ sub: "owner" }))}.sig`);
  const payload = { scenario_type: "workplace", brief: "", targets: [{ corpus_item_id: "corpus-4", role: "primary" }] };
  const requestId = "0123456789abcdef0123456789abcdef";
  for (const [code, id, expectedCode, expectedId] of [
    ["invalid_output_schema", requestId, "invalid_output_schema", requestId],
    ["persistence_unavailable", requestId, "persistence_unavailable", requestId],
    ["learner_chose_wrong_words", "not-a-request-id", null, null],
    [null, null, null, null]
  ]) {
    const headers = {};
    if (code) headers["X-Speaking-Plan-Error"] = code;
    if (id) headers["X-Speaking-Plan-Request-ID"] = id;
    globalThis.fetch = async () => new Response(JSON.stringify({ detail: "Planning service is temporarily unavailable." }), { status: 503, headers });
    await assert.rejects(api.plan(payload, new AbortController().signal), error => {
      assert.equal(error.code, expectedCode); assert.equal(error.requestId, expectedId);
      const problem = missionProblem(error, "preparing");
      assert.equal(problem.kind, "system");
      assert.match(problem.message, /not evidence that you chose the wrong targets/);
      return true;
    });
  }
});

test("network and saving failures remain distinct from fit advice and actionable input errors", () => {
  for (const error of [new SpeakingApiError("Offline", 0), new SpeakingApiError("Rate limited", 429), new SpeakingApiError("Provider failed", 503, "provider_failure")]) {
    assert.equal(missionProblem(error, "preparing").kind, "system");
  }
  const saving = missionProblem(new SpeakingApiError("Storage unavailable", 503), "saving");
  assert.equal(saving.phase, "saving");
  assert.equal(saving.title, "Saving is temporarily unavailable");
  assert.equal(missionProblem(new SpeakingApiError("Selected item was removed", 404), "preparing").kind, "other");
  assert.equal(missionProblem(new SpeakingApiError("Sign in again", 401), "preparing").kind, "other");
  assert.equal(missionProblem(new Error("Draft changed in another tab"), "preparing").kind, "other");
});
