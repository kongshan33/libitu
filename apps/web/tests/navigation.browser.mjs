import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { installAnalyticsFixture } from "./helpers/analytics-fixture.mjs";
import { installLoadoutFixture, fixtureContentId, loadoutOwner } from "./helpers/loadout-fixture.mjs";
import { speakingWorkspace, speakingSessionId } from "./helpers/speaking-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3001";
const learning = `/practice/${fixtureContentId}/shadow?segmentId=loadout-segment&sentenceId=sentence-v2-loadout#practice`;
const query = new URLSearchParams({ returnTo: learning });
const reportPath = `/speaking/${speakingSessionId}/analytics?${query}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    const { auth, feedback } = await installAnalyticsFixture(page, { origin });
    await page.route(`**/api/speaking/sessions/${speakingSessionId}/workspace`, route => route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: { ...speakingWorkspace(), session: feedback.report.session }
    }));
    await page.goto(origin + reportPath);
    await page.getByRole("heading", { name: "Your mission report", exact: true }).waitFor();
    const review = page.getByRole("link", { name: "Conversation review" });
    assert.equal(new URL(await review.getAttribute("href"), origin).searchParams.get("returnTo"), learning);
    await review.click();
    const report = page.getByRole("link", { name: "View mission report" });
    await report.waitFor();
    assert.equal(await report.getAttribute("href"), reportPath);
    await page.getByRole("link", { name: "Loadout", exact: true }).click();
    const back = page.getByRole("link", { name: "Back to learning" });
    await back.waitFor();
    assert.equal(await back.getAttribute("href"), learning);
    await page.reload();
    assert.equal(await back.getAttribute("href"), learning, "refresh retains learning origin");
    await page.goBack();
    await report.waitFor();
    assert.equal(await report.getAttribute("href"), reportPath, "browser back retains origin");
    await report.click();
    await page.getByRole("button", { name: /Adjust loadout/ }).click();
    await back.waitFor();
    assert.equal(await back.getAttribute("href"), learning, "adjusting report preserves origin");
    await page.goto(origin + reportPath);
    await page.getByRole("button", { name: /Retry this mission/ }).click();
    await page.waitForURL(/\/speaking\/10000000/);
    assert.equal(new URL(page.url()).searchParams.get("returnTo"), learning, "new attempt preserves origin");
    await page.goto(origin + reportPath + "#report");
    await page.getByRole("heading", { name: "Your mission report", exact: true }).waitFor();
    await page.evaluate(() => window.__setLoadoutUser(null));
    await page.getByRole("heading", { name: "Sign in to view your report" }).waitFor();
    await page.getByRole("main").getByRole("button", { name: "Sign in", exact: true }).click();
    const authCalls = await page.evaluate(() => window.__loadoutAuthCalls);
    assert.equal(authCalls.at(-1).forceRedirectUrl, origin + reportPath + "#report", "auth returns to report, not its learning origin");
    assert.deepEqual(auth.errors, []);
    await context.close();
    console.log(`PASS ${width}: report/review/loadout origin, refresh/back, adjust/retry, exact auth return`);
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  const state = await installLoadoutFixture(page, { origin, shadow: true, initialOwner: loadoutOwner });
  await page.goto(`${origin}/practice/${fixtureContentId}`);
  await page.getByText("Shadow to loadout", { exact: true }).first().waitFor();
  assert.equal(state.requests.filter(request => request.path === "/api/content/resolve").length, 0);
  const mission = page.locator('a[href^="/loadout?returnTo="]').first();
  await mission.waitFor();
  const copiedHref = await mission.getAttribute("href");
  const copiedOrigin = new URL(copiedHref, origin).searchParams.get("returnTo");
  assert.equal(new URL(copiedOrigin, origin).pathname, `/practice/${fixtureContentId}`);
  assert.equal(new URL(copiedOrigin, origin).search, "");
  const newTab = await context.newPage();
  await installLoadoutFixture(newTab, { origin, initialOwner: loadoutOwner });
  await newTab.goto(origin + copiedHref);
  assert.equal(await newTab.getByRole("link", { name: "Back to learning" }).getAttribute("href"), copiedOrigin, "copied link/new tab preserves origin without click handler");
  const requestCount = state.requests.length;
  await page.goto(`${origin}/practice/${fixtureContentId}/shadow?segmentId=first&segmentId=second`);
  await page.getByText(/invalid segmentId/).waitFor();
  assert.equal(state.requests.slice(requestCount).filter(request => /\/api\/(content|jobs|blueprints)/.test(request.path)).length, 0);
  assert.deepEqual(state.errors, []);
  await context.close();
  console.log("PASS canonical content, copied mission/new-tab origin, duplicate-parameter rejection without analysis");
} finally { await browser.close(); }
