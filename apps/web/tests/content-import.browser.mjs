import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { installLoadoutFixture, fixtureContentId, shadowBlueprint } from "./helpers/loadout-fixture.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3001";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    const state = await installLoadoutFixture(page, { origin, shadow: true, initialOwner: null });
    await page.addInitScript(() => {
      window.addEventListener("message", event => {
        if (event.source !== window || event.data?.type !== "LIBITU_HANDOFF_REQUEST") return;
        const request = event.data;
        window.__importHandoffs = (window.__importHandoffs ?? 0) + 1;
        window.postMessage({ type: "LIBITU_HANDOFF_RESPONSE", version: 4, requestId: request.requestId,
          handoffId: request.handoffId, phase: "connected" }, location.origin);
        window.__releaseImportCaptions = () => window.postMessage({ type: "LIBITU_HANDOFF_RESPONSE", version: 4,
          requestId: request.requestId, handoffId: request.handoffId, phase: "ready",
          transcriptText: "0:01\tMatching handoff captions." }, location.origin);
      });
    });
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
    const pending = [];
    let resolveReceived;
    let nextResolve = new Promise(resolve => { resolveReceived = resolve; });
    await page.route("**/api/content/resolve", route => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      assert.equal(route.request().postDataJSON().transcript_text, "0:01\tMatching handoff captions.");
      pending.push(route);
      resolveReceived(route);
    });
    await page.goto(`${origin}/practice/import?sourceUrl=${encodeURIComponent(shadowBlueprint.source_url)}&handoffId=matching-handoff`);
    await page.waitForFunction(() => typeof window.__releaseImportCaptions === "function");
    const skeleton = page.locator('.reader-shell[aria-busy="true"]');
    await skeleton.waitFor();
    assert.equal(pending.length, 0, "resolve waits for matching captions");
    assert.equal(await page.evaluate(() => window.__loadoutPlayers.length), 0, "skeleton creates no media");
    assert.equal(await page.locator(".reader-skeleton-line").first().evaluate(node => getComputedStyle(node).animationName), "none");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `/tmp/libitu-import-loading-${width}.png`, fullPage: true });
    await page.evaluate(() => window.__releaseImportCaptions());
    const firstResolve = await nextResolve;
    assert.equal(await skeleton.count(), 1, "skeleton stays visible during resolve");
    assert.equal(await page.evaluate(() => window.__loadoutPlayers.length), 0);
    await firstResolve.fulfill({ status: 503, headers, json: { detail: "Content temporarily unavailable" } });
    await page.getByRole("alert").filter({ hasText: "Content temporarily unavailable" }).waitFor();
    assert.equal(await skeleton.count(), 0, "errors are not hidden by placeholders");
    await page.screenshot({ path: `/tmp/libitu-import-error-${width}.png`, fullPage: true });
    nextResolve = new Promise(resolve => { resolveReceived = resolve; });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await skeleton.waitFor();
    await page.waitForFunction(() => window.__importHandoffs === 2);
    await page.evaluate(() => window.__releaseImportCaptions());
    const secondResolve = await nextResolve;
    await secondResolve.fulfill({ headers, json: { content_id: fixtureContentId, kind: "youtube", source_url: shadowBlueprint.source_url } });
    await page.waitForURL(`${origin}/practice/${fixtureContentId}`);
    await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).waitFor();
    assert.equal(new URL(page.url()).search, "");
    assert.deepEqual(state.errors, []);
    console.log(`Import handoff/resolve skeleton, reduced motion, media isolation and retry passed at ${width}px`);
    await context.close();
  }
} finally { await browser.close(); }
