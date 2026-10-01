import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureContentId, fixtureRecords, installLoadoutFixture, loadoutOwner,
  shadowBlueprint, shadowJob } from "./helpers/loadout-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const artifacts = await mkdtemp(join(tmpdir(), "libitu-loadout-"));
const returnTo = `/?${new URLSearchParams({ contentId: fixtureContentId, stage: "2", segmentId: "loadout-segment" })}#practice`;
const entry = `${origin}/loadout?${new URLSearchParams({ contentId: fixtureContentId, returnTo })}`;
const structures = fixtureRecords.filter((record) => record.item.kind === "structure");
const expressions = fixtureRecords.filter((record) => record.item.kind !== "structure");
const requestedViewport = Number(process.env.LIBITU_LOADOUT_VIEWPORT ?? 0);
const viewports = [{ width: 1440, height: 1050 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]
  .filter((viewport) => !requestedViewport || viewport.width === requestedViewport);

const select = (page, record) => page.getByRole("button", { name: `Select ${record.item.text}`, exact: true });
const remove = (page, record) => page.getByRole("button", { name: `Remove ${record.item.text} from loadout`, exact: true });
const selected = (page) => page.getByRole("button", { name: /^Remove .+ from loadout$/ });

async function waitForSelected(page, count) {
  await page.waitForFunction((expected) => [...document.querySelectorAll("button")]
    .filter((button) => /^Remove .+ from loadout$/.test(button.getAttribute("aria-label") ?? "")).length === expected, count);
}

async function choose(page, label, value) {
  const field = page.getByLabel(label, { exact: true });
  if (await field.evaluate((node) => node.tagName === "SELECT")) await field.selectOption(value);
  else {
    await field.click();
    await page.getByRole("option", { name: new RegExp(value, "i") }).click();
  }
}

async function checkLayout(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true,
    `${name} has no horizontal page overflow`);
  await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
}

async function holdDraftLock(page) {
  // Model another live tab holding the same browser lock. This makes a lost
  // envelope update reproducible instead of relying on a probabilistic race.
  await page.evaluate(() => new Promise((entered) => {
    void navigator.locks.request("libitu:loadout:v1", async () => {
      entered();
      await new Promise((release) => { window.__releaseLoadoutDraftLock = release; });
    });
  }));
}

