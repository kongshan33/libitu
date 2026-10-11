import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { installLoadoutFixture, fixtureContentId, loadoutOwner } from "./helpers/loadout-fixture.mjs";
const { chromium } = createRequire(import.meta.url)(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3001";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    const state = await installLoadoutFixture(page, { origin, shadow: true, initialOwner: loadoutOwner });
    await page.addInitScript(() => {
      window.__setupRequests = [];
      window.__setupReply = (request, status) => postMessage({ type: "LIBITU_BUFFER_EVENT", version: 4,
        sessionId: request.sessionId, requestId: request.requestId, status }, location.origin);
      addEventListener("message", ({ data }) => {
        if (data?.type !== "LIBITU_BUFFER_REQUEST") return;
        window.__setupRequests.push(data);
        if (["ping", "register"].includes(data.action)) window.__setupReply(data, "available");
      });
    });
    await page.goto(`${origin}/practice/${fixtureContentId}`);
    const enable = page.getByRole("button", { name: "Enable reference audio", exact: true });
    await enable.waitFor();
    await enable.click();
    await page.getByText("Preparing reference audio setup…", { exact: true }).waitFor();
    assert.equal(await page.getByText("Click Libitu in Chrome’s toolbar on this tab once to enable reference preparation.", { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.__setupRequests.filter(request => request.action === "arm").length), 1);
    await page.getByRole("button", { name: "Cancel audio setup" }).click();
    await enable.waitFor();
    await page.evaluate(() => {
      const request = window.__setupRequests.find(item => item.action === "arm");
      window.__setupReply(request, "armed"); window.__setupReply(request, "enabled");
    });
    await enable.click();
    await page.getByText("Preparing reference audio setup…", { exact: true }).waitFor();
    await page.evaluate(() => window.__setupReply(window.__setupRequests.findLast(request => request.action === "arm"), "armed"));
    await page.getByText("Click Libitu in Chrome’s toolbar on this tab once to enable reference preparation.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__loadoutMicrophoneTracks.length), 0);
    assert.deepEqual(state.errors, []);
    await context.close();
    console.log(`Reference setup waits for acknowledgement, cancels stale replies and retries at ${width}px`);
  }
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await browser.close(); }
