import { contentContextFixture } from "./helpers/content-context-fixture.mjs";
import assert from "node:assert/strict";
import { installSignedInPractice } from "./helpers/signed-in-practice.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const job = {
  id: "recording-test", content_id: "a0000000-0000-4000-8000-000000000003", status: "ready", blueprint_id: "recording-blueprint",
  analysis_version: "mvp-v9", processing_stage: "completed", analysis_preview: null, error_message: null
};
const blueprint = {
  id: job.blueprint_id, content_id: job.content_id, title: "Local sentence recording",
  source_url: "https://www.youtube.com/watch?v=practice123", summary: "Practice one sentence at a time.",
  chapters: [], logic_flow: [{ id: "logic-1", title: "Opening", subtitle: "An introduction.", time: "0:01" }], corpus_items: [],
  transcript: ["Let's begin.", "This is the second sentence.", "We finish the segment."].map((text, index) => ({
    id: `sentence-v2-recording-${index}`, time: `0:0${index * 3 + 1}`, parts: [text],
    start_ms: index * 3000 + 1000, end_ms: index * 3000 + 4000,
    source_token_start: index * 5, source_token_end: index * 5 + text.split(" ").length,
    segmentation_version: "sentence-v2", boundary_source: "syntax_merge", boundary_confidence: "medium"
  })),
  segments: [{ id: "recording-segment", sequence: 1, title: "Opening", summary: "Practice the opening.",
    start_ms: 1000, end_ms: 10000, transcript_start_index: 0, transcript_end_index: 3, phonology_tags: [] }]
};
const entry = `${origin}/practice/${job.content_id}/shadow?${new URLSearchParams({
  segmentId: blueprint.segments[0].id, sentenceId: blueprint.transcript[0].id
})}`;

async function openPractice(page) {
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await page.locator(".stage-two-recording").waitFor();
  await page.waitForFunction(() => window.__activePlayer?.ready && !window.__activePlayer.destroyed);
}

async function startRecording(page, again = false) {
  await page.getByRole("button", { name: again ? "Record again" : "Record sentence", exact: true }).click();
  await page.getByText("Recording your voice", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__activePlayer.playing), false, "recording pauses the reference");
}

