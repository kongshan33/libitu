import assert from "node:assert/strict";
import { installSignedInPractice } from "./helpers/signed-in-practice.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const videoId = "YIokM_4i1i0";
const job = { id: "recovery-job", content_id: "recovery-content", status: "ready", blueprint_id: "recovery-blueprint",
  processing_stage: "completed", analysis_version: "mvp-v9", analysis_preview: null, error_message: null };
const blueprint = {
  id: job.blueprint_id, content_id: job.content_id, source_url: `https://youtu.be/${videoId}?si=cached-share`,
  title: "Cached caption recovery", summary: "The cached semantic summary stays available.", chapters: [], logic_flow: [], corpus_items: [],
  transcript: ["Cached words stay together.", "Another complete sentence follows."].map((text, index) => ({
    id: `sentence-v2-recovery-${index}`, segmentation_version: "sentence-v2", time: `0:0${1 + index * 3}`,
    parts: [text], source_token_start: index * 4, source_token_end: index * 4 + 4,
    start_ms: 1000 + index * 3000, end_ms: 4000 + index * 3000,
    boundary_source: "source_punctuation", boundary_confidence: "high", timing_source: "caption_estimate"
  })),
  segments: [{ id: "recovery-segment", sequence: 1, title: "Cached practice", summary: "Listen to the saved sentences.",
    start_ms: 1000, end_ms: 7000, transcript_start_index: 0, transcript_end_index: 2, phonology_tags: [] }]
};
const recovered = { ...blueprint, transcript: blueprint.transcript.map((row, index) => ({
  ...row, id: `sentence-v3-recovery-${index}`, segmentation_version: "sentence-v3", start_ms: row.start_ms + 100,
  timing_source: "caption_word_offsets", word_timings: row.parts[0].split(" ").map((text, offset) => ({
    source_token_index: row.source_token_start + offset, text,
    start_ms: row.start_ms + 100 + offset * 200, end_ms: row.start_ms + 300 + offset * 200,
    start_source: "caption_offset", end_source: "next_word_estimate", source_event_index: index, source_seg_index: offset
  }))
})) };
const track = { version: "youtube-json3-v1", video_id: videoId, language: "en", kind: "asr",
  events: blueprint.transcript.map((row) => ({ tStartMs: row.start_ms, dDurationMs: 3000,
    segs: row.parts[0].split(" ").map((utf8, index) => ({ utf8: `${index ? " " : ""}${utf8}`, tOffsetMs: index * 200 })) })) };
const observerFailures = [
  ["observer_missing", /reload the extension first.*Refresh that YouTube page once/],
  ["not_observed", /Turn on English captions/],
  ["no_word_offsets", /currently observed caption track.*English \(auto-generated\).*may still be unavailable/],
  ["request_failed", /caption request failed.*off and back on.*player can request captions again/],
  ["empty_response", /empty caption JSON response.*off and back on.*player can request captions again/],
  ["invalid_response", /not valid JSON3/],
  ["response_too_large", /exceeded the supported size limit/],
  ["observer_timeout", /observed captions timed out.*off and back on.*player can request captions again/],
  ["bridge_error", /Communication with the Libitu extension was interrupted/]
];

async function reply(page, status = "ready") {
  await page.evaluate(({ status, track }) => {
    const request = window.__freshRequests.at(-1);
    window.postMessage({ type: "LIBITU_FRESH_CAPTIONS_RESPONSE", requestId: request.requestId,
      videoId: request.videoId, status, ...(status === "ready" ? { captionTrack: track } : {}) }, location.origin);
  }, { status, track });
}

