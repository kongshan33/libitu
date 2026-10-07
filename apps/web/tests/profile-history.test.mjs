import assert from "node:assert/strict";
import { test } from "node:test";
import { groupHistory } from "../features/profile/history-groups.ts";

test("history groups use the viewer's calendar, not UTC dates", () => {
  const items = ["2026-10-02T16:01:00Z", "2026-10-02T15:59:00Z", "2026-10-01T23:59:00Z"].map((occurred_at, id) => ({ id, occurred_at }));
  const east = groupHistory(items, "Asia/Shanghai");
  assert.deepEqual(east.map((group) => group.items.map((item) => item.id)), [[0], [1, 2]]);
  assert.match(east[0].label, /Oct 3, 2026/);
  const west = groupHistory(items, "America/Los_Angeles");
  assert.deepEqual(west.map((group) => group.items.map((item) => item.id)), [[0, 1], [2]]);
});

test("repeated DST hour and appended pages stay in one date group", () => {
  const items = ["2026-11-01T06:30:00Z", "2026-11-01T05:30:00Z", "2026-11-01T04:00:00Z"].map((occurred_at, id) => ({ id, occurred_at }));
  assert.equal(groupHistory(items, "America/New_York").length, 1);
  assert.deepEqual(groupHistory([], "UTC"), []);
});
