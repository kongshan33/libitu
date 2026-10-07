import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installProfileFixture, otherProfileOwner, profileFeedbackReport, profileFeedbackSessionId,
  profileFeedbackSummary, profileHistory, profileOwner } from "./helpers/profile-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const artifacts = await mkdtemp(join(tmpdir(), "libitu-profile-feedback-"));
const reportPath = `/speaking/${profileFeedbackSessionId}/analytics`;
const browser = await chromium.launch({ channel: process.env.LIBITU_BROWSER_CHANNEL ?? "chrome", headless: true });

const feedbackCard = (page) => page.locator('section[aria-labelledby="feedback-title"]');
const dimension = (page, name) => feedbackCard(page).getByRole("button", { name: new RegExp(`^${name}`) });

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
async function screenshot(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true,
    `${name} has no horizontal overflow`);
  await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
}
function availableHistory(status = "ready") {
  return profileHistory.map((row) => row.session_id === profileFeedbackSessionId
    ? { ...row, feedback: { id: "profile-report", status, available: true, unavailable_reason: null } } : row);
}

try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, timezoneId: "Asia/Shanghai" });
    const page = await context.newPage(); page.setDefaultTimeout(30_000);
    const state = await installProfileFixture(page, { origin });
    let summary = profileFeedbackSummary();
    state.transformProfile = (data, request) => request.owner !== profileOwner ? data : {
      ...data, latest_feedback: summary, latest_feedback_unavailable_reason: null,
      recent_history: { items: availableHistory(summary.status).slice(0, 5), next_offset: 5 }
    };
    state.feedbackReports.set(profileFeedbackSessionId, profileFeedbackReport());
    try {
      await page.goto(`${origin}/profile`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await feedbackCard(page).getByRole("heading", { name: summary.goal, exact: true }).waitFor();
      assert.equal(await feedbackCard(page).getByRole("button").count(), 4);
      assert.match(await dimension(page, "Task fit").innerText(), /75\s*\/\s*100/);
      assert.match(await dimension(page, "Language transfer").innerText(), /67\s*\/\s*100/);
      assert.match(await dimension(page, "Task fit").innerText(), /AI assessment/);
      assert.match(await dimension(page, "Language transfer").innerText(), /Coverage/);
      assert.equal(await feedbackCard(page).evaluate((node) => Boolean(node.compareDocumentPosition(document.querySelector('[aria-labelledby="dimensions-title"]')) & Node.DOCUMENT_POSITION_FOLLOWING)), true,
        "conversation feedback is presented before overall learning dimensions");
      const naturalness = dimension(page, "Naturalness");
      await naturalness.focus(); await naturalness.press("Enter");
      assert.equal(await naturalness.getAttribute("aria-pressed"), "true");
      await page.locator("#mission-feedback-detail").getByText(/does not assess pronunciation or speech timing/).waitFor();
      const overall = page.getByRole("group", { name: "Learning dimensions", exact: true });
      assert.equal(await overall.getByText("Not assessed", { exact: true }).count(), 4);
      assert.equal(await overall.getByText("Not available yet", { exact: true }).count(), 1,
        "a Mission assessment does not fabricate overall ability or writing scores");
      assert.equal(state.requests.some((request) => request.path.endsWith("/feedback")), false,
        "profile reads summary data without generating or polling reports");
      assert.equal(await page.getByRole("link", { name: new RegExp(profileHistory[1].title) }).getAttribute("href"), reportPath);
      await screenshot(page, `feedback-ready-${width}`);

      await feedbackCard(page).getByRole("link", { name: "View full report", exact: true }).click();
      await page.waitForURL(`**${reportPath}`);
      await page.getByRole("heading", { name: "Your mission report", exact: true }).waitFor();
      assert.equal(await page.getByRole("tab").count(), 4, "profile opens the integrated Stage 5 report");
      assert.equal(state.requests.filter((request) => request.path.endsWith("/feedback")).length, 1);
      assert.equal(state.requests.every((request) => request.method === "GET"), true,
        "opening an existing report never creates another assessment");

      summary = profileFeedbackSummary("partial");
      summary.dimensions[0].score = 0;
      summary.dimensions[0].summary = "The available evidence supports a zero task-fit score for this conversation.";
      await page.goto(`${origin}/profile`, { waitUntil: "domcontentloaded" });
      await feedbackCard(page).getByText("Partial report", { exact: true }).waitFor();
      assert.match(await dimension(page, "Task fit").innerText(), /0\s*\/\s*100/,
        "a valid zero score is shown as zero");
      assert.match(await dimension(page, "Language transfer").innerText(), /Not assessed/,
        "a missing dimension score never becomes zero");
      assert.doesNotMatch(await dimension(page, "Language transfer").innerText(), /\/\s*100/);
      const transfer = dimension(page, "Language transfer");
      await transfer.focus(); await transfer.press("Space");
      assert.equal(await transfer.getAttribute("aria-pressed"), "true");
      await feedbackCard(page).getByText(/Missing scores stay unassessed/).waitFor();
      await screenshot(page, `feedback-partial-${width}`);
      assert.deepEqual(state.errors, []);
      console.log(`PASS ${width}: report summary, keyboard dimensions, score basis, zero/null, partial status, distinct ability scaffold, integrated report navigation, GET-only reads`);
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `failure-${width}.png`), fullPage: true });
      throw error;
    } finally { await context.close(); }
  }

  const stateContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const statePage = await stateContext.newPage();
  const fixture = await installProfileFixture(statePage, { origin });
  const historyCases = [
    ["Ready Mission", "ready", true, null, "View report"],
    ["Partial Mission", "partial", true, null, "Partial report"],
    ["Queued Mission", "queued", false, null, "Report queued"],
    ["Processing Mission", "processing", false, null, "Report in progress"],
    ["Failed Mission", "failed", false, null, "Report needs retry"],
    ["Limited Mission", "insufficient_data", false, null, "Limited evidence"],
    ["Earlier Mission", "ready", false, "version_mismatch", "View earlier report"],
    ["Invalid Mission", "ready", false, "invalid_result", "Check report"],
    ["Legacy Mission", "ready", false, "legacy_report", "View conversation"],
    ["No report Mission", null, false, null, "View report"],
    ["Active Mission", null, false, null, "Continue"]
  ];
  const rows = historyCases.map(([title, status, available, reason], index) => ({ ...profileHistory[1],
    id: `feedback-status-${index}`, title, status: title === "Active Mission" ? "active" : "completed",
    session_id: `10000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
    feedback: status ? { id: `status-report-${index}`, status, available, unavailable_reason: reason } : null
  }));
  let reason = "not_available";
  fixture.transformProfile = (data) => ({ ...data, latest_feedback: null, latest_feedback_unavailable_reason: reason,
    recent_history: { items: rows.slice(2, 5), next_offset: 3 } });
  fixture.transformHistory = () => ({ items: rows, next_offset: null });
  await statePage.goto(`${origin}/profile`, { waitUntil: "domcontentloaded" });
  await feedbackCard(statePage).getByText("Your next Mission can bring new insight", { exact: true }).waitFor();
  assert.equal(await feedbackCard(statePage).getByRole("button").count(), 0,
    "queued, processing, and failed reports never supply latest scores");
  for (const status of ["Report queued", "Report in progress", "Report needs retry"]) await statePage.getByText(status, { exact: true }).waitFor();
  assert.equal(fixture.requests.some((request) => request.path.endsWith("/feedback")), false,
    "pending status rendering does not initiate assessment jobs");
  await screenshot(statePage, "feedback-pending-390");
  reason = "version_mismatch";
  await statePage.reload({ waitUntil: "domcontentloaded" });
  await feedbackCard(statePage).getByText("Your earlier report is in your history", { exact: true }).waitFor();
  await feedbackCard(statePage).getByText(/current scoring rubric/).waitFor();
  assert.equal(await feedbackCard(statePage).getByRole("button").count(), 0);
  await screenshot(statePage, "feedback-version-mismatch-390");
  reason = "invalid_result";
  await statePage.reload({ waitUntil: "domcontentloaded" });
  await feedbackCard(statePage).getByText("This report needs a closer look", { exact: true }).waitFor();
  assert.equal(await feedbackCard(statePage).getByRole("button").count(), 0);
  reason = "legacy_report";
  await statePage.reload({ waitUntil: "domcontentloaded" });
  await feedbackCard(statePage).getByText("Your earlier conversation is in your history", { exact: true }).waitFor();
  await feedbackCard(statePage).getByText(/older record has no compatible report/).waitFor();
  assert.equal(await feedbackCard(statePage).getByRole("button").count(), 0,
    "legacy records do not fabricate scores or offer an incompatible report");
  await statePage.goto(`${origin}/profile/history`, { waitUntil: "domcontentloaded" });
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], label = historyCases[index][4];
    const link = statePage.getByRole("link", { name: new RegExp(`^${row.title}`) });
    await link.waitFor(); assert.match(await link.innerText(), new RegExp(label));
    assert.equal(await link.getAttribute("href"), row.status === "active" || row.feedback?.unavailable_reason === "legacy_report"
      ? `/speaking/${row.session_id}?returnTo=%2Fprofile` : `/speaking/${row.session_id}/analytics`);
  }
  assert.equal(fixture.requests.every((request) => request.method === "GET"), true);
  await screenshot(statePage, "feedback-history-states-390");
  assert.deepEqual(fixture.errors, []); await stateContext.close();
  console.log("PASS status-only history, pending/failed suppression, version mismatch, invalid result, safe legacy conversation recovery, completed-versus-active destinations, no assessment creation");

  const raceContext = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const racePage = await raceContext.newPage();
  const raceFixture = await installProfileFixture(racePage, { origin });
  const summary = profileFeedbackSummary();
  raceFixture.transformProfile = (data, request) => request.owner === profileOwner
    ? { ...data, latest_feedback: summary, latest_feedback_unavailable_reason: null } : data;
  await racePage.goto(`${origin}/profile`, { waitUntil: "domcontentloaded" });
  await dimension(racePage, "Task fit").waitFor();
  const oldRequest = gate(); raceFixture.profileGate = oldRequest.promise;
  await racePage.getByRole("button", { name: "Last 3 months", exact: true }).click();
  await waitFor(() => raceFixture.requests.some((request) => request.owner === profileOwner && request.query.range === "3m"), "old account range read started");
  const newRequest = gate(); raceFixture.profileGate = newRequest.promise;
  await racePage.evaluate((owner) => window.__setProfileUser(owner), otherProfileOwner);
  await waitFor(() => raceFixture.requests.some((request) => request.owner === otherProfileOwner), "new account profile read started");
  assert.equal(await feedbackCard(racePage).getByRole("button").count(), 0,
    "old account scores clear before a new account's request resolves");
  assert.equal(await racePage.getByText(summary.goal, { exact: true }).count(), 0);
  newRequest.release();
  await feedbackCard(racePage).getByText("Your next Mission can bring new insight", { exact: true }).waitFor();
  oldRequest.release();
  await waitFor(() => raceFixture.responses.some((request) => request.owner === profileOwner && request.query.range === "3m"), "late prior-account report summary resolved");
  await settle(racePage);
  assert.equal(await feedbackCard(racePage).getByRole("button").count(), 0);
  assert.equal(await racePage.getByText(summary.goal, { exact: true }).count(), 0,
    "a delayed old-account score/goal cannot reappear");
  assert.deepEqual(raceFixture.errors, []); await raceContext.close();
  console.log("PASS account isolation: prior scores and Mission goal clear immediately and remain absent after delayed responses");
  console.log(`Screenshots: ${artifacts}`);
} finally { await browser.close(); }
