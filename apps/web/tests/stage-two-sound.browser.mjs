import { contentContextFixture } from "./helpers/content-context-fixture.mjs";
import assert from "node:assert/strict";
import { installSignedInPractice } from "./helpers/signed-in-practice.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const job = { id: "sound-job", content_id: "sound-content", status: "ready", blueprint_id: "sound-blueprint",
  analysis_version: "mvp-v9", processing_stage: "completed", analysis_preview: null, error_message: null };
const sentences = ["Pick it up, then pick it up.", "Zorbquux read the book.", "Hello.", "Please retry.",
  "This response arrives late.", "The current sentence remains."];
const blueprint = {
  id: job.blueprint_id, content_id: job.content_id, title: "Connected speech guide",
  source_url: "https://www.youtube.com/watch?v=practice123", summary: "Explore possible readings.", chapters: [],
  logic_flow: [{ id: "logic-1", title: "Practice", subtitle: "Read and listen.", time: "0:01" }], corpus_items: [],
  transcript: sentences.map((text, index) => ({ id: `sentence-v2-sound-${index}`, time: `0:${String(index * 5 + 1).padStart(2, "0")}`,
    parts: [text], start_ms: index * 5000 + 1000, end_ms: index * 5000 + 6000,
    source_token_start: index * 10, source_token_end: index * 10 + text.split(" ").length,
    segmentation_version: "sentence-v2", boundary_source: "source_punctuation", boundary_confidence: "high",
    timing_source: "caption_word_offsets", word_timings: text.split(" ").map((word, offset) => ({
      source_token_index: index * 10 + offset, text: word, start_ms: index * 5000 + 1000 + offset * 100,
      end_ms: index * 5000 + 1100 + offset * 100, start_source: "caption_offset", end_source: "next_word_estimate",
      source_event_index: index, source_seg_index: offset
    })) })),
  segments: [{ id: "sound-segment", sequence: 1, title: "Practice", summary: "Explore possible readings.",
    start_ms: 1000, end_ms: 31000, transcript_start_index: 0, transcript_end_index: 6, phonology_tags: [] }]
};
const entry = `${origin}/practice/${job.content_id}/shadow?${new URLSearchParams({ segmentId: blueprint.segments[0].id, sentenceId: blueprint.transcript[0].id })}`;

// These responses exercise the rendering contract; they are not a dictionary or detector evaluation.
function annotation(index) {
  const sentence = blueprint.transcript[index], text = sentence.parts[0];
  const tokens = [...text.matchAll(/[A-Za-z]+/g)].map((match, tokenIndex) => ({ index: tokenIndex,
    text: match[0], start: match.index, end: match.index + match[0].length, status: "known",
    pronunciations: [["AH0"]], ipa: ["ə"] }));
  if (index === 1) {
    Object.assign(tokens[0], { status: "unknown", pronunciations: [], ipa: [] });
    Object.assign(tokens[1], { status: "ambiguous", pronunciations: [["R", "IY1", "D"], ["R", "EH1", "D"]], ipa: ["ɹid", "ɹɛd"] });
  }
  const add = (kind, start, end, suffix) => ({ id: `${sentence.id}-${kind}-${suffix}`, kind, status: "candidate",
    token_start: start, token_end: end, source_text: text.slice(tokens[start].start, tokens[end - 1].end),
    rule_id: "browser-fixture", phonemes_before: "/t/ /ə/", phonemes_after: "/t‿ə/",
    explanation: `Possible ${kind.replace("_", " ")} under suitable speaking conditions.`,
    conditions: ["The words belong to the same phrase.", "Actual realization depends on the speaker and emphasis."] });
  const candidates = index === 0 ? [add("linking", 0, 2, "first"), add("linking", 4, 6, "second"),
    add("weak_form", 1, 2, "weak"), add("flap", 1, 3, "flap"), add("assimilation", 3, 5, "assimilation"),
    add("elision", 0, 1, "elision")] : [3, 4, 5].includes(index) ? [add("linking", 0, 2, "only")] : [];
  return { version: "sound-rules-v1", content_id: job.content_id, sentence_id: sentence.id, sentence_text: text,
    dialect: "en-US", provider: "cmudict-rules", lexicon_version: "browser-fixture", tokens, candidates,
    coverage: { total: tokens.length, known: tokens.filter((token) => token.status === "known").length }, warnings: [] };
}

