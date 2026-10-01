import assert from "node:assert/strict";
import test from "node:test";
import { adoptDeviceDraft, draftSignature, emptyDraft, LOADOUT_STORAGE_KEY, openDraft, prepareSubmission, readDraftEnvelope, resolveSelection, saveDraft, selectionError, toggleSelection } from "../features/loadout/draft.ts";
import { safeReturnPath } from "../features/loadout/navigation.ts";
import { createSpeakingApi, getSpeakingOptions, SpeakingApiError } from "../features/loadout/api/speaking-api.ts";

const uuid = "a0000000-0000-4000-8000-000000000001";
function storage() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
function record(key, kind = "chunk", serverId = `server-${key}`) {
  return { key, serverId, item: { id: `blueprint-${key}`, kind, text: key, tags: [], meta: "Saved" }, sourceUrl: `https://example.com/${key}`, sourceTitle: key };
}
function goalDraft(goal = "Agree on a project deadline") { return { ...emptyDraft(), goal }; }
function token(owner) { return `e30.${btoa(JSON.stringify({ sub: owner }))}.signature`; }

test("chunks and idioms share five slots; structures have three independent slots", () => {
  const expressions = Array.from({ length: 6 }, (_, index) => record(`expression-${index}`, index % 2 ? "idiom" : "chunk"));
  const structures = Array.from({ length: 4 }, (_, index) => record(`structure-${index}`, "structure"));
  const records = [...expressions, ...structures];
  let draft = goalDraft();
  for (const item of records) draft = toggleSelection(draft, item, records);
  assert.deepEqual(draft.selectedKeys, [...expressions.slice(0, 5), ...structures.slice(0, 3)].map((item) => item.key));
  assert.equal(resolveSelection(draft, records).expressions.length, 5);
  assert.equal(resolveSelection(draft, records).structures.length, 3);
  draft = toggleSelection(draft, expressions[2], records);
  draft = toggleSelection(draft, expressions[5], records);
  assert.equal(draft.selectedKeys.at(-1), expressions[5].key);
  assert.equal(new Set(draft.selectedKeys).size, 8);
});

test("one item and no logic are valid; missing, unsynced, duplicate and changed-kind items block new creates", () => {
  const row = record("saved");
  const draft = { ...goalDraft(), selectedKeys: [row.key] };
  assert.equal(selectionError(draft, [row], true), null);
  assert.match(selectionError(goalDraft(), [row], true), /at least one/);
  assert.match(selectionError(draft, [], true), /no longer/);
  assert.match(selectionError(draft, [{ ...row, serverId: undefined }], true), /waiting to sync/);
  assert.equal(selectionError(draft, [{ ...row, serverId: undefined }], false), null);
  assert.match(selectionError({ ...draft, selectedKeys: [row.key, "duplicate"] }, [row, record("duplicate", "chunk", row.serverId)], true), /twice/);
  const changed = Array.from({ length: 4 }, (_, index) => record(`changed-${index}`, "structure"));
  assert.match(selectionError({ ...draft, selectedKeys: changed.map((item) => item.key) }, changed, true), /up to 3/);
});

test("guest draft claims once, existing account draft wins, and explicit adoption retains owner isolation", async () => {
  const store = storage();
  await saveDraft(store, null, { ...goalDraft("Guest goal"), selectedKeys: ["guest-item"] });
  const first = await openDraft(store, "user-a");
  assert.equal(first.draft.goal, "Guest goal");
  assert.equal(readDraftEnvelope(store).guest, null);
  assert.equal((await openDraft(store, null)).draft.goal, "");
  assert.equal((await openDraft(store, "user-b")).draft.goal, "");
  await saveDraft(store, "user-a", goalDraft("Account goal"));
  await saveDraft(store, null, goalDraft("Another device goal"));
  const account = await openDraft(store, "user-a");
  assert.equal(account.draft.goal, "Account goal");
  assert.equal(account.deviceDrafts[0].goal, "Another device goal");
  assert.equal((await openDraft(store, "user-b")).deviceDrafts.length, 0);
  assert.equal((await adoptDeviceDraft(store, "user-a", 0)).draft.goal, "Another device goal");
  assert.equal((await openDraft(store, "user-a")).deviceDrafts.length, 0);
});

