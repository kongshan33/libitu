import assert from "node:assert/strict";
import test from "node:test";
import { finishMissionNavigation, prepareMissionNavigation, startMissionPhase } from "../features/speaking/mission-timing.ts";

const name = phase => `libitu:mission:${phase}`;
test("Mission measurements keep bounded phases and safe server diagnostics without source content", () => {
  const headers = new Headers({ "X-Request-ID": "a".repeat(32), "Server-Timing": "model_generation;dur=1400.25, model_repair;dur=350, total;dur=1810, source_text;dur=3, validation;dur=999999" });
  const finish = startMissionPhase("planning_request");
  finish("success", headers); finish("error");
  let entries = performance.getEntriesByName(name("planning_request"));
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].detail, { outcome: "success", request_id: "a".repeat(32), server_ms: { model_generation: 1400.25, model_repair: 350, total: 1810 } });
  startMissionPhase("planning_request")("error", new Headers({ "X-Request-ID": "untrusted-source-text", "Server-Timing": "total;dur=NaN, model_generation;dur=-4" }));
  entries = performance.getEntriesByName(name("planning_request"));
  assert.equal(entries.length, 1, "retries replace the previous phase measurement");
  assert.deepEqual(entries[0].detail, { outcome: "error" });
});

test("navigation timing requires the verified owner and Mission and can only finish once", () => {
  for (const phase of ["navigation_to_ready", "start_to_ready"]) performance.clearMeasures(name(phase));
  prepareMissionNavigation("owner", "mission", performance.now());
  finishMissionNavigation("other-owner", "mission");
  assert.equal(performance.getEntriesByName(name("start_to_ready")).length, 0);
  prepareMissionNavigation("owner", "mission", performance.now());
  finishMissionNavigation("owner", "other-mission");
  assert.equal(performance.getEntriesByName(name("start_to_ready")).length, 0);
  prepareMissionNavigation("owner", "mission", performance.now());
  finishMissionNavigation("owner", "mission");
  finishMissionNavigation("owner", "mission");
  for (const phase of ["navigation_to_ready", "start_to_ready"]) {
    const entries = performance.getEntriesByName(name(phase));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].detail, { outcome: "success" });
  }
});

test("telemetry cannot block product work if performance measurements are unavailable", t => {
  t.mock.method(performance, "measure", () => { throw new Error("unsupported"); });
  assert.doesNotThrow(() => startMissionPhase("create_request")("aborted"));
});
