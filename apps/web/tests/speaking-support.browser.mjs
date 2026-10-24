import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureRecords, installLoadoutFixture, loadoutOwner } from "./helpers/loadout-fixture.mjs";
import { installSpeakingFixture, speakingSessionId } from "./helpers/speaking-fixture.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const artifacts = await mkdtemp(join(tmpdir(), "libitu-speaking-support-"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
async function waitFor(check, message) {
  for (let index = 0; index < 160; index++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(message);
}
async function choose(page, name, label) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await page.getByRole("listbox").waitFor({ state: "detached" });
}
async function capture(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${name}: no horizontal overflow`);
  await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
}
function plannedWorkspace(state, level) {
  state.workspace.session.support_level = level;
  state.workspace.support = { level, version: 0 };
  state.workspace.demonstrations = [];
  const targets = state.workspace.session.items.map((item, index) => ({
    session_item_id: item.id, corpus_item_id: `corpus-${index}`, role: index === 2 ? "opportunity" : "primary",
    communicative_function: "FUNCTION_DETAIL_MUST_STAY_HIDDEN", fit: "high", fit_reason: "The role can use this.",
    trigger_question: "What matters for your part of the plan?", skip_when: "No decision remains.", metadata_status: "available",
    sentence_frame: item.kind === "structure" ? item.text : `${item.text}, [your own point].`
  }));
  state.workspace.session.mission_plan = { plan_id: "plan", candidate_id: "candidate", version: 1, scenario_type: "workplace",
    title: "Align a delivery", setting: "A short planning discussion.", goal: state.workspace.session.goal, user_role: "Project lead", ai_role: "Colleague", register: "professional", targets };
  state.workspace.opportunities = targets.map(target => ({ session_item_id: target.session_item_id, role: target.role, status: "planned",
    skipped_reason: null, skipped_at: null, sent: false, bound: false, reflected: false, presented: false, last_response_id: null }));
}
function publish(state, change = {}) {
  Object.assign(state.workspace, change);
  state.workspace.version++;
  state.sockets.at(-1).send(JSON.stringify({ type: "snapshot", workspace: state.workspace }));
}
async function openSidebar(page, width) {
  if (width < 800) {
    const toggle = page.getByRole("button", { name: "Loadout", exact: true });
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  }
  const sidebar = page.getByRole("complementary", { name: "Training sidebar" });
  await sidebar.scrollIntoViewIfNeeded();
  return sidebar;
}
async function connect(page, state) {
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "Connect for text", exact: true }).click();
  await waitFor(() => state.events.some(event => event.type === "microphone"), "runtime connected");
}
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(30_000);
    const state = await installLoadoutFixture(page, { origin, initialOwner: loadoutOwner });
    try {
      await page.goto(`${origin}/loadout`, { waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.getByRole("heading", { name: "Mission loadout", exact: true }).waitFor();
      await waitFor(async () => (await page.getByRole("combobox", { name: "Mission support", exact: true }).innerText()).includes("Model + frame"), "new draft hydrates its default support");
      for (const record of [fixtureRecords[4], fixtureRecords[5]]) await page.getByRole("button", { name: `Select ${record.item.text}`, exact: true }).click();
      await page.getByText("Choose a scene myself", { exact: true }).click();
      await page.getByRole("button", { name: "Generate matching scenes", exact: true }).click();
      await page.getByRole("button", { name: "Choose Plan a small launch", exact: true }).click();
      await page.waitForFunction(owner => JSON.parse(localStorage.getItem("libitu:loadout:v1")).accounts[owner].draft.selectedCandidateId, loadoutOwner);
      const before = await page.evaluate(owner => JSON.parse(localStorage.getItem("libitu:loadout:v1")).accounts[owner].draft, loadoutOwner);
      await choose(page, "Mission support", "No automatic hints");
      await page.waitForFunction(owner => JSON.parse(localStorage.getItem("libitu:loadout:v1")).accounts[owner].draft.supportLevel === "no_hint"
        && document.querySelector("[data-pending]")?.getAttribute("data-pending") === "false", loadoutOwner);
      const after = await page.evaluate(owner => JSON.parse(localStorage.getItem("libitu:loadout:v1")).accounts[owner].draft, loadoutOwner);
      assert.equal(after.plan.value.id, before.plan.value.id);
      assert.equal(after.selectedCandidateId, before.selectedCandidateId);
      assert.equal(after.supportLevel, "no_hint");
      await capture(page, `loadout-support-${width}`);
      await page.getByRole("button", { name: "Start mission", exact: true }).click();
      await page.getByRole("heading", { name: "Agree on a practical launch plan", exact: true }).waitFor();
      assert.equal(state.planRequests.length, 1, "changing support must not pay for another plan");
      assert.equal(state.creates[0].input.support_level, "no_hint");
      assert.equal(Object.hasOwn(state.planRequests[0].input, "support_level"), false);
      const sidebar = await openSidebar(page, width);
      assert.equal(await sidebar.getByRole("heading", { name: "to be fair", exact: true }).count(), 0);
      assert.equal(await sidebar.getByRole("heading", { name: "Primary target 1", exact: true }).count(), 1);
      assert.deepEqual(state.errors, []);
      console.log(`PASS ${width}: default support, cached scene reuse, explicit no-hint create and anonymous loadout`);
    } finally { await context.close(); }
  }

  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(30_000);
    const { state, errors } = await installSpeakingFixture(page, { origin, deferSupport: true });
    plannedWorkspace(state, "model_frame");
    const requests = () => state.events.filter(event => event.type === "support.set");
    try {
      await page.goto(`${origin}/speaking/${speakingSessionId}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.getByRole("heading", { name: "Align the migration plan", exact: true }).waitFor();
      await connect(page, state);
      const sidebar = await openSidebar(page, width);
      await sidebar.getByText("To be fair, [your own point].").waitFor();
      assert.equal(await sidebar.getByText("Acknowledge another perspective", { exact: true }).count(), 0, "a frame does not silently include detailed usage");
      await waitFor(() => state.events.some(event => event.type === "target.shown"), "visible label/frame sends an assistance receipt");
      const message = { id: "model-1", ordinal: 0, role: "assistant", text: "🙂 To be fair, moving the demo gives testers another day. Which part of your plan needs more time?",
        input_source: "text", status: "final", revision: 1, provider_item_id: "model-provider", response_id: "model-response", client_turn_id: null, created_at: new Date().toISOString() };
      publish(state, { messages: [message], demonstrations: [
        { target_item_id: "item-1", message_id: message.id, revision: 1, start: 3, end: 13, quote: "To be fair" },
        { target_item_id: "item-2", message_id: message.id, revision: 0, start: 3, end: 13, quote: "To be fair" }
      ] });
      await page.locator('[aria-label="Conversation transcript"] mark').waitFor();
      assert.equal(await page.locator("mark").count(), 1, "only exact current assistant span is marked");
      await capture(page, `model-frame-${width}`);

      await page.getByRole("button", { name: "Reduce support", exact: true }).click();
      await waitFor(() => requests().length === 1, "first manual support reduction");
      assert.equal(requests()[0].level, "model_label");
      assert.equal(requests()[0].expected_version, 0);
      assert.match(await page.getByRole("combobox", { name: "Mission support" }).innerText(), /Model \+ frame/, "unconfirmed change leaves current mode intact");
      await page.getByText("Waiting for the support change to be confirmed…", { exact: true }).waitFor();
      publish(state, { support: { level: "model_label", version: 1 }, help: null });
      await waitFor(async () => (await page.getByRole("combobox", { name: "Mission support" }).innerText()).includes("Model + label"), "server confirms model-label");
      assert.equal(await sidebar.getByText("To be fair, [your own point].").count(), 0);
      assert.equal(await sidebar.getByRole("heading", { name: "To be fair", exact: true }).count(), 1);
      publish(state, { help: { id: "stale-automatic", version: 1, target_item_id: "item-1", level: "example", status: "ready", direction: null,
        expression: "AUTOMATIC_WORDING_MUST_STAY_HIDDEN", meaning: null, pattern: null, example: "AUTOMATIC_EXAMPLE_MUST_STAY_HIDDEN", substitution: null, source: "automatic", source_message_id: null, error: null } });
      assert.equal(await page.getByRole("region", { name: "Speaking hint" }).count(), 0, "new support modes cannot receive an old automatic help card");
      await capture(page, `model-label-${width}`);

      await page.getByRole("button", { name: "Reduce support", exact: true }).click();
      await waitFor(() => requests().length === 2, "second manual support reduction");
      publish(state, { support: { level: "label_only", version: 2 }, help: null });
      await waitFor(async () => (await page.getByRole("combobox", { name: "Mission support" }).innerText()).includes("Label only"), "label-only confirmed");
      await capture(page, `label-only-${width}`);
      await page.getByRole("button", { name: "Reduce support", exact: true }).click();
      await waitFor(() => requests().length === 3, "third manual support reduction");
      publish(state, { support: { level: "no_hint", version: 3 }, help: null });
      await waitFor(async () => (await page.getByRole("combobox", { name: "Mission support" }).innerText()).includes("No automatic hints"), "no-hint confirmed");
      assert.equal(await page.locator("mark").count(), 0);
      assert.equal(await page.getByText(message.text, { exact: true }).count(), 1, "historical transcript is preserved");
      const hiddenText = await sidebar.innerText();
      for (const secret of ["To be fair", "on the same page", "[priority]", "Acknowledge another perspective", "FUNCTION_DETAIL_MUST_STAY_HIDDEN", "Pattern slots"]) assert.equal(hiddenText.includes(secret), false, `${secret} must be absent from no-hint loadout`);
      const first = sidebar.locator("article").filter({ has: page.getByRole("heading", { name: "Primary target 1", exact: true }) });
      await first.getByRole("button", { name: "Doesn't fit this scene", exact: true }).click();
      await first.getByRole("button", { name: "Undo skip", exact: true }).waitFor();
      await first.getByRole("button", { name: "Undo skip", exact: true }).click();
      await first.getByRole("button", { name: "Doesn't fit this scene", exact: true }).waitFor();
      await capture(page, `no-hint-${width}`);
      await first.getByRole("button", { name: "Help me use this", exact: true }).click();
      const hint = page.getByRole("region", { name: "Speaking hint" });
      await hint.getByText("To be fair", { exact: true }).waitFor();
      await hint.scrollIntoViewIfNeeded();
      await waitFor(() => state.events.some(event => event.type === "hint.shown" && event.level === "usage"), "explicit help remains available and is recorded");
      await choose(page, "Mission support", "Model + frame");
      await waitFor(() => requests().length === 4, "explicit support increase");
      const rejected = requests().at(-1);
      state.sockets.at(-1).send(JSON.stringify({ type: "error", code: "support_busy", request_id: rejected.request_id, retryable: true, message: "Busy" }));
      publish(state);
      await page.getByRole("alert").filter({ hasText: "Wait for the current reply to finish" }).waitFor();
      assert.match(await page.getByRole("combobox", { name: "Mission support" }).innerText(), /No automatic hints/);
      assert.equal(requests().length, 4, "busy does not trigger a retry loop");
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}: confirmed four-level reduction, verified model spans, no-hint privacy, skip/undo, explicit help and busy recovery`);
    } finally { await context.close(); }
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const { state, errors } = await installSpeakingFixture(page, { origin });
  plannedWorkspace(state, "no_hint");
  try {
    await page.goto(`${origin}/speaking/${speakingSessionId}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.getByRole("heading", { name: "Align the migration plan", exact: true }).waitFor();
    await connect(page, state);
    await page.waitForTimeout(180);
    assert.equal(state.events.some(event => event.type === "target.shown"), false, "cold no-hint session never exposes hidden target wording");
    assert.equal(await page.getByRole("complementary", { name: "Training sidebar" }).getByRole("heading", { name: "To be fair", exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log("PASS cold no-hint: no label/frame exposure receipt");
  } finally { await context.close(); }
  const legacyContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const legacyPage = await legacyContext.newPage();
  const legacy = await installSpeakingFixture(legacyPage, { origin });
  try {
    await legacyPage.goto(`${origin}/speaking/${speakingSessionId}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await legacyPage.getByRole("heading", { name: "Align the migration plan", exact: true }).waitFor();
    await connect(legacyPage, legacy.state);
    await choose(legacyPage, "Mission support", "Label only");
    await openSidebar(legacyPage, 1440);
    await waitFor(() => legacy.state.events.some(event => event.type === "target.shown" && event.target_item_id === "item-1"), "explicit support on a plan-free legacy session records its visible label");
    assert.deepEqual(legacy.errors, []);
    console.log("PASS legacy opt-in: owned visible wording is recorded without a mission plan");
  } finally { await legacyContext.close(); }
  console.log(`Screenshots: ${artifacts}`);
} finally { await browser.close(); }
