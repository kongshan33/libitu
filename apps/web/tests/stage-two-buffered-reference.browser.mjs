import { contentContextFixture } from "./helpers/content-context-fixture.mjs";
import assert from "node:assert/strict";
import { installSignedInPractice } from "./helpers/signed-in-practice.mjs";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Run against a local web server. The extension and player are simulated; audio
// decoding, Silero/Pitchy inference and Chrome microphone encoding are real.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const directory = mkdtempSync(join(tmpdir(), "libitu-buffered-reference-"));
const input = process.env.LIBITU_SPEECH_WAV ?? join(directory, "voice.aiff");
if (!process.env.LIBITU_SPEECH_WAV) {
  execFileSync("say", ["-v", "Samantha", "-r", "155", "-o", input,
    "Let us begin. We can learn to speak clearly."]);
}
const rawPath = join(directory, "voice.pcm");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-af", "apad=whole_dur=5",
  "-t", "5", "-ar", "16000", "-ac", "1", "-f", "s16le", rawPath]);
const pcm = readFileSync(rawPath), header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
const wav = Buffer.concat([header, pcm]), wavPath = join(directory, "voice.wav");
writeFileSync(wavPath, wav);
const job = { id: "buffered-job", content_id: "a0000000-0000-4000-8000-000000000004", status: "ready",
  blueprint_id: "buffered-blueprint", analysis_version: "mvp-v9", processing_stage: "completed",
  analysis_preview: null, error_message: null };
const texts = ["Let us begin. We can learn to speak clearly.", "Here is another sentence to practice.",
  "We finish by speaking calmly and clearly."];
let tokenIndex = 0;
const transcript = texts.map((text, index) => {
  const start = 1000 + index * 5000, words = text.split(" "), sourceStart = tokenIndex;
  tokenIndex += words.length;
  return { id: `sentence-v3-buffered-${index}`, time: `0:${String(1 + index * 5).padStart(2, "0")}`,
    parts: [text], start_ms: start, end_ms: start + 5000,
    source_token_start: sourceStart, source_token_end: tokenIndex, segmentation_version: "sentence-v3",
    boundary_source: "source_punctuation", boundary_confidence: "high", timing_source: "caption_word_offsets",
    word_timings: words.map((word, wordIndex) => ({ source_token_index: sourceStart + wordIndex, text: word,
      start_ms: start + wordIndex * 350, end_ms: start + (wordIndex + 1) * 350,
      start_source: "caption_offset", end_source: "next_word_estimate", source_event_index: index,
      source_seg_index: wordIndex })) };
});
const blueprint = { id: job.blueprint_id, content_id: job.content_id, title: "Buffered practice fixture",
  source_url: "https://www.youtube.com/watch?v=practice123", summary: "Listen once and reuse local references.",
  chapters: [], logic_flow: [{ id: "buffered-logic", title: "Practice", subtitle: "Listen and repeat.", time: "0:01" }],
  corpus_items: [], transcript, segments: [{ id: "buffered-segment", sequence: 1, title: "Buffered practice",
    summary: "Listen and repeat.", start_ms: 1000, end_ms: 16000, transcript_start_index: 0,
    transcript_end_index: 3, phonology_tags: [] }] };
const entry = `${origin}/practice/${job.content_id}`;

function soundGuide(row) {
  const text = row.parts[0];
  const tokens = [...text.matchAll(/[A-Za-z]+/g)].map((match, index) => ({ index, text: match[0],
    start: match.index, end: match.index + match[0].length, status: "known", pronunciations: [["AH0"]], ipa: ["ə"] }));
  return { version: "sound-rules-v1", content_id: job.content_id, sentence_id: row.id, sentence_text: text,
    dialect: "en-US", provider: "cmudict-rules", lexicon_version: "browser-fixture", tokens,
    coverage: { total: tokens.length, known: tokens.length }, warnings: [], candidates: [{
      id: `candidate-${row.id}`, kind: "linking", status: "candidate", token_start: 0, token_end: 2,
      source_text: text.slice(tokens[0].start, tokens[1].end), rule_id: "browser-fixture",
      phonemes_before: "/t/ /ə/", phonemes_after: "/t‿ə/", explanation: "A possible linking fixture, not an acoustic observation.",
      conditions: ["The words are spoken together without a pause."]
    }] };
}

