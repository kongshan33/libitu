import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { installLoadoutFixture, fixtureContentId, shadowBlueprint, loadoutOwner } from "./helpers/loadout-fixture.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3001";
const reader = `${origin}/practice/${fixtureContentId}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

try {
  for (const width of [1440, 390]) {
    for (const view of ["reader", "segments", "shadow", "import"]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
      const page = await context.newPage();
      const state = await installLoadoutFixture(page, { origin, shadow: true, initialOwner: loadoutOwner });
      await page.addInitScript(() => {
        window.__loadingSeen = { reader: false, practice: false };
        const sample = () => {
          const visible = selector => [...document.querySelectorAll(selector)].some(node => node.checkVisibility() && node.getClientRects().length);
          window.__loadingSeen.reader ||= visible(".reader-skeleton");
          window.__loadingSeen.practice ||= visible('[aria-busy="true"][class*="practice"]');
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      // Hold JavaScript to inspect the server-rendered first frame, then hold
      // content reads to inspect the hydrated business-loading state separately.
      const scripts = deferred(), content = deferred(), contentRequested = deferred();
      await page.route("**/_next/static/**/*.js", async route => { await scripts.promise; await route.continue(); });
      await page.route(`**/api/content/${fixtureContentId}`, async route => {
        contentRequested.resolve();
        await content.promise;
        await route.fallback();
      });
      const resolveContent = deferred(), resolveRequested = deferred();
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
      await page.route("**/api/content/resolve", async route => {
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        resolveRequested.resolve();
        await resolveContent.promise;
        await route.fulfill({ headers, json: { content_id: fixtureContentId, kind: "youtube", source_url: shadowBlueprint.source_url } });
      });
      const url = view === "reader" ? reader : view === "import"
        ? `${origin}/practice/import?sourceUrl=${encodeURIComponent(shadowBlueprint.source_url)}`
        : `${reader}/${view}${view === "shadow" ? "?segmentId=loadout-segment&sentenceId=sentence-v2-loadout" : ""}`;
      await page.goto(url, { waitUntil: "commit" });
      const practice = view === "shadow" || view === "segments";
      const expected = practice ? '[aria-busy="true"][class*="practice"]' : ".reader-skeleton";
      await page.locator(expected).first().waitFor();
      assert.equal(await page.locator(practice ? ".reader-skeleton" : '[aria-busy="true"][class*="practice"]').count(), 0, "server shell matches the target route");
      assert.equal(await page.evaluate(() => window.__loadoutPlayers.length), 0, "server fallback creates no player");
      if (practice) {
        const placeholder = page.locator(`[data-practice-skeleton="${view}"]`);
        await placeholder.waitFor();
        assert.equal(await placeholder.locator("button, input, iframe, audio, video").count(), 0, "skeletons are decorative and create no controls/media");
        assert.equal(await placeholder.locator("span").last().evaluate(node => getComputedStyle(node).animationName), "none");
        if (view === "shadow") {
          const sidebar = await placeholder.locator('[data-skeleton-region="sentences"]').boundingBox();
          const main = await placeholder.locator(".stage-two-practice-main").boundingBox();
          assert.ok(width >= 1024 ? sidebar.x < main.x : sidebar.y >= main.y + main.height - 1, "sentence sidebar follows the real desktop/mobile order");
          assert.equal(await placeholder.locator('[data-skeleton-region="media"], [data-skeleton-region="analysis"]').count(), 2);
        }
      }
      await page.screenshot({ path: `/tmp/libitu-workspace-loading-${view}-${width}.png`, fullPage: true });
      scripts.resolve();
      if (view === "import") {
        await resolveRequested.promise;
        await page.locator('.reader-shell[aria-busy="true"]').waitFor();
        assert.equal(await page.evaluate(() => window.__loadoutPlayers.length), 0);
        resolveContent.resolve();
        await page.waitForURL(reader);
      }
      await contentRequested.promise;
      await page.locator(expected).first().waitFor();
      content.resolve();
      if (view === "shadow") await page.locator(".stage-two-shadow").waitFor();
      else if (view === "segments") await page.locator(".stage-one-segment-card").first().waitFor();
      else await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.__loadingSeen), { reader: !practice, practice }, "no wrong-stage skeleton was painted during entry");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(state.errors, []);
      console.log(`Loading boundary: ${view}, server → hydration → delayed content, passed at ${width}px`);
      resolveContent.resolve();
      await context.unrouteAll({ behavior: "ignoreErrors" });
      await context.close();
    }
  }
} finally { await browser.close(); }
