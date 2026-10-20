import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSpeakingFixture, speakingSessionId } from "./helpers/speaking-fixture.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const artifacts = await mkdtemp(join(tmpdir(), "libitu-speaking-help-"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const help = (request, version, changes = {}) => ({ id: request.request_id, version, target_item_id: "item-2", level: request.level, status: "ready", direction: "Check that you agree about the timeline.", expression: "on the same page", meaning: "Share an understanding", pattern: "We need to be on the same page about [topic].", example: null, substitution: null, source: "requested", source_message_id: null, error: null, ...changes });
async function waitFor(check, message) {
  for (let index = 0; index < 100; index++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(message);
}
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(30_000);
    const { state, errors } = await installSpeakingFixture(page, { origin, deferHints: true });
    const requests = () => state.events.filter(event => event.type === "hint");
    const shown = (id, version, level) => state.events.some(event => event.type === "hint.shown" && event.hint_id === id && event.version === version && event.level === level);
    const publish = card => { state.workspace.help = card; state.workspace.version++; state.sockets.at(-1).send(JSON.stringify({ type: "snapshot", workspace: state.workspace })); };
    const card = page.getByRole("region", { name: "Speaking hint" });
    try {
      await page.goto(`${origin}/speaking/${speakingSessionId}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.getByRole("heading", { name: "Align the migration plan", exact: true }).waitFor();
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await page.getByRole("button", { name: "Connect for text", exact: true }).click();
      await waitFor(() => state.events.some(event => event.type === "microphone"), "socket must be ready");
      state.workspace.hint = "LEGACY_UNTRACKED_TARGET"; publish(null);
      await page.getByRole("button", { name: "Need a hint?", exact: true }).click();
      await waitFor(() => requests().length === 1, "usage request");
      const usageRequest = requests()[0];
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      publish(help(usageRequest, 1, { status: "loading", pattern: null }));
      await card.getByText("Finding a helpful way to say it…", { exact: true }).waitFor();
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      assert.equal(shown(usageRequest.request_id, 1, "usage"), false, "background visibility cannot acknowledge a mounted hint");
      await page.evaluate(() => {
        const overlay = document.createElement("div"); overlay.id = "fixture-cover";
        overlay.style.cssText = "position:fixed;inset:0;z-index:999999;background:#fff"; document.body.append(overlay);
        delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForTimeout(150);
      assert.equal(shown(usageRequest.request_id, 1, "usage"), false, "an overlay covering the hint cannot count as exposure");
      await page.evaluate(() => { document.getElementById("fixture-cover").remove(); window.dispatchEvent(new Event("pointerup")); });
      await waitFor(() => shown(usageRequest.request_id, 1, "usage"), "visible loading expression must acknowledge usage");
      assert.equal(await page.getByText("LEGACY_UNTRACKED_TARGET", { exact: true }).count(), 0, "legacy hint cannot bypass the card acknowledgement flow");
      publish(help(usageRequest, 2));
      await card.getByText("We need to be on the same page about [topic].").waitFor();
      await card.scrollIntoViewIfNeeded();
      await waitFor(() => shown(usageRequest.request_id, 2, "usage"), "ready usage pattern must be shown");
      await page.screenshot({ path: join(artifacts, `usage-${width}.png`), fullPage: true });

      await card.getByRole("button", { name: "Show an example", exact: true }).click();
      await waitFor(() => requests().length === 2, "example request");
      const exampleRequest = requests()[1];
      publish(help(exampleRequest, 1, { status: "loading", pattern: null }));
      await card.getByText("Writing an example for this conversation…", { exact: true }).waitFor();
      await card.scrollIntoViewIfNeeded();
      await waitFor(() => shown(exampleRequest.request_id, 1, "usage"), "example loading exposes only basic usage");
      assert.equal(shown(exampleRequest.request_id, 1, "example"), false);
      const example = help(exampleRequest, 2, { example: "Before we start, let's make sure we're on the same page about the timeline.", substitution: "Replace the timeline with the decision you want to clarify." });
      publish(example);
      await card.getByText(example.example, { exact: true }).waitFor();
      await card.scrollIntoViewIfNeeded();
      await waitFor(() => shown(exampleRequest.request_id, 2, "example"), "a painted example must acknowledge example exposure");
      publish(help(usageRequest, 3, { direction: "STALE_HINT_MUST_NOT_RENDER" }));
      await page.waitForTimeout(150);
      assert.equal(await card.getByText("STALE_HINT_MUST_NOT_RENDER", { exact: true }).count(), 0);
      assert.equal(await card.getByText(example.example, { exact: true }).count(), 1);
      publish(example);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `no horizontal overflow at ${width}`);
      await page.screenshot({ path: join(artifacts, `example-${width}.png`), fullPage: true });

      const automatic = help({ request_id: `automatic-${width}`, level: "direction" }, 1, { source: "automatic", direction: "Explain which outcome matters most." });
      state.sockets.at(-1).send(JSON.stringify({ type: "user.activity", speaking: true }));
      publish(automatic);
      await page.waitForTimeout(150);
      assert.equal(await card.count(), 0, "automatic help stays hidden while speaking");
      assert.equal(shown(automatic.id, 1, "direction"), false);
      state.sockets.at(-1).send(JSON.stringify({ type: "user.activity", speaking: false }));
      await card.getByText(automatic.direction, { exact: true }).waitFor();
      await card.scrollIntoViewIfNeeded();
      await waitFor(() => shown(automatic.id, 1, "direction"), "direction appears after speech");
      assert.equal(await card.getByText("on the same page", { exact: true }).count(), 0, "direction does not expose its target payload");
      state.sockets.at(-1).send(JSON.stringify({ type: "user.activity", speaking: true }));
      state.sockets.at(-1).send(JSON.stringify({ type: "user.activity", speaking: false }));
      publish(automatic);
      await page.waitForTimeout(150);
      assert.equal(await card.count(), 0, "the retired opportunity cannot return after another utterance");
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}: usage/example loading, real visibility ACK, hidden/covered suppression, stale-result fence, automatic-card retirement, no legacy exposure or overflow`);
    } catch (error) {
      console.error(`Browser fixture failed at ${width}; ${artifacts}`, state.events.filter(event => event.type === "hint.shown"));
      await page.screenshot({ path: join(artifacts, `failure-${width}.png`), fullPage: true }); throw error;
    } finally { await context.close(); }
  }
  console.log(`Screenshots: ${artifacts}`);
} finally { await browser.close(); }