const browser = await chromium.launch({ headless: true, channel: process.env.LIBITU_BROWSER_CHANNEL ?? "chrome",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
    `--use-file-for-fake-audio-capture=${wavPath}`] });
try {
  const viewportFilter = process.env.LIBITU_BUFFER_VIEWPORT;
  const viewports = viewportFilter === "desktop" ? [{ width: 1440, height: 1000 }]
    : viewportFilter === "mobile" ? [{ width: 390, height: 844 }]
      : [{ width: 1440, height: 1000 }, { width: 390, height: 844 }];
  for (const viewport of process.env.LIBITU_BUFFER_WORKLET_ONLY === "1" ? [] : viewports) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [], mutations = [], assets = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      // Record-only practice metadata is now expected; reference/learner media must
      // still stay local in this fixture (recording retention is disabled below).
      if (url.pathname.startsWith("/api/") && !["GET", "OPTIONS"].includes(request.method())
        && !(url.pathname === "/api/practice/attempts" && request.method() === "POST")) mutations.push(request.url());
      if (url.pathname.includes("/acoustic-assets/")) assets.push(request.url());
    });
    await page.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
      if (url.pathname.startsWith("/api/")) {
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        assert.equal(request.method(), "GET", "buffered preparation never uploads media or starts server analysis");
        if (url.pathname === `/api/content/${blueprint.content_id}`) return route.fulfill({ json: contentContextFixture(blueprint, job), headers });
        if (url.pathname === `/api/jobs/${job.id}`) return route.fulfill({ json: job, headers });
        if (url.pathname === `/api/blueprints/${job.content_id}`) return route.fulfill({ json: blueprint, headers });
        if (url.pathname === "/api/references/capability") return route.fulfill({ json: { available: false, input_mode: null }, headers });
        const row = transcript.find((item) => url.pathname === `/api/blueprints/${job.content_id}/sentences/${item.id}/sound`);
        assert.ok(row, `Unexpected API request ${url.pathname}`);
        return route.fulfill({ json: soundGuide(row), headers });
      }
      if (url.origin === origin || url.hostname.endsWith(".clerk.accounts.dev")) return route.continue();
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><body>Local player fixture</body>" });
    });
    await installSignedInPractice(page);
    await page.addInitScript(({ audioBase64 }) => {
      window.__bufferRequests = []; window.__bufferSession = null; window.__toolbarGrants = 0;
      window.__heldExtracts = []; window.__players = []; window.__holdExtracts = true;
      window.__workerStarts = 0;
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        // Production builds hash the worker filename. This fixture's only workers
        // are acoustic analyses; readiness and model-asset checks verify inference.
        constructor(...args) { super(...args); window.__workerStarts++; }
      };
      window.__visibility = "visible";
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__visibility });
      window.__setVisibility = (state) => { window.__visibility = state; document.dispatchEvent(new Event("visibilitychange")); };
      const post = (data) => window.postMessage({ type: "LIBITU_BUFFER_EVENT", version: 4, ...data }, location.origin);
      window.__grantBuffer = () => {
        const request = window.__bufferRequests.findLast((item) => item.action === "arm");
        if (!request) throw new Error("The page did not arm a reference session");
        window.__toolbarGrants++;
        window.__bufferSession = request.sessionId;
        post({ sessionId: request.sessionId, requestId: request.requestId, status: "enabled" });
      };
      window.__coverage = (ranges, sessionId = window.__bufferSession) => post({ sessionId, requestId: sessionId,
        status: "coverage", ranges, retainedBytes: ranges.length * 160_000, recording: false });
      window.__completeExtract = (request, sessionId = request.sessionId) => post({ sessionId,
        requestId: request.requestId, status: "complete", captureId: `fixture-${request.requestId}`,
        start: request.start, end: request.end, durationMs: 5000, mimeType: "audio/wav", audioBase64 });
      window.addEventListener("message", ({ data }) => {
        if (data?.type !== "LIBITU_BUFFER_REQUEST") return;
        if (data.version !== 4) throw new Error("Expected buffered reference protocol v3");
        window.__bufferRequests.push(data);
        const response = { sessionId: data.sessionId, requestId: data.requestId };
        if (data.action === "ping") post({ ...response, status: "available" });
        if (data.action === "arm") post({ ...response, status: "armed" });
        if (data.action === "extract") {
          if (window.__bufferSession !== data.sessionId) throw new Error("Extraction without a toolbar grant");
          if (window.__holdExtracts) window.__heldExtracts.push(data);
          else window.__completeExtract(data);
        }
        if (data.action === "close" && data.sessionId === window.__bufferSession) window.__bufferSession = null;
      });
      window.YT = { Player: class {
        time = 0; rate = 1; state = 2; ready = false; playCalls = 0;
        constructor(_element, { events }) {
          this.events = events; window.__players.push(this); window.__activePlayer = this;
          this.last = performance.now();
          this.tick = setInterval(() => {
            const now = performance.now();
            if (this.state === 1) this.time += (now - this.last) / 1000 * this.rate;
            this.last = now;
          }, 20);
          queueMicrotask(() => { this.ready = true; events.onReady(); });
        }
        getCurrentTime() { return this.time; }
        getPlayerState() { return this.state; }
        seekTo(seconds) {
          this.time = seconds;
          // Native YouTube may emit a transient Play during a paused seek.
          if (this.state !== 1) { this.state = 1; this.events.onStateChange({ data: 1 }); }
        }
        playVideo() { this.playCalls++; this.last = performance.now(); this.state = 1; this.events.onStateChange({ data: 1 }); }
        pauseVideo() { this.state = 2; this.events.onStateChange({ data: 2 }); }
        setPlaybackRate(rate) { this.rate = rate; this.events.onPlaybackRateChange({ data: rate }); }
        getPlaybackRate() { return this.rate; }
        getAvailablePlaybackRates() { return [0.75, 1, 1.25]; }
        destroy() { this.destroyed = true; clearInterval(this.tick); }
      } };
    }, { audioBase64: wav.toString("base64") });

    try {
      await page.goto(entry, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const reference = page.getByRole("region", { name: "Reference preparation", exact: true });
      const requests = (action) => page.evaluate((target) => window.__bufferRequests.filter((item) => item.action === target), action);
      const activeSession = () => page.evaluate(() => window.__bufferSession);
      const waitPlayer = () => page.waitForFunction(() => window.__activePlayer?.ready && !window.__activePlayer.destroyed);
      const assertPaused = async (reason) => assert.equal(await page.evaluate(() => window.__activePlayer.state), 2, reason);
      await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).waitFor();
      await waitPlayer();
      assert.deepEqual(assets, [], "Stage 1 does not load speech models before reference demand");
      await reference.getByRole("button", { name: "Enable reference audio", exact: true }).click();
      await reference.getByText(/Click Libitu in Chrome/).waitFor();
      await page.evaluate(() => window.__grantBuffer());
      await reference.getByText("Audio enabled", { exact: true }).waitFor();
      const session = await activeSession();
      assert.ok(session);
      await assertPaused("enabling reference preparation never autoplays");
      assert.equal((await requests("extract")).length, 0);

      await page.locator(".transcript-time").first().click();
      await page.waitForFunction(() => window.__bufferRequests.some((item) => item.action === "observe" && item.telemetry.state === 1));
      const readerGeneration = (await requests("observe")).findLast((item) => item.telemetry.state === 1).telemetry.generation;
      await page.evaluate(() => { window.__activePlayer.pauseVideo(); window.__coverage([{ start: 1, end: 6 }, { start: 11, end: 16 }]); });
      await page.waitForTimeout(100);
      await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).click();
      await page.locator(".stage-one-segment-card").first().click();
      await page.getByRole("button", { name: /Begin Stage 2/ }).click();
      const preparation = page.getByRole("region", { name: "Preparing Stage 2", exact: true });
      await preparation.waitFor();
      await waitPlayer();
      await preparation.getByText("2 of 3 sentence audio ranges available on this device. 0 references analyzed.", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Start shadowing", exact: true }).isEnabled(), true,
        "partial raw coverage and pending analysis cannot block practice");
      await assertPaused("preparation view does not silently replay the segment");
      assert.equal(await activeSession(), session, "the source-owned session survives the picker");
      await page.waitForFunction(() => window.__heldExtracts.length > 0);
      const heldCount = await page.evaluate(() => window.__heldExtracts.length);
      await page.evaluate(() => window.__completeExtract(window.__heldExtracts.at(-1), "stale-session"));
      await page.waitForTimeout(150);
      assert.equal(await preparation.getByText(/0 references analyzed/).count(), 1, "a foreign session cannot publish a reference");
      assert.equal(await page.evaluate(() => window.__heldExtracts.length), heldCount);
      await preparation.evaluate((element) => { element.scrollTop = 0; });
      const preparationLayout = await preparation.evaluate((element) => {
        const heading = element.querySelector("h1").getBoundingClientRect();
        const frame = element.querySelector(".youtube-player-shell").getBoundingClientRect();
        const topbar = document.querySelector(".topbar").getBoundingClientRect();
        return { headingTop: heading.top, topbarEnd: topbar.bottom, width: frame.width, height: frame.height };
      });
      assert.ok(preparationLayout.headingTop >= preparationLayout.topbarEnd - 1, "the preparation heading is not clipped behind the header");
      assert.ok(preparationLayout.width > 200 && Math.abs(preparationLayout.height / preparationLayout.width - 9 / 16) < 0.01,
        "the preparation player remains a bounded 16:9 frame on desktop and mobile");
      await page.screenshot({ path: `/tmp/libitu-buffered-preparation-${viewport.width}.png`, fullPage: true });
      await page.evaluate(() => {
        window.__holdExtracts = false;
        for (const request of window.__heldExtracts) window.__completeExtract(request);
      });
      await preparation.getByText(/2 references analyzed/).waitFor({ timeout: 100_000 });
      assert.ok(assets.some((url) => url.endsWith("silero_vad_v5.onnx")), "references use actual local Silero model assets");
      await page.getByRole("button", { name: "Start shadowing", exact: true }).click();
      await page.locator(".stage-two-shadow").waitFor();
      await waitPlayer();
      const shadowReference = page.getByRole("region", { name: "Reference preparation", exact: true });
      await shadowReference.getByText("Reference connected", { exact: true }).waitFor();
      assert.equal(await page.getByText("Practice audio enabled", { exact: true }).count(), 0,
        "Stage 2 consumes the shared buffered panel instead of the legacy capture panel");
      await reference.getByText("Reference ready for this sentence.", { exact: true }).waitFor();
      assert.equal(await activeSession(), session);
      assert.equal((await requests("arm")).length, 1, "Stage 2 reuses the Stage 1 toolbar grant");
      assert.equal(await page.evaluate(() => window.__toolbarGrants), 1);
      await assertPaused("entering Shadow with prepared audio does not autoplay");
      const extractsAtEntry = (await requests("extract")).length;
      const directoryButtons = page.locator(".stage-two-sentences ol button");
      const layers = page.getByRole("tablist", { name: "Practice layers", exact: true });
      for (const layer of ["Rhythm", "Melody", "Sound"]) {
        await layers.getByRole("tab", { name: layer, exact: true }).click();
        await assertPaused("layer navigation never starts reference playback");
      }
      await directoryButtons.nth(2).click();
      await reference.getByText("Reference ready for this sentence.", { exact: true }).waitFor();
      await assertPaused("sentence navigation never starts reference playback");
      assert.equal((await requests("extract")).length, extractsAtEntry, "prepared sentences reuse their analyzed cache");

      await directoryButtons.nth(1).click();
      await reference.getByText(/has not been fully captured/).waitFor();
      await layers.getByRole("tab", { name: "Rhythm", exact: true }).click();
      assert.equal(await page.locator(".rhythm-pause").count(), 0, "an uncovered gap never borrows a neighboring sentence's pause markers");
      await page.getByRole("combobox", { name: "Playback speed", exact: true }).click();
      await page.getByRole("option", { name: "0.75×", exact: true }).click();
      await reference.getByRole("button", { name: "Prepare this sentence at 1×", exact: true }).click();
      await page.waitForFunction(() => window.__activePlayer.state === 1 && window.__activePlayer.rate === 1);
      await page.waitForFunction((generation) => window.__bufferRequests.some((item) => item.action === "observe"
        && item.telemetry.state === 1 && item.telemetry.generation > generation), readerGeneration);
      await reference.getByRole("button", { name: "Cancel preparation", exact: true }).click();
      await assertPaused("cancelling explicit preparation pauses the player");
      assert.equal(await activeSession(), session, "cancel leaves the source session available");

      await page.getByRole("button", { name: "Play sentence", exact: true }).click();
      await page.waitForFunction(() => window.__activePlayer.state === 1);
      await page.evaluate(() => window.__setVisibility("hidden"));
      await assertPaused("hiding the tab suspends listening");
      await page.waitForFunction(() => window.__bufferRequests.findLast((item) => item.action === "observe")?.telemetry.state === 2);
      assert.equal(await activeSession(), session, "visibility suspension retains completed reference coverage");
      await page.evaluate(() => window.__setVisibility("visible"));
      await assertPaused("returning to the tab does not autoplay");

      await page.getByRole("button", { name: "Record sentence", exact: true }).click();
      await page.getByText("Recording your voice", { exact: true }).waitFor();
      await assertPaused("recording suspends reference playback");
      assert.equal(await activeSession(), session, "recording reuses rather than closes the reference session");
      assert.equal(await page.evaluate(() => { window.__activePlayer.playVideo(); return window.__activePlayer.state; }), 2,
        "native player controls cannot contaminate a microphone take");
      await page.waitForTimeout(700);
      await page.getByRole("button", { name: "Stop recording", exact: true }).click();
      await page.getByRole("button", { name: "Replay recording", exact: true }).waitFor();

      // Complete an extraction after the selected sentence has changed. It must
      // never replace the cache/view for the currently selected sentence.
      await page.evaluate(() => { window.__holdExtracts = true; window.__coverage([{ start: 1, end: 16 }]); });
      await page.waitForFunction(() => window.__heldExtracts.some((request) => request.start === 6));
      const stale = await page.evaluate(() => window.__heldExtracts.findLast((request) => request.start === 6));
      await directoryButtons.first().click();
      await reference.getByText("Reference ready for this sentence.", { exact: true }).waitFor();
      await page.evaluate((request) => window.__completeExtract(request), stale);
      await page.waitForTimeout(200);
      assert.equal(new URL(page.url()).searchParams.get("sentenceId"), transcript[0].id);
      await reference.getByText("Reference ready for this sentence.", { exact: true }).waitFor();
      await assertPaused("late extraction never changes the selected sentence or starts playback");
      await page.getByRole("button", { name: "Record sentence", exact: true }).click();
      await page.getByText("Recording your voice", { exact: true }).waitFor();
      await page.waitForTimeout(5000);
      await page.getByRole("button", { name: "Stop recording", exact: true }).click();
      // The current comparison UI exposes normalized local pitch while word
      // alignment remains pending; obsolete AcousticComparisonPanel labels are not used.
      const rhythm = page.locator(".layer-comparison-rhythm");
      const melody = page.locator(".layer-comparison-melody");
      const sound = page.locator(".layer-comparison-sound");
      await layers.getByRole("tab", { name: "Rhythm", exact: true }).click();
      assert.equal(await rhythm.locator(".paired-reference .paired-word strong").count(), texts[0].split(" ").length);
      assert.match(await rhythm.innerText(), /dictionary syllable stress/);
      assert.ok(!(await rhythm.innerText()).includes("NaN"));
      const rhythmRows = await rhythm.locator(".paired-grid").elementHandle();
      await layers.getByRole("tab", { name: "Melody", exact: true }).click();
      await page.waitForFunction(() => [".paired-reference-trace path", ".paired-learner-trace path"]
        .every(selector => (document.querySelector(selector)?.getAttribute("d")?.length ?? 0) > 10), undefined, { timeout: 100_000 });
      assert.ok(!(await melody.innerText()).includes("NaN"));
      const pitchPlot = await melody.locator("svg[role=img]").elementHandle();
      const workers = await page.evaluate(() => window.__workerStarts);
      const players = await page.evaluate(() => window.__players.length);
      assert.equal(players, 1, "Reader, preparation and Shadow share one player instance");
      assert.ok(workers >= 3, "reference and learner recordings each run actual local acoustic inference");
      await layers.getByRole("tab", { name: "Sound", exact: true }).click();
      assert.match(await sound.innerText(), /not (?:yet |been )?evaluated/i, "timing and pitch cannot certify Sound realization");
      await layers.getByRole("tab", { name: "Rhythm", exact: true }).click();
      assert.equal(await rhythmRows.evaluate(element => element.isConnected), true);
      await layers.getByRole("tab", { name: "Melody", exact: true }).click();
      assert.equal(await pitchPlot.evaluate(element => element.isConnected), true);
      assert.equal(await page.evaluate(() => window.__workerStarts), workers, "layer switches do not repeat acoustic inference");
      assert.equal(await page.evaluate(() => window.__players.length), players, "layer switches retain the player");
      assert.ok(assets.some((url) => url.includes(".wasm")), "the real same-origin ONNX WASM runtime was loaded");
      assert.ok(assets.every((url) => url.startsWith(origin)), "acoustic models and runtimes stay on the app origin");
      await page.getByRole("button", { name: "Replay recording", exact: true }).click();
      await page.getByRole("button", { name: "Pause recording", exact: true }).waitFor();
      await assertPaused("local replay cannot play the reference player concurrently");
      await page.getByRole("button", { name: "Pause recording", exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator(".stage-two-practice-main").evaluate((element) => { element.scrollTop = 0; });
      await page.screenshot({ path: `/tmp/libitu-buffered-shadow-${viewport.width}.png`, fullPage: true });
      await page.getByRole("button", { name: "Back to segments", exact: true }).click();
      assert.equal(await activeSession(), session, "returning to the picker retains the same source session");
      await page.getByRole("button", { name: "Stage 1 - Ingest", exact: true }).click();
      await reference.getByText("Audio enabled", { exact: true }).waitFor();
      await reference.getByRole("button", { name: "Turn off audio preparation", exact: true }).click();
      await reference.getByRole("button", { name: "Enable reference audio", exact: true }).waitFor();
      await page.waitForFunction(() => window.__bufferSession === null);
      assert.equal(await activeSession(), null, "explicit turn off closes the source session");
      assert.equal((await requests("arm")).length, 1);
      assert.deepEqual(mutations, []);
      assert.deepEqual(errors, []);
      console.log(`Buffered Stage 1 → preparation → Stage 2 passed at ${viewport.width}px (actual local inference, no media uploads)`);
    } catch (error) {
      await page.screenshot({ path: `/tmp/libitu-buffered-failure-${viewport.width}.png`, fullPage: true }).catch(() => {});
      console.error(await page.locator("body").innerText().catch(() => "Page unavailable"));
      throw error;
    } finally { await context.close(); }
  }
  await verifyActualBufferedWorklet(browser);
} finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }

