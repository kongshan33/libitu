import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { installLoadoutFixture, shadowBlueprint, shadowJob } from "./helpers/loadout-fixture.mjs";
import { contentContextFixture } from "./helpers/content-context-fixture.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const lines = Array.from({ length: 30 }, (_, i) => ({
  ...shadowBlueprint.transcript[0], id: `sentence-v2-progressive-${i}`, time: `0:${String(i + 1).padStart(2, "0")}`,
  start_ms: (i + 1) * 1000, end_ms: (i + 2) * 1000, text: `This is sentence number ${i + 1}.`,
  source_token_start: i * 6, source_token_end: (i + 1) * 6
}));
const blueprint = { ...shadowBlueprint, corpus_items: [],
  transcript: lines.map(({ text, ...line }) => ({ ...line, parts: [text] })) };
const preview = count => ({ output_chars: count * 100, summary: "A progressively rendered summary.", chapters: [],
  logic_flow: [{ title: "Opening", subtitle: "An introduction", timestamp: "0:01" }],
  corpus_items: [], transcript_lines: lines.slice(0, count) });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  for (const [width, reducedMotion] of [[1440, "no-preference"], [390, "no-preference"], [1440, "reduce"]]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion });
    const page = await context.newPage();
    const state = await installLoadoutFixture(page, { origin, shadow: true, seedCorpus: false });
    await page.route("https://www.youtube-nocookie.com/embed/**", route => route.fulfill({
      contentType: "text/html", body: '<body style="margin:0"><button onclick="this.textContent=\'Played\'">Play fixture</button></body>'
    }));
    const job = { ...shadowJob, status: "processing", processing_stage: "analyzing", blueprint_id: null };
    const headers = { "access-control-allow-origin": "*" };
    await page.route(`**/api/content/${blueprint.content_id}`, route => route.fulfill({ headers, json: contentContextFixture(blueprint, job) }));
    await page.route(`**/api/jobs/${job.id}`, route => route.fulfill({ headers, json: job }));
    await page.route(`**/api/blueprints/${blueprint.content_id}?**`, route => route.fulfill({ headers, json: blueprint }));
    await page.addInitScript(() => {
      window.__readerStreams = [];
      window.__readerAnimations = [];
      document.addEventListener("animationstart", event => {
        if (event.animationName === "reader-content-reveal") window.__readerAnimations.push(event.target.dataset.readerReveal);
      });
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.__readerStreams.push(this); }
        close() {}
      };
    });
    await page.goto(`${origin}/practice/${blueprint.content_id}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__readerStreams.length === 1);
    assert.equal(await page.locator(".reader-skeleton").count(), 3);
    const emit = snapshots => page.evaluate(snapshots => snapshots.forEach(snapshot => {
      window.__readerStreams[0].dispatchEvent(new MessageEvent("job", { data: JSON.stringify(snapshot) }));
    }), snapshots);
    await emit([{ ...job, analysis_preview: preview(2) }]);
    await page.waitForFunction(() => document.querySelectorAll(".transcript-line").length === 2);
    assert.equal(await page.locator(".left-panel .reader-skeleton, .center-panel .reader-skeleton").count(), 0);
    assert.equal(await page.locator(".right-panel .reader-skeleton").count(), 1, "empty regions keep their skeleton");
    assert.equal(await page.getByText("Expressions will appear here as they are validated.", { exact: true }).count(), 0);
    const first = await page.locator(".transcript-line").first().elementHandle();
    const frame = await page.locator(".youtube-player iframe").elementHandle();
    const delays = await page.locator(".transcript-line").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationDelay));
    if (reducedMotion === "reduce") {
      assert.equal(await first.evaluate(node => getComputedStyle(node).animationName), "none");
    } else assert.deepEqual(delays, ["0s", "0.04s"]);
    await page.waitForTimeout(600); // Let the actual CSS entrance finish before checking for replay.
    const starts = await page.evaluate(() => [...window.__readerAnimations]);
    await emit([{ ...job, analysis_preview: preview(3) }, { ...job, analysis_preview: preview(4) }]);
    await page.waitForFunction(() => document.querySelectorAll(".transcript-line").length === 4);
    if (reducedMotion !== "reduce") {
      assert.equal(await page.locator(".transcript-line").nth(2).evaluate(node => getComputedStyle(node).animationDelay), "0s",
        "a new batch starts immediately, without waiting behind earlier rows");
    }
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(key => window.__readerAnimations.filter(value => value === key).length,
      "transcript:sentence-v2-progressive-0"), starts.filter(value => value === "transcript:sentence-v2-progressive-0").length);
    await emit([{ ...job, analysis_preview: preview(30) }]);
    await page.waitForFunction(() => document.querySelectorAll(".transcript-line").length === 30);
    assert.ok(await page.locator(".transcript-line[data-reader-entering]").count() <= 16, "large batches bound animation work");
    job.status = "ready"; job.blueprint_id = blueprint.id; job.processing_stage = "completed";
    await emit([job]);
    await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).waitFor();
    assert.equal(await first.evaluate(node => node === document.querySelector(".transcript-line")), true);
    assert.equal(await frame.evaluate(node => node === document.querySelector(".youtube-player iframe")), true);
    assert.equal(await page.locator(".reader-skeleton").count(), 0);
    await page.locator(".center-panel").evaluate(node => { node.scrollTop = 0; });
    await page.locator(".workspace-media-slot").scrollIntoViewIfNeeded();
    const video = page.frameLocator(".youtube-player iframe");
    await video.getByRole("button", { name: "Play fixture" }).click();
    await video.getByRole("button", { name: "Played" }).waitFor();
    const box = await page.locator(".youtube-player iframe").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 100));
    const scrollBefore = await page.evaluate(() => scrollY + document.querySelector(".center-panel").scrollTop);
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(before => scrollY + document.querySelector(".center-panel").scrollTop > before, scrollBefore);
    const scrollAfter = await page.evaluate(() => scrollY + document.querySelector(".center-panel").scrollTop);
    await page.mouse.wheel(0, -60);
    await page.waitForFunction(after => scrollY + document.querySelector(".center-panel").scrollTop < after, scrollAfter);
    assert.equal(await frame.evaluate(node => node === document.querySelector(".youtube-player iframe")), true);
    await page.locator(".transcript-line").first().click();
    assert.equal(await page.evaluate(() => window.__loadoutPlayers.at(-1).time), 1, "revealed rows remain seekable");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(state.errors, []);
    await page.screenshot({ path: `/tmp/libitu-progressive-${width}-${reducedMotion}.png`, fullPage: false });
    console.log(`Progressive reader passed: ${width}px, ${reducedMotion}`);
    await context.close();
  }
} finally { await browser.close(); }
