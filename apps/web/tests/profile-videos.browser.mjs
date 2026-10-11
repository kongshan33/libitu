import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLoadoutFixture, loadoutOwner, fixtureContentId, shadowBlueprint } from "./helpers/loadout-fixture.mjs";
import { profileResponse } from "./helpers/profile-fixture.mjs";
const { chromium } = createRequire(import.meta.url)(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const screenshots = await mkdtemp(join(tmpdir(), "libitu-profile-videos-"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const state = await installLoadoutFixture(page, { origin, shadow: true, initialOwner: loadoutOwner, seedCorpus: false });
    const videos = new Map();
    let writes = 0, fail = true;
    await page.route("**/api/profile**", async route => {
      const request = route.request(), url = new URL(request.url());
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,PUT,OPTIONS" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      const token = request.headers().authorization.split(" ")[1];
      const owner = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
      if (request.method() === "PUT") {
        assert.equal(url.pathname, `/api/profile/videos/${fixtureContentId}`);
        writes++;
        if (fail) { fail = false; return route.fulfill({ status: 503, headers, json: {} }); }
        videos.set(owner, { id: fixtureContentId, content_id: fixtureContentId, kind: "video", status: "opened", title: shadowBlueprint.title,
          occurred_at: "2026-10-11T03:00:00Z", source_url: shadowBlueprint.source_url, duration_ms: null, turn_count: null, sentence_id: null, session_id: null, feedback: null });
        return route.fulfill({ status: 204, headers });
      }
      assert.equal(request.method(), "GET");
      const items = videos.has(owner) ? [videos.get(owner)] : [];
      if (url.pathname === "/api/profile/history") return route.fulfill({ headers, json: { items, next_offset: null } });
      const summary = profileResponse({ empty: true });
      summary.recent_videos = { items, next_offset: null };
      summary.recent_history = { items: [], next_offset: null };
      return route.fulfill({ headers, json: summary });
    });
    await page.goto(`${origin}/practice/${fixtureContentId}`, { waitUntil: "domcontentloaded" });
    await page.getByText("Video history could not be saved.", { exact: true }).waitFor();
    const retrySaved = page.waitForResponse(response => response.url().includes("/api/profile/videos/") && response.status() === 204 && response.request().method() === "PUT");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await retrySaved;
    await page.getByText("Video history could not be saved.", { exact: true }).waitFor({ state: "detached" });
    assert.equal(writes, 2);
    await page.goto(`${origin}/profile`, { waitUntil: "domcontentloaded" });
    const card = page.getByRole("region", { name: "Original videos" });
    await card.getByText(shadowBlueprint.title, { exact: true }).waitFor();
    const videoLink = card.getByRole("link", { name: /Open Stage 1/ });
    assert.equal(await videoLink.getAttribute("href"), `/practice/${fixtureContentId}`);
    await page.screenshot({ path: join(screenshots, `profile-${width}.png`), fullPage: true });
    await card.getByRole("link", { name: "View all videos" }).click();
    const feed = page.getByRole("region", { name: "Saved practice history" });
    await feed.getByText(shadowBlueprint.title, { exact: true }).waitFor();
    assert.equal(await feed.getByRole("button", { name: "Videos", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await feed.locator("li").count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(screenshots, `history-${width}.png`), fullPage: true });
    const savedAgain = page.waitForResponse(response => response.url().includes("/api/profile/videos/") && response.request().method() === "PUT");
    await feed.getByRole("link", { name: /Open Stage 1/ }).click();
    await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, `/practice/${fixtureContentId}`);
    await savedAgain;
    assert.equal(videos.size, 1, "reopening a video updates the same record");
    const writesBeforeSwitch = writes;
    await page.evaluate(() => window.__setLoadoutUser("loadout-browser-b"));
    await page.goto(`${origin}/profile`, { waitUntil: "domcontentloaded" });
    await page.getByText("Your videos will appear here when you open them while signed in.", { exact: true }).waitFor();
    assert.equal(writes, writesBeforeSwitch, "account switch cannot adopt the prior account's mounted video");
    assert.deepEqual(state.errors, []);
    console.log(`PASS video history ${width}px: authenticated save/retry, profile card, Videos filter, Stage 1 navigation, deduplication and account isolation`);
    await context.close();
  }
  console.log(`Screenshots: ${screenshots}`);
} finally { await browser.close(); }
