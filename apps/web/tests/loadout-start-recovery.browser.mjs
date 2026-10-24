import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureRecords, installLoadoutFixture, loadoutOwner } from "./helpers/loadout-fixture.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const artifacts = await mkdtemp(join(tmpdir(), "libitu-start-recovery-"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,authorization", "access-control-allow-methods": "GET,POST,OPTIONS" };

async function draft(page) {
  return page.evaluate(owner => JSON.parse(localStorage.getItem("libitu:loadout:v1")).accounts[owner].draft, loadoutOwner);
}
async function saved(page) {
  await page.waitForFunction(() => document.querySelector("[data-pending]")?.getAttribute("data-pending") === "false");
}
async function fixture(width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 } });
  const page = await context.newPage();
  const state = await installLoadoutFixture(page, { origin, initialOwner: loadoutOwner });
  await page.route("**/api/speaking/sessions/*/end", async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const id = new URL(route.request().url()).pathname.split("/")[4];
    const workspace = state.workspaces.get(id);
    assert.equal(route.request().method(), "POST");
    workspace.version++;
    workspace.session.status = "completed";
    state.sessions.get(id).status = "completed";
    return route.fulfill({ json: workspace, headers });
  });
  await page.route("**/api/speaking/sessions/*/feedback", async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const id = new URL(route.request().url()).pathname.split("/")[4];
    return route.fulfill({ json: { id: `report-${id}`, session_id: id, status: "insufficient_data", input_hash: "empty-conversation", rubric_version: "fixture", analysis_version: "fixture", attempts: 0, retryable: false, error_code: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), session: state.sessions.get(id), messages: [], result: null }, headers });
  });
  await page.goto(`${origin}/loadout`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  for (const record of [fixtureRecords[4], fixtureRecords[5], fixtureRecords[0]]) {
    await page.getByRole("button", { name: `Select ${record.item.text}`, exact: true }).click();
  }
  await saved(page);
  return { context, page, state };
}
async function ready(page) {
  await page.waitForURL(/\/speaking\/10000000/);
  await page.getByRole("button", { name: "Start conversation", exact: true }).waitFor();
}
async function endAndReturn(page) {
  await page.getByRole("button", { name: "End mission", exact: true }).click();
  await page.getByRole("button", { name: "End and review", exact: true }).click();
  await page.waitForURL(/\/analytics(?:\?|$)/);
  await page.getByRole("link", { name: /^New mission/ }).click();
  await page.getByRole("button", { name: "Start mission", exact: true }).waitFor();
  await saved(page);
}

