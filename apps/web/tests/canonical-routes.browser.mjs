import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { installLoadoutFixture, fixtureContentId, shadowBlueprint, loadoutOwner } from "./helpers/loadout-fixture.mjs";
const { chromium } = createRequire(import.meta.url)(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3001";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    const state = await installLoadoutFixture(page, { origin, shadow: true, initialOwner: null });
    let resolves = 0;
    await page.addInitScript(() => {
      window.addEventListener("message", event => {
        if (event.source !== window || event.data?.type !== "LIBITU_HANDOFF_REQUEST") return;
        window.postMessage({ type: "LIBITU_HANDOFF_RESPONSE", version: 4, requestId: event.data.requestId,
          handoffId: event.data.handoffId, phase: "ready", transcriptText: "0:01\tMatching handoff captions." }, location.origin);
      });
    });
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
    await page.route("**/api/content/resolve", route => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      resolves++;
      if (resolves === 2) assert.equal(route.request().postDataJSON().transcript_text, "0:01\tMatching handoff captions.");
      assert.equal(route.request().postDataJSON().source_url, shadowBlueprint.source_url);
      return route.fulfill({ headers, json: { content_id: fixtureContentId, kind: "youtube", source_url: shadowBlueprint.source_url } });
    });
    const reader = `${origin}/practice/${fixtureContentId}`;
    const shadow = `${reader}/shadow?segmentId=loadout-segment&sentenceId=sentence-v2-loadout`;
    await page.goto(shadow);
    await page.getByRole("heading", { name: "Sign in to start Shadow" }).waitFor();
    assert.equal(resolves, 0, "cold canonical content reads never resolve again");
    assert.equal(new URL(page.url()).pathname, `/practice/${fixtureContentId}/shadow`);
    await page.evaluate(owner => window.__setLoadoutUser(owner), loadoutOwner);
    await page.locator(".stage-two-shadow").waitFor();
    await page.reload();
    await page.locator(".stage-two-shadow").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("sentenceId"), "sentence-v2-loadout");
    await page.goto(`${reader}/segments?segmentId=loadout-segment&step=prepare`);
    await page.getByRole("button", { name: "Start shadowing", exact: true }).waitFor();
    await page.goto(`${origin}/practice/import?sourceUrl=${encodeURIComponent(shadowBlueprint.source_url)}`);
    await page.waitForURL(reader);
    await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).waitFor();
    assert.equal(resolves, 1);
    await page.goto(`${origin}/practice/import?sourceUrl=${encodeURIComponent(shadowBlueprint.source_url)}&handoffId=matching-handoff`);
    await page.waitForURL(reader);
    await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).waitFor();
    assert.equal(resolves, 2);
    assert.equal(new URL(page.url()).searchParams.has("handoffId"), false);
    assert.equal(new URL(page.url()).searchParams.has("transcriptText"), false);
    // Invalid client-side selection must neither retry the prior content nor
    // poison its activation identity when browser Back restores the valid URL.
    const workRequests = () => state.requests.filter(request => /^\/api\/(?:content|jobs|blueprints)/.test(request.path)).length;
    const beforeInvalid = workRequests();
    await page.evaluate(() => history.pushState(null, "", location.pathname + "?segmentId=one&segmentId=two"));
    await page.getByText(/invalid segmentId/).waitFor();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    assert.equal(workRequests(), beforeInvalid);
    await page.goBack();
    await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).waitFor();
    let unavailable = true;
    await page.route(`**/api/content/${fixtureContentId}`, route => unavailable
      ? route.fulfill({ status: 503, headers, json: { detail: "Content temporarily unavailable" } }) : route.fallback());
    await page.goto(`${reader}/segments`);
    await page.getByText("Content temporarily unavailable", { exact: true }).waitFor();
    unavailable = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.locator(".stage-one-segment-card").first().waitFor();
    const publicReads = () => state.requests.filter(request => /^\/api\/(?:content|jobs|blueprints)/.test(request.path)).length;
    const before = publicReads();
    await page.goto(`${reader}/shadow?segmentId=one&segmentId=two`);
    await page.getByText(/invalid segmentId/).waitFor();
    assert.equal(publicReads(), before, "malformed links start no API work");
    await page.goto(`${origin}/?contentId=${fixtureContentId}&stage=2`);
    assert.equal(await page.locator(".stage-two-shadow").count(), 0);
    assert.equal(publicReads(), before, "obsolete root links stay on Landing");
    assert.deepEqual(state.errors, []);
    console.log(`Canonical import, cold auth, refresh and invalid-link isolation passed at ${width}px`);
    await context.close();
  }
} finally { await browser.close(); }
