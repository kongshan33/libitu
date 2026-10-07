import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { installLoadoutFixture, fixtureContentId, shadowBlueprint, shadowJob, loadoutOwner } from "./helpers/loadout-fixture.mjs";
import { installSpeakingFixture, speakingSessionId } from "./helpers/speaking-fixture.mjs";
import { installAnalyticsFixture } from "./helpers/analytics-fixture.mjs";
import { installProfileFixture } from "./helpers/profile-fixture.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://127.0.0.1:3000";
const out = process.env.LIBITU_VISUAL_ARTIFACTS ?? "/tmp/libitu-inter-preview";
await mkdir(out, { recursive: true });
const widths = process.env.LIBITU_VISUAL_WIDTH ? [Number(process.env.LIBITU_VISUAL_WIDTH)] : [1440, 390];
const names = process.env.LIBITU_VISUAL_PAGES?.split(",") ?? ["landing", "reader", "shadow", "loadout", "corpus", "speaking", "analytics", "profile", "history"];
const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--no-proxy-server"] });
try {
  for (const width of widths) for (const name of names) {
    console.log(`Checking ${name} ${width}`);
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    const page = await context.newPage(); page.setDefaultTimeout(45000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const fontRequests = []; page.on("request", request => { if (/\.(woff2?|ttf)(\?|$)/.test(request.url())) fontRequests.push(request.url()); });
    if (name === "speaking") await installSpeakingFixture(page, { origin });
    else if (name === "analytics") await installAnalyticsFixture(page, { origin });
    else if (["profile", "history"].includes(name)) await installProfileFixture(page, { origin });
    else await installLoadoutFixture(page, { origin, shadow: true, initialOwner: loadoutOwner });
    // Fixture-only forwarding avoids Clerk's hosted development handshake.
    await page.route(origin + "/**", async route => {
      if (new URL(route.request().url()).pathname.startsWith("/api/")) return route.fallback();
      if (route.request().url().includes("webpack-hmr")) return route.continue();
      try { await route.fulfill({ response: await route.fetch({ timeout: 60000, maxRetries: 2,
        headers: { ...route.request().headers(), accept: "*/*", "sec-fetch-dest": "empty" } }) }); }
      catch { await route.abort().catch(() => {}); }
    });
    const source = `contentId=${fixtureContentId}&jobId=${shadowJob.id}&sourceUrl=${encodeURIComponent(shadowBlueprint.source_url)}`;
    const routes = { landing: "/", reader: `/?${source}`, shadow: `/?${source}&stage=2&segmentId=loadout-segment&sentenceId=sentence-v2-loadout`, loadout: "/loadout", corpus: "/corpus", speaking: `/speaking/${speakingSessionId}`, analytics: `/speaking/${speakingSessionId}/analytics`, profile: "/profile", history: "/profile/history" };
    try {
      await page.goto(origin + routes[name], { waitUntil: "commit", timeout: 60000 });
      await page.locator('a[aria-label="Libitu home"] b').first().waitFor();
      if (name === "landing") await page.waitForFunction(() => { const el = document.querySelector("#video-url"); return el && Object.keys(el).some(key => key.startsWith("__reactProps")); });
      if (name === "loadout") await page.getByRole("button", { name: "Select to be fair", exact: true }).waitFor();
      if (name === "corpus") await page.getByRole("button", { name: "View to be fair", exact: true }).waitFor();
      if (name === "shadow") await page.getByRole("button", { name: "Record sentence", exact: true }).waitFor();
      if (name === "reader") await page.getByText("Shadow to loadout", { exact: true }).first().waitFor();
      if (name === "speaking") await page.getByRole("heading", { name: "Align the migration plan", exact: true }).waitFor();
      if (name === "analytics") await page.getByRole("heading", { name: "Your mission report", exact: true }).waitFor();
      if (name === "profile") await page.getByRole("heading", { name: "My learning", exact: true }).waitFor();
      if (name === "history") await page.getByRole("heading", { name: "Practice history", exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const cdp = await context.newCDPSession(page); await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument");
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: 'a[aria-label="Libitu home"] b' });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      assert.ok(fonts.some(font => font.isCustomFont && /Inter/i.test(font.familyName)), `actual Inter glyphs required: ${JSON.stringify(fonts)}`);
      assert.ok(fontRequests.length > 0 && fontRequests.every(url => new URL(url).origin === origin), "fonts must be served locally");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} horizontal overflow at ${width}`);
      if (name === "landing") {
        const field = page.getByLabel("Your YouTube video", { exact: true });
        await field.fill("https://example.com/no-video"); await field.press("Enter");
        await page.locator("#video-error").waitFor();
        assert.equal(await field.getAttribute("aria-invalid"), "true");
        assert.equal(await field.locator("..").evaluate(el => getComputedStyle(el).borderColor), "rgb(163, 55, 43)");
      }
      if (name === "loadout") {
        const field = page.getByLabel("Mission goal", { exact: true }); await field.fill("Explain the project update"); await field.focus();
        assert.equal(await field.evaluate(el => getComputedStyle(el).outlineWidth), "1px");
        assert.notEqual(await field.evaluate(el => getComputedStyle(el).outlineColor), "rgb(83, 74, 183)");
        assert.notEqual(await field.evaluate(el => getComputedStyle(el).borderColor), "rgb(83, 74, 183)");
        await page.getByRole("combobox", { name: "Difficulty", exact: true }).click();
        await page.getByRole("option", { name: "Guided", exact: true }).click();
        assert.equal(await page.getByRole("combobox", { name: "Difficulty", exact: true }).textContent(), "Guided");
      }
      if (name === "corpus") {
        const search = page.getByRole("searchbox", { name: "Search corpus" }); await search.fill("to be fair");
        assert.equal(await page.getByRole("button", { name: "View to be fair", exact: true }).count(), 1);
        await search.clear(); await page.getByRole("button", { name: "View to be fair", exact: true }).click();
        await page.getByRole("button", { name: "Edit item", exact: true }).click();
        await page.getByLabel("Meaning", { exact: true }).fill("An updated meaning");
        assert.equal(await page.getByLabel("Meaning", { exact: true }).inputValue(), "An updated meaning");
      }
      assert.deepEqual(errors, [], "no uncaught page errors");
      await page.screenshot({ path: `${out}/${name}-${width}.png`, fullPage: true });
      console.log(`PASS ${name} ${width}: local Inter glyphs, responsive layout and controls`);
    } catch (error) {
      console.error(await page.evaluate(() => [...document.querySelectorAll("body *")].filter(el => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(el => ({ tag: el.tagName, className: el.className, width: el.getBoundingClientRect().width }))));
      await page.screenshot({ path: `${out}/failure-${name}-${width}.png`, fullPage: true });
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
console.log(`Screenshots: ${out}`);
