import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const artifacts = await mkdtemp(join(tmpdir(), "libitu-shadow-persistence-"));
const content = "71303ef5-b347-42b8-ae5f-f51be4354ab5";
const job = { id: "practice-test", content_id: content, status: "ready", blueprint_id: "practice-blueprint",
  analysis_version: "mvp-v9", processing_stage: "completed", analysis_preview: null, error_message: null };
const blueprint = { id: job.blueprint_id, content_id: content, title: "Save your Shadow practice",
  source_url: "https://www.youtube.com/watch?v=practice123", summary: "Practice and recover saved takes.", chapters: [],
  logic_flow: [{ id: "logic-1", title: "Opening", subtitle: "An introduction", time: "0:01" }], corpus_items: [],
  transcript: ["Let's begin.", "This is the second sentence."].map((text, index) => ({
    id: `sentence-v2-persistence-${index}`, time: `0:0${index * 3 + 1}`, parts: [text],
    start_ms: index * 3000 + 1000, end_ms: index * 3000 + 4000,
    source_token_start: index * 5, source_token_end: index * 5 + text.split(" ").length,
    segmentation_version: "sentence-v2", boundary_source: "syntax_merge", boundary_confidence: "medium"
  })),
  segments: [{ id: "practice-segment", sequence: 1, title: "Opening", summary: "Practice the opening.",
    start_ms: 1000, end_ms: 7000, transcript_start_index: 0, transcript_end_index: 2, phonology_tags: [], recommended: true }] };
const entry = `${origin}/?${new URLSearchParams({ sourceUrl: blueprint.source_url, title: blueprint.title, contentId: content,
  jobId: job.id, learnerLevel: "B2", stage: "2", segmentId: "practice-segment", sentenceId: blueprint.transcript[1].id })}#practice`;

// Test-only Clerk resource emitter: exercises the real React auth boundary and return
// options without credentials. It does not establish hosted Clerk/OAuth correctness.
function installFixture() {
  const listeners = new Set();
  const clerk = {
    loaded: true, user: null, session: null, organization: null,
    client: { sessions: [] }, telemetry: { record() {} },
    __internal_environment: {}, __internal_lastEmittedResources: null,
    load: async () => {}, mountUserButton() {}, unmountUserButton() {},
    addListener(callback, options) { listeners.add(callback); if (!options?.skipInitialEmit) callback(clerk.__internal_lastEmittedResources); return () => listeners.delete(callback); },
    openSignIn(options) { window.__authCalls.push(options); }, openSignUp(options) { window.__authCalls.push(options); },
    __internal_updateProps() {},
  };
  window.__authCalls = [];
  window.__setUser = (owner) => {
    sessionStorage.setItem("test-owner", owner ?? "");
    clerk.user = owner ? { id: owner, organizationMemberships: [] } : null;
    clerk.session = owner ? { id: `session-${owner}`, status: "active", user: clerk.user,
      lastActiveToken: { jwt: { claims: { sub: owner } } },
      getToken: async () => `header.${btoa(JSON.stringify({ sub: owner }))}.test` } : null;
    clerk.client = { sessions: clerk.session ? [clerk.session] : [] };
    clerk.__internal_lastEmittedResources = { user: clerk.user, session: clerk.session, client: clerk.client, organization: null };
    for (const listener of listeners) listener(clerk.__internal_lastEmittedResources);
  };
  window.__setUser(sessionStorage.getItem("test-owner") || null);
  window.Clerk = clerk;
  window.YT = { Player: class {
    time = 0; rate = 1; playing = false;
    constructor(_element, { events }) { this.events = events; window.__player = this; queueMicrotask(() => events.onReady()); }
    getCurrentTime() { return this.time; } seekTo(seconds) { this.time = seconds; }
    playVideo() { this.playing = true; this.events.onStateChange({ data: 1 }); }
    pauseVideo() { this.playing = false; this.events.onStateChange({ data: 2 }); }
    getPlaybackRate() { return this.rate; } getAvailablePlaybackRates() { return [0.5, 1, 1.25]; }
    setPlaybackRate(rate) { this.rate = rate; this.events.onPlaybackRateChange?.({ data: rate }); }
    destroy() { this.playing = false; }
  } };
  window.__micCalls = 0;
  const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (options) => { window.__micCalls++; return getMedia(options); };
}

