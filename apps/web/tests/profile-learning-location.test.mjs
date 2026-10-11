import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceLearningVisit, canRememberLearningVisit, canonicalLearningSource,
  readLearningLocation, rememberLearningLocation, safeLearningHref
} from "../features/profile/learning-location.ts";
import { replaceStageTwoLocation, STAGE_TWO_LOCATION_CHANGED } from "../features/stage-two/location.ts";

const contentId = "a0000000-0000-4000-8000-000000000001";
const source = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const updatedAt = "2026-10-02T04:00:00.000Z";
const href = `/practice/${contentId}/shadow?segmentId=segment-1&sentenceId=sentence-2`;

function storage() {
  const data = new Map();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test("learning destinations retain exact Shadow selection but discard job, handoff, transcript and credentials", () => {
  const incoming = new URL(href, "https://libitu.test");
  for (const key of ["jobId", "handoffId", "transcriptText", "token", "redirect", "title", "autoplay"]) incoming.searchParams.set(key, "private-value");
  incoming.hash = "private-fragment";
  const safe = safeLearningHref(incoming.pathname + incoming.search + incoming.hash);
  assert.equal(safe, null);
  assert.equal(safeLearningHref(href), href);
  assert.equal(canonicalLearningSource("https://youtu.be/dQw4w9WgXcQ?token=private#fragment"), source);
  assert.equal(canonicalLearningSource("https://www.youtube.com/watch?v=abc123"), null);
});

test("learning destinations reject external routes, malformed identifiers and unsupported sources", () => {
  assert.equal(safeLearningHref(`/?contentId=${contentId}`), null, "a stored destination must preserve the actual video source");
  for (const value of ["https://evil.test/", "//evil.test/", "/\\evil.test/", "/profile?contentId=c", "/%2f?contentId=c", "/?contentId=", "/?contentId=a%0Ab", "/?contentId=" + "a".repeat(201), "/?contentId=c&stage=2", "/?contentId=c&stage=2&segmentId=s&sentenceId=%2Fbad", "/?contentId=c&stage=9", "/?contentId=c&sourceUrl=https://evil.test/watch?v=dQw4w9WgXcQ"]) {
    assert.equal(safeLearningHref(value), null, value);
  }
  assert.equal(canonicalLearningSource("https://user:secret@www.youtube.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(canonicalLearningSource("https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ"), null);
});

test("last learning location is isolated per account and safely optional when storage is unavailable", () => {
  const local = storage();
  assert.equal(rememberLearningLocation("user_a", { href, title: "Actual source", updatedAt }, local), true);
  assert.deepEqual(readLearningLocation("user_a", local), { href, title: "Actual source", updatedAt });
  assert.equal(readLearningLocation("user_b", local), null);
  assert.equal(readLearningLocation(null, local), null);
  assert.equal(rememberLearningLocation("", { href, title: "Source", updatedAt }, local), false);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } };
  assert.equal(readLearningLocation("user_a", blocked), null);
  assert.equal(rememberLearningLocation("user_a", { href, title: "Source", updatedAt }, blocked), false);
  local.setItem("libitu:learning-location:v2:user_b", local.getItem("libitu:learning-location:v2:user_a"));
  assert.equal(readLearningLocation("user_b", local), null);
  local.setItem("libitu:learning-location:v2:user_a", "{broken");
  assert.equal(readLearningLocation("user_a", local), null);
});

test("account changes cannot adopt a mounted source, while a new source starts a new visit", () => {
  const initial = advanceLearningVisit(null, "user_a", "source-a");
  assert.equal(canRememberLearningVisit(initial), true);
  const switched = advanceLearningVisit(initial, "user_b", "source-a");
  assert.equal(canRememberLearningVisit(switched), false);
  assert.equal(canRememberLearningVisit(advanceLearningVisit(switched, "user_b", "source-a")), false);
  assert.equal(canRememberLearningVisit(advanceLearningVisit(switched, "user_b", "source-b")), true);
  const guest = advanceLearningVisit(null, null, "source-a");
  assert.equal(canRememberLearningVisit(guest), false);
  assert.equal(canRememberLearningVisit(advanceLearningVisit(guest, "user_b", "source-a")), false);
  const loading = advanceLearningVisit(null, "user_a", null);
  assert.equal(canRememberLearningVisit(advanceLearningVisit(loading, "user_a", "source-a")), true);
});

test("Shadow URL updates notify the tracker once per changed sentence, without playback", () => {
  const original = globalThis.window;
  const events = [];
  const location = { href: "https://libitu.test/practice/a0000000-0000-4000-8000-000000000001" };
  globalThis.window = {
    location, history: { state: null, replaceState(_state, _unused, next) { location.href = String(next); } },
    dispatchEvent(event) { events.push(event.type); }
  };
  try {
    replaceStageTwoLocation({ segmentId: "segment-1", sentenceId: "sentence-2" });
    replaceStageTwoLocation({ segmentId: "segment-1", sentenceId: "sentence-2" });
    assert.deepEqual(events, [STAGE_TWO_LOCATION_CHANGED]);
    assert.equal(new URL(location.href).searchParams.get("sentenceId"), "sentence-2");
    assert.equal(new URL(location.href).pathname, "/practice/a0000000-0000-4000-8000-000000000001/shadow");
  } finally { globalThis.window = original; }
});
