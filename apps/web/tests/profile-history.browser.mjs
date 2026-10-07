import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installProfileFixture, profileHistory } from "./helpers/profile-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const artifacts = await mkdtemp(join(tmpdir(), "libitu-history-"));
const browser = await chromium.launch({ headless: true, channel: process.env.LIBITU_BROWSER_CHANNEL ?? "chrome" });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: "Asia/Shanghai" });
    const page = await context.newPage();
    const state = await installProfileFixture(page, { origin });
    await page.goto(`${origin}/profile`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: /Practice history Revisit/ }).click();
    await page.getByRole("heading", { name: "Practice history", exact: true }).waitFor();
    const feed = page.getByRole("region", { name: "Saved practice history" });
    await feed.getByText(profileHistory[19].title, { exact: true }).waitFor();
    assert.equal(await feed.locator("li").count(), 20);
    assert.equal(await feed.getByRole("heading", { name: "Friday, Oct 2, 2026" }).count(), 1);
    assert.match(await feed.locator("time").first().innerText(), /2:00 PM/);
    state.failHistory = true;
    await feed.getByRole("button", { name: "Load more practice" }).click();
    await feed.getByRole("button", { name: "Retry", exact: true }).waitFor();
    assert.equal(await feed.locator("li").count(), 20);
    await feed.getByRole("button", { name: "Retry", exact: true }).click();
    await feed.getByText(profileHistory[22].title, { exact: true }).waitFor();
    assert.equal(await feed.locator("li").count(), 23);
    assert.equal(await feed.getByRole("heading", { name: "Thursday, Oct 1, 2026" }).count(), 1);
    assert.equal(await feed.getByText("Source unavailable", { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(artifacts, `history-${width}.png`), fullPage: true });
    await feed.getByRole("button", { name: "Shadowing", exact: true }).click();
    await feed.getByText(profileHistory[22].title, { exact: true }).waitFor();
    assert.equal(await feed.locator("li").count(), 12);
    assert.equal(await feed.getByText("Completed", { exact: true }).count(), 0);
    assert.equal(await feed.getByRole("button", { name: "Load more practice" }).count(), 0);
    // A late response from the previous filter must not replace the new one.
    let release;
    state.historyGate = new Promise((resolve) => { release = resolve; });
    const requestStarted = page.waitForRequest((request) => request.url().includes("kind=speaking"));
    await feed.getByRole("button", { name: "Missions", exact: true }).click();
    await requestStarted;
    state.historyGate = null;
    await feed.getByRole("button", { name: "All practice", exact: true }).click();
    await feed.getByText(profileHistory[0].title, { exact: true }).waitFor();
    release();
    await page.waitForTimeout(150);
    assert.equal(await feed.locator("li").count(), 20);
    await feed.getByRole("button", { name: "Missions", exact: true }).click();
    await feed.getByText(profileHistory[21].title, { exact: true }).waitFor();
    assert.equal(await feed.locator("li").count(), 11);
    assert.equal(await feed.getByText("Saved take", { exact: true }).count(), 0);
    assert.match(await feed.locator("li a").first().getAttribute("href"), /\/analytics$/);
    state.empty = true;
    await feed.getByRole("button", { name: "Shadowing", exact: true }).click();
    await feed.getByRole("heading", { name: "No saved shadowing takes yet" }).waitFor();
    assert.equal(await feed.getByRole("link", { name: "Explore practice" }).getAttribute("href"), "/");
    await page.screenshot({ path: join(artifacts, `empty-${width}.png`), fullPage: true });
    assert.deepEqual(state.errors, []);
    await context.close();
    console.log(`PASS history ${width}px: profile entry, local dates, pagination retry, filters, stale response, report navigation, empty state`);
  }
  console.log(`Screenshots: ${artifacts}`);
} finally { await browser.close(); }
