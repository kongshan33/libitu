import assert from "node:assert/strict";
import { test } from "node:test";
import { readProfileResource, ProfileApiError } from "../features/profile/api.ts";
import { historyAction, historyHref, profileSourceHref } from "../features/profile/format.ts";

const token = (owner) => `fixture.${btoa(JSON.stringify({ sub: owner }))}.fixture`;

test("profile never fetches private records with another account's token", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected fetch"); });
  await assert.rejects(readProfileResource("", "account-a", async () => token("account-b"), new AbortController().signal),
    (error) => error instanceof ProfileApiError && error.status === 401);
  assert.equal(fetch.mock.callCount(), 0);
});

test("unmount or account switch while token is pending cancels profile fetch", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected fetch"); });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const controller = new AbortController();
  const result = readProfileResource("", "account-a", () => pending, controller.signal);
  controller.abort(); release(token("account-a"));
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 0);
});

test("profile uses no-store and sanitizes persistence failures", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("private upstream diagnostics", { status: 503 }));
  await assert.rejects(readProfileResource("?range=4w", "account-a", async () => token("account-a"), new AbortController().signal),
    (error) => error instanceof ProfileApiError && error.status === 503 && !error.message.includes("diagnostics"));
  assert.equal(fetch.mock.calls[0].arguments[1].cache, "no-store");
  assert.equal(fetch.mock.calls[0].arguments[1].headers.Authorization, `Bearer ${token("account-a")}`);
});

test("history retains a canonical source for old blueprints and never navigates to an arbitrary host", () => {
  const href = profileSourceHref("a0000000-0000-4000-8000-000000000001", "https://untrusted.example/watch?v=abcdef12345");
  assert.equal(href, "/practice/a0000000-0000-4000-8000-000000000001");
  assert.equal(profileSourceHref("invalid-id", "https://youtu.be/abcdef12345"), null);
  assert.equal(historyHref({ kind: "shadowing", content_id: "a0000000-0000-4000-8000-000000000001", source_url: null }), href);
  assert.equal(historyHref({ kind: "speaking", session_id: "session-1" }), "/speaking/session-1?returnTo=%2Fprofile");
});

test("completed Missions open Stage 5 while active conversations remain resumable", () => {
  const item = { kind: "speaking", session_id: "session-1", status: "completed", feedback: null };
  assert.equal(historyHref(item), "/speaking/session-1/analytics");
  assert.equal(historyAction(item), "View report");
  for (const [status, label] of [["queued", "Report queued"], ["processing", "Report in progress"], ["failed", "Report needs retry"], ["insufficient_data", "Limited evidence"]]) {
    assert.equal(historyAction({ ...item, feedback: { id: "report-1", status, available: false, unavailable_reason: null } }), label);
  }
  assert.equal(historyAction({ ...item, feedback: { id: "report-1", status: "partial", available: true, unavailable_reason: null } }), "Partial report");
  assert.equal(historyAction({ ...item, feedback: { id: "report-1", status: "ready", available: false, unavailable_reason: "version_mismatch" } }), "View earlier report");
  const legacy = { ...item, feedback: { id: "report-1", status: "ready", available: false, unavailable_reason: "legacy_report" } };
  assert.equal(historyAction(legacy), "View conversation");
  assert.equal(historyHref(legacy), "/speaking/session-1?returnTo=%2Fprofile");
  assert.equal(historyHref({ ...legacy, feedback: { ...legacy.feedback, unavailable_reason: "version_mismatch" } }), "/speaking/session-1/analytics");
  assert.equal(historyHref({ ...item, status: "active" }), "/speaking/session-1?returnTo=%2Fprofile");
});

test("original video links always open Stage 1 without restoring Shadow selection", () => {
  const item = { kind: "video", content_id: "a0000000-0000-4000-8000-000000000001", source_url: "https://untrusted.example", status: "opened" };
  assert.equal(historyHref(item), "/practice/a0000000-0000-4000-8000-000000000001");
  assert.equal(historyAction(item), "Open Stage 1");
  assert.equal(historyHref({ ...item, content_id: "../bad" }), null);
});

test("recording a video authenticates its owner and accepts a no-content acknowledgement", async (t) => {
  const { rememberProfileVideo } = await import("../features/profile/api.ts");
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  await assert.rejects(rememberProfileVideo("video-id", "a", async () => token("b"), new AbortController().signal));
  assert.equal(fetch.mock.callCount(), 0);
  await rememberProfileVideo("video-id", "a", async () => token("a"), new AbortController().signal);
  assert.equal(fetch.mock.calls[0].arguments[1].method, "PUT");
  assert.match(fetch.mock.calls[0].arguments[0], /\/profile\/videos\/video-id$/);
});
