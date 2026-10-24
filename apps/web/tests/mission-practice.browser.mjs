import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAnalyticsFixture } from "./helpers/analytics-fixture.mjs";
import { loadoutOwner } from "./helpers/loadout-fixture.mjs";
import { speakingSessionId } from "./helpers/speaking-fixture.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3005";
const artifacts = await mkdtemp(join(tmpdir(), "libitu-mission-practice-"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const reportPath = `/speaking/${speakingSessionId}/analytics`;
const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS" };
const oldDraft = { scenarioType: "everyday", goal: "Keep my unrelated draft", difficulty: "guided",
  feedbackLevel: "light", logicTemplateId: null, selectedKeys: [], supportLevel: "model_frame" };

async function snapshot(page) {
  return page.evaluate(owner => JSON.parse(localStorage.getItem("libitu:loadout:v1")).accounts[owner], loadoutOwner);
}
async function saved(page) {
  await page.waitForFunction(() => document.querySelector("[data-pending]")?.getAttribute("data-pending") === "false");
}
async function select(page, label, option) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function screenshot(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, name);
  await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
}
function reference(message) {
  return { message_id: message.id, transcript_revision: message.revision, quote: message.text, start: 0, end: message.text.length };
}
async function install(page) {
  const fixture = await installAnalyticsFixture(page, { origin, planned: true });
  const report = fixture.feedback.report;
  report.analysis_version = "speaking-feedback-v3"; report.rubric_version = "speaking-rubric-v2";
  report.effective_support_level = "model_frame";
  report.session.support_level = "model_frame"; report.session.evidence_contract_version = "speaking-evidence-v3";
  report.session.items.forEach(item => {
    item.source_corpus_item_id = item.corpus_item_id;
    const cloud = [...fixture.auth.cloud.get(loadoutOwner).values()].find(row => row.id === item.corpus_item_id);
    cloud.slots = structuredClone(item.slots);
  });
  report.messages[1].text = "The current system still works. A safe transition is the priority.";
  Object.assign(report.result.item_results[0], { status: "not_observed", independent_uses: 0, prompted_uses: 0,
    evidence: [], qualifying_independent_evidence: [], opportunity_status: "offered" });
  report.result.statistics.used_primary_targets = 0;
  const original = reference(report.messages[5]);
  report.result.missed_opportunities_status = "ready";
  report.result.missed_opportunities = [{
    id: "missed-1", session_item_id: report.session.items[0].id, opportunity_attempt_id: "attempt-1",
    opportunity_response_id: "response-1", original,
    suggested: "To be fair, I would explain the risk and ask for their ideas.",
    reason: "Acknowledge the team's perspective while keeping your own stated plan.", basis: "ai_suggestion",
  }, {
    id: "missed-invalid", session_item_id: report.session.items[0].id, opportunity_attempt_id: "attempt-stale",
    opportunity_response_id: "response-stale", original: { ...original, transcript_revision: 99 },
    suggested: "A stale suggestion must remain hidden.", reason: "Stale fixture.", basis: "ai_suggestion",
  }];
  fixture.auth.plans = new Map([[report.session.mission_plan.plan_id, {
    owner: loadoutOwner,
    plan: { candidates: [{ ...report.session.mission_plan, id: report.session.mission_plan.candidate_id }] },
  }]]);
  const state = { ...fixture, plans: [], recommendations: [], comparisons: [], comparison: null, planGate: null };
  function authorize(route) {
    if (route.request().method() === "OPTIONS") return false;
    const token = route.request().headers().authorization?.split(" ")[1];
    return token && JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub === loadoutOwner;
  }
  await page.route(`**/api/speaking/sessions/${speakingSessionId}/practice-plans`, async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (!authorize(route)) return route.fulfill({ status: 404, headers, json: { detail: "Not found" } });
    const input = route.request().postDataJSON(); state.plans.push(input);
    const plan = {
      id: "50000000-0000-4000-8000-000000000001", version: 1, scenario_type: "workplace",
      brief: "A second discussion about a migration.", created_at: "2026-10-20T10:00:00Z",
      practice_source: { parent_session_id: speakingSessionId, root_session_id: speakingSessionId,
        variation: input.variation, parent_snapshot_hash: "a".repeat(64) },
      candidates: [0, 1].map(index => ({
        id: `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        title: index ? "Review a different migration detail" : "Review a staged rollout",
        setting: "A follow-up meeting about a staged migration.", goal: "Agree on a staged rollout.",
        user_role: input.variation === "role_swap" ? "Reviewer" : "Project lead",
        ai_role: input.variation === "role_swap" ? "Project lead" : "Reviewer", register: "professional",
        targets: report.session.mission_plan.targets.map(target => {
          const snapshot = { ...target }; delete snapshot.session_item_id; return snapshot;
        }),
        changes: [{ field: "setting", before: report.session.mission_plan.setting, after: "A follow-up meeting about a staged migration." }],
      })),
    };
    fixture.auth.plans ??= new Map(); fixture.auth.plans.set(plan.id, { owner: loadoutOwner, plan });
    if (state.planGate) await state.planGate;
    return route.fulfill({ status: 201, headers, json: plan }).catch(() => {});
  });
  await page.route("**/api/speaking/support-recommendations", async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (!authorize(route)) return route.fulfill({ status: 404, headers, json: { detail: "Not found" } });
    const input = route.request().postDataJSON(); state.recommendations.push(input);
    return route.fulfill({ headers, json: {
      status: "suggest_reduce", current_level: input.current_level, suggested_level: "no_hint",
      rule_version: "support-history-v1", as_of: "2026-10-20T10:00:00Z", history_truncated: false,
      reason: "Recorded practice supports trying less help; this is not a mastery rating.",
      targets: input.targets.map(target => ({ ...target, qualifying_missions: 3, practice_days: 2, scene_roots: 2,
        eligible: target.role === "primary", evidence: [{ session_id: speakingSessionId, report_id: report.id,
          practiced_at: "2026-10-18T10:00:00Z" }] })),
    } });
  });
  await page.route(`**/api/speaking/sessions/${speakingSessionId}/practice-comparison`, async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    assert.equal(route.request().method(), "GET", "comparison only reads existing reports");
    if (!authorize(route)) return route.fulfill({ status: 404, headers, json: { detail: "Not found" } });
    state.comparisons.push(route.request().method());
    return route.fulfill({ headers, json: state.comparison });
  });
  return state;
}

try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 } });
    const page = await context.newPage();
    const state = await install(page);
    try {
      await page.goto(origin + reportPath, { waitUntil: "domcontentloaded", timeout: 90_000 });
      const missed = page.getByRole("region", { name: "Missed opportunities", exact: true });
      await missed.getByRole("heading", { name: "Your original reply", exact: true }).waitFor();
      assert.equal(await missed.getByRole("heading", { name: "AI suggestion", exact: true }).count(), 1);
      assert.equal(await missed.getByText("A stale suggestion must remain hidden.", { exact: true }).count(), 0);
      assert.match(await missed.innerText(), /do not count toward your results/);
      await missed.getByRole("link", { name: "View source", exact: true }).click();
      assert.equal(await page.locator("#source-report-message-5 mark").innerText(), state.feedback.report.messages[5].text);
      await page.waitForFunction(() => document.activeElement.id === "source-report-message-5");
      assert.equal(await page.evaluate(() => document.activeElement.id), "source-report-message-5");
      assert.equal(await page.getByRole("complementary", { name: "Report summary and next steps" })
        .locator("dl > div").filter({ has: page.getByText("Primary targets used", { exact: true }) }).locator("dd").innerText(), "0");
      await screenshot(page, `missed-report-${width}`);
      await page.evaluate(({ owner, draft }) => localStorage.setItem("libitu:loadout:v1",
        JSON.stringify({ version: 1, guest: null, accounts: { [owner]: { draft, deviceDrafts: [] } } })), { owner: loadoutOwner, draft: oldDraft });
      const second = page.getByRole("region", { name: "Prepare a second round", exact: true });
      assert.equal(await second.getByRole("combobox", { name: "Second-round support", exact: true }).innerText(), "Label only");
      if (width === 390) await select(page, "Practice variation", "Swap roles");
      let release;
      state.planGate = new Promise(resolve => { release = resolve; });
      await second.getByRole("button", { name: "Prepare second round", exact: true }).evaluate(button => { button.click(); button.click(); });
      await second.getByRole("button", { name: "Preparing second round…", exact: true }).waitFor();
      release(); state.planGate = null;
      await second.getByRole("heading", { name: "Review the changes", exact: true }).waitFor();
      assert.deepEqual(state.plans, [{ variation: width === 390 ? "role_swap" : "details" }], "double-click makes one preparation");
      assert.deepEqual((await snapshot(page)).draft, oldDraft, "generation cannot replace the existing draft");
      assert.equal(state.auth.creates.length, 0, "reviewing a plan does not create a mission");
      await screenshot(page, `practice-review-${width}`);
      await second.getByRole("button", { name: "Confirm and open Loadout", exact: true }).click();
      await page.waitForURL("**/loadout?reportImport=saved");
      assert.deepEqual((await snapshot(page)).draft, oldDraft);
      await page.getByRole("button", { name: "Use device draft", exact: true }).click();
      await page.getByRole("button", { name: "Unlink second round", exact: true }).waitFor();
      await saved(page);
      const linkedDraft = (await snapshot(page)).draft;
      assert.equal(linkedDraft.plan.value.practice_source.parent_session_id, speakingSessionId);
      assert.equal(linkedDraft.supportLevel, "label_only");
      assert.equal(await page.getByRole("textbox", { name: "Scene preferences", exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("combobox", { name: "Mission support", exact: true }).isDisabled(), false);
      await page.getByRole("button", { name: "Check practice history", exact: true }).click();
      const history = page.getByRole("region", { name: "Practice history", exact: true });
      await history.getByRole("button", { name: "Apply suggested support", exact: true }).waitFor();
      assert.equal((await snapshot(page)).draft.supportLevel, "label_only", "history never changes support automatically");
      assert.equal(state.recommendations.length, 1);
      await screenshot(page, `practice-history-${width}`);
      await history.getByRole("button", { name: "Apply suggested support", exact: true }).click();
      await saved(page);
      assert.equal((await snapshot(page)).draft.supportLevel, "no_hint");
      assert.equal((await snapshot(page)).draft.plan.value.id, linkedDraft.plan.value.id, "support change preserves frozen scene choices");
      state.auth.failNextCreate = true;
      await page.getByRole("button", { name: "Start mission", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "Fixture connection interrupted." }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Unlink second round", exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("combobox", { name: "Mission support", exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "Check practice history", exact: true }).isDisabled(), true);
      const pending = (await snapshot(page)).draft;
      assert.ok(pending.submission, "uncertain create retains exact request");
      await page.getByRole("button", { name: "Retry start mission", exact: true }).click();
      await page.waitForURL(/\/speaking\/10000000/);
      assert.deepEqual(state.auth.creates[1].input, state.auth.creates[0].input);
      assert.equal(state.auth.creates[0].input.support_level, "no_hint");
      assert.equal(state.plans.length, 1, "uncertain create recovery never prepares another scene");
      assert.equal(state.feedback.posts.length, 0, "reading or practicing does not regenerate the report");
      assert.deepEqual(state.auth.errors, []);
      console.log(`PASS ${width}: grounded suggestions, source focus, explicit preparation, preserved draft, linked target lock, explicit support choice, idempotent recovery`);
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `failure-${width}.png`), fullPage: true });
      throw error;
    } finally { await context.close(); }
  }

  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    const page = await context.newPage();
    const state = await install(page);
    await page.goto(origin + reportPath, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Prepare second round", exact: true }).click();
    await page.getByRole("button", { name: "Confirm and open Loadout", exact: true }).click();
    await page.waitForURL("**/loadout?reportImport=active");
    await page.getByRole("button", { name: "Unlink second round", exact: true }).waitFor();
    await saved(page);
    const linked = (await snapshot(page)).draft;
    await page.getByRole("button", { name: "Unlink second round", exact: true }).click();
    await saved(page);
    const unlinked = (await snapshot(page)).draft;
    assert.equal(unlinked.plan, undefined);
    assert.deepEqual(unlinked.selectedKeys, linked.selectedKeys);
    assert.deepEqual(unlinked.targetRoles, linked.targetRoles);
    assert.equal(unlinked.supportLevel, linked.supportLevel);
    assert.equal(await page.getByRole("textbox", { name: "Scene preferences", exact: true }).isDisabled(), false);
    assert.equal(state.plans.length, 1);
    assert.equal(state.auth.creates.length, 0, "unlink is a local draft edit, never an implicit mission");
    await screenshot(page, "practice-unlinked-1440");
    assert.deepEqual(state.auth.errors, []); await context.close();
  }
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const state = await install(page);
    state.feedback.report.effective_support_level = "no_hint";
    await page.goto(origin + reportPath, { waitUntil: "domcontentloaded" });
    assert.equal(await page.getByRole("combobox", { name: "Second-round support", exact: true }).innerText(), "No automatic hints");
    let release;
    state.planGate = new Promise(resolve => { release = resolve; });
    await page.getByRole("button", { name: "Prepare second round", exact: true }).click();
    await page.getByRole("button", { name: "Preparing second round…", exact: true }).waitFor();
    await page.evaluate(() => window.__setLoadoutUser("another-practice-owner"));
    await page.getByRole("heading", { name: "Report unavailable", exact: true }).waitFor();
    release(); state.planGate = null;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole("button", { name: "Confirm and open Loadout", exact: true }).count(), 0);
    assert.equal(await page.getByText("Review a staged rollout", { exact: true }).count(), 0);
    assert.equal(state.auth.creates.length, 0);
    assert.deepEqual(state.auth.errors, []); await context.close();
  }
  console.log("PASS explicit unlink preserves selected targets and no-hint preference/account-switch cancellation");

  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const state = await install(page);
    await page.goto(origin + reportPath, { waitUntil: "domcontentloaded" });
    state.auth.failNextCreate = true;
    await page.getByRole("button", { name: /^Retry this mission/ }).click();
    await page.getByRole("alert").filter({ hasText: "Fixture connection interrupted." }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Prepare second round", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: /^Adjust loadout/ }).isDisabled(), true);
    const originalRequest = structuredClone(state.auth.creates[0].input);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Your mission report", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Prepare second round", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: /^Adjust loadout/ }).isDisabled(), true);
    const corpusReads = state.auth.requests.filter(request => request.path === "/api/corpus" && request.method === "GET").length;
    const stored = [...state.auth.sessions.values()].find(session => session.client_id === originalRequest.client_id);
    assert.ok(stored, "the fixture saved a session before simulating a lost response");
    state.auth.cloud.get(loadoutOwner).delete(`corpus-fixture:${originalRequest.corpus_item_ids[0]}`);
    // Real idempotency recovery resolves the existing session before inspecting
    // today's corpus. The generic fixture deliberately validates new requests,
    // so model that already-saved recovery with this narrowly scoped route.
    await page.route("**/api/speaking/sessions", async route => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      assert.equal(route.request().method(), "POST");
      const input = route.request().postDataJSON();
      assert.deepEqual(input, originalRequest);
      assert.equal(state.auth.requests.filter(request => request.path === "/api/corpus" && request.method === "GET").length, corpusReads,
        "an uncertain report retry recovers the frozen payload without rereading changed corpus");
      state.auth.creates.push({ owner: loadoutOwner, input });
      return route.fulfill({ status: 201, headers, json: stored });
    });
    await page.getByRole("button", { name: /^Retry this mission/ }).click();
    await page.waitForURL(/\/speaking\/10000000/);
    assert.equal(state.auth.creates.length, 2);
    assert.deepEqual(state.auth.creates[0].input, state.auth.creates[1].input);
    assert.equal(state.plans.length, 0, "uncertain retry cannot pay for a second-round preparation");
    assert.equal(state.feedback.posts.length, 0);
    assert.deepEqual(state.auth.errors, []); await context.close();
  }
  console.log("PASS report retry recovery survives refresh and source deletion without preparing another mission");

  for (const status of ["pending", "unavailable", "incompatible", "ready"]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const state = await install(page);
    const report = state.feedback.report;
    report.session.practice = { parent_session_id: status === "unavailable" ? null : "70000000-0000-4000-8000-000000000001",
      root_session_id: "70000000-0000-4000-8000-000000000001", variation: "details", changes: [] };
    state.comparison = {
      status, reason: `${status} comparison fixture: only recorded facts are shown.`,
      parent_session_id: report.session.practice.parent_session_id, child_session_id: speakingSessionId,
      parent_support_level: "model_frame", child_support_level: "label_only",
      items: status === "ready" ? [{ session_item_id: report.session.items[0].id, parent_session_item_id: "parent-item",
        text: "To be fair", role: "primary",
        before: { status: "appropriate", opportunity_status: "used", independent_uses: 0, prompted_uses: 1, uncertain_assistance_uses: 0, excluded_reason: null },
        after: { status: "appropriate", opportunity_status: "used", independent_uses: 1, prompted_uses: 0, uncertain_assistance_uses: 0, excluded_reason: null } }] : [],
    };
    await page.goto(origin + reportPath, { waitUntil: "domcontentloaded" });
    const comparison = page.getByRole("region", { name: "Practice comparison", exact: true });
    await comparison.getByText(state.comparison.reason, { exact: true }).waitFor();
    assert.equal(await comparison.getByText(/independent ·/).count(), status === "ready" ? 2 : 0,
      "unavailable comparisons never render missing observations as zero");
    assert.equal(await comparison.getByRole("link", { name: "View original report", exact: true }).count(), status === "unavailable" ? 0 : 1);
    assert.equal(state.feedback.posts.length, 0);
    assert.deepEqual(state.comparisons, ["GET"]);
    await screenshot(page, `practice-comparison-${status}-390`);
    assert.deepEqual(state.auth.errors, []); await context.close();
  }
  console.log(`PASS read-only comparison ready/pending/unavailable/incompatible and deleted parent. Screenshots: ${artifacts}`);
} finally {
  console.log(`Screenshots: ${artifacts}`);
  await browser.close();
}