test("submission maps stable keys to account IDs in chosen order and replays an uncertain create after reload or corpus deletion", async () => {
  const rows = [record("first", "idiom"), record("second", "structure")];
  const store = storage();
  await openDraft(store, "user-a");
  const prepared = prepareSubmission({ ...goalDraft(), selectedKeys: ["second", "first"] }, rows, () => uuid);
  assert.deepEqual(prepared.submission.request.corpus_item_ids, ["server-second", "server-first"]);
  assert.equal(prepared.submission.request.logic_template_id, null);
  await saveDraft(store, "user-a", prepared);
  const recovered = (await openDraft(store, "user-a")).draft;
  assert.deepEqual(prepareSubmission(recovered, [], () => { throw new Error("must not allocate a new request"); }).submission.request, prepared.submission.request);
  const edited = toggleSelection(recovered, rows[0], rows);
  assert.equal(edited.submission, undefined);
  const next = prepareSubmission(edited, rows, () => "b0000000-0000-4000-8000-000000000002");
  assert.notEqual(next.submission.request.client_id, uuid);
});

test("corrupt or blocked browser storage is not silently overwritten", async () => {
  const store = storage();
  store.setItem(LOADOUT_STORAGE_KEY, '{"version":2}');
  await assert.rejects(openDraft(store, "user-a"), /not been overwritten/);
  assert.equal(store.getItem(LOADOUT_STORAGE_KEY), '{"version":2}');
  store.setItem(LOADOUT_STORAGE_KEY, "invalid JSON");
  await assert.rejects(openDraft(store, null), /not been overwritten/);
  assert.equal(store.getItem(LOADOUT_STORAGE_KEY), "invalid JSON");
  await assert.rejects(saveDraft({ getItem: () => null, setItem: () => { throw new Error("quota"); } }, null, goalDraft()), /quota/);
});

test("interleaved field edits, submission persistence, and guest adoption share the envelope lock", async () => {
  const store = storage();
  let busy = false;
  const queue = [];
  const lock = (operation) => new Promise((resolve, reject) => {
    queue.push(() => {
      busy = true;
      try { resolve(operation()); } catch (error) { reject(error); }
      finally { busy = false; queue.shift(); if (queue.length) queue[0](); }
    });
    if (!busy && queue.length === 1) queue[0]();
  });
  await openDraft(store, "user-a", true, { lock });
  await openDraft(store, "user-b", true, { lock });
  const prepared = prepareSubmission({ ...goalDraft("A submitted mission"), selectedKeys: ["saved"] }, [record("saved")], () => uuid);
  let secondWrite;
  let interleaved = false;
  const interleavingStorage = {
    getItem(key) {
      const staleRead = store.getItem(key);
      if (!interleaved) {
        interleaved = true;
        // Start another tab's complete mutation after A reads but before A writes.
        secondWrite = saveDraft(store, "user-a", prepared, { lock });
      }
      return staleRead;
    },
    setItem: store.setItem
  };
  await saveDraft(interleavingStorage, "user-b", goalDraft("B edited a field"), { lock });
  await secondWrite;
  assert.equal(readDraftEnvelope(store).accounts["user-b"].draft.goal, "B edited a field");
  assert.equal(readDraftEnvelope(store).accounts["user-a"].draft.submission.request.client_id, uuid);
  await saveDraft(store, null, goalDraft("Claimed device mission"), { lock });
  await openDraft(store, "user-b", true, { lock });
  interleaved = false;
  await adoptDeviceDraft(interleavingStorage, "user-b", 0, { lock });
  await secondWrite;
  const final = readDraftEnvelope(store);
  assert.equal(final.accounts["user-a"].draft.submission.request.client_id, uuid);
  assert.equal(final.accounts["user-b"].draft.goal, "Claimed device mission");
  assert.equal(final.accounts["user-b"].deviceDrafts.length, 0);
});

