import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installProfileFixture, otherProfileOwner, profileContentId,
  profileHistory, profileOwner, profileSessionId, profileSourceUrl } from "./helpers/profile-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const artifacts = await mkdtemp(join(tmpdir(), "libitu-profile-"));
const requestedViewport = Number(process.env.LIBITU_PROFILE_VIEWPORT ?? 0);
const viewports = [{ width: 1440, height: 1050 }, { width: 390, height: 844 }]
  .filter(({ width }) => !requestedViewport || requestedViewport === width);

async function waitFor(check, message) {
  for (let index = 0; index < 200; index++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function layout(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true,
    `${name} does not overflow horizontally`);
  await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
}

const browser = await chromium.launch({ headless: true, channel: process.env.LIBITU_BROWSER_CHANNEL ?? "chrome" });
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport, timezoneId: "Asia/Shanghai" });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const state = await installProfileFixture(page, { origin });
    try {
      await page.goto(`${origin}/profile`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("heading", { name: "My learning", exact: true }).waitFor();
      await page.getByRole("heading", { name: "Recent practice", exact: true }).waitFor();
      await page.getByText(profileHistory[0].title, { exact: true }).first().waitFor();
      assert.equal(state.requests.find((request) => request.path === "/api/profile").query.timezone, "Asia/Shanghai");

      const dimensions = page.getByRole("group", { name: "Learning dimensions", exact: true });
      assert.equal(await dimensions.getByText("Not assessed", { exact: true }).count(), 4);
      assert.equal(await dimensions.getByText("Not available yet", { exact: true }).count(), 1);
      const writing = dimensions.getByRole("button", { name: /^Writing/ });
      await writing.focus();
      await writing.press("Enter");
      assert.equal(await writing.getAttribute("aria-pressed"), "true");
      await page.locator("#dimension-detail").getByText("A dedicated writing practice and assessment experience is not available yet.", { exact: true }).waitFor();
      const intake = dimensions.getByRole("button", { name: /^Intake/ });
      await intake.focus();
      await intake.press("Space");
      assert.equal(await intake.getAttribute("aria-pressed"), "true");
      await page.locator("#dimension-detail").getByText(/do not measure listening or reading comprehension/).waitFor();
      assert.equal(await page.locator('section[aria-labelledby="dimensions-title"] polygon:not([fill="none"])').count(), 0,
        "the assessment scaffold never fabricates scored radar data");

      await page.getByRole("button", { name: "Last 3 months", exact: true }).click();
      await waitFor(() => state.responses.some((request) => request.path === "/api/profile" && request.query.range === "3m"), "3-month range refetches real data");
      await page.getByRole("img", { name: /^Shadowing takes:/ }).waitFor();
      await page.getByText("View activity data", { exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length === 90);
      await page.getByText("View activity data", { exact: true }).click();
      await page.getByRole("button", { name: "All time", exact: true }).click();
      await waitFor(() => state.responses.some((request) => request.path === "/api/profile" && request.query.range === "all"), "all-time range refetches real data");
      await page.getByText(/Monthly counts/).waitFor();
      await page.getByRole("button", { name: "Last 4 weeks", exact: true }).click();
      await page.getByText(/Daily counts/).waitFor();

      const resumeLink = page.locator(`a[href^="/speaking/${profileSessionId}"]`).first();
      assert.ok(await resumeLink.count(), "unfinished Mission has a recovery destination");
      const sourceLink = page.locator(`a[href*="contentId=${profileContentId}"]`).first();
      assert.ok(await sourceLink.count(), "saved source has a valid recovery destination");
      const sourceDestination = new URL(await sourceLink.getAttribute("href"), origin);
      assert.equal(sourceDestination.searchParams.get("contentId"), profileContentId);
      assert.equal(sourceDestination.searchParams.get("sourceUrl"), profileSourceUrl,
        "server history includes the matching video rather than a fallback demo player");
      await layout(page, `profile-${viewport.width}`);

      await page.goto(`${origin}/profile/history`, { waitUntil: "domcontentloaded" });
      await page.getByText(profileHistory[19].title, { exact: true }).waitFor();
      const more = page.getByRole("button", { name: /Load more/i });
      state.failHistory = true;
      await more.click();
      await page.locator('main [role="alert"]').waitFor();
      assert.equal(await page.getByText(profileHistory[19].title, { exact: true }).count(), 1,
        "failed pagination retains previously loaded records");
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page.getByText(profileHistory[22].title, { exact: true }).waitFor();
      assert.equal(await page.getByRole("link", { name: new RegExp(profileHistory[22].title) }).count(), 0,
        "a historical take without its source URL never links to a different video");
      assert.equal(await more.count(), 0, "history stops at its final server page");
      assert.deepEqual(state.requests.filter((request) => request.path === "/api/profile/history").map((request) => Number(request.query.offset ?? 0)), [0, 20, 20]);
      assert.equal(await page.getByText(profileHistory[0].title, { exact: true }).count(), 1, "pagination appends without duplicating records");
      await layout(page, `history-${viewport.width}`);
      assert.deepEqual(state.errors, []);
      console.log(`PASS ${viewport.width}: truthful profile, keyboard dimensions, real date-range requests, recovery links, paginated history, responsive layout`);
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `failure-${viewport.width}.png`), fullPage: true });
      throw error;
    } finally { await context.close(); }
  }

  // Check the empty-account and service-failure surfaces independently: a failed
  // read must not become a convincing zero-activity summary.
  const emptyContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const emptyPage = await emptyContext.newPage();
  const emptyState = await installProfileFixture(emptyPage, { origin, empty: true });
  await emptyPage.goto(`${origin}/profile`, { waitUntil: "domcontentloaded" });
  await emptyPage.getByText("No shadowing takes in this period", { exact: true }).waitFor();
  await layout(emptyPage, "profile-empty");
  emptyState.failProfile = true;
  await emptyPage.reload({ waitUntil: "domcontentloaded" });
  await emptyPage.locator('main [role="alert"]').waitFor();
  assert.equal(await emptyPage.getByText("No shadowing takes in this period", { exact: true }).count(), 0, "a service error is not empty activity");
  await layout(emptyPage, "profile-error");
  await emptyPage.getByRole("button", { name: /Retry/ }).click();
  await emptyPage.getByText("No shadowing takes in this period", { exact: true }).waitFor();
  emptyState.failHistory = true;
  await emptyPage.goto(`${origin}/profile/history`, { waitUntil: "domcontentloaded" });
  await emptyPage.locator('main [role="alert"]').waitFor();
  await emptyPage.getByRole("button", { name: /Retry/ }).click();
  await emptyPage.getByRole("heading", { name: "Your next practice starts here", exact: true }).waitFor();
  emptyState.empty = false;
  emptyState.transformProfile = (data) => ({ ...data,
    overview: { ...data.overview, corpus_week_added: null },
    activity: { ...data.activity, items: data.activity.items.map((item) => ({ ...item, corpus_added: null })) }
  });
  await emptyPage.goto(`${origin}/profile`, { waitUntil: "domcontentloaded" });
  await emptyPage.getByText(profileHistory[0].title, { exact: true }).first().waitFor();
  await emptyPage.getByRole("button", { name: "Corpus added", exact: true }).click();
  await emptyPage.getByText("Dates aren’t available for this activity yet.", { exact: true }).waitFor();
  assert.equal(await emptyPage.getByText(/\+\d+ this week/).count(), 0,
    "unknown corpus creation dates do not fabricate a weekly addition count");
  assert.deepEqual(emptyState.errors, []);
  await emptyContext.close();
  console.log("PASS empty account and failed reads: explicit empty states, visible failures, successful retries, unknown corpus dates");

  const raceContext = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const racePage = await raceContext.newPage();
  const raceState = await installProfileFixture(racePage, { origin });
  await racePage.goto(`${origin}/profile`, { waitUntil: "domcontentloaded" });
  await racePage.getByText(profileHistory[0].title, { exact: true }).first().waitFor();
  const oldRequest = gate();
  raceState.profileGate = oldRequest.promise;
  await racePage.getByRole("button", { name: "Last 3 months", exact: true }).click();
  await waitFor(() => raceState.requests.some((request) => request.owner === profileOwner && request.query.range === "3m"), "old account's range request started");
  const newRequest = gate();
  raceState.profileGate = newRequest.promise;
  await racePage.evaluate((owner) => window.__setProfileUser(owner), otherProfileOwner);
  await waitFor(() => raceState.requests.some((request) => request.owner === otherProfileOwner && request.path === "/api/profile"), "new account starts its own summary read");
  assert.equal(await racePage.getByText(profileHistory[0].title, { exact: true }).count(), 0, "old account history clears before the new request resolves");
  newRequest.release();
  await waitFor(() => raceState.responses.some((request) => request.owner === otherProfileOwner && request.path === "/api/profile"), "new account summary resolved");
  await settle(racePage);
  oldRequest.release();
  await waitFor(() => raceState.responses.some((request) => request.owner === profileOwner && request.query.range === "3m"), "delayed old account response completed");
  await settle(racePage);
  assert.equal(await racePage.getByText(profileHistory[0].title, { exact: true }).count(), 0, "late old-account response cannot restore private records");
  assert.equal(await racePage.locator(`a[href^="/speaking/${profileSessionId}"]`).count(), 0, "late response cannot restore an old account's Mission");
  raceState.profileGate = null;

  await racePage.evaluate((owner) => window.__setProfileUser(owner), profileOwner);
  await racePage.goto(`${origin}/profile/history`, { waitUntil: "domcontentloaded" });
  await racePage.getByText(profileHistory[19].title, { exact: true }).waitFor();
  const historyRequest = gate();
  raceState.historyGate = historyRequest.promise;
  await racePage.getByRole("button", { name: /Load more/i }).click();
  await waitFor(() => raceState.requests.some((request) => request.path === "/api/profile/history" && request.query.offset === "20"), "old account's next history page started");
  raceState.historyGate = null;
  await racePage.evaluate((owner) => window.__setProfileUser(owner), otherProfileOwner);
  await racePage.getByRole("heading", { name: "Your next practice starts here", exact: true }).waitFor();
  historyRequest.release();
  await waitFor(() => raceState.responses.some((request) => request.path === "/api/profile/history" && request.query.offset === "20"), "late history page completed");
  await settle(racePage);
  assert.equal(await racePage.getByText(profileHistory[0].title, { exact: true }).count(), 0);
  assert.equal(await racePage.getByText(profileHistory[22].title, { exact: true }).count(), 0, "late page cannot append another account's history");
  assert.deepEqual(raceState.errors, []);
  await raceContext.close();
  console.log("PASS account boundaries: immediate private-data clearing, delayed summary and pagination responses fenced");

  const locationContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const locationPage = await locationContext.newPage();
  const locationState = await installProfileFixture(locationPage, { origin });
  const savedHref = `/?${new URLSearchParams({ contentId: profileContentId, sourceUrl: profileSourceUrl,
    stage: "2", segmentId: "segment-one", sentenceId: "sentence-three" })}`;
  await locationPage.addInitScript(({ owner, href }) => {
    localStorage.setItem(`libitu:learning-location:v1:${owner}`, JSON.stringify({ version: 1, owner,
      href, title: "The source I last visited", updatedAt: "2026-10-02T04:00:00Z" }));
  }, { owner: profileOwner, href: savedHref });
  await locationPage.goto(`${origin}/profile`, { waitUntil: "domcontentloaded" });
  const continueLearning = locationPage.getByRole("link", { name: /Continue learning/ });
  await continueLearning.waitFor();
  assert.equal(await continueLearning.getAttribute("href"), savedHref,
    "Continue learning preserves the actual saved source, segment, and sentence");
  await locationPage.evaluate((owner) => window.__setProfileUser(owner), otherProfileOwner);
  await locationPage.getByRole("heading", { name: "Robin Chen", exact: true }).waitFor();
  assert.equal(await continueLearning.count(), 0, "a saved device location does not transfer to another account");
  assert.equal(await locationPage.getByText("The source I last visited", { exact: false }).count(), 0);
  assert.deepEqual(locationState.errors, []);
  await locationContext.close();
  console.log("PASS saved learning location: exact source/segment/sentence destination and account isolation");

  for (const path of ["/profile", "/profile/history"]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const state = await installProfileFixture(page, { origin, initialOwner: null });
    await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
    const signIn = page.getByRole("button", { name: /^Sign in to/ });
    await signIn.waitFor();
    assert.equal(state.requests.length, 0, "signed-out profile never requests personal records");
    await signIn.click();
    const options = await page.evaluate(() => window.__profileAuthCalls.at(-1));
    assert.equal(options.forceRedirectUrl, page.url());
    assert.equal(options.signUpForceRedirectUrl, page.url());
    assert.deepEqual(state.errors, []);
    await layout(page, `signed-out-${path.endsWith("history") ? "history" : "profile"}`);
    await context.close();
  }
  console.log("PASS signed-out profile/history: no private reads and explicit login/register return destinations");
  console.log(`Screenshots: ${artifacts}`);
} finally { await browser.close(); }