async function finishRecording(page) {
  // Record real encoded data from Chromium's synthetic audio source, never a physical microphone.
  await page.waitForTimeout(850);
  await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  await page.getByText("Your take is ready to replay", { exact: true }).waitFor();
  await assertReleased(page);
  const clip = await page.evaluate(() => {
    const audio = document.querySelector(".stage-two-recording audio");
    const item = window.__createdUrls.find((candidate) => candidate.url === audio.src);
    return { url: audio.src, size: item?.size, type: item?.type };
  });
  assert.ok(clip.size > 100, `the real MediaRecorder produces a nonempty encoded Blob: ${JSON.stringify(clip)}`);
  assert.match(clip.type, /^audio\//);
  return clip.url;
}

async function assertReleased(page) {
  await page.waitForFunction(() => window.__micStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")));
}

async function beginPending(page, again = false) {
  await page.evaluate(() => { window.__gumMode = "pending"; });
  await page.getByRole("button", { name: again ? "Record again" : "Record sentence", exact: true }).click();
  await page.getByText("Waiting for microphone permission…", { exact: true }).waitFor();
}

async function releasePending(page) {
  await page.evaluate(async () => {
    window.__gumMode = "grant";
    await window.__releaseMedia();
  });
  await assertReleased(page);
}

const browser = await chromium.launch({
  headless: true, channel: process.env.LIBITU_BROWSER_CHANNEL ?? "chrome",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
});
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    const apiCalls = [];
    const mediaUploads = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const type = request.headers()["content-type"] ?? "";
      if (request.method() !== "GET" && /^(audio\/|video\/|multipart\/)/i.test(type)) mediaUploads.push(request.url());
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
      if (url.pathname.startsWith("/api/")) {
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        apiCalls.push(`${request.method()} ${url.pathname}`);
        if (url.pathname === `/api/content/${blueprint.content_id}`) return route.fulfill({ json: contentContextFixture(blueprint, job), headers });
        if (request.method() === "GET" && url.pathname === `/api/jobs/${job.id}`) return route.fulfill({ json: job, headers });
        if (request.method() === "GET" && url.pathname === `/api/blueprints/${job.content_id}`) return route.fulfill({ json: blueprint, headers });
        if (request.method() === "GET" && url.pathname.startsWith(`/api/blueprints/${job.content_id}/sentences/`)
          && url.pathname.endsWith("/sound")) return route.fulfill({ status: 404, json: { detail: "Sound guide is outside this recorder fixture." }, headers });
        throw new Error(`Unexpected product API call: ${request.method()} ${url.pathname}`);
      }
      if (url.origin === origin || url.hostname.endsWith(".clerk.accounts.dev")) return route.continue();
      return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><body style='margin:0;background:#eeeef5;height:100vh;display:grid;place-content:center;color:#686377;font:16px system-ui'>Video player test fixture</body>" });
    });
    await installSignedInPractice(page);
    await page.addInitScript(() => {
      window.__players = [];
      window.YT = { Player: class {
        time = 0; rate = 1; playing = false; ready = false; destroyed = false;
        constructor(_element, { events }) {
          this.events = events;
          window.__players.push(this);
          window.__activePlayer = this;
          queueMicrotask(() => { this.ready = true; events.onReady(); });
        }
        getCurrentTime() { return this.time; }
        seekTo(seconds) { this.time = seconds; }
        playVideo() { this.playing = true; this.events.onStateChange({ data: 1 }); }
        pauseVideo() { this.playing = false; this.events.onStateChange({ data: 2 }); }
        setPlaybackRate(rate) { this.rate = rate; this.events.onPlaybackRateChange?.({ data: rate }); }
        getPlaybackRate() { return this.rate; }
        getAvailablePlaybackRates() { return [0.5, 0.75, 1, 1.25]; }
        destroy() { this.destroyed = true; this.playing = false; }
      } };
      window.__micStreams = [];
      window.__gumMode = "grant";
      window.__pendingMedia = [];
      window.__NativeMediaRecorder = window.MediaRecorder;
      const nativeGetMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      async function capture(constraints) {
        const stream = await nativeGetMedia(constraints);
        window.__micStreams.push(stream);
        return stream;
      }
      navigator.mediaDevices.getUserMedia = (constraints) => {
        if (window.__gumMode === "pending") return new Promise((resolve, reject) => {
          window.__pendingMedia.push({ constraints, resolve, reject });
        });
        if (window.__gumMode !== "grant") return Promise.reject(new DOMException("Test microphone failure", window.__gumMode));
        return capture(constraints);
      };
      window.__releaseMedia = async () => {
        const pending = window.__pendingMedia.shift();
        if (!pending) throw new Error("No pending microphone request");
        pending.resolve(await capture(pending.constraints));
      };
      window.__createdUrls = [];
      window.__revokedUrls = [];
      const createUrl = URL.createObjectURL.bind(URL);
      const revokeUrl = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = createUrl(blob);
        window.__createdUrls.push({ url, size: blob.size, type: blob.type });
        return url;
      };
      URL.revokeObjectURL = (url) => { window.__revokedUrls.push(url); revokeUrl(url); };
    });

    await openPractice(page);
    const panel = page.locator(".stage-two-recording");
    const audio = panel.locator("audio");
    const next = page.getByRole("button", { name: "Next sentence", exact: true });
    await page.getByRole("button", { name: "Play sentence", exact: true }).click();
    await startRecording(page);
    assert.equal(await page.getByRole("button", { name: "Play sentence", exact: true }).isDisabled(), true);
    await page.waitForTimeout(250); // Let the original seek settle before bypassing the custom Play control.
    await page.evaluate(() => window.__activePlayer.playVideo());
    assert.equal(await page.evaluate(() => window.__activePlayer.playing), false, "native YouTube play is blocked during capture");
    const firstUrl = await finishRecording(page);

    await page.getByRole("button", { name: "Replay recording", exact: true }).click();
    await page.waitForFunction(() => {
      const element = document.querySelector(".stage-two-recording audio");
      return element && !element.paused && element.currentTime > 0 && element.readyState >= 2;
    });
    assert.equal(await page.evaluate(() => window.__activePlayer.playing), false);
    await page.evaluate(() => window.__activePlayer.playVideo());
    await page.waitForFunction(() => document.querySelector(".stage-two-recording audio").paused);
    assert.equal(await page.evaluate(() => window.__activePlayer.playing), true, "native reference playback stops replay");
    await page.getByRole("button", { name: "Replay recording", exact: true }).click();
    await page.getByRole("button", { name: "Pause recording", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__activePlayer.playing), false, "replay pauses reference playback");

    await startRecording(page, true);
    assert.equal(await audio.evaluate((element) => element.paused), true);
    await page.getByRole("button", { name: "Cancel recording", exact: true }).click();
    await assertReleased(page);
    assert.equal(await audio.getAttribute("src"), firstUrl, "cancelled re-record preserves the previous take");
    assert.equal(await page.evaluate((url) => window.__revokedUrls.includes(url), firstUrl), false);
    await page.locator(".stage-two-sentences ol button").first().click();
    assert.equal(await audio.getAttribute("src"), firstUrl, "reselecting the same sentence retains its take");

    await startRecording(page, true);
    const secondUrl = await finishRecording(page);
    assert.notEqual(secondUrl, firstUrl);
    assert.equal(await page.evaluate((url) => window.__revokedUrls.filter((item) => item === url).length, firstUrl), 1);
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "recording controls fit the viewport");
    await page.screenshot({ path: `/tmp/libitu-stage-two-recording-${viewport.width}.png`, fullPage: true });

    await next.click();
    assert.equal(await audio.count(), 0, "sentence changes discard the previous take");
    assert.equal(await page.evaluate((url) => window.__revokedUrls.includes(url), secondUrl), true);
    assert.match(await panel.locator("h2").innerText(), /Sentence 2/);
    await beginPending(page);
    await next.click();
    await releasePending(page);
    assert.match(await panel.locator("h2").innerText(), /Sentence 3/);
    assert.equal(await page.getByRole("button", { name: "Stop recording", exact: true }).count(), 0);
    assert.equal(await audio.count(), 0, "late permission cannot attach audio to another sentence");

    await page.evaluate(() => { window.__gumMode = "NotAllowedError"; });
    await page.getByRole("button", { name: "Record sentence", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "Microphone access was denied" }).waitFor();
    await page.evaluate(() => { window.__gumMode = "NotFoundError"; });
    await page.getByRole("button", { name: "Record sentence", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "No available microphone" }).waitFor();
    await page.evaluate(() => { window.MediaRecorder = undefined; });
    await page.getByRole("button", { name: "Record sentence", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "unavailable in this browser" }).waitFor();
    await page.evaluate(() => { window.MediaRecorder = window.__NativeMediaRecorder; window.__gumMode = "grant"; });
    await startRecording(page);
    const retainedUrl = await finishRecording(page);
    await page.evaluate(() => { window.__gumMode = "NotReadableError"; });
    await page.getByRole("button", { name: "Record again", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "microphone could not start" }).waitFor();
    assert.equal(await audio.getAttribute("src"), retainedUrl, "permission/device failures retain the previous take");
    await page.evaluate(() => { window.__gumMode = "grant"; });

    await startRecording(page, true);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await assertReleased(page);
    assert.equal(await audio.getAttribute("src"), retainedUrl, "hiding cancels only the unfinished take");
    await page.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(await page.getByRole("button", { name: "Stop recording", exact: true }).count(), 0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await audio.waitFor({ state: "detached" });
    assert.equal(await audio.count(), 0, "pagehide clears temporary replay state, including bfcache navigation");
    assert.equal(await page.evaluate((url) => window.__revokedUrls.includes(url), retainedUrl), true);
    await assertReleased(page);

    await startRecording(page);
    await page.getByRole("button", { name: "Stage 1 - Ingest", exact: true }).click();
    await assertReleased(page);
    assert.equal(await panel.count(), 0, "the parent Stage 1 header unmounts and releases capture");
    await openPractice(page);
    await beginPending(page);
    await page.getByRole("button", { name: "Back to segments", exact: true }).click();
    await page.locator(".stage-one-segment-card").first().waitFor();
    await releasePending(page);
    assert.equal(await panel.count(), 0, "late grant after leaving Stage 2 does not revive recording");

    await openPractice(page);
    await startRecording(page);
    const deletedUrl = await finishRecording(page);
    await page.getByRole("button", { name: "Clear local recording", exact: true }).click();
    assert.equal(await audio.count(), 0);
    assert.equal(await page.evaluate((url) => window.__revokedUrls.includes(url), deletedUrl), true);
    await startRecording(page);
    await finishRecording(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await panel.waitFor();
    assert.equal(await audio.count(), 0, "reload restores sentence selection without the recording");
    assert.equal(new URL(page.url()).searchParams.get("sentenceId"), blueprint.transcript[0].id);
    assert.deepEqual(mediaUploads, []);
    assert.ok(apiCalls.length > 0 && apiCalls.every((call) => call.startsWith("GET ")), "practice never uploads microphone data");
    assert.deepEqual(errors, []);
    console.log(`Stage 2 real MediaRecorder with synthetic microphone passed at ${viewport.width}px`);
    await context.close();
  }
} finally {
  await browser.close();
}