test("a queued obsolete owner mutation is fenced before touching local storage", async () => {
  const store = storage();
  let current = true;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const waiting = saveDraft(store, "user-a", goalDraft("Late private draft"), {
    lock: async (operation) => { await gate; return operation(); }, isCurrent: () => current
  });
  current = false;
  release();
  assert.equal(await waiting, false);
  assert.equal(store.getItem(LOADOUT_STORAGE_KEY), null);
});

test("adopting a stale device-draft position cannot select a different draft", async () => {
  const store = storage();
  await openDraft(store, "user-a");
  await saveDraft(store, null, goalDraft("First device draft"));
  await openDraft(store, "user-a");
  await saveDraft(store, null, goalDraft("Second device draft"));
  const shown = await openDraft(store, "user-a");
  const firstSignature = draftSignature(shown.deviceDrafts[0]);
  await adoptDeviceDraft(store, "user-a", 0, { expectedSignature: firstSignature });
  await assert.rejects(adoptDeviceDraft(store, "user-a", 0, { expectedSignature: firstSignature }), /changed in another tab/);
  const after = readDraftEnvelope(store).accounts["user-a"];
  assert.equal(after.draft.goal, "First device draft");
  assert.equal(after.deviceDrafts[0].goal, "Second device draft");
});

test("return paths retain source context and reject external or encoded redirect forms", () => {
  assert.equal(safeReturnPath("/?contentId=video&stage=2&sentenceId=s1#sound"), "/?contentId=video&stage=2&sentenceId=s1#sound");
  const source = "/?title=My%20Video&sourceUrl=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dexample#My%20section";
  assert.equal(safeReturnPath(source), source);
  for (const path of ["https://evil.test", "//evil.test", "/\\evil.test", "/%5Cevil.test", "/%2Fevil.test", "/%0aevil.test", "/loadout", "/speaking/id"]) assert.equal(safeReturnPath(path), "/");
});

test("public options need no token; private requests reject the wrong identity before fetch", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => { calls++; assert.equal(init.headers.Authorization, undefined); return Response.json({ logic_templates: [], max_structures: 3, max_expressions: 5, min_items: 1 }); };
  try {
    assert.equal((await getSpeakingOptions(new AbortController().signal)).min_items, 1);
    await assert.rejects(createSpeakingApi("user-a", async () => token("user-b")).read("mission", new AbortController().signal), /account changed/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test("account-switch cancellation rejects a late create response and never returns another owner's session", async () => {
  const original = globalThis.fetch;
  let resolve;
  globalThis.fetch = () => new Promise((done) => { resolve = done; });
  const controller = new AbortController();
  try {
    const pending = createSpeakingApi("user-a", async () => token("user-a")).create({ client_id: uuid }, controller.signal);
    await new Promise((done) => setImmediate(done));
    controller.abort();
    resolve(Response.json({ id: "mission", user_id: "user-a" }));
    await assert.rejects(pending, { name: "AbortError" });
    globalThis.fetch = async () => Response.json({ id: "mission", user_id: "user-b" });
    await assert.rejects(createSpeakingApi("user-a", async () => token("user-a")).read("mission", new AbortController().signal), /account changed/);
  } finally { globalThis.fetch = original; }
});

test("API errors preserve actionable status and do not expose structured server failures", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ detail: "Mission storage is temporarily unavailable." }, { status: 503 });
    await assert.rejects(createSpeakingApi("user-a", async () => token("user-a")).read("mission", new AbortController().signal), (error) => error instanceof SpeakingApiError && error.status === 503 && /temporarily unavailable/.test(error.message));
    globalThis.fetch = async () => Response.json({ detail: [{ secret: "internal failure" }] }, { status: 500 });
    await assert.rejects(createSpeakingApi("user-a", async () => token("user-a")).read("mission", new AbortController().signal), (error) => !error.message.includes("internal failure"));
  } finally { globalThis.fetch = original; }
});
