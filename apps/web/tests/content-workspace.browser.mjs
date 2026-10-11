import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { installLoadoutFixture, fixtureContentId, shadowJob, shadowBlueprint, loadoutOwner } from "./helpers/loadout-fixture.mjs";
import { contentContextFixture } from "./helpers/content-context-fixture.mjs";
const { chromium } = createRequire(import.meta.url)(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3001";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, permissions: ["microphone"] });
    const page = await context.newPage();
    const state = await installLoadoutFixture(page, { origin, shadow: true, initialOwner: loadoutOwner });
    const failed = { ...shadowJob, status: "failed", attempt_count: 4, error_message: "Fixture processing failed" };
    let current = failed, available = false, posts = [];
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
    await page.route(`**/api/content/${fixtureContentId}`, route => route.fulfill({ headers, json: {
      ...contentContextFixture(shadowBlueprint, current), processing: { ...contentContextFixture(shadowBlueprint, current).processing, blueprint_available: available }
    } }));
    await page.route(`**/api/jobs/${shadowJob.id}`, route => route.fulfill({ headers, json: current }));
    await page.route("**/api/jobs", route => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      posts.push(route.request().postDataJSON());
      if (posts.length === 1) { current = { ...failed, attempt_count: 5 }; return route.abort("failed"); }
      if (posts.length === 2) return route.fulfill({ headers, json: current });
      current = { ...shadowJob, attempt_count: 6 }; available = true;
      return route.fulfill({ headers, json: current });
    });
    await page.goto(`${origin}/practice/${fixtureContentId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByText("Fixture processing failed", { exact: true }).waitFor();
    assert.equal(posts.length, 0, "opening a failed job never retries it");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByText("Failed to fetch", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByText("Fixture processing failed", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).waitFor();
    assert.deepEqual(posts.map(post => post.expected_attempt_count), [4, 4, 5], "lost response reuses the original retry generation");
    assert.ok(posts.every(post => post.retry_failed && post.content_id === fixtureContentId));
    await page.waitForFunction(() => window.__loadoutPlayers.some(player => !player.destroyed));
    const initialPlayers = await page.evaluate(() => window.__loadoutPlayers.length);
    const frame = await page.locator(".youtube-player iframe").elementHandle();
    await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).click();
    await page.locator(".stage-one-segment-card").first().click();
    await page.getByRole("button", { name: /Begin Stage 2/ }).click();
    await page.getByRole("button", { name: "Start shadowing", exact: true }).click();
    await page.locator(".stage-two-shadow").waitFor();
    assert.equal(await page.evaluate(() => window.__loadoutPlayers.length), initialPlayers);
    assert.equal(await frame.evaluate(node => node.isConnected), true);
    // Real history return uses the same cleanup as explicit view navigation.
    await page.getByRole("button", { name: "Record sentence", exact: true }).click();
    await page.waitForFunction(() => window.__loadoutMicrophoneTracks.some(track => track.readyState === "live"));
    await page.goBack();
    await page.getByRole("button", { name: "Start shadowing", exact: true }).waitFor();
    await page.waitForFunction(() => window.__loadoutMicrophoneTracks.every(track => track.readyState === "ended"));
    await page.goForward();
    await page.locator(".stage-two-shadow").waitFor();
    assert.equal(await frame.evaluate(node => node.isConnected), true);
    // The same public workspace survives owner changes; the private recorder does not.
    await page.getByRole("button", { name: "Record sentence", exact: true }).click();
    await page.waitForFunction(() => window.__loadoutMicrophoneTracks.some(track => track.readyState === "live"));
    await page.evaluate(() => window.__setLoadoutUser("workspace-other-owner"));
    await page.waitForFunction(() => window.__loadoutMicrophoneTracks.every(track => track.readyState === "ended"));
    assert.equal(await page.evaluate(() => window.__loadoutPlayers.length), initialPlayers);
    await page.evaluate(() => window.__setLoadoutUser(null));
    await page.getByRole("heading", { name: "Sign in to start Shadow" }).waitFor();
    assert.equal(await page.evaluate(() => window.__loadoutPlayers.at(-1).playing), false);
    assert.equal(posts.length, 3, "account changes never restart public processing");
    await page.getByRole("button", { name: "Back to Stage 1", exact: true }).click();
    await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).waitFor();
    assert.equal(await frame.evaluate(node => node.isConnected), true);
    await page.evaluate(owner => window.__setLoadoutUser(owner), loadoutOwner);
    await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).click();
    await page.locator(".stage-one-segment-card").first().click();
    await page.getByRole("button", { name: /Begin Stage 2/ }).click();
    await page.getByRole("button", { name: "Start shadowing", exact: true }).click();
    let releaseSave;
    state.practiceGate = new Promise(resolve => releaseSave = resolve);
    await page.getByRole("button", { name: "Record sentence", exact: true }).click();
    await page.getByText("Recording your voice", { exact: true }).waitFor();
    await page.waitForTimeout(800);
    const pending = page.waitForRequest(request => request.url().includes("/api/practice/attempts") && request.method() === "POST");
    await page.getByRole("button", { name: "Stop recording", exact: true }).click();
    await pending;
    await page.getByRole("link", { name: "Stage 3 - Mission", exact: true }).click();
    try { await page.getByRole("heading", { name: "Mission loadout", exact: true }).waitFor(); }
    catch (error) { console.error({ url: page.url(), errors: state.errors, body: (await page.locator("body").innerText()).slice(0, 1800) }); throw error; }
    assert.equal(state.practiceCompleted, 0, "root outbox remains pending after leaving the workspace");
    const saved = page.waitForResponse(response => response.url().includes("/api/practice/attempts") && response.request().method() === "POST");
    releaseSave(); assert.equal((await saved).status(), 201);
    await page.locator(".practice-save-banner").waitFor({ state: "detached" });
    assert.equal(state.practiceRequests.length, 1); assert.equal(state.practiceCompleted, 1);
    await page.waitForFunction(() => window.__loadoutPlayers.every(player => player.destroyed));
    assert.equal(await frame.evaluate(node => node.isConnected), false, "leaving the workspace destroys the iframe");
    assert.deepEqual(state.errors, []);
    console.log(`Content read/retry, media lifetime and owner isolation passed at ${width}px`);
    await context.close();
  }
} finally { await browser.close(); }