try {
  for (const width of [1440, 390]) {
    const { context, page, state } = await fixture(width);
    state.failNextCreate = true;
    await page.getByRole("button", { name: "Start mission", exact: true }).click();
    await page.getByRole("button", { name: "Retry start mission", exact: true }).waitFor();
    const pending = await draft(page);
    assert.ok(pending.submission, "an uncertain create keeps its durable replay request");
    assert.equal(await page.getByRole("textbox", { name: "Scene preferences", exact: true }).isDisabled(), true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Retry start mission", exact: true }).click();
    await ready(page);
    const acknowledged = await draft(page);
    assert.equal(acknowledged.submission, undefined, "acknowledgement releases the Loadout lock before navigation");
    assert.deepEqual(acknowledged, JSON.parse(JSON.stringify({ ...pending, submission: undefined })), "acknowledgement keeps targets, selected scene and all settings");
    assert.deepEqual(state.creates[1].input, state.creates[0].input, "retry still recovers the exact original request");
    assert.equal(state.sessions.size, 1);
    await endAndReturn(page);
    assert.equal(await page.getByRole("textbox", { name: "Scene preferences", exact: true }).isEnabled(), true);
    assert.equal(await page.getByText(/A mission start is awaiting confirmation/).count(), 0);
    await page.screenshot({ path: join(artifacts, `unlocked-loadout-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Start mission", exact: true }).click();
    await ready(page);
    assert.equal(state.sessions.size, 2, "after ending the recovered Mission, Start creates a new conversation");
    assert.notEqual(state.creates[2].input.client_id, state.creates[0].input.client_id);
    assert.equal(state.planRequests.length, 1, "the next Mission reuses its unchanged prepared scene");
    assert.equal((await draft(page)).submission, undefined, "ordinary successful starts also release the lock");
    await page.getByRole("link", { name: "Loadout", exact: true }).click();
    await page.getByRole("button", { name: "Start mission", exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Scene preferences", exact: true }).isEnabled(), true);
    assert.deepEqual(state.errors, []);
    await context.close();
    console.log(`PASS ${width}px: interrupted create, exact retry, End mission, editable Loadout and a new request identity.`);
  }

  // A pending draft left by the old bug may point at an already completed Mission.
  const legacy = await fixture();
  legacy.state.failNextCreate = true;
  await legacy.page.getByRole("button", { name: "Start mission", exact: true }).click();
  await legacy.page.getByRole("button", { name: "Retry start mission", exact: true }).waitFor();
  const oldRequest = (await draft(legacy.page)).submission.request;
  [...legacy.state.sessions.values()][0].status = "completed";
  await legacy.page.getByRole("button", { name: "Retry start mission", exact: true }).click();
  await legacy.page.waitForURL(/\/speaking\/10000000/);
  await legacy.page.getByRole("link", { name: "Loadout", exact: true }).waitFor();
  assert.equal((await draft(legacy.page)).submission, undefined);
  assert.deepEqual(legacy.state.creates[1].input, oldRequest);
  await legacy.page.getByRole("link", { name: "Loadout", exact: true }).click();
  await legacy.page.getByRole("button", { name: "Start mission", exact: true }).click();
  await ready(legacy.page);
  assert.notEqual(legacy.state.creates[2].input.client_id, oldRequest.client_id);
  assert.deepEqual(legacy.state.errors, []);
  await legacy.context.close();
  console.log("PASS: old stuck drafts recover a completed Mission once, then permit a fresh Mission.");

  const mismatch = await fixture();
  mismatch.state.createResponseTransform = session => ({ ...session, client_id: "f0000000-0000-4000-8000-000000000099" });
  await mismatch.page.getByRole("button", { name: "Start mission", exact: true }).click();
  await mismatch.page.getByRole("button", { name: "Retry start mission", exact: true }).waitFor();
  const mismatchedRequest = (await draft(mismatch.page)).submission.request;
  assert.equal(new URL(mismatch.page.url()).pathname, "/loadout");
  assert.equal(mismatch.state.creates.length, 1);
  mismatch.state.createResponseTransform = null;
  await mismatch.page.getByRole("button", { name: "Retry start mission", exact: true }).click();
  await ready(mismatch.page);
  assert.deepEqual(mismatch.state.creates[1].input, mismatchedRequest, "an unrelated success response cannot release or replace the pending request");
  assert.equal((await draft(mismatch.page)).submission, undefined);
  assert.deepEqual(mismatch.state.errors, []);
  await mismatch.context.close();
  console.log("PASS: a mismatched success response leaves the original request recoverable.");

  const blocked = await fixture();
  await blocked.page.evaluate(owner => {
    const original = Storage.prototype.setItem;
    window.__blockMissionAcknowledgement = true;
    Storage.prototype.setItem = function(key, value) {
      if (this === localStorage && key === "libitu:loadout:v1" && window.__blockMissionAcknowledgement) {
        const previous = JSON.parse(this.getItem(key) ?? "null");
        const next = JSON.parse(value);
        if (previous?.accounts[owner]?.draft.submission && !next.accounts[owner]?.draft.submission) {
          throw new DOMException("Synthetic quota limit", "QuotaExceededError");
        }
      }
      return original.call(this, key, value);
    };
  }, loadoutOwner);
  await blocked.page.getByRole("button", { name: "Start mission", exact: true }).click();
  await blocked.page.getByRole("button", { name: "Retry start mission", exact: true }).waitFor();
  const blockedRequest = (await draft(blocked.page)).submission.request;
  assert.equal(new URL(blocked.page.url()).pathname, "/loadout", "navigation waits until clearing the confirmed request is durable");
  assert.equal(blocked.state.sessions.size, 1);
  assert.equal(await blocked.page.getByRole("button", { name: "Retry start mission", exact: true }).isDisabled(), true);
  await blocked.page.evaluate(() => { window.__blockMissionAcknowledgement = false; });
  await blocked.page.getByRole("button", { name: "Retry saving draft", exact: true }).click();
  await saved(blocked.page);
  await blocked.page.getByRole("button", { name: "Retry start mission", exact: true }).click();
  await ready(blocked.page);
  assert.deepEqual(blocked.state.creates[1].input, blockedRequest, "storage recovery replays the same Mission instead of allocating a duplicate");
  assert.equal((await draft(blocked.page)).submission, undefined);
  assert.equal(blocked.state.sessions.size, 1);
  assert.deepEqual(blocked.state.errors, []);
  await blocked.context.close();
  console.log("PASS: failed local acknowledgement persistence retains the exact retry until storage recovers.");

  const tabs = await fixture();
  let releaseCreate;
  tabs.state.createGate = new Promise(resolve => { releaseCreate = resolve; });
  const pendingCreate = tabs.page.waitForRequest(request => new URL(request.url()).pathname === "/api/speaking/sessions" && request.method() === "POST");
  await tabs.page.getByRole("button", { name: "Start mission", exact: true }).click();
  await pendingCreate;
  const oldPending = await draft(tabs.page);
  const tabB = await tabs.context.newPage();
  await installLoadoutFixture(tabB, { origin, initialOwner: loadoutOwner, seedCorpus: false, sharedState: tabs.state });
  await tabB.goto(`${origin}/loadout`, { waitUntil: "domcontentloaded" });
  await tabB.getByRole("button", { name: "Retry start mission", exact: true }).waitFor();
  const newerId = "b0000000-0000-4000-8000-000000000002";
  await tabB.evaluate(({ owner, clientId }) => {
    // Model another tab's durable replacement while the old response is in flight.
    const envelope = JSON.parse(localStorage.getItem("libitu:loadout:v1"));
    envelope.accounts[owner].draft.submission.request.client_id = clientId;
    localStorage.setItem("libitu:loadout:v1", JSON.stringify(envelope));
  }, { owner: loadoutOwner, clientId: newerId });
  await tabs.page.waitForFunction(([owner, clientId]) => JSON.parse(localStorage.getItem("libitu:loadout:v1")).accounts[owner].draft.submission.request.client_id === clientId, [loadoutOwner, newerId]);
  tabs.state.createGate = null;
  releaseCreate();
  await tabs.page.getByRole("button", { name: "Retry start mission", exact: true }).waitFor();
  assert.equal(new URL(tabs.page.url()).pathname, "/loadout", "a stale response cannot navigate over another tab's request");
  assert.equal((await draft(tabs.page)).submission.request.client_id, newerId);
  assert.notEqual(newerId, oldPending.submission.request.client_id);
  assert.equal(tabs.state.creates.length, 1, "the stale response does not automatically send another request");
  assert.deepEqual(tabs.state.errors, []);
  await tabs.context.close();
  console.log("PASS: a late success cannot clear another tab's newer pending request.");
  console.log(`Artifacts: ${artifacts}`);
} finally {
  await browser.close();
}