const browser = await chromium.launch({ headless: true, channel: process.env.LIBITU_BROWSER_CHANNEL ?? "chrome" });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [], writes = [], assets = [], counts = Array(sentences.length).fill(0);
    const pendingRequests = new Map();
    let documentResponse = null;
    let releaseLate;
    const late = new Promise((resolve) => { releaseLate = resolve; });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      pendingRequests.set(request, { resource: request.resourceType(), url: `${url.origin}${url.pathname}`, started: Date.now() });
      if ((url.origin === origin || url.pathname.startsWith("/api/")) && !["GET", "OPTIONS"].includes(request.method())) writes.push(request.url());
      if (url.pathname.includes("/acoustic-assets/")) assets.push(url.pathname);
    });
    page.on("requestfinished", (request) => pendingRequests.delete(request));
    page.on("requestfailed", (request) => pendingRequests.delete(request));
    page.on("response", (response) => {
      if (response.request().isNavigationRequest() && response.request().frame() === page.mainFrame()) {
        documentResponse = { status: response.status(), received: Date.now() };
      }
    });
    await page.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
      if (url.pathname.startsWith("/api/")) {
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        assert.equal(request.method(), "GET", "Sound guidance never uploads media or requests a paid analysis");
        if (url.pathname === `/api/content/${blueprint.content_id}`) return route.fulfill({ json: contentContextFixture(blueprint, job), headers });
        if (url.pathname === `/api/jobs/${job.id}`) return route.fulfill({ json: job, headers });
        if (url.pathname === `/api/blueprints/${job.content_id}`) return route.fulfill({ json: blueprint, headers });
        if (url.pathname === "/api/references/capability") return route.fulfill({ json: { available: false, input_mode: null }, headers });
        const index = blueprint.transcript.findIndex((row) => url.pathname === `/api/blueprints/${job.content_id}/sentences/${row.id}/sound`);
        assert.ok(index >= 0, `Unexpected API ${url.pathname}`);
        counts[index]++;
        if (index === 3 && counts[index] === 1) return route.fulfill({ status: 503, headers, json: { detail: "Dictionary unavailable" } });
        if (index === 4) await late;
        return route.fulfill({ headers, json: annotation(index) });
      }
      if (url.origin === origin || url.hostname.endsWith(".clerk.accounts.dev")) return route.continue();
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><body>Video fixture</body>" });
    });
    await installSignedInPractice(page);
    await page.addInitScript(() => {
      window.__audioAnalysisRuns = 0;
      window.__workerStarts = 0;
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); if (/analysis[._-]worker/.test(String(args[0]))) window.__workerStarts++; }
        postMessage(message, ...args) {
          if (message?.samples instanceof Float32Array && Number.isFinite(message.sampleRate)) window.__audioAnalysisRuns++;
          return super.postMessage(message, ...args);
        }
      };
      window.__microphoneRequests = 0;
      navigator.mediaDevices.getUserMedia = () => { window.__microphoneRequests++; return Promise.reject(new Error("Unexpected microphone request")); };
      window.__referenceRequests = [];
      window.addEventListener("message", ({ data }) => { if (data?.type === "LIBITU_REFERENCE_REQUEST") window.__referenceRequests.push(data); });
      window.__players = [];
      window.YT = { Player: class {
        time = 0; rate = 1; ready = false;
        constructor(_element, { events }) { this.events = events; window.__players.push(this); window.__activePlayer = this; queueMicrotask(() => { this.ready = true; events.onReady(); }); }
        getCurrentTime() { return this.time; }
        seekTo(seconds) { this.time = seconds; }
        playVideo() { this.events.onStateChange({ data: 1 }); }
        pauseVideo() { this.events.onStateChange({ data: 2 }); }
        setPlaybackRate(rate) { this.rate = rate; this.events.onPlaybackRateChange?.({ data: rate }); }
        getPlaybackRate() { return this.rate; }
        getAvailablePlaybackRates() { return [0.5, 1, 1.25]; }
        destroy() { this.destroyed = true; }
      } };
    });
    try {
      await page.goto(entry, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (error) {
      console.error("Sound browser navigation diagnostic", {
        viewport: viewport.width, documentResponse,
        pending: [...pendingRequests.values()].map(({ started, ...request }) => ({ ...request, ageMs: Date.now() - started }))
      });
      throw error;
    }
    const panel = page.getByRole("region", { name: "Sound guide", exact: true });
    const filters = panel.getByRole("group", { name: "Sound phenomenon filters" });
    const options = panel.getByRole("group", { name: "Possible sound changes" });
    const detail = panel.getByRole("article", { name: "Selected sound suggestion" });
    const tabs = page.getByRole("tablist", { name: "Practice layers", exact: true });
    const layer = (name) => tabs.getByRole("tab", { name, exact: true });
    const layerPanel = (name) => page.getByRole("tabpanel", { name, exact: true, includeHidden: true });
    const directory = page.locator(".stage-two-sentences ol button");
    const select = async (index) => { await directory.nth(index).click(); };
    await detail.waitFor();
    await page.waitForFunction(() => window.__activePlayer?.ready);
    assert.equal(await tabs.getByRole("tab").count(), 3);
    assert.equal(await page.getByRole("tabpanel").count(), 1, "only the active layer is exposed to assistive technology");
    assert.equal(await page.getByRole("tabpanel", { includeHidden: true }).count(), 3, "all layers remain mounted");
    assert.equal(await layer("Sound").getAttribute("aria-selected"), "true");
    const iframe = await page.locator(".youtube-player iframe").elementHandle();
    const soundNode = await panel.elementHandle();
    const initialPlayers = await page.evaluate(() => window.__players.length);
    const initialWorkerStarts = await page.evaluate(() => window.__workerStarts);
    const initialCounts = counts.slice();
    async function assertLayer(name) {
      assert.equal(await layer(name).getAttribute("aria-selected"), "true");
      assert.equal(await layer(name).getAttribute("tabindex"), "0");
      assert.equal(await layerPanel(name).isVisible(), true);
      assert.equal(await page.getByRole("tabpanel").count(), 1);
      assert.equal(await layer(name).getAttribute("aria-controls"), await layerPanel(name).getAttribute("id"));
    }
    await layer("Sound").focus();
    for (const [key, name] of [["ArrowRight", "Rhythm"], ["ArrowRight", "Melody"], ["ArrowRight", "Sound"],
      ["ArrowLeft", "Melody"], ["Home", "Sound"], ["End", "Melody"]]) {
      await page.keyboard.press(key);
      await assertLayer(name);
      assert.equal(await layer(name).evaluate((element) => element === document.activeElement), true,
        `${key} moves focus and activates the ${name} layer`);
    }
    for (const name of ["Rhythm", "Melody", "Sound"]) {
      await tabs.scrollIntoViewIfNeeded();
      await layer(name).click();
      await assertLayer(name);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} fits the viewport`);
      await page.screenshot({ path: `/tmp/libitu-stage-two-layer-${name.toLowerCase()}-${viewport.width}.png`, fullPage: true });
    }
    const media = page.getByRole("region", { name: "Listen and record", exact: true });
    assert.equal(await media.getByRole("button", { name: "Play sentence", exact: true }).count(), 1);
    assert.equal(await media.getByRole("button", { name: "Enable reference audio", exact: true }).count(), 1);
    assert.equal(await media.getByRole("button", { name: "Record sentence", exact: true }).count(), 1);
    const mediaBounds = await media.boundingBox(), tabBounds = await tabs.boundingBox();
    assert.ok(mediaBounds.y + mediaBounds.height <= tabBounds.y, "video and all media actions precede the three analysis layers");
    const videoBounds = await media.locator(".stage-two-practice-video").boundingBox();
    const audioBounds = await media.locator(".stage-two-practice-audio").boundingBox();
    const playBounds = await media.getByRole("button", { name: "Play sentence", exact: true }).boundingBox();
    const recordBounds = await media.getByRole("button", { name: "Record sentence", exact: true }).boundingBox();
    assert.ok(videoBounds.y + videoBounds.height <= playBounds.y,
      "the unified operation bar sits immediately below the video");
    if (viewport.width >= 700) assert.ok(Math.abs(playBounds.y - recordBounds.y) < 64,
      "desktop keeps reference playback and recording on one row");
    else assert.ok(playBounds.y + playBounds.height <= recordBounds.y,
      "mobile stacks reference playback before recording in the same operation bar");
    assert.ok(recordBounds.y + recordBounds.height <= audioBounds.y,
      "reference connection status follows the primary operations");
    await page.locator(".stage-two-practice-main").evaluate((element) => { element.scrollTop = 0; });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `/tmp/libitu-stage-two-media-top-${viewport.width}.png`, fullPage: true });
    const visibleInScrollport = (element) => {
      let top = 0, bottom = innerHeight;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) {
          const bounds = parent.getBoundingClientRect();
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
        }
      }
      const bounds = element.getBoundingClientRect();
      return bounds.top >= top - 1 && bounds.bottom <= bottom + 1;
    };
    await media.evaluate((element) => element.scrollIntoView({ block: "start" }));
    const tabsBeforeShortcut = (await tabs.boundingBox()).y;
    await page.getByRole("button", { name: "Focus Rhythm layer", exact: true }).click();
    // The shortcut schedules its scroll after React has switched the active layer.
    await tabs.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await assertLayer("Rhythm");
    assert.equal(await tabs.evaluate(visibleInScrollport), true, "a layer shortcut brings its workspace back into view");
    assert.ok((await tabs.boundingBox()).y < tabsBeforeShortcut, "a layer shortcut moves from the media area toward analysis");
    await page.screenshot({ path: `/tmp/libitu-stage-two-shortcut-rhythm-${viewport.width}.png` });
    await layer("Sound").click();
    assert.deepEqual(counts, initialCounts, "layer switches do not refetch Sound guidance");
    assert.equal(await page.evaluate(() => window.__workerStarts), initialWorkerStarts, "layer switches do not create acoustic workers");
    assert.equal(await page.evaluate(() => window.__players.length), initialPlayers, "layer switches do not recreate the player");
    assert.equal(await iframe.evaluate((node) => node.isConnected && node === document.querySelector(".youtube-player iframe")), true);
    assert.equal(await soundNode.evaluate((node) => node.isConnected && node === document.querySelector('[aria-label="Sound guide"]')), true);
    assert.equal(await options.getByRole("button").count(), 6);
    assert.equal(await panel.getByText("No recording", { exact: true }).count(), 2);
    assert.match(await panel.innerText(), /do not confirm what either speaker said/);
    assert.equal(await panel.getByText("Possible", { exact: true }).count(), 1);
    assert.doesNotMatch(await panel.innerText(), /(?:score|accuracy|passed|failed)\s*[:=]?\s*\d/i);
    await filters.getByRole("button", { name: "Linking 2", exact: true }).click();
    assert.equal(await options.getByRole("button").count(), 2);
    await options.getByRole("button", { name: "Linking: pick it", exact: true }).click();
    assert.equal(await panel.locator("mark").innerText(), "pick it");
    assert.equal(await panel.locator("mark").evaluate((mark) => mark.previousSibling?.textContent), "Pick it up, then ",
      "selecting the repeated occurrence highlights its exact source offset");
    const secondCandidate = options.getByRole("button", { name: "Linking: pick it", exact: true });
    assert.equal(await secondCandidate.getAttribute("aria-pressed"), "true");
    await layer("Melody").click();
    await layer("Sound").click();
    assert.equal(await filters.getByRole("button", { name: "Linking 2", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await secondCandidate.getAttribute("aria-pressed"), "true", "switching layers preserves the selected source occurrence");
    await page.getByRole("button", { name: "Play sentence", exact: true }).click();
    await page.evaluate(() => { window.__activePlayer.time = 1.05; });
    await page.waitForFunction(() => document.querySelector(".stage-two-sentence-focus .caption-word-active")?.textContent === "Pick");
    await panel.getByRole("button", { name: "Hide text", exact: true }).click();
    assert.equal(await page.locator(".stage-two-sentence-focus .caption-word").count(), 0, "hidden text is removed, not merely visually covered");
    assert.equal(await directory.first().locator(".caption-word").count(), 0, "hidden directory text has no caption word DOM");
    await page.evaluate(() => { window.__activePlayer.time = 1.25; });
    await page.waitForTimeout(150);
    assert.equal(await page.locator(".caption-word-active").count(), 0, "the playback clock cannot reveal a hidden prompt");
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await panel.getByText("0 of 7 words revealed", { exact: true }).waitFor();
    assert.equal(await detail.count(), 0, "recall mode conceals the selected suggestion text");
    assert.equal(await options.count(), 0, "recall mode conceals source phrases in candidate controls");
    assert.equal(await panel.locator("mark").isVisible(), false, "recall mode conceals the highlighted sentence");
    assert.equal(await panel.getByRole("button", { name: /^Reveal word / }).count(), 7);
    assert.ok(!(await page.locator(".stage-two-sentence-focus").innerText()).includes(sentences[0]),
      "the shared sentence focus does not reveal the hidden prompt");
    assert.ok(!(await directory.nth(0).getAttribute("aria-label")).includes(sentences[0]),
      "the selected directory item does not reveal the hidden prompt to assistive technology");
    await panel.getByRole("button", { name: "Reveal word 2", exact: true }).click();
    await panel.getByText("1 of 7 words revealed", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "Word 2: it", exact: true }).waitFor();
    await layer("Rhythm").click();
    await layer("Sound").click();
    await panel.getByText("1 of 7 words revealed", { exact: true }).waitFor();
    assert.equal(await panel.getByRole("button", { name: /^Reveal word / }).count(), 6,
      "switching layers preserves individually revealed words");
    await page.screenshot({ path: `/tmp/libitu-stage-two-sound-recall-${viewport.width}.png`, fullPage: true });
    await panel.getByRole("button", { name: "Reveal all", exact: true }).click();
    await detail.waitFor();
    assert.equal(await secondCandidate.getAttribute("aria-pressed"), "true", "revealing all restores the previous candidate");
    await filters.getByRole("button", { name: "All 6", exact: true }).focus();
    await page.keyboard.press("Tab");
    const keyboardFocus = await page.evaluate(() => ({ text: document.activeElement.textContent,
      outline: getComputedStyle(document.activeElement).outlineStyle, width: getComputedStyle(document.activeElement).outlineWidth }));
    assert.match(keyboardFocus.text, /Linking/);
    assert.notEqual(keyboardFocus.outline, "none", "keyboard focus is visible on a Sound filter");
    assert.notEqual(keyboardFocus.width, "0px");
    await page.keyboard.press("Enter");
    assert.equal(await filters.getByRole("button", { name: "Linking 2", exact: true }).getAttribute("aria-pressed"), "true");
    const firstCount = counts[0];

    await panel.getByRole("button", { name: "Hide text", exact: true }).click();
    await select(1);
    await panel.getByRole("button", { name: "Hide text", exact: true }).waitFor();
    assert.equal(await panel.getByRole("button", { name: /^Reveal word / }).count(), 0, "a new sentence starts with visible word cards");
    const summary = panel.locator("summary");
    await summary.filter({ hasText: "2/4 words have one reading" }).waitFor();
    await summary.click();
    await panel.getByText(/Not in dictionary: Zorbquux/).waitFor();
    await panel.getByText(/Multiple readings: read/).waitFor();
    assert.equal(await panel.getByText("Pronunciation unavailable", { exact: true }).count(), 1);
    assert.match(await panel.innerText(), /ɹid · ɹɛd/);
    assert.equal(await panel.locator("mark").count(), 0);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/libitu-stage-two-sound-dictionary-${viewport.width}.png`, fullPage: true });
    await select(0);
    await detail.waitFor();
    assert.equal(counts[0], firstCount, "returning to a cached sentence makes no additional Sound request");
    assert.equal(await filters.getByRole("button", { name: "All 6", exact: true }).getAttribute("aria-pressed"), "true",
      "sentence changes reset the phenomenon filter");
    await filters.getByRole("button", { name: "Elision 1", exact: true }).click();
    assert.equal(await options.getByRole("button").count(), 1);
    await filters.getByRole("button", { name: "All 6", exact: true }).click();
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal page overflow");
    const overflow = await panel.evaluate((element) => [...element.querySelectorAll("*")].filter((child) => {
      if (child.closest("details:not([open])") && child.tagName !== "SUMMARY") return false;
      const box = child.getBoundingClientRect();
      return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1);
    }).map((child) => `${child.tagName}.${child.className}`));
    assert.deepEqual(overflow, [], "Sound controls, IPA and evidence fit the viewport");
    await page.screenshot({ path: `/tmp/libitu-stage-two-sound-${viewport.width}.png`, fullPage: true });

    await select(2);
    await panel.getByText("No suggestions were found by the current rules. This does not mean the sentence has no connected speech.", { exact: true }).waitFor();
    assert.equal(await detail.count(), 0);
    await filters.getByRole("button", { name: "Flap 0", exact: true }).click();
    assert.equal(await options.count(), 0);
    await select(3);
    await panel.getByRole("alert").filter({ hasText: "pronunciation dictionary is unavailable" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Record sentence", exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole("button", { name: "Play sentence", exact: true }).isEnabled(), true);
    await panel.getByRole("button", { name: "Retry sound guide", exact: true }).click();
    await detail.waitFor();
    assert.equal(counts[3], 2);
    assert.equal(await panel.getByRole("alert").count(), 0);
    await filters.getByRole("button", { name: "Flap 0", exact: true }).click();
    await panel.getByText("No suggestions of this type were found for this sentence.", { exact: true }).waitFor();
    await Promise.all([page.waitForRequest((request) => request.url().endsWith(`/${blueprint.transcript[4].id}/sound`)), select(4)]);
    await panel.getByRole("status").filter({ hasText: "Preparing this sentence" }).waitFor();
    // The server is still working on the old sentence when the learner chooses another.
    await select(5);
    await detail.getByRole("heading", { name: "Linking · The current", exact: true }).waitFor();
    releaseLate();
    await page.waitForTimeout(250);
    assert.equal(await panel.locator(".stage-two-sound-sentence").innerText(), sentences[5]);
    assert.equal(await panel.getByRole("alert").count(), 0, "late response cannot attach an error or suggestion to another sentence");
    await select(0);
    await detail.waitFor();
    assert.equal(counts[0], firstCount);
    assert.equal(await page.evaluate(() => window.__audioAnalysisRuns), 0, "reading and filtering Sound guidance never starts audio inference");
    assert.equal(await page.evaluate(() => window.__players.length), initialPlayers, "word recall, layer and sentence changes preserve the player");
    assert.equal(await page.evaluate(() => window.__microphoneRequests), 0);
    assert.equal(await page.evaluate(() => window.__referenceRequests.filter((item) => ["arm", "begin"].includes(item.action)).length), 0);
    await layer("Melody").click();
    await page.getByRole("button", { name: "Back to segments", exact: true }).click();
    assert.equal(await page.getByRole("tabpanel", { includeHidden: true }).count(), 0, "leaving the source releases every practice layer");
    assert.equal(await page.evaluate(() => window.__players.every((player) => player.destroyed)), true);
    await page.locator(".stage-one-segment-card").first().click();
    await page.getByRole("button", { name: /Begin Stage 2/ }).click();
    await page.getByRole("button", { name: "Start shadowing", exact: true }).click();
    await detail.waitFor();
    assert.equal(await layer("Sound").getAttribute("aria-selected"), "true", "a new practice starts on the Sound layer");
    assert.ok(counts[0] > firstCount, "a new practice receives a new source-bound guide cache");
    assert.deepEqual(assets, [], "Sound guidance does not fetch acoustic models");
    assert.deepEqual(writes, [], "no media, feature, or Sound API mutation");
    assert.deepEqual(errors, []);
    console.log(`Stage 2 Sound guide render, source selection, dictionary states, retry, cancellation, cache, keyboard and overflow passed at ${viewport.width}px`);
    await context.close();
  }
} finally { await browser.close(); }