const browser = await chromium.launch({ headless: true, channel: process.env.LIBITU_BROWSER_CHANNEL ?? "chrome" });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const scenario of ["paused-apply", "practice-pending", "absent-extension", "observer-statuses"]) {
      const context = await browser.newContext({ viewport, serviceWorkers: "block" });
      const page = await context.newPage();
      const errors = [], requests = [], assets = [];
      let updateRoute;
      let resolveUpdateRoute;
      const updateArrived = new Promise((resolve) => { resolveUpdateRoute = resolve; });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => { if (request.url().includes("/acoustic-assets/")) assets.push(request.url()); });
      await context.route("**/*", async (route) => {
        const request = route.request(), url = new URL(request.url());
        const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
        if (url.pathname.startsWith("/api/")) {
          if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
          requests.push(`${request.method()} ${url.pathname}`);
          if (url.pathname === `/api/jobs/${job.id}` && request.method() === "GET") return route.fulfill({ json: job, headers });
          if (url.pathname === `/api/blueprints/${job.content_id}`) return route.fulfill({ json: blueprint, headers });
          if (url.pathname === `/api/content/${job.content_id}/caption-timing`) {
            assert.equal(request.method(), "POST");
            assert.equal(url.searchParams.get("learner_level"), "B2");
            assert.deepEqual(request.postDataJSON(), { caption_track: track });
            updateRoute = route;
            resolveUpdateRoute();
            return;
          }
          if (url.pathname.startsWith(`/api/blueprints/${job.content_id}/sentences/`) && url.pathname.endsWith("/sound")) {
            return route.fulfill({ status: 404, json: { detail: "Sound is outside this caption recovery fixture." }, headers });
          }
          throw new Error(`Unexpected API request: ${request.method()} ${url.pathname}`);
        }
        if (url.origin === origin) return route.continue();
        // Anonymous auth and player fixtures must never reach external providers.
        if (request.resourceType() === "script") return route.fulfill({ contentType: "application/javascript", body: "" });
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><body>Cached video fixture</body>" });
      });
      await installSignedInPractice(page);
      await page.addInitScript(() => {
        window.__freshRequests = [];
        window.__referenceRequests = [];
        window.__players = [];
        window.__microphoneRequests = 0;
        navigator.mediaDevices.getUserMedia = () => { window.__microphoneRequests++; return new Promise(() => {}); };
        window.addEventListener("message", ({ data }) => {
          if (data?.type === "LIBITU_FRESH_CAPTIONS_REQUEST") window.__freshRequests.push(data);
          if (data?.type !== "LIBITU_REFERENCE_REQUEST") return;
          window.__referenceRequests.push(data);
          const base = { type: "LIBITU_REFERENCE_EVENT", version: 2, sessionId: data.sessionId, requestId: data.requestId };
          if (data.action === "ping") window.postMessage({ ...base, status: "available" }, location.origin);
          if (data.action === "arm") {
            window.__referenceSession = data.sessionId;
            window.postMessage({ ...base, status: "armed" }, location.origin);
            window.postMessage({ ...base, status: "enabled" }, location.origin);
          }
          if (data.action === "close") window.__referenceSession = null;
        });
        window.YT = { Player: class {
          time = 0; rate = 1; playing = false; ready = false;
          constructor(_element, { events }) { this.events = events; window.__players.push(this); window.__activePlayer = this;
            queueMicrotask(() => { this.ready = true; events.onReady(); }); }
          getCurrentTime() { return this.time; }
          getPlayerState() { return this.playing ? 1 : 2; }
          seekTo(seconds) { this.time = seconds; }
          playVideo() { this.playing = true; this.events.onStateChange({ data: 1 }); }
          pauseVideo() { this.playing = false; this.events.onStateChange({ data: 2 }); }
          setPlaybackRate(rate) { this.rate = rate; this.events.onPlaybackRateChange?.({ data: rate }); }
          getPlaybackRate() { return this.rate; }
          getAvailablePlaybackRates() { return [0.75, 1, 1.25]; }
          destroy() { this.destroyed = true; this.playing = false; }
        } };
      });
      const params = new URLSearchParams({ contentId: job.content_id, jobId: job.id, learnerLevel: "B2", sourceUrl: blueprint.source_url });
      if (scenario === "practice-pending") {
        params.set("stage", "2"); params.set("segmentId", blueprint.segments[0].id); params.set("sentenceId", blueprint.transcript[0].id);
      }
      await page.goto(`${origin}/?${params}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForFunction(() => window.__freshRequests.length === 1 && window.__activePlayer?.ready);
      assert.equal(new URL(page.url()).searchParams.get("sourceUrl"), `https://www.youtube.com/watch?v=${videoId}`);
      assert.equal(await page.evaluate(() => window.__freshRequests[0].sourceUrl), `https://www.youtube.com/watch?v=${videoId}`);
      const iframe = await page.locator(".youtube-player iframe").elementHandle();
      assert.equal(updateRoute, undefined, "cached content appears before the extension replies");
      assert.ok(!requests.some((request) => request.startsWith("POST")));

      if (scenario === "paused-apply") {
        await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).waitFor();
        assert.equal(await page.locator(".transcript-line").count(), 2);
        await page.locator(".transcript-time").first().click();
        await reply(page);
        await updateArrived;
        assert.ok(updateRoute);
        await updateRoute.fulfill({ json: { status: "updated", blueprint: recovered }, headers: { "access-control-allow-origin": "*" } });
        await page.locator("[data-caption-recovery-phase='ready']").waitFor();
        assert.match(await page.locator(".caption-timing-recovery").innerText(), /Pause the video/);
        assert.equal(await page.locator(".transcript-line").first().getAttribute("id"), "transcript-sentence-v2-recovery-0");
        assert.equal(await page.evaluate(() => window.__activePlayer.playing), true);
        await page.evaluate(() => window.__activePlayer.pauseVideo());
        await page.locator("#transcript-sentence-v3-recovery-0").waitFor();
        assert.equal(await page.locator(".caption-word").count(), 8);
        assert.equal(await page.locator(".word-timing-notice").count(), 0);
        assert.equal(await iframe.evaluate((node) => node.isConnected && node === document.querySelector(".youtube-player iframe")), true);
      } else if (scenario === "practice-pending") {
        await page.locator(".stage-two-shadow").waitFor();
        // Hold the slower API response while setting up practice; do not let fixture
        // interactions consume the extension bridge's intentionally short timeout.
        await reply(page);
        await updateArrived;
        const recorder = await page.locator(".stage-two-recording").elementHandle();
        await page.getByRole("button", { name: "Record sentence", exact: true }).click();
        await page.getByText("Waiting for microphone permission…", { exact: true }).waitFor();
        await updateRoute.fulfill({ json: { status: "updated", blueprint: recovered }, headers: { "access-control-allow-origin": "*" } });
        await page.locator("[data-caption-recovery-phase='ready']").waitFor();
        assert.match(await page.locator(".caption-timing-recovery").innerText(), /Return to Stage 1/);
        assert.equal(new URL(page.url()).searchParams.get("sentenceId"), blueprint.transcript[0].id);
        assert.equal(await page.locator(".stage-two-sentence-focus .caption-word").count(), 0);
        assert.equal(await page.getByText("Waiting for microphone permission…", { exact: true }).count(), 1);
        assert.equal(await page.evaluate(() => window.__microphoneRequests), 1);
        assert.equal(await page.evaluate(() => window.__referenceRequests.length), 0,
          "caption recovery does not activate a reference capture session");
        for (const [node, selector] of [[iframe, ".youtube-player iframe"], [recorder, ".stage-two-recording"]]) {
          assert.equal(await node.evaluate((element, css) => element.isConnected && element === document.querySelector(css), selector), true);
        }
        await page.screenshot({ path: `/tmp/libitu-caption-recovery-practice-held-${viewport.width}.png`, fullPage: true });
        await page.getByRole("button", { name: "Stage 1 - Ingest", exact: true }).click();
        await page.locator("#transcript-sentence-v3-recovery-0").waitFor();
      } else if (scenario === "observer-statuses") {
        await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).waitFor();
        for (const [index, [status, expected]] of observerFailures.entries()) {
          if (index) {
            await page.getByRole("button", { name: "Retry word timing", exact: true }).click();
            await page.waitForFunction((count) => window.__freshRequests.length === count, index + 1);
          }
          await reply(page, status);
          const notice = page.locator("[data-caption-recovery-phase='failed']");
          await notice.waitFor();
          assert.match(await notice.innerText(), expected);
          assert.equal(await notice.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
          assert.equal(await page.locator(".transcript-line").count(), 2);
          assert.equal(await page.evaluate(() => window.__freshRequests.length), index + 1);
          assert.ok(!requests.some((request) => request.startsWith("POST")), "observation failures do not write to an API");
          await page.screenshot({ path: `/tmp/libitu-caption-recovery-${status}-${viewport.width}.png`, fullPage: true });
        }
      } else {
        await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).waitFor();
        await page.getByRole("button", { name: "Retry word timing", exact: true }).waitFor({ timeout: 7000 });
        assert.match(await page.locator(".caption-timing-recovery").innerText(), /caption check timed out/);
        const toggle = page.getByRole("button", { name: "Highlight active", exact: true });
        await toggle.click(); await toggle.click();
        assert.equal(await page.evaluate(() => window.__freshRequests.length), 1, "display toggles do not retry");
        await page.getByRole("button", { name: "Retry word timing", exact: true }).click();
        await page.waitForFunction(() => window.__freshRequests.length === 2);
        // Same video but a new content URL must invalidate the in-flight recovery.
        await page.evaluate(() => { const url = new URL(location.href); url.searchParams.set("contentId", "other-content"); history.replaceState(history.state, "", url); });
        await reply(page);
        await page.getByRole("button", { name: "Retry word timing", exact: true }).waitFor();
        assert.match(await page.locator(".caption-timing-recovery").innerText(), /source changed/);
        assert.equal(updateRoute, undefined);
        assert.ok(!requests.some((request) => request.startsWith("POST")), "absent/stale extension replies never trigger an API write");
      }
      assert.equal(await page.evaluate(() => window.__freshRequests.length),
        scenario === "observer-statuses" ? observerFailures.length : scenario === "absent-extension" ? 2 : 1,
        "Strict Mode and ordinary rerenders issue one real automatic read per source");
      assert.ok(!requests.some((request) => request === "POST /api/jobs" || request.includes("/resolve") || request.includes("analyze")));
      assert.deepEqual(assets, []);
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `/tmp/libitu-caption-recovery-${scenario}-${viewport.width}.png`, fullPage: true });
      console.log(`Caption recovery ${scenario} passed at ${viewport.width}px`);
      await context.close();
    }
  }
} finally { await browser.close(); }