const browser = await chromium.launch({ headless: true, channel: "chrome",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
try {
  for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors = [], rows = new Map(), audios = new Map();
    let failUpload = false;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(installFixture);
    await page.route("**/*", async (route) => {
      const req = route.request(), url = new URL(req.url());
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,authorization",
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS" };
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname === `/api/jobs/${job.id}`) return route.fulfill({ json: job, headers });
        if (url.pathname === `/api/blueprints/${content}`) return route.fulfill({ json: blueprint, headers });
        if (url.pathname.includes("/sound")) return route.fulfill({ status: 404, json: { detail: "Not part of persistence fixture" }, headers });
        if (url.pathname === "/api/references/capability") return route.fulfill({ json: { available: false, input_mode: null }, headers });
        if (url.pathname === "/api/references/captures/latest") return route.fulfill({ json: null, headers });
        if (url.pathname === "/api/corpus") return route.fulfill({ json: [], headers });
        if (req.method() === "GET" && /^\/api\/practice\/attempts\/[^/]+\/analysis$/.test(url.pathname)) {
          return route.fulfill({ json: null, headers });
        }
        if (url.pathname === "/api/practice/attempts") {
          if (req.method() === "GET") return route.fulfill({ json: { items: [...rows.values()].filter((row) => row.sentence_id === url.searchParams.get("sentence_id")), next_offset: null }, headers });
          const data = req.postDataJSON();
          const row = rows.get(data.client_id) ?? { ...data, id: data.client_id, sentence_text: "Fixture sentence",
            recording_state: data.recording ? "pending" : "none", created_at: new Date().toISOString() };
          rows.set(row.id, row);
          return route.fulfill({ status: 201, json: row, headers });
        }
        const match = url.pathname.match(/^\/api\/practice\/attempts\/([^/]+)(\/recording)?$/);
        if (match) {
          const row = rows.get(match[1]);
          if (req.method() === "PUT") {
            if (failUpload) return route.fulfill({ status: 503, json: { detail: "Test storage unavailable. Retry your save." }, headers });
            audios.set(row.id, req.postDataBuffer()); row.recording_state = "ready";
            return route.fulfill({ json: row, headers });
          }
          if (req.method() === "GET") return route.fulfill({ body: audios.get(row.id), contentType: row.recording.mime_type, headers });
          if (req.method() === "DELETE") {
            audios.delete(row.id);
            if (match[2]) row.recording_state = "deleted"; else rows.delete(row.id);
            return route.fulfill({ status: 204, headers });
          }
        }
        throw Error(`Unexpected API request: ${req.method()} ${url.pathname}`);
      }
      if (url.hostname.endsWith("clerk.accounts.dev") || url.hostname.includes("clerk.com")) return route.fulfill({ contentType: "application/javascript", body: "/* test Clerk already installed */" });
      if (url.pathname.startsWith("/acoustic-assets/")) return route.abort();
      if (url.origin === origin) return route.continue();
      return route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>Player fixture</body></html>" });
    });
    await page.goto(entry, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Sign in or create account" }).waitFor();
    assert.equal(await page.locator(".stage-two-recording").count(), 0);
    assert.equal(await page.evaluate(() => window.__micCalls), 0);
    const returnUrl = page.url();
    assert.deepEqual([...new URL(returnUrl).searchParams].sort(), [...new URL(entry).searchParams].sort());
    assert.equal(new URL(returnUrl).hash, "#practice");
    await page.getByRole("button", { name: "Sign in or create account" }).click();
    const options = await page.evaluate(() => window.__authCalls.at(-1));
    assert.equal(options.forceRedirectUrl, returnUrl);
    assert.equal(options.signUpForceRedirectUrl, returnUrl);
    await page.getByRole("button", { name: "Back to Stage 1", exact: true }).click();
    await page.getByRole("button", { name: "Choose a segment to shadow", exact: true }).click();
    await page.locator(".stage-one-picker-begin").click();
    await page.getByRole("button", { name: "Start shadowing", exact: true }).click();
    await page.getByRole("heading", { name: "Sign in to start Shadow" }).waitFor();
    assert.equal(await page.evaluate(() => window.__authCalls.length), 2);
    assert.equal(new URL(page.url()).searchParams.get("sentenceId"), blueprint.transcript[0].id);
    assert.equal(await page.evaluate(() => window.__micCalls), 0);
    await page.evaluate(() => window.__setUser("test-user-a"));
    await page.locator(".stage-two-recording").waitFor();
    const record = page.getByRole("button", { name: "Record sentence", exact: true });
    await record.click();
    await page.getByText("Recording your voice", { exact: true }).waitFor();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Stop recording", exact: true }).click();
    await page.getByText("No retained audio", { exact: true }).waitFor();
    assert.equal(audios.size, 0, "unchecked retention never uploads audio");
    await page.getByRole("checkbox", { name: "Keep new recordings in my account for later playback" }).check();
    failUpload = true;
    await page.getByRole("button", { name: "Record again", exact: true }).click();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Stop recording", exact: true }).click();
    await page.getByRole("button", { name: "Retry saves" }).waitFor();
    await page.getByRole("button", { name: "Next sentence", exact: true }).click();
    failUpload = false;
    await page.getByRole("button", { name: "Retry saves" }).click();
    await page.locator(".practice-save-banner").waitFor({ state: "detached" });
    assert.equal(rows.size, 2, "retry is idempotent across sentence changes");
    assert.equal([...rows.values()].every((row) => row.sentence_id === blueprint.transcript[0].id), true);
    await page.getByRole("button", { name: "Previous sentence", exact: true }).click();
    await page.getByRole("button", { name: "Load recording", exact: true }).waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Load recording", exact: true }).click();
    await page.locator(".practice-history audio").waitFor();
    await page.locator(".practice-history audio").evaluate(async (audio) => { await audio.play(); });
    await page.getByRole("button", { name: "Record sentence", exact: true }).click();
    assert.equal(await page.locator(".practice-history audio").evaluate((audio) => audio.paused), true);
    await page.getByRole("button", { name: "Cancel recording", exact: true }).click();
    await page.getByRole("button", { name: "Delete saved audio", exact: true }).click();
    await page.getByRole("button", { name: "Load recording", exact: true }).waitFor({ state: "detached" });
    assert.equal(audios.size, 0); assert.equal(rows.size, 2);
    await page.locator(".practice-history").screenshot({ path: join(artifacts, `history-${viewport.width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.evaluate(() => window.__setUser(null));
    await page.getByRole("heading", { name: "Sign in to start Shadow" }).waitFor();
    assert.equal(await page.locator(".practice-history").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(`PASS: anonymous gate, CTA login return, signed-in record/save/retry/history/replay/delete and logout at desktop/mobile. Screenshots: ${artifacts}`);
} finally { await browser.close(); }
