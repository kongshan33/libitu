import assert from "node:assert/strict";
import test from "node:test";
import { CorpusStorage, CORPUS_STORAGE_KEY, savedCorpusKey } from "../features/stage-one/api/corpus-storage.ts";
import { createCorpusRemote } from "../features/stage-one/api/corpus-api.ts";

function fixture() {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  return { storage, open: () => new CorpusStorage(() => storage), envelope: () => JSON.parse(storage.getItem(CORPUS_STORAGE_KEY)) };
}
function record(text = "double down on") {
  const item = { id: text, kind: "idiom", text, meaning: "Increase commitment.", tags: ["idiom"], meta: "0:01 - B2", level: "B2", slots: {} };
  return { key: savedCorpusKey("video", item), item, sourceUrl: "https://www.youtube.com/watch?v=video", sourceTitle: "Video" };
}
function remote(initial = []) {
  const rows = new Map(initial.map((row) => [row.key, row]));
  let saves = 0;
  return {
    rows, get saves() { return saves; },
    list: async () => [...rows.values()],
    save: async (row) => {
      saves++;
      const saved = rows.get(row.key) ?? { ...row, serverId: `server-${rows.size}` };
      rows.set(row.key, saved);
      return saved;
    },
    remove: async (id) => { for (const [key, row] of rows) if (row.serverId === id) rows.delete(key); }
  };
}

test("guest saves survive reload and deletion persists", async () => {
  const f = fixture();
  const first = f.open();
  await first.open(null);
  assert.equal(await first.save(record()), true);
  const second = f.open();
  await second.open(null);
  assert.deepEqual(second.state.records, [record()]);
  assert.equal(await second.remove(record()), true);
  await first.open(null);
  assert.deepEqual(first.state.records, []);
});

test("login imports guests once, preserves cloud edits, and clears acknowledged outbox", async () => {
  const f = fixture();
  const store = f.open();
  await store.open(null);
  await store.save(record());
  await store.save(record("on the same page"));
  const cloud = remote([{ ...record(), item: { ...record().item, meaning: "User-edited meaning" }, serverId: "existing" }]);
  await store.open("user-a", cloud);
  assert.equal(cloud.saves, 1);
  assert.equal(store.state.records.length, 2);
  assert.equal(store.state.records[0].item.meaning, "User-edited meaning");
  assert.deepEqual(f.envelope(), { version: 1, guest: [], pending: { "user-a": [] } });
  await store.open("user-a", cloud);
  assert.equal(cloud.saves, 1);
});

test("partial imports retain unacknowledged items only and never import into another account", async () => {
  const f = fixture();
  const store = f.open();
  await store.open(null);
  await store.save(record());
  await store.save(record("on the same page"));
  const cloud = remote();
  await store.open("user-a", { ...cloud, save: async (row) => {
    if (row.key === record("on the same page").key) throw new Error("offline");
    return cloud.save(row);
  } });
  assert.equal(store.state.error, "offline");
  assert.equal(f.envelope().pending["user-a"].length, 1);
  await store.open(null);
  assert.deepEqual(store.state.records, []);
  const other = remote();
  await store.open("user-b", other);
  assert.equal(other.saves, 0);
  assert.deepEqual(store.state.records, []);
  await store.open("user-a", cloud);
  assert.equal(store.state.records.length, 2);
  assert.equal(f.envelope().pending["user-a"].length, 0);
});

test("late responses from a previous account cannot replace current records", async () => {
  const f = fixture();
  const store = f.open();
  let resolve;
  const delayed = new Promise((done) => { resolve = done; });
  const old = store.open("user-a", { ...remote(), list: () => delayed });
  await new Promise((done) => setImmediate(done));
  await store.open("user-b", remote());
  resolve([{ ...record(), serverId: "private-a" }]);
  await old;
  assert.equal(store.state.owner, "user-b");
  assert.deepEqual(store.state.records, []);
});

test("late save acknowledgement cannot leak into another account", async () => {
  const f = fixture();
  const store = f.open();
  let resolve;
  const delayed = new Promise((done) => { resolve = done; });
  await store.open("user-a", { ...remote(), save: () => delayed });
  const saving = store.save(record());
  await new Promise((done) => setImmediate(done));
  await store.open("user-b", remote());
  resolve({ ...record(), serverId: "private-a" });
  assert.equal(await saving, false);
  assert.deepEqual(store.state.records, []);
  assert.equal(f.envelope().pending["user-a"].length, 1);
});

test("failed local writes do not show a successful save", async () => {
  const f = fixture();
  const store = f.open();
  await store.open(null);
  f.storage.setItem = () => { throw new Error("Quota exceeded"); };
  assert.equal(await store.save(record()), false);
  assert.deepEqual(store.state.records, []);
  assert.equal(store.state.error, "Quota exceeded");
});

test("failed cloud save stays pending; uncertain committed saves can be deleted", async () => {
  const f = fixture();
  const store = f.open();
  const cloud = remote();
  await store.open("user-a", { ...cloud, save: async (row) => {
    await cloud.save(row);
    throw new Error("Network timeout");
  } });
  assert.equal(await store.save(record()), false);
  assert.equal(store.state.records.length, 1);
  assert.equal(f.envelope().pending["user-a"].length, 1);
  assert.equal(await store.remove(store.state.records[0]), true);
  assert.equal(cloud.rows.size, 0);
  assert.deepEqual(f.envelope().pending["user-a"], []);
});

test("failed remote deletion keeps the saved record visible", async () => {
  const f = fixture();
  const store = f.open();
  await store.open("user-a", { ...remote([{ ...record(), serverId: "saved" }]), remove: async () => { throw new Error("offline"); } });
  assert.equal(await store.remove(store.state.records[0]), false);
  assert.equal(store.state.records.length, 1);
});

test("corrupt local data is not overwritten", async () => {
  const f = fixture();
  f.storage.setItem(CORPUS_STORAGE_KEY, "broken");
  const store = f.open();
  await store.open("user-a", remote());
  assert.equal(store.state.ready, false);
  assert.ok(store.state.error);
  assert.equal(f.storage.getItem(CORPUS_STORAGE_KEY), "broken");
});

test("reopening an unchanged account does not trigger cross-tab storage write loops", async (t) => {
  const f = fixture();
  const writes = t.mock.method(f.storage, "setItem");
  const store = f.open();
  await store.open("user-a", remote());
  const count = writes.mock.callCount();
  await store.open("user-a", remote());
  assert.equal(writes.mock.callCount(), count);
});

test("authenticated API preserves learning metadata and uses the captured account token", async (t) => {
  const token = `header.${Buffer.from(JSON.stringify({ sub: "user-a" })).toString("base64url")}.signature`;
  const original = { ...record(), item: { ...record().item, sourceText: "doubled down on", register: "professional", slots: { OBJECT: "plan" } } };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(options);
    return new Response(JSON.stringify({ ...JSON.parse(options.body), id: "server-id" }), { status: 201 });
  });
  const api = createCorpusRemote("user-a", async () => token);
  const saved = await api.save(original, new AbortController().signal);
  assert.equal(requests[0].headers.Authorization, `Bearer ${token}`);
  assert.equal(saved.serverId, "server-id");
  assert.equal(saved.key, original.key);
  assert.equal(saved.item.sourceText, original.item.sourceText);
  assert.equal(saved.item.register, original.item.register);
  assert.deepEqual(saved.item.slots, original.item.slots);
  const switched = createCorpusRemote("user-b", async () => token);
  await assert.rejects(switched.list(new AbortController().signal), /Account changed/);
  assert.equal(requests.length, 1);
});
