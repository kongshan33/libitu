import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { parseSoundAnnotation, fetchSoundAnnotation, SoundGuideCache } from "../features/stage-two/sound/sound-api.ts";
import { soundObservation } from "../features/stage-two/sound/evidence.ts";

const source = { contentId: "content", sentenceId: "sentence-1", text: "🙂 Red apple, red apple." };
function fixture(forSource = source) {
  return {
    version: "sound-rules-v1", content_id: forSource.contentId, sentence_id: forSource.sentenceId,
    sentence_text: forSource.text, dialect: "en-US", provider: "cmudict-rules", lexicon_version: "cmudict-test",
    tokens: [{ text: "Red", start: 3, end: 6 }, { text: "apple", start: 7, end: 12 },
      { text: "red", start: 14, end: 17 }, { text: "apple", start: 18, end: 23 }].map((item, index) => ({
      ...item, index, status: "known", pronunciations: index % 2 ? [["AE1", "P", "AH0", "L"]] : [["R", "EH1", "D"]],
      ipa: index % 2 ? ["ˈæpəl"] : ["ɹɛd"]
    })),
    candidates: [{ id: "link-second", kind: "linking", status: "candidate", token_start: 2, token_end: 4,
      source_text: "red apple", phonemes_before: "/d/ + /æ/", phonemes_after: "[d‿æ]", explanation: "The final consonant may flow into the next vowel.",
      conditions: ["If there is no phrase boundary between these words."], rule_id: "linking-v1" }],
    coverage: { known: 4, total: 4 }, warnings: []
  };
}

test("source offsets identify the right repeated occurrence after a non-BMP character", () => {
  const result = parseSoundAnnotation(fixture(), source);
  const candidate = result.candidates[0];
  const start = result.tokens[candidate.token_start].start;
  const end = result.tokens[candidate.token_end - 1].end;
  assert.equal(start, 14);
  assert.equal(source.text.slice(start, end), "red apple");
  assert.equal(result.candidates[0].status, "candidate");
});

test("rejects stale identity, guessed source spans, invalid token order and invented observed statuses", () => {
  const cases = [
    (data) => { data.sentence_id = "old-sentence"; },
    (data) => { data.content_id = "other-video"; },
    (data) => { data.sentence_text = "Other text."; },
    (data) => { data.version = "unknown-version"; },
    (data) => { data.tokens[0].start = 2; },
    (data) => { data.tokens[1].index = 0; },
    (data) => { data.candidates[0].token_end = 99; },
    (data) => { data.candidates[0].source_text = "Red apple"; },
    (data) => { data.candidates[0].status = "detected"; },
    (data) => { data.candidates[0].conditions = []; },
    (data) => { data.candidates.push({ ...data.candidates[0] }); },
    (data) => { data.coverage.known = 5; }
  ];
  for (const mutate of cases) {
    const data = fixture(); mutate(data);
    assert.throws(() => parseSoundAnnotation(data, source), /does not match/);
  }
});

test("unknown and ambiguous tokens stay distinct from a supported sentence without candidates", () => {
  const data = fixture();
  data.tokens[0] = { ...data.tokens[0], status: "unknown", pronunciations: [], ipa: [] };
  data.tokens[1] = { ...data.tokens[1], status: "ambiguous", pronunciations: [["AE1"], ["EY1"]], ipa: ["æ", "eɪ"] };
  data.coverage.known = 2;
  data.candidates = [];
  const result = parseSoundAnnotation(data, source);
  assert.equal(result.tokens[0].status, "unknown");
  assert.equal(result.tokens[1].status, "ambiguous");
  assert.equal(result.candidates.length, 0);
});

test("practice cache is source-bound, bounded to 20 entries, and explicitly clears", () => {
  const cache = new SoundGuideCache();
  const entry = (i) => ({ ...source, sentenceId: `sentence-${i}` });
  for (let i = 0; i < 20; i++) cache.set(entry(i), fixture(entry(i)));
  assert.ok(cache.get(entry(0)));
  cache.set(entry(20), fixture(entry(20)));
  assert.equal(cache.get(entry(1)), undefined);
  assert.ok(cache.get(entry(0)));
  assert.equal(cache.get({ ...entry(0), contentId: "different" }), undefined);
  assert.equal(cache.get({ ...entry(0), text: "Edited transcript." }), undefined);
  cache.clear();
  assert.equal(cache.get(entry(0)), undefined);
});

test("sound loading sends only source IDs and makes no media or paid-analysis write", async () => {
  const requests = [];
  const fetch = mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(fixture()), { status: 200 });
  });
  try {
    const result = await fetchSoundAnnotation(source, new AbortController().signal);
    assert.equal(result.sentence_id, source.sentenceId);
    assert.equal(new URL(requests[0].url).pathname, "/api/blueprints/content/sentences/sentence-1/sound");
    assert.equal(requests[0].init.body, undefined);
    assert.equal(requests[0].init.method, undefined);
    assert.equal(requests[0].url.includes("Red"), false);
  } finally { fetch.mock.restore(); }
});

test("unavailable dictionaries, stale sentences and request failures have recoverable errors", async () => {
  for (const [status, message] of [[404, /latest sentence/], [409, /latest sentence/], [422, /supported text limits/], [503, /dictionary is unavailable/], [500, /could not load/]]) {
    const fetch = mock.method(globalThis, "fetch", async () => new Response("", { status }));
    try { await assert.rejects(fetchSoundAnnotation(source, new AbortController().signal), message); }
    finally { fetch.mock.restore(); }
  }
});

test("aborted and late responses cannot publish a previous sentence's annotations", async () => {
  const abort = new AbortController();
  let release;
  const fetch = mock.method(globalThis, "fetch", () => new Promise((resolve) => { release = resolve; }));
  try {
    const promise = fetchSoundAnnotation(source, abort.signal);
    abort.abort();
    release(new Response(JSON.stringify(fixture()), { status: 200 }));
    await assert.rejects(promise, { name: "AbortError" });
    await assert.rejects(fetchSoundAnnotation(source, abort.signal), { name: "AbortError" });
    assert.equal(fetch.mock.callCount(), 1);
  } finally { fetch.mock.restore(); }
});

test("usable pitch and VAD never become positive or negative Sound evidence", () => {
  for (const input of [
    { available: false, pending: false, error: null, features: null },
    { available: true, pending: true, error: null, features: null },
    { available: true, pending: false, error: "Failed", features: null },
    { available: true, pending: false, error: null, features: { quality: { status: "insufficient" } } },
    { available: true, pending: false, error: null, features: { quality: { status: "usable" }, pauseCount: 0, pitchRangeSemitones: 8 } }
  ]) {
    const observation = soundObservation(input);
    assert.equal(observation.status, "not_evaluated");
    assert.equal("score" in observation, false);
    assert.ok(observation.reason.length > 0);
  }
});
