import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLoadoutFixture, loadoutOwner, fixtureContentId, shadowJob, shadowBlueprint } from "./helpers/loadout-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://127.0.0.1:3000";
const artifacts = await mkdtemp(join(tmpdir(), "libitu-buttons-"));
const color = (locator, property = "backgroundColor") => locator.evaluate((element, key) => getComputedStyle(element)[key], property);

for (const width of process.env.LIBITU_BUTTON_WIDTH ? [Number(process.env.LIBITU_BUTTON_WIDTH)] : [1440, 390]) {
  const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--no-proxy-server", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  let releaseCreate, page;
  try {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce", permissions: ["microphone"] });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on("pageerror", error => console.error("Page error:", error.message));
    const state = await installLoadoutFixture(page, { origin, initialOwner: loadoutOwner, shadow: true });
    // Only fixture pages: avoid the hosted Clerk development-browser handshake.
    // Never install this forwarding route in the application or real-login checks.
    await page.route(origin + "/**", async route => {
      if (new URL(route.request().url()).pathname.startsWith("/api/")) return route.fallback();
      if (route.request().url().includes("webpack-hmr")) return route.continue();
      try { await route.fulfill({ response: await route.fetch({ timeout: 60000, maxRetries: 2,
        headers: { ...route.request().headers(), accept: "*/*", "sec-fetch-dest": "empty" } }) }); }
      catch { await route.abort().catch(() => {}); }
    });
    console.log(`Checking ${width}: landing`);
    await page.goto(origin + "/", { waitUntil: "commit", timeout: 60000 });
    const input = page.getByLabel("Your YouTube video", { exact: true });
    await page.waitForFunction(() => {
      const element = document.querySelector("#video-url");
      return element && Object.keys(element).some(key => key.startsWith("__reactProps"));
    });
    await input.fill("https://example.com/not-a-video"); await input.press("Enter");
    await page.getByText(/Enter a YouTube video link/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Analyze video", exact: true }).getAttribute("type"), "submit");
    assert.equal(new URL(page.url()).pathname, "/");
    const navigation = page.getByRole("link", { name: "My learning", exact: true }).first();
    assert.equal(await navigation.evaluate(element => element.tagName), "A");

    console.log(`Checking ${width}: loadout`);
    await page.goto(origin + "/loadout", { waitUntil: "commit", timeout: 60000 });
    await page.getByRole("button", { name: "Select to be fair", exact: true }).click();
    await page.getByLabel("Mission goal", { exact: true }).fill("Explain the project update");
    const start = page.getByRole("button", { name: "Start mission", exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent.includes("Start mission") && !button.disabled));
    assert.equal(await color(start), "rgb(83, 74, 183)");
    await page.keyboard.press("Tab"); await start.focus(); assert.equal(await color(start, "outlineColor"), "rgb(83, 74, 183)");
    await start.hover(); assert.equal(await color(start), "rgb(60, 52, 137)");
    const before = await start.boundingBox();
    state.createGate = new Promise(resolve => { releaseCreate = resolve; });
    await start.click();
    const saving = page.getByRole("button", { name: "Saving mission…", exact: true });
    await saving.waitFor(); assert.equal(await saving.isDisabled(), true);
    assert.equal(await saving.getAttribute("aria-busy"), "true");
    const during = await saving.boundingBox();
    assert.ok(Math.abs(before.width - during.width) < 1, "loading must not change width");
    assert.ok(Math.abs(before.height - during.height) < 1, "loading must not change height");
    await saving.evaluate(button => { button.click(); button.click(); });
    assert.equal(state.creates.length, 1, "busy native buttons prevent duplicate submissions");
    assert.equal(await color(saving), "rgb(83, 74, 183)", "disabled hover must not retain the hover color");
    assert.equal(await saving.locator(".ui-button-spinner").evaluate(element => getComputedStyle(element).animationName), "none");
    await page.screenshot({ path: join(artifacts, `loading-${width}.png`), fullPage: true });
    releaseCreate(); await page.waitForURL(/\/speaking\//, { waitUntil: "commit", timeout: 60000 });

    console.log(`Checking ${width}: corpus`);
    await page.goto(origin + "/corpus", { waitUntil: "commit", timeout: 60000 });
    await page.getByRole("button", { name: "View to be fair", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const remove = dialog.getByRole("button", { name: "Delete item", exact: true });
    assert.equal(await color(remove, "color"), "rgb(163, 55, 43)");
    await remove.click();
    assert.equal(await color(dialog.getByRole("button", { name: "Confirm delete", exact: true })), "rgb(163, 55, 43)");
    await dialog.getByRole("button", { name: "Keep item", exact: true }).click();
    await page.screenshot({ path: join(artifacts, `dialog-${width}.png`), fullPage: true });
    await dialog.getByRole("button", { name: "Close corpus detail", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "All items", exact: true }).getAttribute("data-variant"), null, "selection controls are not action buttons");

    const query = new URLSearchParams({ contentId: fixtureContentId, jobId: shadowJob.id, sourceUrl: shadowBlueprint.source_url, stage: "2", segmentId: "loadout-segment", sentenceId: "sentence-v2-loadout" });
    await page.goto(`${origin}/?${query}`, { waitUntil: "commit", timeout: 60000 });
    console.log(`Checking ${width}: recording`);
    const record = page.getByRole("button", { name: "Record sentence", exact: true });
    await record.waitFor(); assert.equal(await color(record), "rgb(26, 26, 26)");
    await record.click(); console.log(`Checking ${width}: recording started`);
    const stop = page.getByRole("button", { name: "Stop recording", exact: true });
    await stop.waitFor(); await page.mouse.move(0, 0); assert.equal(await color(stop), "rgb(163, 55, 43)");
    await page.getByRole("button", { name: "Cancel recording", exact: true }).click();
    console.log(`Checking ${width}: recording cancelled`);
    await record.waitFor(); await record.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(artifacts, `media-${width}.png`), fullPage: true });
    const geometry = await page.evaluate(() => {
      const after = document.documentElement.scrollWidth;
      const buttons = [...document.querySelectorAll(".ui-button")];
      const variants = buttons.map(button => button.getAttribute("data-variant"));
      buttons.forEach(button => button.removeAttribute("data-variant"));
      const legacy = document.documentElement.scrollWidth;
      buttons.forEach((button, index) => button.setAttribute("data-variant", variants[index]));
      return { after, legacy, viewport: innerWidth };
    });
    assert.ok(geometry.after <= geometry.viewport + 1, `shared button paint must not introduce horizontal overflow: ${JSON.stringify(geometry)}`);
    console.log(`Geometry ${width}: ${JSON.stringify(geometry)}`);
    console.log(`PASS ${width}: submit/link semantics, primary hover/focus, stable loading geometry, duplicate prevention, reduced motion, destructive confirmation and recording states`);
  } catch (error) {
    console.error(error);
    console.error(await page.evaluate(() => [...document.querySelectorAll("body *")].filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => ({ tag: el.tagName, className: el.className, width: el.getBoundingClientRect().width })).slice(0, 20)));
    await page.screenshot({ path: join(artifacts, `failure-${width}.png`), fullPage: true });
    console.error(`Screenshots: ${artifacts}`); throw error;
  } finally { releaseCreate?.(); await browser.close(); }
}
console.log(`Screenshots: ${artifacts}`);