async function verifyActualBufferedWorklet(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${origin}/__buffer_check__/**`, async (route) => {
    const file = new URL(route.request().url()).pathname.split("/").at(-1);
    if (["buffer-offscreen.js", "buffer-pcm.js", "buffer-worklet.js"].includes(file)) {
      return route.fulfill({ contentType: "application/javascript",
        body: readFileSync(new URL(`../../extension/src/${file}`, import.meta.url), "utf8") });
    }
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><button id="start">Start audio fixture</button>' });
  });
  try {
    await page.goto(`${origin}/__buffer_check__/index.html`);
    await page.evaluate(() => {
      window.__events = [];
      document.querySelector("#start").addEventListener("click", () => {
        window.__started = (async () => {
          const { createBufferedRecorder } = await import("./buffer-offscreen.js");
          // Chrome's AudioWorklet module loader does not use Playwright's page
          // route interception. Load the exact module bytes through fetch first.
          window.__workletUrl = URL.createObjectURL(new Blob([await (await fetch("./buffer-worklet.js")).text()],
            { type: "application/javascript" }));
          const source = new AudioContext();
          const oscillator = source.createOscillator();
          const gain = source.createGain(); gain.gain.value = 0.25; oscillator.frequency.value = 220;
          const destination = source.createMediaStreamDestination();
          oscillator.connect(gain); gain.connect(destination); oscillator.start(); await source.resume();
          window.__oscillatorSource = source;
          window.__recorder = createBufferedRecorder((event) => { window.__events.push(event); }, {
            getUserMedia: async () => destination.stream,
            createContext: () => {
              const context = new AudioContext();
              const addModule = context.audioWorklet.addModule.bind(context.audioWorklet);
              context.audioWorklet.addModule = async (...args) => {
                try { await addModule(...args); } catch (error) { window.__workletError = error.message; throw error; }
              };
              return context;
            },
            createNode: (context) => {
              try { return new AudioWorkletNode(context, "libitu-pcm-buffer"); }
              catch (error) { window.__workletError = error.message; throw error; }
            },
            workletUrl: () => window.__workletUrl
          });
          await window.__recorder.open({ token: "worklet-test", sessionId: "worklet-test", streamId: "oscillator" });
          window.__observeRun = (videoStart, generation, rate = 1) => {
            const anchor = performance.now();
            const sample = (state = 1) => {
              const now = performance.now();
              window.__recorder.observe({ token: "worklet-test", sessionId: "worklet-test", telemetry: {
                time: videoStart + (now - anchor) / 1000 * rate, epochTime: performance.timeOrigin + now,
                wallTime: now, state, rate, generation
              } });
            };
            sample(); window.__observeTimer = setInterval(sample, 250);
            window.__pauseRun = () => { clearInterval(window.__observeTimer); sample(2); };
          };
          window.__observeRun(100, 1);
        })().catch((error) => { window.__startError = error.message; });
      });
    });
    await page.getByRole("button", { name: "Start audio fixture", exact: true }).click();
    await page.waitForFunction(() => window.__events.some((event) => event.status === "enabled" || event.status === "error"));
    assert.equal(await page.evaluate(() => window.__events.some((event) => event.status === "enabled")), true,
      "the real buffered recorder initializes its AudioWorklet");
    await page.waitForFunction(() => window.__events.some((event) => event.status === "coverage"
      && event.ranges.some((range) => range.start <= 100.5 && range.end >= 102.5)), null, { timeout: 15_000 });
    await page.evaluate(async () => {
      window.__pauseRun();
      await window.__recorder.extract({ token: "worklet-test", sessionId: "worklet-test",
        requestId: "clip-real", start: 100.5, end: 101.5 });
    });
    const event = await page.evaluate(() => window.__events.find((item) => item.requestId === "clip-real"));
    assert.equal(event?.status, "complete", "the actual AudioWorklet capture exports a covered interval");
    const bytes = Buffer.from(event.audioBase64, "base64");
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
    const sampleRate = bytes.readUInt32LE(24), samples = bytes.readUInt32LE(40) / 2;
    assert.ok(Math.abs(samples / sampleRate - 1) <= 1 / sampleRate + 1e-9, "the extracted WAV has the requested duration");
    let squareSum = 0;
    for (let offset = 44; offset < bytes.length; offset += 2) squareSum += (bytes.readInt16LE(offset) / 32768) ** 2;
    assert.ok(Math.sqrt(squareSum / samples) > 0.1, "real oscillator PCM reaches the exported WAV");
    await page.waitForTimeout(200);
    const pausedBytes = await page.evaluate(() => window.__events.findLast((item) => item.status === "coverage").retainedBytes);
    await page.waitForTimeout(900);
    assert.equal(await page.evaluate(() => window.__events.findLast((item) => item.status === "coverage").retainedBytes),
      pausedBytes, "paused audio does not keep accumulating PCM");
    await page.evaluate(() => window.__observeRun(105, 2, 1.25));
    await page.waitForTimeout(1200);
    const rateCoverage = await page.evaluate(() => window.__events.findLast((item) => item.status === "coverage"));
    assert.equal(rateCoverage.retainedBytes, pausedBytes, "non-1× playback does not accumulate comparison PCM");
    assert.ok(rateCoverage.ranges.every((range) => range.end < 105), "speed changes never fabricate covered ranges");
    await page.evaluate(() => { window.__pauseRun(); window.__observeRun(110, 3); });
    await page.waitForFunction(() => window.__events.some((item) => item.status === "coverage"
      && item.ranges.some((range) => range.start <= 110.5 && range.end >= 111)), null, { timeout: 15_000 });
    await page.evaluate(async () => {
      window.__pauseRun();
      await window.__recorder.extract({ token: "worklet-test", sessionId: "worklet-test",
        requestId: "clip-gap", start: 101.5, end: 110.5 });
    });
    assert.equal(await page.evaluate(() => window.__events.find((item) => item.requestId === "clip-gap")?.status),
      "missing", "a seek/generation gap cannot be exported as continuous reference audio");
    assert.deepEqual(errors, []);
    console.log("Actual AudioContext → AudioWorklet → bounded PCM → WAV passed; pause, rate and generation gaps remain excluded");
  } catch (error) {
    console.error("Actual worklet diagnostic", await page.evaluate(() => ({
      events: window.__events?.slice(-5).map(({ audioBase64, ...event }) => ({ ...event, audioBytes: audioBase64?.length })),
      startError: window.__startError, workletError: window.__workletError,
      sourceState: window.__oscillatorSource?.state
    })));
    throw error;
  } finally {
    await page.evaluate(async () => {
      clearInterval(window.__observeTimer); window.__recorder?.dispose(); await window.__oscillatorSource?.close();
      if (window.__workletUrl) URL.revokeObjectURL(window.__workletUrl);
    }).catch(() => {});
    await context.close();
  }
}
