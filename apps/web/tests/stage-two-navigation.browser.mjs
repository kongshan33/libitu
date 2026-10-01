import assert from "node:assert/strict";
import { installSignedInPractice } from "./helpers/signed-in-practice.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const job = {
  id: "stage-two-test", content_id: "practice-content", status: "ready", blueprint_id: "practice-blueprint",
  analysis_version: "mvp-v9", processing_stage: "completed", analysis_preview: null, error_message: null
};
const blueprint = {
  id: job.blueprint_id, content_id: job.content_id, title: "Sentence practice",
  source_url: "https://www.youtube.com/watch?v=practice123", summary: "A short practice clip.", chapters: [],
  logic_flow: [{ id: "logic-1", title: "Opening", subtitle: "An introduction.", time: "0:01" }], corpus_items: [],
  transcript: [
    { time: "0:01", parts: ["Let's begin."], start_ms: 1000, end_ms: 3000, source_token_start: 0, source_token_end: 2 },
    { time: "0:01", parts: ['Dr. Smith asked, "Really?" and waited for our reply.'], start_ms: 3000, end_ms: 9000,
      source_token_start: 2, source_token_end: 11 },
    { time: "0:09", parts: ["The third sentence continues here."], start_ms: 9000, end_ms: 15000,
      source_token_start: 11, source_token_end: 16 },
    { time: "0:12", parts: ["We finish the segment."], start_ms: 15000, end_ms: 20000,
      source_token_start: 16, source_token_end: 20 },
    { time: "0:20", parts: ["One final sentence."], start_ms: 20000, end_ms: 26000,
      source_token_start: 20, source_token_end: 23 }
  ].map((row, index) => ({
    ...row, id: `sentence-v2-practice-${index}`, segmentation_version: "sentence-v2",
    boundary_source: "syntax_merge", boundary_confidence: "medium",
    timing_source: index < 3 ? "caption_word_offsets" : "caption_event_estimate",
    word_timings: index < 3 ? row.parts[0].split(" ").map((text, wordIndex) => ({
      source_token_index: row.source_token_start + wordIndex, text,
      start_ms: row.start_ms + wordIndex * 100, end_ms: row.start_ms + (wordIndex + 1) * 100,
      start_source: "caption_offset", end_source: "next_word_estimate", source_event_index: index, source_seg_index: wordIndex
    })) : []
  })),
  segments: [
    { id: "segment-1", sequence: 1, title: "Opening", summary: "Practice the opening.", start_ms: 1000, end_ms: 20000,
      transcript_start_index: 0, transcript_end_index: 4, phonology_tags: [] },
    { id: "segment-2", sequence: 2, title: "Closing", summary: "Practice the closing.", start_ms: 20000, end_ms: 26000,
      transcript_start_index: 4, transcript_end_index: 5, phonology_tags: [] },
    { id: "segment-3", sequence: 3, title: "No captions", summary: "Listen to the segment.", start_ms: 30000, end_ms: 35000,
      phonology_tags: [] }
  ]
};
const entry = `${origin}/?${new URLSearchParams({
  sourceUrl: blueprint.source_url, title: blueprint.title, contentId: job.content_id, jobId: job.id, learnerLevel: "B2"
})}#transcript-0-01`;
const requestedViewport = Number(process.env.LIBITU_NAV_VIEWPORT ?? 0);
const viewports = [{ width: 1440, height: 1000 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]
  .filter((viewport) => !requestedViewport || viewport.width === requestedViewport);

async function startSegment(page, index) {
  await page.locator(".stage-one-segment-card").nth(index).click();
  await page.getByRole("button", { name: /Begin Stage 2/ }).click();
  await page.getByRole("button", { name: "Start shadowing", exact: true }).click();
  await page.locator(".stage-two-shadow").waitFor();
  await page.waitForFunction(() => window.__activePlayer?.ready && !window.__activePlayer.destroyed);
}

async function sampleAt(page, seconds) {
  await page.evaluate((time) => { window.__activePlayer.time = time; }, seconds);
  // The production controller polls every 100 ms; cross at least two ticks.
  await page.waitForTimeout(250);
}

async function chooseSelect(page, label, option) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function selectedText(page, label) {
  return (await page.getByRole("combobox", { name: label, exact: true }).textContent())?.trim();
}

const browser = await chromium.launch({ headless: true, channel: process.env.LIBITU_BROWSER_CHANNEL ?? "chrome" });
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
      if (url.pathname.startsWith("/api/")) {
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (route.request().method() === "GET" && url.pathname.startsWith(`/api/blueprints/${job.content_id}/sentences/`)
          && url.pathname.endsWith("/sound")) return route.fulfill({ status: 404, json: { detail: "Sound guide is outside this navigation fixture." }, headers });
        requests.push(`${route.request().method()} ${url.pathname}`);
        if (url.pathname === `/api/jobs/${job.id}`) return route.fulfill({ json: job, headers });
        if (url.pathname === `/api/blueprints/${job.content_id}`) return route.fulfill({ json: blueprint, headers });
        throw new Error(`Unexpected API call: ${url.pathname}`);
      }
      if (url.origin === origin || url.hostname.endsWith(".clerk.accounts.dev")) return route.continue();
      return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><body style='margin:0;background:#eeeef5;height:100vh;display:grid;place-content:center;color:#686377;font:16px system-ui'>Video player test fixture</body>" });
    });
    await installSignedInPractice(page);
    await page.addInitScript(() => {
      window.__players = [];
      window.YT = { Player: class {
        time = 0; rate = 1; playing = false; ready = false; destroyed = false; seeks = [];
        constructor(_element, { events }) {
          this.events = events;
          window.__players.push(this);
          window.__activePlayer = this;
          queueMicrotask(() => { this.ready = true; events.onReady(); });
        }
        getCurrentTime() { return this.time; }
        seekTo(seconds) { this.seeks.push(seconds); if (!window.__holdSeek) this.time = seconds; }
        playVideo() { this.playing = true; this.events.onStateChange({ data: 1 }); }
        pauseVideo() { this.playing = false; this.events.onStateChange({ data: 2 }); }
        setPlaybackRate(rate) { this.rate = rate; this.events.onPlaybackRateChange?.({ data: rate }); }
        getPlaybackRate() { return this.rate; }
        getAvailablePlaybackRates() { return [0.5, 0.75, 1, 1.25, 1.5]; }
        destroy() { this.destroyed = true; this.playing = false; }
      } };
    });
    await page.goto(entry, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).click();
    await startSegment(page, 0);
    const nav = page.locator(".stage-two-sentence-navigation");
    const items = page.locator(".stage-two-sentences ol button");
    assert.equal(await items.count(), 4);
    assert.match(await nav.innerText(), /Sentence 1 of 4/);
    assert.equal(await page.getByRole("button", { name: "Previous sentence", exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__activePlayer.playing), false);
    assert.equal(new URL(page.url()).searchParams.get("stage"), "2");
    const iframe = await page.locator(".youtube-player iframe").elementHandle();

    await page.getByRole("button", { name: "Next sentence", exact: true }).click();
    assert.match(await nav.innerText(), /Sentence 2 of 4/);
    const sentenceId = new URL(page.url()).searchParams.get("sentenceId");
    assert.equal(sentenceId, blueprint.transcript[1].id, "Stage 2 retains the shared server sentence ID");
    assert.ok((await items.nth(1).innerText()).includes(blueprint.transcript[1].parts[0]),
      "punctuation inside a finalized sentence does not create more practice units");
    const secondStart = await page.evaluate(() => window.__activePlayer.seeks.at(-1));
    assert.ok(secondStart > 1 && secondStart < 9);
    assert.equal(await page.evaluate(() => window.__activePlayer.playing), false);
    await sampleAt(page, secondStart);
    await page.getByRole("button", { name: "Play sentence", exact: true }).click();
    await sampleAt(page, 3.15);
    assert.equal(await page.locator(".stage-two-sentence-focus .caption-word-active").textContent(), "Smith");
    assert.equal(await items.nth(1).locator(".caption-word-active").textContent(), "Smith");
    await chooseSelect(page, "Playback speed", "0.75×");
    await sampleAt(page, 3.25);
    assert.equal(await page.locator(".stage-two-sentence-focus .caption-word-active").textContent(), "asked,", "rate changes follow actual video time");
    await chooseSelect(page, "Playback speed", "1×");
    await page.evaluate(() => { window.__holdSeek = true; });
    const seeksBeforeLoop = await page.evaluate(() => window.__activePlayer.seeks.length);
    await sampleAt(page, 9);
    await page.waitForFunction((expected) => window.__activePlayer.seeks.length >= expected, seeksBeforeLoop + 1);
    assert.equal(await page.evaluate(() => window.__activePlayer.seeks.length), seeksBeforeLoop + 1,
      "the old end timestamp must not cause repeated seeks while a loop seek is pending");
    await page.evaluate((time) => { window.__holdSeek = false; window.__activePlayer.time = time; }, secondStart);
    await page.waitForTimeout(150);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await sampleAt(page, 9);
    assert.equal(await page.evaluate(() => window.__activePlayer.playing), false, "paused playback cannot restart a loop");
    await page.getByRole("button", { name: "Loop on", exact: true }).click();
    await page.getByRole("button", { name: "Play sentence", exact: true }).click();
    await page.waitForTimeout(150);
    await sampleAt(page, 9);
    assert.equal(await page.evaluate(() => window.__activePlayer.playing), false, "play once stops at the sentence end");

    await chooseSelect(page, "Playback range", "Segment");
    assert.equal(await page.evaluate(() => window.__activePlayer.seeks.at(-1)), 1);
    await page.getByRole("button", { name: "Loop off", exact: true }).click();
    await sampleAt(page, 1);
    await page.getByRole("button", { name: "Play segment", exact: true }).click();
    await sampleAt(page, 9);
    assert.equal(await page.evaluate(() => window.__activePlayer.playing), true, "segment playback crosses sentence boundaries");
    assert.match(await nav.innerText(), /Sentence 2 of 4/, "playing sentence is separate from the selected sentence");
    assert.match(await items.nth(2).innerText(), /Playing/);
    assert.equal(await page.locator(".stage-two-sentence-focus .caption-word-active").count(), 0,
      "the selected sentence cannot highlight words from the playing sentence");
    assert.equal(await items.nth(2).locator(".caption-word-active").textContent(), "The");
    await sampleAt(page, 20);
    assert.equal(await page.evaluate(() => window.__activePlayer.seeks.at(-1)), 1);
    await items.nth(1).click();
    assert.equal(await selectedText(page, "Playback range"), "Sentence");
    assert.equal(await page.evaluate(() => window.__activePlayer.playing), false);
    await items.nth(1).press("End");
    assert.match(await nav.innerText(), /Sentence 4 of 4/);
    assert.equal(await page.getByRole("button", { name: "Next sentence", exact: true }).isDisabled(), true);
    await items.nth(3).press("Home");
    await items.nth(0).press("ArrowDown");
    assert.equal(new URL(page.url()).searchParams.get("sentenceId"), sentenceId);
    await chooseSelect(page, "Playback speed", "0.75×");
    assert.equal(await selectedText(page, "Playback speed"), "0.75×");
    assert.equal(await page.evaluate(() => window.__activePlayer.rate), 0.75);
    assert.equal(await iframe.evaluate((node) => node.isConnected && node === document.querySelector(".youtube-player iframe")), true,
      "sentence, scope and speed changes preserve the iframe");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".stage-two-shadow").waitFor();
    assert.match(await nav.innerText(), /Sentence 2 of 4/);
    assert.equal(new URL(page.url()).searchParams.get("sentenceId"), sentenceId);
    assert.equal(new URL(page.url()).hash, "#transcript-0-01");
    assert.equal(new URL(page.url()).searchParams.get("learnerLevel"), "B2");
    await page.waitForFunction(() => window.__activePlayer?.ready);
    assert.equal(await page.evaluate(() => window.__activePlayer.playing), false);
    assert.deepEqual(requests, Array(2).fill([`GET /api/jobs/${job.id}`, `GET /api/blueprints/${job.content_id}`]).flat());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal page overflow");
    const playerGeometry = await page.locator(".stage-two-shadow-player").evaluate((container) => {
      const box = container.getBoundingClientRect();
      const frame = container.querySelector("iframe").getBoundingClientRect();
      return { width: box.width, height: box.height, frameWidth: frame.width, frameHeight: frame.height };
    });
    assert.ok(Math.abs(playerGeometry.width - playerGeometry.frameWidth) < 1
      && Math.abs(playerGeometry.height - playerGeometry.frameHeight) < 1, "the iframe fills the player at every viewport");
    await page.locator(".stage-two-shadow-header").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/libitu-stage-two-${viewport.width}.png`, fullPage: true });

    const stale = new URL(page.url());
    stale.searchParams.set("sentenceId", "obsolete-sentence");
    await page.goto(stale.href, { waitUntil: "domcontentloaded" });
    await page.locator(".stage-two-shadow").waitFor();
    assert.match(await nav.innerText(), /Sentence 1 of 4/);
    await page.waitForFunction(() => new URL(location.href).searchParams.get("sentenceId") !== "obsolete-sentence");
    await page.getByRole("button", { name: "Back to segments", exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.has("stage"), false);
    assert.equal(await page.evaluate(() => window.__players.every((player) => player.destroyed)), true);
    await startSegment(page, 1);
    assert.match(await nav.innerText(), /Sentence 1 of 1/);
    assert.equal(await page.getByRole("button", { name: "Previous sentence", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Next sentence", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Back to segments", exact: true }).click();
    await startSegment(page, 2);
    assert.match(await nav.innerText(), /Segment playback/);
    assert.equal(await page.getByRole("button", { name: "Play segment", exact: true }).isEnabled(), true);
    assert.equal(await selectedText(page, "Playback range"), "Segment");

    const invalid = new URL(page.url());
    invalid.searchParams.set("segmentId", "removed-segment");
    await page.goto(invalid.href, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).waitFor();
    await page.waitForFunction(() => !new URL(location.href).searchParams.has("stage"));
    assert.equal(await page.locator(".stage-two-shadow").count(), 0);
    assert.deepEqual(errors, []);
    console.log(`Stage 2 navigation passed at ${viewport.width}px`);
    await context.close();
  }
} finally {
  await browser.close();
}