const browser = await chromium.launch({ headless: true, channel: process.env.LIBITU_BROWSER_CHANNEL ?? "chrome",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const state = await installLoadoutFixture(page, { origin });
    try {
      await page.goto(entry, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("heading", { name: "Mission loadout", exact: true }).waitFor();
      await select(page, structures[0]).waitFor();
      await page.getByLabel("Mission goal", { exact: true }).fill("Agree on a revised project deadline");
      const guestStart = page.getByRole("button", { name: "Sign in to start mission", exact: true });
      assert.equal(await guestStart.isDisabled(), true, "no language selected cannot start");
      await select(page, expressions[2]).focus();
      await select(page, expressions[2]).press("Space");
      await waitForSelected(page, 1);
      assert.equal(await guestStart.isEnabled(), true, "one idiom alone is sufficient");
      await page.getByLabel("Search corpus", { exact: true }).fill("same page");
      assert.equal(await select(page, structures[0]).count(), 0, "search filters the picker");
      assert.equal(await page.getByRole("button", { name: `Remove ${expressions[2].item.text}`, exact: true }).count(), 1);
      await choose(page, "Source", fixtureContentId);
      assert.equal(await page.getByRole("button", { name: `Remove ${expressions[2].item.text}`, exact: true }).count(), 0);
      assert.equal(await remove(page, expressions[2]).count(), 1, "source filtering retains preview selections");
      await page.getByLabel("Search corpus", { exact: true }).fill("");
      await choose(page, "Source", "");
      await guestStart.click();
      const authCall = await page.evaluate(() => window.__loadoutAuthCalls.at(-1));
      assert.equal(authCall.forceRedirectUrl, page.url());
      assert.equal(authCall.signUpForceRedirectUrl, page.url());
      assert.equal(state.creates.length, 0, "guest click only opens sign-in");
      await remove(page, expressions[2]).focus();
      await remove(page, expressions[2]).press("Enter");

      await choose(page, "Scenario type", "everyday");
      await choose(page, "Difficulty", "challenging");
      await choose(page, "Feedback level", "detailed");
      const logic = page.getByRole("button", { name: /Persuasive pitch/ });
      await logic.focus();
      await logic.press("Enter");
      assert.equal(await logic.getAttribute("aria-pressed"), "true");
      for (const record of structures.slice(0, 3)) await select(page, record).click();
      for (const record of expressions.slice(0, 5)) await select(page, record).click();
      await waitForSelected(page, 8);
      assert.equal(await select(page, structures[3]).isDisabled(), true, "structures stop at three");
      assert.equal(await select(page, expressions[5]).isDisabled(), true, "chunks and idioms share five slots");
      await remove(page, expressions[2]).click();
      await waitForSelected(page, 7);
      assert.equal(await select(page, expressions[5]).isEnabled(), true, "removing an idiom releases one expression slot");
      assert.equal(await remove(page, expressions[2]).count(), 0, "preview reflects removal");
      await select(page, expressions[2]).click();
      await waitForSelected(page, 8);
      await logic.focus();
      await logic.press("Space");
      assert.equal(await logic.getAttribute("aria-pressed"), "false", "logic is optional and can be removed");
      await logic.click();
      assert.notEqual(await page.getByRole("button", { name: `Remove ${structures[0].item.text}`, exact: true })
        .evaluate((node) => getComputedStyle(node).backgroundColor),
      await select(page, structures[3]).evaluate((node) => getComputedStyle(node).backgroundColor),
      "selected corpus cards retain their visual selection background");
      await checkLayout(page, `loadout-${viewport.width}`);
      if (viewport.width === 1440) {
        // Half-size CSS viewport models desktop 200% zoom reflow. This is not a
        // claim that browser-level zoom or assistive technology was exercised.
        await page.setViewportSize({ width: 720, height: 525 });
        await guestStart.scrollIntoViewIfNeeded();
        assert.equal(await guestStart.isVisible(), true);
        assert.equal(await guestStart.isEnabled(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true,
          "200%-equivalent reflow keeps mission start reachable without horizontal page overflow");
        await page.setViewportSize(viewport);
      }

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForSelected(page, 8);
      assert.equal(await page.getByLabel("Mission goal", { exact: true }).inputValue(), "Agree on a revised project deadline");
      assert.equal(await page.getByLabel("Scenario type", { exact: true }).inputValue(), "everyday");
      assert.equal(await page.getByLabel("Difficulty", { exact: true }).inputValue(), "challenging");
      assert.equal(await page.getByLabel("Feedback level", { exact: true }).inputValue(), "detailed");
      assert.equal(await logic.getAttribute("aria-pressed"), "true");
      assert.equal(new URL(page.url()).searchParams.get("returnTo"), returnTo);

      let releaseCorpus;
      state.corpusGate = new Promise((resolve) => { releaseCorpus = resolve; });
      await page.evaluate((owner) => window.__setLoadoutUser(owner), loadoutOwner);
      await page.getByRole("button", { name: "Start mission", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Start mission", exact: true }).isDisabled(), true,
        "unsynchronized corpus cannot be submitted");
      assert.equal(state.creates.length, 0);
      state.corpusGate = null;
      releaseCorpus();
      await page.waitForFunction(() => [...document.querySelectorAll("button")]
        .some((button) => button.textContent?.includes("Start mission") && !button.disabled));
      await waitForSelected(page, 8);
      assert.equal(state.corpusSaves.length, fixtureRecords.length, "guest corpus is imported once");

      state.failNextCreate = true;
      await page.getByRole("button", { name: "Start mission", exact: true }).click();
      await page.getByRole("button", { name: "Retry start mission", exact: true }).waitFor();
      await waitForSelected(page, 8);
      assert.equal(state.creates.length, 1);
      const first = state.creates[0].input;
      assert.equal(first.logic_template_id, "persuasive_pitch");
      assert.equal(first.scenario_type, "everyday");
      assert.equal(first.difficulty, "challenging");
      assert.equal(first.feedback_level, "detailed");
      assert.ok(first.corpus_item_ids.every((id) => !id.startsWith("blueprint-candidate")));
      assert.equal(state.sessions.size, 1, "the fixture models an uncertain response after committing");
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForSelected(page, 8);
      await page.getByRole("button", { name: /^(Retry start mission|Start mission)$/ }).click();
      await page.waitForURL(/\/speaking\/[a-f0-9-]+/);
      await page.getByText(structures[0].item.text, { exact: true }).waitFor();
      assert.equal(state.creates.length, 2);
      assert.deepEqual(state.creates[1].input, first, "refresh and retry preserve the entire submission including client_id");
      assert.equal(state.sessions.size, 1);
      const sessionUrl = page.url();
      const readsBefore = state.sessionReads.length;
      state.cloud.get(loadoutOwner).clear();
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByText(structures[0].item.text, { exact: true }).waitFor();
      assert.ok(state.sessionReads.length > readsBefore, "session refresh reads its server snapshot");
      assert.ok((await page.locator("main").innerText()).match(/role.?play.*(not|available|yet)|not.*role.?play/i),
        "preparation page explains the availability of role-play");
      await checkLayout(page, `session-${viewport.width}`);
      await page.evaluate(() => window.__setLoadoutUser("loadout-browser-b"));
      await page.getByText("Session not found.", { exact: true }).waitFor();
      assert.equal(await page.getByText(structures[0].item.text, { exact: true }).count(), 0,
        "switching identity hides the previous account's snapshot");
      assert.equal(page.url(), sessionUrl);
      assert.deepEqual(state.errors, []);
      console.log(`PASS ${viewport.width}px: guest draft, 1/3/5 limits, optional logic, preview removal, identity sync, retry UUID, snapshot recovery, session identity isolation.`);
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `failure-${viewport.width}.png`), fullPage: true });
      throw error;
    } finally { await context.close(); }
  }

  const tabsContext = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const tabA = await tabsContext.newPage();
  const tabsReturnTo = `/?${new URLSearchParams({ sourceUrl: shadowBlueprint.source_url,
    title: shadowBlueprint.title, contentId: fixtureContentId, jobId: shadowJob.id })}`;
  const tabsEntry = `${origin}/loadout?${new URLSearchParams({ returnTo: tabsReturnTo })}`;
  const tabsState = await installLoadoutFixture(tabA, { origin, initialOwner: loadoutOwner, shadow: true });
  await tabA.goto(tabsEntry, { waitUntil: "domcontentloaded" });
  await select(tabA, expressions[0]).click();
  await tabA.getByLabel("Mission goal", { exact: true }).fill("Account A initial draft");
  const tabB = await tabsContext.newPage();
  const otherOwner = "loadout-browser-b";
  await installLoadoutFixture(tabB, { origin, initialOwner: otherOwner, seedCorpus: false, sharedState: tabsState, shadow: true });
  await tabB.goto(tabsEntry, { waitUntil: "domcontentloaded" });
  await tabB.getByLabel("Mission goal", { exact: true }).fill("Account B initial draft");
  await tabB.waitForFunction((owner) => JSON.parse(localStorage.getItem("libitu:loadout:v1")).accounts[owner]?.draft.goal === "Account B initial draft", otherOwner);
  const beforeEdits = await tabA.evaluate(() => localStorage.getItem("libitu:loadout:v1"));
  await holdDraftLock(tabA);
  await Promise.all([
    tabA.getByLabel("Mission goal", { exact: true }).fill("Account A concurrent edit"),
    (async () => {
      const goal = tabB.getByLabel("Mission goal", { exact: true });
      await goal.fill("Account B concurrent");
      await goal.pressSequentially(" edit", { delay: 5 });
      assert.equal(await goal.inputValue(), "Account B concurrent edit", "pending writes do not interrupt continuous typing");
    })()
  ]);
  assert.equal(await tabB.evaluate(() => localStorage.getItem("libitu:loadout:v1")), beforeEdits,
    "edits in both tabs wait for the competing envelope writer");
  await tabA.evaluate(() => window.__releaseLoadoutDraftLock());
  await tabA.waitForFunction(([ownerA, ownerB]) => {
    const accounts = JSON.parse(localStorage.getItem("libitu:loadout:v1")).accounts;
    return accounts[ownerA]?.draft.goal === "Account A concurrent edit" && accounts[ownerB]?.draft.goal === "Account B concurrent edit";
  }, [loadoutOwner, otherOwner]);
  assert.equal(await tabA.getByLabel("Mission goal", { exact: true }).inputValue(), "Account A concurrent edit");
  assert.equal(await tabB.getByLabel("Mission goal", { exact: true }).inputValue(), "Account B concurrent edit",
    "cross-tab storage events do not roll back pending input");
  assert.equal(await selected(tabB).count(), 0, "another account's selected language stays isolated");

  await holdDraftLock(tabB);
  tabsState.failNextCreate = true;
  await tabA.getByRole("button", { name: "Start mission", exact: true }).click();
  await tabB.getByLabel("Mission goal", { exact: true }).fill("Account B edit during account A create");
  assert.equal(tabsState.creates.length, 0, "network creation waits until the retry identifier is durably saved under the lock");
  await tabB.evaluate(() => window.__releaseLoadoutDraftLock());
  await tabA.getByRole("button", { name: "Retry start mission", exact: true }).waitFor();
  assert.equal(tabsState.creates.length, 1);
  const firstTabRequest = tabsState.creates[0];
  await tabB.getByLabel("Mission goal", { exact: true }).fill("Account B final independent draft");
  await tabB.waitForFunction((owner) => JSON.parse(localStorage.getItem("libitu:loadout:v1")).accounts[owner]?.draft.goal === "Account B final independent draft", otherOwner);
  const concurrentEnvelope = await tabA.evaluate(() => JSON.parse(localStorage.getItem("libitu:loadout:v1")));
  assert.equal(concurrentEnvelope.accounts[loadoutOwner].draft.submission.request.client_id, firstTabRequest.input.client_id,
    "another account's edits retain the uncertain creation request");
  await Promise.all([tabA.reload({ waitUntil: "domcontentloaded" }), tabB.reload({ waitUntil: "domcontentloaded" })]);
  await tabA.getByRole("button", { name: "Retry start mission", exact: true }).waitFor();
  await tabB.waitForFunction(() => document.querySelector("textarea")?.value === "Account B final independent draft");
  await tabA.getByRole("button", { name: "Retry start mission", exact: true }).click();
  await tabA.waitForURL(/\/speaking\/[a-f0-9-]+/);
  assert.equal(tabsState.creates.length, 2);
  assert.deepEqual(tabsState.creates[1], firstTabRequest);
  assert.equal(tabsState.sessions.size, 1);
  assert.equal(await tabB.getByLabel("Mission goal", { exact: true }).inputValue(), "Account B final independent draft");
  for (const method of ["link", "history"]) {
    const pendingGoal = `Account B saved after ${method} navigation`;
    await holdDraftLock(tabA);
    await tabB.getByLabel("Mission goal", { exact: true }).fill(pendingGoal);
    await tabB.getByText("Saving your draft on this device… Keep this page open until saving finishes.", { exact: true }).waitFor();
    assert.equal(await tabB.getByLabel("Mission goal", { exact: true }).inputValue(), pendingGoal);
    assert.equal(await tabB.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }), true, "pending device writes warn before a full-page exit");
    if (method === "link") await tabB.getByRole("link", { name: "Back to learning", exact: true }).click();
    else await tabB.goBack({ waitUntil: "domcontentloaded" });
    await tabB.getByRole("button", { name: "Choose a segment to shadow", exact: true }).waitFor();
    await tabA.evaluate(() => window.__releaseLoadoutDraftLock());
    await tabA.waitForFunction(([owner, goal]) => JSON.parse(localStorage.getItem("libitu:loadout:v1")).accounts[owner]?.draft.goal === goal,
      [otherOwner, pendingGoal]);
    if (method === "link") await tabB.locator(".mission-box").getByRole("link", { name: "Open loadout", exact: true }).click();
    else await tabB.goForward({ waitUntil: "domcontentloaded" });
    await tabB.waitForFunction((goal) => document.querySelector("textarea")?.value === goal, pendingGoal);
    assert.equal(await tabB.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }), false, "the exit warning clears once the queued write has completed");
  }
  const beforeOwnerChange = await tabA.evaluate(() => JSON.parse(localStorage.getItem("libitu:loadout:v1")));
  await holdDraftLock(tabA);
  await tabB.getByLabel("Mission goal", { exact: true }).fill("This queued edit must be cancelled on account change");
  await tabB.evaluate((owner) => window.__setLoadoutUser(owner), loadoutOwner);
  await tabA.evaluate(() => window.__releaseLoadoutDraftLock());
  await waitForSelected(tabB, 1);
  const afterOwnerChange = await tabA.evaluate(() => JSON.parse(localStorage.getItem("libitu:loadout:v1")));
  assert.deepEqual(afterOwnerChange.accounts[otherOwner], beforeOwnerChange.accounts[otherOwner],
    "account changes cancel writes waiting in the previous account's queue");
  assert.equal(afterOwnerChange.accounts[loadoutOwner].draft.submission.request.client_id, firstTabRequest.input.client_id);
  assert.deepEqual(tabsState.errors, []);
  await tabsContext.close();
  console.log("PASS: two-account tabs serialize writes, preserve typing and retry IDs, retain queued drafts through SPA/history navigation, and cancel queued writes on account change.");

  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage();
  const state = await installLoadoutFixture(page, { origin });
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await select(page, expressions[0]).waitFor();
  await page.getByLabel("Mission goal", { exact: true }).fill("Private account A goal");
  await select(page, expressions[0]).click();
  await page.evaluate((owner) => window.__setLoadoutUser(owner), loadoutOwner);
  await page.waitForFunction(() => [...document.querySelectorAll("button")]
    .some((button) => button.textContent?.includes("Start mission") && !button.disabled));
  await page.evaluate(() => window.__setLoadoutUser("loadout-browser-b"));
  await page.waitForFunction(() => document.querySelector("textarea")?.value !== "Private account A goal");
  await waitForSelected(page, 0);
  assert.equal(state.corpusSaves.filter((row) => row.owner === "loadout-browser-b").length, 0);
  await page.evaluate((owner) => window.__setLoadoutUser(owner), loadoutOwner);
  await waitForSelected(page, 1);
  assert.equal(await page.getByLabel("Mission goal", { exact: true }).inputValue(), "Private account A goal");
  await page.evaluate(() => window.__setLoadoutUser(null));
  await waitForSelected(page, 0);
  assert.notEqual(await page.getByLabel("Mission goal", { exact: true }).inputValue(), "Private account A goal");
  await page.getByLabel("Mission goal", { exact: true }).fill("A new device draft");
  await page.evaluate((owner) => window.__setLoadoutUser(owner), loadoutOwner);
  await page.getByRole("button", { name: "Use device draft", exact: true }).waitFor();
  await waitForSelected(page, 1);
  assert.equal(await page.getByLabel("Mission goal", { exact: true }).inputValue(), "Private account A goal",
    "an existing account draft is not silently overwritten by a later device draft");
  await page.getByRole("button", { name: "Use device draft", exact: true }).click();
  await waitForSelected(page, 0);
  assert.equal(await page.getByLabel("Mission goal", { exact: true }).inputValue(), "A new device draft");
  assert.equal(state.creates.length, 0);
  await select(page, expressions[0]).click();
  let releaseCreate;
  state.createGate = new Promise((resolve) => { releaseCreate = resolve; });
  const pendingCreate = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/speaking/sessions" && request.method() === "POST");
  await page.getByRole("button", { name: "Start mission", exact: true }).click();
  await pendingCreate;
  await page.evaluate(() => window.__setLoadoutUser("loadout-browser-b"));
  await waitForSelected(page, 0);
  assert.equal(new URL(page.url()).pathname, "/loadout");
  await page.evaluate((owner) => window.__setLoadoutUser(owner), loadoutOwner);
  await waitForSelected(page, 1);
  await page.getByRole("button", { name: "Retry start mission", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry start mission", exact: true }).isEnabled(), true,
    "switching back to the account clears stale in-flight UI state");
  state.createGate = null;
  releaseCreate();
  await page.getByRole("button", { name: "Retry start mission", exact: true }).click();
  await page.waitForURL(/\/speaking\/[a-f0-9-]+/);
  assert.equal(state.creates.length, 2);
  assert.deepEqual(state.creates[0], state.creates[1], "an interrupted account submission recovers the same owner and client ID");
  assert.deepEqual(state.errors, []);
  await context.close();
  console.log("PASS: account/logout draft isolation, explicit device-draft adoption, in-flight account switch and recovery.");

  const emptyContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const emptyPage = await emptyContext.newPage();
  const emptyState = await installLoadoutFixture(emptyPage, { origin, records: [] });
  await emptyPage.goto(`${origin}/loadout`, { waitUntil: "domcontentloaded" });
  await emptyPage.getByRole("heading", { name: "Mission loadout", exact: true }).waitFor();
  await emptyPage.getByRole("button", { name: "Sign in to start mission", exact: true }).waitFor();
  assert.equal(await emptyPage.getByRole("button", { name: "Sign in to start mission", exact: true }).isDisabled(), true);
  assert.equal(await selected(emptyPage).count(), 0);
  assert.match(await emptyPage.locator("main").innerText(), /save.*(language|corpus)|corpus.*empty|no saved/i);
  await checkLayout(emptyPage, "empty-390");
  assert.equal(emptyState.creates.length, 0);
  assert.deepEqual(emptyState.errors, []);
  await emptyContext.close();
  console.log("PASS: empty corpus guidance and disabled mission start.");

  const savedContext = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const savedPage = await savedContext.newPage();
  const savedState = await installLoadoutFixture(savedPage, { origin, records: [], shadow: true });
  const readerEntry = `${origin}/?${new URLSearchParams({ sourceUrl: shadowBlueprint.source_url,
    title: shadowBlueprint.title, contentId: fixtureContentId, jobId: shadowJob.id, learnerLevel: "B2" })}#practice`;
  await savedPage.goto(readerEntry, { waitUntil: "domcontentloaded" });
  await savedPage.getByRole("button", { name: "Save to corpus", exact: true }).click();
  await savedPage.getByRole("button", { name: "Remove from corpus", exact: true }).waitFor();
  const savedReturnUrl = new URL(savedPage.url());
  await savedPage.locator(".mission-box").getByRole("link", { name: "Open loadout", exact: true }).click();
  await select(savedPage, expressions[0]).waitFor();
  assert.equal(new URL(savedPage.url()).searchParams.get("returnTo"), savedReturnUrl.pathname + savedReturnUrl.search + savedReturnUrl.hash);
  await savedPage.getByLabel("Mission goal", { exact: true }).fill("Share a fair assessment of the plan");
  await select(savedPage, expressions[0]).click();
  await savedPage.evaluate((owner) => window.__setLoadoutUser(owner), loadoutOwner);
  await savedPage.getByRole("button", { name: "Start mission", exact: true }).click();
  await savedPage.waitForURL(/\/speaking\/[a-f0-9-]+/);
  await savedPage.getByText(expressions[0].item.text, { exact: true }).waitFor();
  assert.equal(savedState.corpusSaves.length, 1);
  assert.equal(savedState.creates.length, 1);
  assert.equal(savedState.creates[0].input.corpus_item_ids.length, 1);
  assert.equal(savedState.creates[0].input.logic_template_id, null, "one saved chunk can start without logic or structures");
  assert.deepEqual(savedState.errors, []);
  await savedContext.close();
  console.log("PASS: Stage 1 save → Open loadout → login corpus sync → one-item mission creation through the real UI.");

  const shadowContext = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const shadowPage = await shadowContext.newPage();
  const shadowState = await installLoadoutFixture(shadowPage, { origin, initialOwner: loadoutOwner, shadow: true });
  const shadowEntry = `${origin}/?${new URLSearchParams({ sourceUrl: shadowBlueprint.source_url,
    title: shadowBlueprint.title, contentId: fixtureContentId, jobId: shadowJob.id, learnerLevel: "B2",
    stage: "2", segmentId: "loadout-segment", sentenceId: "sentence-v2-loadout" })}#practice`;
  await shadowPage.goto(shadowEntry, { waitUntil: "domcontentloaded" });
  await shadowPage.getByRole("button", { name: "Record sentence", exact: true }).waitFor();
  let releasePractice;
  shadowState.practiceGate = new Promise((resolve) => { releasePractice = resolve; });
  await shadowPage.getByRole("button", { name: "Record sentence", exact: true }).click();
  await shadowPage.getByText("Recording your voice", { exact: true }).waitFor();
  await shadowPage.waitForTimeout(800);
  const pendingPractice = shadowPage.waitForRequest((request) => request.url().includes("/api/practice/attempts") && request.method() === "POST");
  await shadowPage.getByRole("button", { name: "Stop recording", exact: true }).click();
  await pendingPractice;
  await shadowPage.locator(".practice-save-banner").waitFor();
  assert.equal(shadowState.practiceRequests.length, 1, "completed take entered the save outbox");
  await shadowPage.getByRole("link", { name: "Open loadout", exact: true }).click();
  await shadowPage.getByRole("heading", { name: "Mission loadout", exact: true }).waitFor();
  assert.equal(shadowState.practiceCompleted, 0, "the save remains pending across client route navigation");
  assert.equal(await shadowPage.evaluate(() => window.__loadoutPlayers.every((player) => player.destroyed)), true);
  assert.equal(await shadowPage.evaluate(() => window.__loadoutMicrophoneTracks.every((track) => track.readyState === "ended")), true);
  const savedResponse = shadowPage.waitForResponse((response) => response.url().includes("/api/practice/attempts") && response.request().method() === "POST");
  releasePractice();
  assert.equal((await savedResponse).status(), 201);
  await shadowPage.locator(".practice-save-banner").waitFor({ state: "detached" });
  assert.equal(shadowState.practiceCompleted, 1);
  assert.equal(shadowState.practiceRows.size, 1);
  assert.equal(shadowState.practiceRequests.length, 1, "navigation did not cancel or duplicate the save");
  assert.deepEqual(shadowState.errors, []);
  await shadowContext.close();
  console.log("PASS: pending Shadow save survives navigation to Loadout; microphone and player are released.");
  console.log(`Screenshots: ${artifacts}`);
} finally { await browser.close(); }
