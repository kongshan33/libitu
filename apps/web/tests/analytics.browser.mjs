import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAnalyticsFixture, analyticsReport } from "./helpers/analytics-fixture.mjs";
import { loadoutOwner } from "./helpers/loadout-fixture.mjs";
import { speakingSessionId } from "./helpers/speaking-fixture.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3001";
const artifacts = await mkdtemp(join(tmpdir(), "libitu-analytics-"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const reportPath = `/speaking/${speakingSessionId}/analytics`;
try {
  for (const width of [1440, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1050 } }); const page = await context.newPage();
    const { auth, feedback } = await installAnalyticsFixture(page, { origin });
    try {
      await page.goto(origin + reportPath, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Your mission report", exact: true }).waitFor();
      assert.equal(await page.getByRole("tab").count(), 4);
      assert.equal(await page.getByText("Fluency", { exact: true }).count(), 0);
      const task = page.getByRole("tab", { name: /^Task fit/ }); await task.focus(); await page.keyboard.press("ArrowRight");
      assert.equal(await page.getByRole("tab", { name: /^Language transfer/ }).getAttribute("aria-selected"), "true");
      await page.getByRole("heading", { name: "Expressions", exact: true }).waitFor();
      await page.getByRole("heading", { name: "Structures", exact: true }).waitFor();
      await page.getByText("0 independent · 1 prompted", { exact: true }).waitFor();
      await page.getByRole("tabpanel").getByRole("link", { name: /To be fair/ }).click();
      assert.equal(await page.locator("#source-report-message-1 mark").textContent(), "To be fair");
      assert.equal(await page.evaluate(() => document.activeElement.id), "source-report-message-1");
      await page.getByRole("tab", { name: /^Naturalness/ }).click();
      await page.getByRole("button", { name: "Save AI suggestion", exact: true }).click();
      await page.getByRole("button", { name: "Saved to corpus", exact: true }).waitFor();
      assert.equal(auth.corpusSaves.length, 1); assert.match(auth.corpusSaves[0].input.usage_context, /AI-generated suggestion/);
      assert.equal(auth.corpusSaves[0].input.source_locator.source_url, origin + reportPath);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `no overflow ${width}`);
      await page.screenshot({ path: join(artifacts, `report-${width}.png`), fullPage: true });
      await page.reload({ waitUntil: "domcontentloaded" }); await page.getByRole("heading", { name: "Your mission report", exact: true }).waitFor();
      assert.equal(feedback.posts.length, 0, "refresh never regenerates completed report");
      await page.getByRole("button", { name: "Save AI suggestion", exact: true }).click(); await page.getByRole("button", { name: "Saved to corpus", exact: true }).waitFor();
      assert.equal(auth.cloud.get(loadoutOwner).size, 4, "repeated suggestion save deduplicates stable provenance key");
      await page.evaluate(() => { localStorage.setItem("libitu:loadout:v1", JSON.stringify({ version: 1, guest: null, accounts: { "loadout-browser-a": { draft: { scenarioType: "everyday", goal: "Keep my unrelated draft", difficulty: "guided", feedbackLevel: "light", logicTemplateId: null, selectedKeys: [] }, deviceDrafts: [] } } })); });
      await page.getByRole("button", { name: /Adjust loadout/ }).click(); await page.waitForURL("**/loadout?reportImport=saved");
      await page.getByRole("button", { name: "Use device draft", exact: true }).waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Mission goal", exact: true }).inputValue(), "Keep my unrelated draft");
      await page.goto(origin + reportPath, { waitUntil: "domcontentloaded" }); await page.getByRole("heading", { name: "Your mission report", exact: true }).waitFor();
      auth.failNextCreate = true; await page.getByRole("button", { name: /Retry this mission/ }).click();
      await page.getByText("Fixture connection interrupted. Please retry.", { exact: true }).waitFor();
      await page.getByRole("button", { name: /Retry this mission/ }).click(); await page.waitForURL(/\/speaking\/10000000/);
      assert.equal(auth.creates.length, 2); assert.deepEqual(auth.creates[0].input, auth.creates[1].input, "lost create retries same client ID");
      assert.equal(auth.creates[0].input.goal, "Align the migration plan"); assert.equal(auth.creates[0].input.corpus_item_ids.length, 3);
      await page.goto(origin + reportPath, { waitUntil: "domcontentloaded" }); await page.getByRole("heading", { name: "Your mission report", exact: true }).waitFor();
      await page.evaluate(() => window.__setLoadoutUser("other-owner")); await page.getByRole("heading", { name: "Report unavailable", exact: true }).waitFor();
      assert.equal(await page.getByText("Align the migration plan", { exact: true }).count(), 0); assert.deepEqual(auth.errors, []);
      console.log(`PASS ${width}: dimensions, keyboard, grouped transfer, source focus, corpus save/reload dedup, preserved draft, idempotent retry, owner switch`);
    } catch (error) { await page.screenshot({ path: join(artifacts, `failure-${width}.png`), fullPage: true }); throw error; }
    finally { await context.close(); }
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } }); const page = await context.newPage();
  const { auth, feedback } = await installAnalyticsFixture(page, { origin, status: "queued", missing: true });
  await page.goto(origin + reportPath, { waitUntil: "domcontentloaded" }); await page.getByText("Your report is queued", { exact: true }).waitFor();
  assert.deepEqual(feedback.posts, [{ retry: false }]); assert.equal(await page.getByText("Not assessed", { exact: true }).count(), 4);
  feedback.report = analyticsReport("partial"); await page.getByText("Some feedback is available", { exact: true }).waitFor();
  assert.equal(await page.getByRole("img", { name: /out of 100/ }).count(), 0, "partial chart never plots missing score as zero");
  await page.screenshot({ path: join(artifacts, "partial-390.png"), fullPage: true });
  feedback.report = analyticsReport("ready"); await page.getByRole("button", { name: "Retry assessment", exact: true }).click();
  await page.getByRole("img", { name: /out of 100/ }).waitFor(); assert.deepEqual(feedback.posts, [{ retry: false }, { retry: true }]);
  auth.cloud.get(loadoutOwner).delete(`corpus-fixture:${feedback.report.session.items[0].corpus_item_id}`);
  await page.getByRole("button", { name: /Retry this mission/ }).click(); await page.waitForURL("**/loadout?reportImport=active&replaceMissing=1");
  await page.getByText(/Some original items were deleted/).waitFor(); assert.equal(auth.creates.length, 0);
  await page.goto(origin + reportPath, { waitUntil: "domcontentloaded" }); await page.getByRole("heading", { name: "Your mission report", exact: true }).waitFor();
  await page.evaluate(() => window.__setLoadoutUser(null)); await page.getByRole("heading", { name: "Sign in to view your report", exact: true }).waitFor();
  assert.equal(await page.getByRole("tab").count(), 0); assert.deepEqual(auth.errors, []); await context.close();
  console.log("PASS queued/create, partial/null chart, explicit retry, deleted corpus replacement, logout");
  for (const status of ["failed", "insufficient_data"]) {
    const stateContext = await browser.newContext({ viewport: { width: 768, height: 1024 }, reducedMotion: "reduce" }); const statePage = await stateContext.newPage();
    const fixture = await installAnalyticsFixture(statePage, { origin, status });
    if (status === "insufficient_data") { fixture.feedback.report.messages = []; fixture.feedback.report.result.dimensions.forEach(dimension => { dimension.score = null; dimension.criteria = []; }); fixture.feedback.report.result.item_results = []; fixture.feedback.report.result.refactors = []; fixture.feedback.report.result.logic_stages = []; }
    await statePage.goto(origin + reportPath, { waitUntil: "domcontentloaded" }); await statePage.getByRole("heading", { name: "Your mission report", exact: true }).waitFor();
    assert.equal(await statePage.getByText("Not assessed", { exact: true }).count(), 4); assert.equal(await statePage.getByRole("img", { name: /out of 100/ }).count(), 0);
    assert.equal(await statePage.getByRole("button", { name: "Retry assessment", exact: true }).count(), status === "failed" ? 1 : 0);
    assert.equal(await statePage.evaluate(() => getComputedStyle(document.querySelector('[role="tab"]')).transitionDuration), "0s");
    assert.equal(await statePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await statePage.screenshot({ path: join(artifacts, `${status}-768.png`), fullPage: true }); assert.deepEqual(fixture.auth.errors, []); await stateContext.close();
  }
  console.log(`PASS failed/insufficient-data/reduced-motion states. Screenshots: ${artifacts}`);
} finally { await browser.close(); }
