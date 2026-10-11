import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { contentIdAt, contentIdentityMatches, currentContentDocumentMatches, verifyContentSource } from "../src/content-identity.js";
const cases = JSON.parse(readFileSync(new URL("../../../packages/types/fixtures/workspace-identity.json", import.meta.url)));
const contentContract = JSON.parse(readFileSync(new URL("../../../packages/types/fixtures/content-context.json", import.meta.url)));
for (const row of cases) test(`v4 content scope: ${row.name}`, () => assert.equal(contentIdAt(row.url), row.contentId));
test("sender origin and current tab must agree; the claimed video must match the public API", async () => {
  const row = cases[0];
  const message = { contentId: row.contentId, videoId: "first-video", documentNonce: "nonce-for-this-document" };
  assert.equal(contentIdentityMatches(message, { url: row.url, tab: { url: row.url } }), true);
  assert.equal(contentIdentityMatches(message, { url: row.url, tab: { url: "http://localhost:3000/profile" } }), false);
  assert.equal(contentIdentityMatches({ ...message, documentNonce: "" }, { url: row.url, tab: { url: row.url } }), false);
  const fetcher = async (url, init) => {
    assert.equal(url, `http://localhost:8000/api/content/${row.contentId}/identity`);
    assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store"); assert.equal(init.method, undefined);
    return Response.json({ ...contentContract.content, content_id: row.contentId, source_url: "https://www.youtube.com/watch?v=first-video" });
  };
  assert.equal(await verifyContentSource(row.contentId, "first-video", fetcher), true);
  assert.equal(await verifyContentSource(row.contentId, "other-video", fetcher), false);
  assert.equal(await verifyContentSource(row.contentId, "first-video", async () => new Response(null, { status: 503 })), false);
});

test("v4 source verification uses the shared public content contract", async () => {
  const fetcher = async () => Response.json(contentContract.content);
  assert.equal(await verifyContentSource(contentContract.content.content_id, "abcdefghijk", fetcher), true);
  assert.equal(await verifyContentSource("different-content", "abcdefghijk", fetcher), false);
  assert.equal(await verifyContentSource(contentContract.content.content_id, "abcdefghijk", async () =>
    Response.json({ content: { id: contentContract.content.content_id, kind: "youtube", source_url: contentContract.content.source_url } })), false);
});

test("SPA content identity uses the live document and refuses stale, inactive and foreign frames", async () => {
  const row = cases[0];
  const message = { contentId: row.contentId, videoId: "first-video", documentNonce: "nonce-for-this-document" };
  const sender = { frameId: 0, documentId: "document-1", url: "http://localhost:3000/practice/import", tab: { id: 1, url: row.url } };
  assert.equal(contentIdentityMatches(message, sender), true);
  assert.equal(contentIdentityMatches(message, { ...sender, url: "https://evil.test" }), false);
  const frame = { url: row.url, documentId: sender.documentId, documentLifecycle: "active" };
  const api = value => ({ webNavigation: { getFrame: async query => { assert.deepEqual(query, { tabId: 1, frameId: 0 }); return value; } } });
  assert.equal(await currentContentDocumentMatches(api(frame), message, sender), true);
  for (const invalid of [null, { ...frame, documentId: "new-document" }, { ...frame, url: "http://localhost:3000/profile" },
    { ...frame, documentLifecycle: "prerender" }]) assert.equal(await currentContentDocumentMatches(api(invalid), message, sender), false);
});
