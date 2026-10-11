import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { learningHref, parseLearningLocation, searchParamsFromRecord } from "../features/navigation/learning-location.ts";
import { missionHref, readReturnPath, safeAuthReturnPath, safeReturnPath } from "../features/navigation/return-location.ts";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/learning-locations.json", import.meta.url)));
for (const fixture of fixtures) test(`canonical route: ${fixture.name}`, () => {
  const result = parseLearningLocation(new URL(fixture.href, "https://libitu.test"));
  assert.equal(result.kind, fixture.kind);
  for (const key of ["contentId", "jobId", "sourceUrl", "learnerLevel"]) if (fixture[key]) assert.equal(result.source[key], fixture[key]);
  for (const key of ["segmentId", "sentenceId"]) if (fixture[key]) assert.equal(result[key], fixture[key]);
});

test("server search parameters preserve duplicates for validation", () => {
  const params = { contentId: ["first", "second"], learnerLevel: "B2", ignored: undefined };
  assert.deepEqual(searchParamsFromRecord(params).getAll("contentId"), ["first", "second"]);
  assert.equal(parseLearningLocation(new URL(`/practice/a0000000-0000-4000-8000-000000000001/shadow?segmentId=first&segmentId=second`, "https://libitu.test")).kind, "invalid");
  assert.equal(parseLearningLocation({ contentId: "c" }).kind, "landing");
});

const source = { contentId: "a0000000-0000-4000-8000-000000000001", sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk", title: "A useful video", learnerLevel: "B2" };
const location = learningHref(source, { segmentId: "seg-1", sentenceId: "sentence-v1:8" }, "#sound");
test("a learning link round trips with source, level, selection and hash", () => {
  const parsed = parseLearningLocation(new URL(location, "https://libitu.test"));
  assert.equal(parsed.kind, "shadow");
  assert.deepEqual(parsed.source, { contentId: source.contentId, learnerLevel: source.learnerLevel });
  assert.equal(safeReturnPath(location), location);
});

test("transient inputs are not propagated as mission origins", () => {
  const withInputs = `${location.split("#")[0]}&jobId=job-1&handoffId=handoff-1&transcriptText=private#sound`;
  assert.equal(safeReturnPath(withInputs), "/");
  assert.equal(safeReturnPath("/corpus?kind=chunk&transcriptText=private&handoffId=h&jobId=j#saved"), "/corpus?kind=chunk#saved");
  for (const input of ["/?jobId=job-1", "/?handoffId=handoff-1", "/?sourceUrl=https%3A%2F%2Fyoutu.be%2Fabcdefghijk&handoffId=h"]) assert.equal(safeReturnPath(input), "/");
});

test("origin and auth return policies are distinct", () => {
  const report = missionHref("analytics", location, "session-1");
  assert.equal(safeReturnPath(report), "/");
  assert.equal(safeAuthReturnPath(report + "#evidence"), report + "#evidence");
  const authSource = location + "-details";
  assert.equal(safeAuthReturnPath(authSource), authSource);
  assert.equal(safeReturnPath("/profile/history?kind=shadowing"), "/profile/history?kind=shadowing");
});

test("return targets reject external, encoded, unknown and recursive destinations", () => {
  for (const value of ["https://evil.test", "//evil.test", "/\\evil.test", "/%5cevil.test", "/%2fevil.test", "/%252fevil.test", "/%0aevil.test", "/unknown", "/api/jobs", "/speaking/id/unknown", "/profile\n"]) {
    assert.equal(safeReturnPath(value), "/", value);
    assert.equal(safeAuthReturnPath(value), "/", value);
  }
  assert.equal(safeReturnPath("/profile?returnTo=%2Fcorpus"), "/");
  assert.equal(readReturnPath({ returnTo: ["/corpus", "/profile"] }), "/");
});

test("mission, report, review, retry and adjustment carry one flat origin", () => {
  let href = missionHref("loadout", location);
  for (const target of ["session", "analytics", "session", "session", "loadout"]) {
    const params = new URL(href, "https://libitu.test").searchParams;
    href = missionHref(target, params.get("returnTo"), "session-1");
    assert.equal(new URL(href, "https://libitu.test").searchParams.get("returnTo"), location);
  }
  const adjusted = new URL(missionHref("loadout", location, undefined, { reportImport: "saved", replaceMissing: true }), "https://libitu.test");
  assert.equal(adjusted.searchParams.get("reportImport"), "saved");
  assert.equal(adjusted.searchParams.get("replaceMissing"), "1");
  assert.equal(adjusted.searchParams.get("returnTo"), location);
  assert.equal(missionHref("session", "https://evil.test", "session-1"), "/speaking/session-1");
  assert.throws(() => missionHref("session", "/corpus"), /session ID/);
});

const identities = JSON.parse(readFileSync(new URL("../../../packages/types/fixtures/workspace-identity.json", import.meta.url)));
for (const row of identities.filter(row => row.contentId)) test(`shared Web/extension scope: ${row.name}`, () => {
  const location = parseLearningLocation(new URL(row.url));
  assert.equal(location.source.contentId, row.contentId);
});
