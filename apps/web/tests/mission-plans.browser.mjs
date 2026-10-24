import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureRecords, installLoadoutFixture, loadoutOwner } from "./helpers/loadout-fixture.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const artifacts = await mkdtemp(join(tmpdir(), "libitu-mission-plans-"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,authorization", "access-control-allow-methods": "GET,POST,OPTIONS" };
async function saved(page) {
  await page.waitForFunction(() => document.querySelector("[data-pending]")?.getAttribute("data-pending") === "false");
}
async function layout(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${name}: no horizontal overflow`);
  await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
}
async function selectThree(page) {
  for (const record of [fixtureRecords[4], fixtureRecords[5], fixtureRecords[0]]) await page.getByRole("button", { name: `Select ${record.item.text}`, exact: true }).click();
  await saved(page);
}
async function accountDraft(page) {
  return page.evaluate(owner => JSON.parse(localStorage.getItem("libitu:loadout:v1")).accounts[owner].draft, loadoutOwner);
}
function varyNextPlan(state, transform) {
  // The fixture awaits this gate after storing the plan but before serializing
  // its response. Give the UI distinct model estimates without live API calls.
  const gate = {
    then(resolve) {
      transform([...state.plans.values()].at(-1).plan);
      if (state.planGate === gate) state.planGate = null;
      resolve();
    }
  };
  state.planGate = gate;
}
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 } });
    const page = await context.newPage();
    const state = await installLoadoutFixture(page, { origin });
    const events = []; let socket;
    await page.route("**/api/speaking/sessions/*/realtime", async route => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      const id = new URL(route.request().url()).pathname.split("/")[4];
      return route.fulfill({ headers, json: { runtime_id: "runtime", ticket: "fixture", expires_at: new Date(Date.now() + 30_000).toISOString(), websocket_path: `/api/speaking/sessions/${id}/realtime/runtime` } });
    });
    await page.routeWebSocket("**/api/speaking/sessions/*/realtime/runtime", ws => {
      socket = ws;
      ws.onMessage(raw => {
        const event = JSON.parse(String(raw)); events.push(event);
        const workspace = [...state.workspaces.values()][0];
        if (event.type === "authenticate") ws.send(JSON.stringify({ type: "ready", workspace }));
        if (event.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        if (event.type === "target.skip" || event.type === "target.restore") {
          const target = workspace.opportunities.find(value => value.session_item_id === event.target_item_id);
          target.status = event.type === "target.skip" ? "skipped" : target.reflected && target.presented ? "offered" : "planned";
          target.skipped_reason = event.type === "target.skip" ? event.reason : null;
          target.skipped_at = event.type === "target.skip" ? new Date().toISOString() : null;
          workspace.version++; ws.send(JSON.stringify({ type: "snapshot", workspace }));
        }
      });
    });
    await page.goto(`${origin}/loadout`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await selectThree(page);
    await page.getByRole("button", { name: "Sign in to start mission", exact: true }).click();
    await page.waitForFunction(() => window.__loadoutAuthCalls.length === 1);
    assert.equal(await page.evaluate(() => window.__loadoutAuthCalls.length), 1);
    await page.evaluate(owner => window.__setLoadoutUser(owner), loadoutOwner);
    await page.getByRole("button", { name: "Start mission", exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Start mission" && !button.disabled));
    assert.equal(await page.getByRole("button", { name: "Generate matching scenes", exact: true }).isVisible(), false, "manual scene comparison is optional and collapsed");
    await layout(page, `loadout-${width}`);
    const originalDraft = await accountDraft(page);
    state.failNextPlan = true;
    await page.getByRole("button", { name: "Start mission", exact: true }).click();
    const recovery = page.getByRole("region", { name: "Mission recovery", exact: true });
    await recovery.getByRole("alert").filter({ hasText: "Scene generation temporarily unavailable." }).waitFor();
    assert.match(await recovery.getByRole("alert").innerText(), /This is a system issue, not evidence that you chose the wrong targets/);
    assert.deepEqual(await accountDraft(page), originalDraft, "system errors preserve every selected target, role and preference");
    assert.equal(state.planRequests.length, 1, "a system failure does not automatically request another plan");
    assert.equal(state.creates.length, 0, "failed planning never creates a fabricated mission");
    assert.equal(await recovery.getByRole("button", { name: /^Make .+ an opportunity$/ }).count(), 0,
      "a system failure cannot invent target-fit advice");
    await recovery.getByRole("button", { name: "Selection tips", exact: true }).click();
    assert.equal(await page.getByText("How to choose targets", { exact: true }).evaluate(node => node.parentElement.open), true);
    await page.getByText("Opportunity targets do not have to be used.", { exact: false }).waitFor();
    await recovery.getByRole("button", { name: "Add scene preferences", exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "Scene preferences", exact: true }).evaluate(node => document.activeElement === node), true);
    assert.deepEqual(await accountDraft(page), originalDraft, "optional guidance does not silently change the selection");
    await layout(page, `system-recovery-${width}`);
    let releasePlan, releaseCreate;
    state.createGate = new Promise(resolve => { releaseCreate = resolve; });
    state.planGate = new Promise(resolve => { releasePlan = resolve; });
    state.failNextCreate = true;
    await recovery.getByRole("button", { name: "Retry preparation", exact: true }).evaluate(button => { button.click(); button.click(); });
    await page.getByRole("button", { name: "Preparing scene…", exact: true }).waitFor();
    state.planGate = null; releasePlan();
    await page.getByRole("button", { name: "Saving mission…", exact: true }).waitFor();
    await page.getByText("Choose a scene myself", { exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Scene selected", exact: true }).isDisabled(), true, "scene selection is frozen during session creation");
    state.createGate = null; releaseCreate();
    await page.getByRole("alert").filter({ hasText: "Fixture connection interrupted." }).waitFor();
    assert.equal(await recovery.getByRole("button", { name: "Retry saving mission", exact: true }).isVisible(), true);
    assert.equal(await recovery.getByRole("button", { name: "Selection tips", exact: true }).count(), 0,
      "an uncertain create offers exact recovery without inviting target changes");
    await saved(page);
    assert.equal(state.planRequests.length, 2, "one deliberate planning retry and no double-click duplicate");
    assert.equal(state.planRequests[1].input.candidate_count, 1, "automatic Start requests only one scene");
    assert.equal([...state.plans.values()].at(-1).plan.candidates.length, 1);
    assert.deepEqual(state.planRequests[1].input.targets.map(value => value.role), ["primary", "primary", "opportunity"]);
    assert.equal(state.creates[0].input.candidate_id, [...state.plans.values()].at(-1).plan.candidates[0].id, "equal fit picks the first scene stably");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Retry start mission", exact: true }).click();
    await page.waitForURL(/\/speaking\/10000000/);
    assert.equal(state.planRequests.length, 2, "uncertain create retries never pay for a new plan");
    assert.deepEqual(state.creates[1].input, state.creates[0].input, "uncertain create retries exact planned request");
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "Connect for text", exact: true }).click();
    await page.getByRole("status").filter({ hasText: /^Connected$/ }).waitFor();
    if (width === 390) {
      assert.equal(events.some(event => event.type === "target.shown"), false, "closed mobile sidebar does not expose target wording");
      await page.getByRole("button", { name: "Loadout", exact: true }).click();
    }
    const sidebar = page.getByRole("complementary", { name: "Training sidebar" });
    await sidebar.getByRole("heading", { name: fixtureRecords[4].item.text, exact: true }).scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const workspace = [...state.workspaces.values()][0];
    Object.assign(workspace.opportunities[0], { status: "offered", sent: true, bound: true, reflected: true, presented: true, last_response_id: "response-1" });
    workspace.version++; socket.send(JSON.stringify({ type: "snapshot", workspace }));
    await sidebar.getByRole("status").filter({ hasText: "Opportunity confirmed" }).waitFor();
    await sidebar.getByRole("button", { name: "Doesn't fit this scene", exact: true }).first().click();
    await sidebar.getByRole("status").filter({ hasText: "Skipped · excluded from assessment" }).waitFor();
    assert.equal(workspace.opportunities[0].reflected, true, "skip retains delivery facts");
    assert.equal(await sidebar.locator("section > div").filter({ has: page.getByText("Skipped", { exact: true }) }).locator("strong").innerText(), "1");
    assert.equal(await sidebar.getByText("Language observed", { exact: true }).count(), 0, "planned missions keep optional and skipped counts separate");
    await sidebar.getByRole("button", { name: "Undo skip", exact: true }).click();
    await sidebar.getByRole("status").filter({ hasText: "Opportunity confirmed" }).waitFor();
    assert.equal(await sidebar.locator("section > div").filter({ has: page.getByText("Skipped", { exact: true }) }).locator("strong").innerText(), "0");
    workspace.opportunities.forEach(target => { target.status = "skipped"; });
    workspace.version++; socket.send(JSON.stringify({ type: "snapshot", workspace }));
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Need a hint?" && button.disabled));
    assert.equal(await page.getByRole("button", { name: "Need a hint?", exact: true }).isDisabled(), true);
    workspace.opportunities.forEach((target, index) => { target.status = index === 0 ? "offered" : "planned"; });
    workspace.version++; socket.send(JSON.stringify({ type: "snapshot", workspace }));
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Need a hint?" && !button.disabled));
    await page.getByRole("button", { name: "Chat", exact: true }).scrollIntoViewIfNeeded();
    await layout(page, `mission-${width}`);
    assert.ok(events.some(event => event.type === "target.shown" && event.target_item_id === "snapshot-0"), "visible target wording has an exposure receipt");
    assert.equal(state.errors.length, 0, state.errors.join("\n"));
    await context.close();
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  const state = await installLoadoutFixture(page, { origin, initialOwner: loadoutOwner });
  await page.goto(`${origin}/loadout`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await selectThree(page);
  await page.getByText("Choose a scene myself", { exact: true }).click();
  let release;
  state.planGate = new Promise(resolve => { release = resolve; });
  await page.getByRole("button", { name: "Generate matching scenes", exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.getByText("Planning roles, goals and natural opportunities for your targets…").waitFor();
  await page.getByRole("textbox", { name: "Scene preferences", exact: true }).fill("A changed preference");
  release(); state.planGate = null;
  await saved(page);
  assert.equal(await page.getByRole("group", { name: "Matching scenes", exact: true }).count(), 0, "late result cannot replace changed inputs");
  await page.getByRole("button", { name: "Generate matching scenes", exact: true }).click();
  await page.getByRole("button", { name: "Choose Plan a small launch", exact: true }).click();
  await saved(page);
  assert.equal(state.planRequests.length, 2, "double click starts only one generation before the deliberate retry");
  await page.getByRole("textbox", { name: "Scene preferences", exact: true }).fill("Another preference");
  await saved(page);
  assert.equal(await page.getByRole("group", { name: "Matching scenes", exact: true }).count(), 0);
  state.nextPlanFit = "unknown";
  await page.getByRole("button", { name: "Generate matching scenes", exact: true }).click();
  await page.getByRole("button", { name: "Choose Plan a small launch", exact: true }).click();
  await page.getByRole("button", { name: "Start mission", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "No prepared scene fits every primary target yet." }).waitFor();
  assert.equal(state.creates.length, 0, "unknown primary fit cannot create a mission");
  assert.equal(state.planRequests.length, 3, "unsuitable cached scenes are not regenerated without an explicit request");
  state.planGate = new Promise(resolve => { release = resolve; });
  await page.getByRole("button", { name: "Generate new scenes", exact: true }).click();
  await page.getByText("Planning roles, goals and natural opportunities for your targets…").waitFor();
  await page.evaluate(() => window.__setLoadoutUser("other-owner"));
  release();
  await page.getByRole("heading", { name: "Mission loadout" }).waitFor();
  await saved(page);
  assert.equal(await page.getByRole("group", { name: "Matching scenes", exact: true }).count(), 0, "account switch discards another owner's result");
  assert.equal(state.errors.length, 0, state.errors.join("\n"));
  await context.close();
  const cachedContext = await browser.newContext(); const cachedPage = await cachedContext.newPage();
  const cached = await installLoadoutFixture(cachedPage, { origin, initialOwner: loadoutOwner });
  await cachedPage.goto(`${origin}/loadout`, { waitUntil: "domcontentloaded" }); await selectThree(cachedPage);
  await cachedPage.getByText("Choose a scene myself", { exact: true }).click();
  await cachedPage.getByRole("button", { name: "Generate matching scenes", exact: true }).click();
  await cachedPage.getByRole("button", { name: "Choose Plan a small launch", exact: true }).waitFor();
  await saved(cachedPage);
  await cachedPage.reload({ waitUntil: "domcontentloaded" });
  await cachedPage.getByRole("combobox", { name: "Difficulty", exact: true }).click();
  await cachedPage.getByRole("option", { name: "Guided", exact: true }).click();
  await cachedPage.getByRole("combobox", { name: "Feedback level", exact: true }).click();
  await cachedPage.getByRole("option", { name: "Detailed", exact: true }).click();
  await cachedPage.getByRole("combobox", { name: "Mission support", exact: true }).click();
  await cachedPage.getByRole("option", { name: "No automatic hints", exact: true }).click();
  await cachedPage.getByText("Conversation strategy · optional", { exact: true }).click();
  await cachedPage.getByRole("button", { name: /^Status update/ }).click();
  await saved(cachedPage);
  await cachedPage.getByRole("button", { name: "Start mission", exact: true }).click();
  await cachedPage.waitForURL(/\/speaking\/10000000/);
  assert.equal(cached.planRequests.length, 1, "a cached plan without an explicit scene choice is reused after reload");
  assert.equal(cached.creates.length, 1);
  assert.equal(cached.planRequests[0].input.candidate_count, 2, "manual comparison retains two candidates");
  assert.equal(cached.creates[0].input.difficulty, "guided");
  assert.equal(cached.creates[0].input.feedback_level, "detailed");
  assert.equal(cached.creates[0].input.logic_template_id, "status_update");
  assert.equal(cached.creates[0].input.support_level, "no_hint");
  await cachedPage.getByRole("button", { name: "Start conversation", exact: true }).waitFor();
  const timingNames = await cachedPage.evaluate(() => performance.getEntriesByType("measure").map(entry => entry.name));
  for (const phase of ["create_request", "workspace_read", "navigation_to_ready", "start_to_ready"]) assert.ok(timingNames.includes(`libitu:mission:${phase}`), phase);
  assert.deepEqual(cached.errors, []); await cachedContext.close();

  const unsuitableContext = await browser.newContext({ viewport: { width: 390, height: 844 } }); const unsuitablePage = await unsuitableContext.newPage();
  const unsuitable = await installLoadoutFixture(unsuitablePage, { origin, initialOwner: loadoutOwner });
  await unsuitablePage.goto(`${origin}/loadout`, { waitUntil: "domcontentloaded" }); await selectThree(unsuitablePage);
  const selectedBeforeFit = await accountDraft(unsuitablePage);
  const firstReason = "The launch scene has not established a natural opinion-sharing opportunity for this expression.";
  const otherReason = "The handoff scene needs a different tone for this expression.";
  varyNextPlan(unsuitable, plan => {
    Object.assign(plan.candidates[0].targets[0], { fit: "unknown", fit_reason: firstReason });
    Object.assign(plan.candidates[1].targets[1], { fit: "low", fit_reason: otherReason });
  });
  await unsuitablePage.getByText("Choose a scene myself", { exact: true }).click();
  await unsuitablePage.getByRole("button", { name: "Generate matching scenes", exact: true }).click();
  await unsuitablePage.getByRole("button", { name: "Choose Plan a small launch", exact: true }).waitFor();
  await unsuitablePage.getByRole("button", { name: "Start mission", exact: true }).click();
  const fitRecovery = unsuitablePage.getByRole("region", { name: "Mission recovery", exact: true });
  await fitRecovery.getByRole("heading", { name: "Review this scene's target fit", exact: true }).waitFor();
  assert.match(await fitRecovery.innerText(), /For Plan a small launch/);
  assert.equal(await fitRecovery.getByText(firstReason, { exact: true }).count(), 1);
  assert.equal(await fitRecovery.getByText(otherReason, { exact: true }).count(), 0,
    "fit guidance does not combine incompatible reasons from different scenes");
  assert.equal(await fitRecovery.getByRole("button", { name: /^Make .+ an opportunity$/ }).count(), 1);
  const afterFit = await accountDraft(unsuitablePage);
  assert.deepEqual(afterFit.selectedKeys, selectedBeforeFit.selectedKeys, "failed fit keeps all targets selected");
  assert.deepEqual(afterFit.targetRoles, selectedBeforeFit.targetRoles, "failed fit does not silently demote a target");
  assert.equal(await fitRecovery.getByText("Fit not established", { exact: true }).isVisible(), true);
  assert.equal(await fitRecovery.getByText("There is not enough evidence of a natural opportunity in this scene.", { exact: true }).isVisible(), true);
  await layout(unsuitablePage, "fit-recovery-390");
  await unsuitablePage.getByRole("group", { name: "Matching scenes", exact: true }).waitFor();
  await unsuitablePage.getByRole("button", { name: "Choose Agree on a team handoff", exact: true }).click();
  await saved(unsuitablePage);
  assert.equal(await fitRecovery.count(), 0, "choosing another scene clears advice for the old scene");
  await unsuitablePage.getByRole("button", { name: "Start mission", exact: true }).click();
  await fitRecovery.getByRole("heading", { name: "Review this scene's target fit", exact: true }).waitFor();
  assert.match(await fitRecovery.innerText(), /For Agree on a team handoff/);
  assert.equal(await fitRecovery.getByText(otherReason, { exact: true }).count(), 1);
  assert.equal(await fitRecovery.getByText(firstReason, { exact: true }).count(), 0);
  assert.equal(unsuitable.planRequests.length, 1, "unsuitable generated scenes stay available for comparison without repeated generation");
  assert.equal(unsuitable.creates.length, 0);
  await fitRecovery.getByRole("button", { name: `Make ${fixtureRecords[5].item.text} an opportunity`, exact: true }).click();
  await saved(unsuitablePage);
  const demoted = await accountDraft(unsuitablePage);
  assert.deepEqual(demoted.selectedKeys, selectedBeforeFit.selectedKeys, "explicit demotion keeps every selected item");
  assert.deepEqual(demoted.targetRoles, { ...selectedBeforeFit.targetRoles, [fixtureRecords[5].key]: "opportunity" });
  assert.equal(demoted.plan, undefined, "changing a target invalidates the old frozen candidate");
  assert.equal(await fitRecovery.count(), 0);
  assert.equal(unsuitable.planRequests.length, 1, "changing a role does not automatically spend another plan request");
  await unsuitablePage.getByText("Selected: 1 primary · 2 opportunity", { exact: true }).waitFor();
  unsuitable.nextPlanFit = "unknown";
  await unsuitablePage.getByRole("button", { name: "Start mission", exact: true }).click();
  await fitRecovery.getByRole("heading", { name: "Review this scene's target fit", exact: true }).waitFor();
  assert.equal(unsuitable.planRequests.length, 2, "only the learner's next Start requests a replacement plan");
  assert.equal(await fitRecovery.getByRole("button", { name: `Make ${fixtureRecords[4].item.text} an opportunity`, exact: true }).isDisabled(), true);
  assert.equal(await fitRecovery.getByRole("button", { name: `Remove ${fixtureRecords[4].item.text} from this mission`, exact: true }).isDisabled(), true,
    "recovery cannot discard the last primary target");
  await fitRecovery.getByText("Keep at least one primary target.", { exact: false }).waitFor();
  assert.deepEqual(unsuitable.errors, []); await unsuitableContext.close();

  const limitContext = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const limitPage = await limitContext.newPage();
  const limitState = await installLoadoutFixture(limitPage, { origin, initialOwner: loadoutOwner });
  await limitPage.goto(`${origin}/loadout`, { waitUntil: "domcontentloaded" }); await selectThree(limitPage);
  await limitPage.getByRole("button", { name: `Select ${fixtureRecords[1].item.text}`, exact: true }).click();
  await saved(limitPage);
  const beforeRemoval = await accountDraft(limitPage);
  varyNextPlan(limitState, plan => {
    for (const candidate of plan.candidates) Object.assign(candidate.targets[0], { fit: "low", fit_reason: "This expression does not suit the tone of this scene." });
  });
  await limitPage.getByRole("button", { name: "Start mission", exact: true }).click();
  const limitRecovery = limitPage.getByRole("region", { name: "Mission recovery", exact: true });
  await limitRecovery.getByRole("heading", { name: "Review this scene's target fit", exact: true }).waitFor();
  assert.equal(await limitRecovery.getByRole("button", { name: `Make ${fixtureRecords[4].item.text} an opportunity`, exact: true }).isDisabled(), true,
    "two existing opportunity targets prevent another demotion");
  await limitRecovery.getByText("You already have two opportunity targets.", { exact: false }).waitFor();
  await layout(limitPage, "fit-recovery-1440");
  await limitRecovery.getByRole("button", { name: `Remove ${fixtureRecords[4].item.text} from this mission`, exact: true }).click();
  await saved(limitPage);
  const afterRemoval = await accountDraft(limitPage);
  assert.deepEqual(afterRemoval.selectedKeys, beforeRemoval.selectedKeys.filter(key => key !== fixtureRecords[4].key));
  const expectedRoles = { ...beforeRemoval.targetRoles }; delete expectedRoles[fixtureRecords[4].key];
  assert.deepEqual(afterRemoval.targetRoles, expectedRoles, "explicit removal keeps every other target's role");
  assert.equal(afterRemoval.plan, undefined);
  assert.equal(await limitRecovery.count(), 0);
  assert.equal(limitState.planRequests.length, 1);
  assert.equal(limitState.creates.length, 0, "removing a target neither starts a mission nor prepares a replacement plan");
  assert.deepEqual(limitState.errors, []); await limitContext.close();

  const tabs = await browser.newContext(); const first = await tabs.newPage();
  const shared = await installLoadoutFixture(first, { origin, initialOwner: loadoutOwner });
  await first.goto(`${origin}/loadout`, { waitUntil: "domcontentloaded" }); await selectThree(first);
  const second = await tabs.newPage();
  await installLoadoutFixture(second, { origin, initialOwner: loadoutOwner, seedCorpus: false, sharedState: shared });
  await second.goto(`${origin}/loadout`, { waitUntil: "domcontentloaded" });
  let releaseStale;
  shared.planGate = new Promise(resolve => { releaseStale = resolve; });
  await first.getByRole("button", { name: "Start mission", exact: true }).click();
  await first.getByRole("button", { name: "Preparing scene…", exact: true }).waitFor();
  await second.getByRole("textbox", { name: "Scene preferences", exact: true }).fill("Changed in another tab"); await saved(second);
  releaseStale(); shared.planGate = null;
  await first.waitForFunction(() => document.querySelector("textarea")?.value === "Changed in another tab");
  await first.getByRole("button", { name: "Start mission", exact: true }).waitFor();
  assert.equal(shared.creates.length, 0, "late automatic preparation cannot start another tab's superseded draft");
  shared.planGate = new Promise(resolve => { releaseStale = resolve; });
  await first.getByRole("button", { name: "Start mission", exact: true }).click();
  await first.getByRole("button", { name: "Preparing scene…", exact: true }).waitFor();
  await first.evaluate(() => window.__setLoadoutUser("changed-owner"));
  releaseStale(); shared.planGate = null;
  await first.waitForFunction(() => document.querySelector("textarea")?.value !== "Changed in another tab");
  assert.equal(shared.creates.length, 0, "account switches cancel automatic start before creating a mission");
  assert.deepEqual(shared.errors, []); await tabs.close();
  const legacyContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const legacyPage = await legacyContext.newPage();
  const legacyState = await installLoadoutFixture(legacyPage, { origin, initialOwner: loadoutOwner });
  await legacyPage.goto(`${origin}/loadout`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await selectThree(legacyPage);
  const legacyKeys = [...fixtureRecords.slice(0, 3), ...fixtureRecords.slice(4, 9)].map(record => record.key);
  await legacyPage.evaluate(({ owner, selectedKeys }) => {
    const key = "libitu:loadout:v1";
    const envelope = JSON.parse(localStorage.getItem(key));
    envelope.accounts[owner].draft = { scenarioType: "workplace", goal: "Original eight-target mission", difficulty: "standard", feedbackLevel: "balanced", logicTemplateId: null, selectedKeys };
    localStorage.setItem(key, JSON.stringify(envelope));
  }, { owner: loadoutOwner, selectedKeys: legacyKeys });
  await legacyPage.reload({ waitUntil: "domcontentloaded" });
  await legacyPage.getByText("Your previous 8 selections are preserved.", { exact: false }).waitFor();
  await legacyPage.getByRole("button", { name: /^Remove .+ from loadout$/ }).first().waitFor();
  assert.equal(await legacyPage.getByRole("button", { name: /^Remove .+ from loadout$/ }).count(), 8);
  assert.equal(await legacyPage.getByRole("button", { name: "Start mission", exact: true }).isDisabled(), true);
  for (const record of fixtureRecords.slice(0, 3)) await legacyPage.getByRole("button", { name: `Remove ${record.item.text} from loadout`, exact: true }).click();
  await saved(legacyPage);
  assert.equal(await legacyPage.getByRole("button", { name: /^Remove .+ from loadout$/ }).count(), 5);
  assert.equal(await legacyPage.getByRole("button", { name: "Start mission", exact: true }).isEnabled(), true);
  assert.equal(legacyState.errors.length, 0, legacyState.errors.join("\n"));
  await legacyContext.close();
  console.log(JSON.stringify({ result: "passed", viewports: [1440, 390], artifacts, coverage: "Synthetic auth/API/model/socket fixtures; no live model quality claim." }));
} finally { await browser.close(); }
