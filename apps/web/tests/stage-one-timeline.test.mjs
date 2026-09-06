import assert from "node:assert/strict";
import test from "node:test";

import { findCurrentTimedItem, parseTimestamp } from "../features/stage-one/timeline.ts";

test("timestamps map playback to the latest transcript or logic entry", () => {
  const first = { id: "logic-1" };
  const second = { id: "logic-2" };
  const timeline = [
    { item: first, seconds: parseTimestamp("0:05") },
    { item: second, seconds: parseTimestamp("0:12") }
  ];

  assert.equal(findCurrentTimedItem(timeline, 4), null);
  assert.equal(findCurrentTimedItem(timeline, 4, true), first);
  assert.equal(findCurrentTimedItem(timeline, 5), first);
  assert.equal(findCurrentTimedItem(timeline, 11.9), first);
  assert.equal(findCurrentTimedItem(timeline, 12), second);
  assert.equal(findCurrentTimedItem(timeline, 90), second);
});

test("untimed entries do not interrupt chronological matching", () => {
  const first = { id: "logic-1" };
  const untimed = { id: "logic-untimed" };
  const second = { id: "logic-2" };

  assert.equal(findCurrentTimedItem([
    { item: second, seconds: 8 },
    { item: untimed, seconds: null },
    { item: first, seconds: 1 }
  ], 8), second);
  assert.equal(parseTimestamp("1:02:03"), 3723);
  assert.equal(parseTimestamp("not-a-time"), null);
});
