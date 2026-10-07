import assert from "node:assert/strict";
import { test } from "node:test";
import { chromeStoreHref, hasReaderSource, videoEntryHref } from "../features/landing/entry.ts";
import { loadStageOneBlueprint } from "../features/stage-one/api/stage-one-api.ts";

const canonical = "https://www.youtube.com/watch?v=abcdefghijk";

test("home only enters a reader when a source or recovery identity exists", () => {
  for (const params of [{}, { utm_source: "campaign" }, { redirect_url: "/profile" }, { sourceUrl: " " },
    { title: "A title", language: "en", stage: "2" }]) assert.equal(hasReaderSource(params), false);
  for (const key of ["sourceUrl", "contentId", "jobId", "handoffId"]) {
    assert.equal(hasReaderSource({ [key]: "source", stage: "2", sentenceId: "saved" }), true);
    assert.equal(hasReaderSource({ [key]: ["", "source"] }), true);
  }
});

test("watch, share, mobile and Shorts links normalize to one source", () => {
  for (const value of [canonical, "  youtu.be/abcdefghijk?si=tracking  ",
    "https://m.youtube.com/watch?v=abcdefghijk&t=34", "www.youtube.com/watch?v=abcdefghijk",
    "https://www.youtube.com/shorts/abcdefghijk?feature=share"]) {
    const href = videoEntryHref(value);
    assert.ok(href);
    const url = new URL(href, "https://libitu.example");
    assert.equal(url.pathname, "/");
    assert.equal(url.searchParams.get("sourceUrl"), canonical);
    assert.deepEqual([...url.searchParams.keys()], ["sourceUrl"]);
  }
});

test("invalid links, spoofed hosts and unsupported protocols stay in the form", () => {
  for (const input of ["", "hello", "https://example.com/watch?v=abcdefghijk", "//youtube.com/watch?v=abcdefghijk",
    "javascript:alert(1)", "ftp://www.youtube.com/watch?v=abcdefghijk", "https://youtube.com.evil.example/watch?v=abcdefghijk",
    "https://user:pass@www.youtube.com/watch?v=abcdefghijk", "https://www.youtube.com:9000/watch?v=abcdefghijk",
    "https://www.youtube.com/watch?v=abcdefghijk&v=12345678901", "https://www.youtube.com/playlist?list=abcdef",
    "https://www.youtube.com/watch?v=short", "https://youtu.be/" , "x".repeat(2049)]) {
    assert.equal(videoEntryHref(input), null, input);
  }
});

test("pasted links cannot assert language, overwrite a title, or redirect auth", () => {
  const href = videoEntryHref(`${canonical}&language=en&title=Fake&redirect_url=https://evil.example#secret`);
  assert.equal(href, videoEntryHref(canonical));
});

test("only a configured Chrome Web Store listing becomes an installation link", () => {
  const listing = `https://chromewebstore.google.com/detail/libitu/${"a".repeat(32)}`;
  assert.equal(chromeStoreHref(listing), listing);
  for (const value of [undefined, "", "https://example.com/install", "https://chromewebstore.google.com/",
    listing.replace("https:", "http:"), listing.replace("//", "//user@"), listing.replace("google.com", "google.com.evil.example")]) {
    assert.equal(chromeStoreHref(value), null);
  }
});

test("a pasted source uses the existing resolve/job/blueprint flow without a demo title", async () => {
  const requests = [];
  const previous = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, body });
    let result;
    if (path === "/api/content/resolve") result = { content_id: "landing-content", kind: "youtube", normalized_key: "youtube:abcdefghijk", source_url: canonical, title: "Actual video title" };
    else if (path === "/api/jobs") result = { id: "landing-job", content_id: "landing-content", status: "ready", blueprint_id: "landing-blueprint", analysis_version: "mvp-v9", error_message: null };
    else if (path === "/api/blueprints/landing-content") result = { id: "landing-blueprint", content_id: "landing-content", title: "Actual video title", source_url: canonical, summary: "A useful conversation.", chapters: [], logic_flow: [], corpus_items: [], transcript: [] };
    else throw new Error(`Unexpected request: ${path}`);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  try {
    const resolved = [];
    const result = await loadStageOneBlueprint({ kind: "youtube", sourceUrl: canonical, title: "" }, undefined,
      { onResolved: (ids) => resolved.push(ids) });
    assert.equal(result.title, "Actual video title");
    assert.equal(requests[0].body.source_url, canonical);
    assert.equal("title" in requests[0].body, false);
    assert.equal("language" in requests[0].body, false);
    assert.deepEqual(resolved, [{ contentId: "landing-content", jobId: "landing-job" }]);
  } finally {
    globalThis.fetch = previous;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
