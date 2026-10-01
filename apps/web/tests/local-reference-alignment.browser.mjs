import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSignedInPractice } from "./helpers/signed-in-practice.mjs";

// Real local WAV decoding, Silero/Pitchy and Charsiu ONNX/WASM inference.
// The player, extension grant/transport, identity, persistence and saved learner
// alignment are fixtures. This checks integration and display, not accuracy.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const artifacts = mkdtempSync(join(tmpdir(), "libitu-local-reference-alignment-"));
const sentenceText = "Let us begin. We can learn to speak English.";
const sourceAudio = process.env.LIBITU_SPEECH_WAV ?? join(artifacts, "reference.aiff");
if (!process.env.LIBITU_SPEECH_WAV) {
  execFileSync("say", ["-v", "Samantha", "-r", "155", "-o", sourceAudio, sentenceText]);
}
const wavPath = join(artifacts, "reference.wav"), pcmPath = join(artifacts, "reference.pcm");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", sourceAudio, "-af", "apad=whole_dur=5",
  "-t", "5", "-ar", "16000", "-ac", "1", "-f", "s16le", pcmPath]);
// The extension protocol deliberately accepts only its exact 44-byte PCM WAV
// header. ffmpeg's optional LIST metadata is outside that transport contract.
const pcm = readFileSync(pcmPath), header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
const wav = Buffer.concat([header, pcm]); writeFileSync(wavPath, wav);
const phones = {
  let: [["L", "EH1", "T"]], us: [["AH1", "S"], ["AH0", "S"]],
  begin: [["B", "IH0", "G", "IH1", "N"]], we: [["W", "IY1"]],
  can: [["K", "AE1", "N"], ["K", "AH0", "N"]], learn: [["L", "ER1", "N"]],
  to: [["T", "UW1"], ["T", "AH0"]], speak: [["S", "P", "IY1", "K"]],
  english: [["IH1", "NG", "G", "L", "IH0", "SH"]],
};
const contentId = "local-alignment-content";
const job = { id: "local-alignment-job", content_id: contentId, status: "ready", blueprint_id: "local-alignment-blueprint",
  analysis_version: "mvp-v9", processing_stage: "completed", analysis_preview: null, error_message: null };
let sourceToken = 0;
const transcript = [sentenceText, "This sentence has no captured reference."].map((text, index) => {
  const start = 1000 + index * 5000, words = text.split(" "), tokenStart = sourceToken;
  sourceToken += words.length;
  return { id: `sentence-v3-local-alignment-${index}`, time: `0:0${1 + index * 5}`, parts: [text],
    start_ms: start, end_ms: start + 5000, source_token_start: tokenStart, source_token_end: sourceToken,
    segmentation_version: "sentence-v3", boundary_source: "source_punctuation", boundary_confidence: "high",
    timing_source: "caption_word_offsets", word_timings: words.map((text, tokenIndex) => ({ text,
      source_token_index: tokenStart + tokenIndex, start_ms: start + tokenIndex * 350,
      end_ms: start + (tokenIndex + 1) * 350, start_source: "caption_offset", end_source: "next_word_estimate",
      source_event_index: index, source_seg_index: tokenIndex })) };
});
const blueprint = { id: job.blueprint_id, content_id: contentId, title: "Local reference alignment regression",
  source_url: "https://www.youtube.com/watch?v=practice123", summary: "Local reference integration fixture.", chapters: [],
  logic_flow: [{ id: "local-logic", title: "Practice", subtitle: "Listen and repeat.", time: "0:01" }], corpus_items: [], transcript,
  segments: [{ id: "local-segment", sequence: 1, title: "Local alignment", summary: "Listen and repeat.", start_ms: 1000,
    end_ms: 11000, transcript_start_index: 0, transcript_end_index: 2, phonology_tags: [], recommended: true }] };
const entry = `${origin}/?${new URLSearchParams({ sourceUrl: blueprint.source_url, title: blueprint.title,
  contentId, jobId: job.id, stage: "2", segmentId: "local-segment", sentenceId: transcript[0].id })}`;
function annotation(row) {
  const text = row.parts[0];
  const tokens = [...text.matchAll(/[A-Za-z]+/g)].map((match, index) => ({ index, text: match[0],
    start: match.index, end: match.index + match[0].length, status: phones[match[0].toLowerCase()] ? "known" : "unknown",
    pronunciations: phones[match[0].toLowerCase()] ?? [], ipa: (phones[match[0].toLowerCase()] ?? []).map(() => "fixture dictionary") }));
  return { version: "sound-rules-v1", content_id: contentId, sentence_id: row.id, sentence_text: text,
    dialect: "en-US", provider: "cmudict-rules", lexicon_version: "local-browser-fixture", tokens, candidates: [],
    coverage: { total: tokens.length, known: tokens.filter(token => token.status === "known").length }, warnings: [] };
}
function learnerAnalysis(attempt, state = "completed") {
  return { id: `analysis-${attempt.id}`, sentence_id: attempt.sentence_id, analysis_version: "browser-learner-fixture-v1", state,
    error_code: null, retryable: false, created_at: new Date().toISOString(), result: state !== "completed" ? null : {
      comparison: "unavailable", reason: "reference_unavailable", reference: null, assessment: null,
      learner: { content: { status: "matched", transcript: attempt.sentence_text, reason: null },
        alignment_status: "aligned", quality_issues: [], words: annotation(transcript[0]).tokens.map((token, index) => ({
          text: token.text, start_sec: index * 0.4, end_sec: index * 0.4 + 0.32, duration_ms: 320,
          pause_after_ms: null, boundary_pause_ms: 0, pitch_st: index / 2 - 2,
          pitch_curve_st: [-1, 0, 1, 0, -1], phones: token.pronunciations[0].map(label => ({ label, duration_ms: 60 })),
        })) } } };
}

function installLocalTransport({ audioBase64 }) {
  window.__localBufferRequests = [];
  window.__localAlignmentResults = [];
  window.__localWorkerStarts = 0;
  window.__localBufferSession = null;
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      window.__localWorkerStarts++;
      // Observe the real worker result; do not replace inference or inject outputs.
      this.addEventListener("message", ({ data }) => {
        if (data?.result?.engineVersion === "charsiu-en-fc-10ms-v1") window.__localAlignmentResults.push(data.result);
      });
    }
  };
  const post = data => window.postMessage({ type: "LIBITU_BUFFER_EVENT", version: 3, ...data }, location.origin);
  window.__grantLocalReference = () => {
    const request = window.__localBufferRequests.findLast(item => item.action === "arm");
    if (!request) throw new Error("Missing explicit reference arm request.");
    window.__localBufferSession = request.sessionId;
    post({ sessionId: request.sessionId, requestId: request.requestId, status: "enabled" });
  };
  window.__publishLocalCoverage = () => post({ sessionId: window.__localBufferSession,
    requestId: window.__localBufferSession, status: "coverage", ranges: [{ start: 1, end: 6 }], retainedBytes: 160_000, recording: false });
  window.addEventListener("message", ({ data }) => {
    if (data?.type !== "LIBITU_BUFFER_REQUEST") return;
    if (data.version !== 3) throw new Error("Expected buffered reference protocol v3.");
    window.__localBufferRequests.push(data);
    const response = { sessionId: data.sessionId, requestId: data.requestId };
    if (data.action === "ping") post({ ...response, status: "available" });
    if (data.action === "arm") post({ ...response, status: "armed" });
    if (data.action === "extract") {
      if (data.sessionId !== window.__localBufferSession || data.start !== 1 || data.end !== 6) {
        throw new Error("Unexpected reference source or sentence extraction.");
      }
      post({ ...response, status: "complete", captureId: `local-fixture-${data.requestId}`,
        start: data.start, end: data.end, durationMs: 5000, mimeType: "audio/wav", audioBase64 });
    }
    if (data.action === "close" && data.sessionId === window.__localBufferSession) window.__localBufferSession = null;
  });
  window.YT = { Player: class {
    time = 0; rate = 1; state = 2;
    constructor(_element, { events }) {
      this.events = events; window.__localPlayer = this;
      queueMicrotask(() => { this.ready = true; events.onReady(); });
    }
    getCurrentTime() { return this.time; }
    getPlayerState() { return this.state; }
    seekTo(seconds) { this.time = seconds; }
    playVideo() { this.state = 1; this.events.onStateChange({ data: 1 }); }
    pauseVideo() { this.state = 2; this.events.onStateChange({ data: 2 }); }
    getPlaybackRate() { return this.rate; }
    setPlaybackRate(rate) { this.rate = rate; this.events.onPlaybackRateChange?.({ data: rate }); }
    getAvailablePlaybackRates() { return [0.75, 1, 1.25]; }
    destroy() { this.state = 2; }
  } };
}

const browser = await chromium.launch({ headless: true, channel: process.env.LIBITU_BROWSER_CHANNEL ?? "chrome",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
    `--use-file-for-fake-audio-capture=${wavPath}`] });
try {
  const viewports = process.env.LIBITU_ALIGNMENT_VIEWPORT === "mobile" ? [{ width: 390, height: 844 }]
    : process.env.LIBITU_ALIGNMENT_VIEWPORT === "both" ? [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]
      : [{ width: 1440, height: 1100 }];
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage(); page.setDefaultTimeout(30_000);
    const errors = [], apiMutations = [], assetRequests = [], attempts = new Map(), analyses = new Map(), uploads = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/") && !["GET", "OPTIONS"].includes(request.method())) {
        apiMutations.push({ path: url.pathname, method: request.method(), contentType: request.headers()["content-type"] ?? "" });
      }
      if (url.pathname.startsWith("/acoustic-assets/")) assetRequests.push(request.url());
    });
    await installSignedInPractice(page);
    await page.addInitScript(installLocalTransport, { audioBase64: wav.toString("base64") });
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,authorization",
        "access-control-allow-methods": "GET,POST,PUT,OPTIONS" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname === `/api/jobs/${job.id}`) return route.fulfill({ json: job, headers });
        if (url.pathname === `/api/blueprints/${contentId}`) return route.fulfill({ json: blueprint, headers });
        if (url.pathname === "/api/references/capability") return route.fulfill({ json: { available: false, input_mode: null }, headers });
        if (url.pathname === "/api/corpus") return route.fulfill({ json: [], headers });
        const row = transcript.find(item => url.pathname === `/api/blueprints/${contentId}/sentences/${item.id}/sound`);
        if (row) {
          assert.equal(request.method(), "GET", "local alignment requests dictionary text only");
          return route.fulfill({ json: annotation(row), headers });
        }
        if (url.pathname === "/api/practice/attempts") {
          if (request.method() === "GET") return route.fulfill({ json: {
            items: [...attempts.values()].filter(item => item.sentence_id === url.searchParams.get("sentence_id")), next_offset: null }, headers });
          assert.equal(request.method(), "POST");
          const input = request.postDataJSON();
          assert.equal(input.recording, null, "optional recording retention stays disabled");
          const sentence = transcript.find(item => item.id === input.sentence_id);
          assert.ok(sentence);
          const attempt = { ...input, id: input.client_id, sentence_text: sentence.parts[0], start_ms: sentence.start_ms,
            end_ms: sentence.end_ms, reference_version: "fixture", recording_state: "none", evidence_source: "browser_recording",
            created_at: new Date().toISOString() };
          attempts.set(attempt.id, attempt);
          return route.fulfill({ status: 201, json: attempt, headers });
        }
        const analysis = url.pathname.match(/^\/api\/practice\/attempts\/([^/]+)\/analysis(\/audio)?$/);
        if (analysis) {
          const attempt = attempts.get(analysis[1]);
          assert.ok(attempt, "learner analysis belongs to a saved microphone attempt");
          if (analysis[2]) {
            assert.equal(request.method(), "PUT");
            assert.ok(analyses.has(attempt.id), "explicit learner purpose precedes upload");
            const bytes = request.postDataBuffer();
            assert.ok(bytes?.length);
            assert.equal(bytes.equals(wav), false, "the captured reference WAV must never become a learner upload");
            assert.match(request.headers()["content-type"], /^audio\/(webm|ogg|mp4)/);
            uploads.push(bytes.length);
            const result = learnerAnalysis(attempt); analyses.set(attempt.id, result);
            return route.fulfill({ json: result, headers });
          }
          if (request.method() === "POST") {
            const input = request.postDataJSON();
            assert.equal(input.consent_version, "practice-analysis-v1");
            assert.equal(input.reference_id, null, "the local reference is never registered as a server file");
            analyses.set(attempt.id, learnerAnalysis(attempt, "awaiting_upload"));
          } else assert.equal(request.method(), "GET");
          return route.fulfill({ json: analyses.get(attempt.id) ?? null, headers });
        }
        throw new Error(`Unexpected API request: ${request.method()} ${url.pathname}`);
      }
      if (/clerk\.(accounts\.dev|com)$/.test(url.hostname)) return route.fulfill({ contentType: "application/javascript", body: "/* synthetic identity */" });
      if (url.origin === origin) return route.continue();
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><body>Local player fixture</body>" });
    });
    try {
      await page.goto(entry, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.locator(".stage-two-shadow").waitFor();
      const reference = page.getByRole("region", { name: "Reference preparation", exact: true });
      await reference.getByRole("button", { name: "Enable reference audio", exact: true }).click();
      await reference.getByText(/Click Libitu in Chrome/).waitFor();
      await page.evaluate(() => window.__grantLocalReference());
      await reference.getByText("Reference connected", { exact: true }).waitFor();
      await page.evaluate(() => window.__publishLocalCoverage());
      console.log(`Reference capture supplied (${viewport.width}px); waiting for real local inference.`);
      await page.waitForFunction(() => {
        const status = document.querySelector(".stage-two-alignment-status")?.textContent;
        return status && !status.includes("Aligning reference words");
      }, null, { timeout: 200_000 });
      const measured = await page.evaluate(() => window.__localAlignmentResults);
      writeFileSync(join(artifacts, `reference-result-${viewport.width}.json`), JSON.stringify(measured, null, 2));
      assert.match(await page.locator(".stage-two-alignment-status").innerText(), /Local word and phoneme alignment ready/,
        `Actual worker results: ${JSON.stringify(measured)}`);
      assert.deepEqual(apiMutations, [], "reference preparation performs no API writes or media upload");
      assert.ok(assetRequests.some(url => url.endsWith("silero_vad_v5.onnx")), "actual Silero assets were loaded");
      assert.ok(assetRequests.some(url => url.endsWith("charsiu-en-fc-10ms-int8.onnx")), "actual Charsiu weights were loaded");
      assert.equal(measured.length, 1);
      assert.equal(measured[0].status, "ready");
      assert.equal(measured[0].contentVerification, "not_independently_verified");
      assert.equal(measured[0].phoneLabels, "dictionary_targets");
      assert.equal(measured[0].words.length, annotation(transcript[0]).tokens.length);
      assert.ok(measured[0].words.every(word => word.endMs > word.startMs && word.phones.length
        && word.phones.every(phone => phone.endMs > phone.startMs)), "real word and phone intervals are nonempty");
      writeFileSync(join(artifacts, `reference-result-${viewport.width}.json`), JSON.stringify(measured[0], null, 2));
      const sound = page.getByRole("region", { name: "Local sound word comparison", exact: true });
      await sound.waitFor();
      assert.equal(await sound.locator(".paired-reference .paired-word").count(), measured[0].words.length);
      assert.ok(await sound.locator(".paired-reference .paired-evidence span").filter({ hasText: /^Vowel/ }).count() > 0,
        "aligned phone durations appear as reference vowel measurements");
      assert.equal(await sound.getByText("No aligned recording", { exact: true }).count(), measured[0].words.length);
      await sound.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(artifacts, `local-reference-${viewport.width}.png`), fullPage: true });
      await sound.locator(".stage-two-layer-canvas").screenshot({ path: join(artifacts, `reference-canvas-${viewport.width}.png`) });

      const workersBefore = await page.evaluate(() => window.__localWorkerStarts);
      const extractsBefore = await page.evaluate(() => window.__localBufferRequests.filter(item => item.action === "extract").length);
      const layers = page.getByRole("tablist", { name: "Practice layers", exact: true });
      for (const layer of ["Rhythm", "Melody", "Sound"]) await layers.getByRole("tab", { name: layer, exact: true }).click();
      assert.equal(await page.evaluate(() => window.__localWorkerStarts), workersBefore, "switching layers reuses inference");
      assert.equal(await page.evaluate(() => window.__localPlayer.state), 2, "layer switching never starts playback");

      await page.getByRole("checkbox", { name: "Analyze new recordings on the server", exact: true }).check();
      await page.getByRole("button", { name: "Record sentence", exact: true }).click();
      await page.getByText("Recording your voice", { exact: true }).waitFor();
      await page.waitForTimeout(1400);
      await page.getByRole("button", { name: "Stop recording", exact: true }).click();
      await page.getByText("Analysis saved. Compare your recording in Sound, Rhythm and Melody.", { exact: true }).waitFor();
      for (const layer of ["Sound", "Rhythm", "Melody"]) {
        await layers.getByRole("tab", { name: layer, exact: true }).click();
        const paired = page.getByRole("region", { name: `Saved ${layer.toLowerCase()} word comparison`, exact: true });
        await paired.waitFor();
        assert.equal(await paired.locator(".paired-reference .paired-word").count(), measured[0].words.length);
        assert.equal(await paired.locator(".paired-learner .paired-word").count(), measured[0].words.length);
        assert.equal(await paired.getByText("No reference measurement", { exact: true }).count(), 0);
        assert.equal(await paired.getByText("No aligned recording", { exact: true }).count(), 0);
        assert.ok(await paired.locator(".paired-score").filter({ hasText: "Not scored" }).count() > 0,
          "cross-engine measurements do not create scores");
        if (layer === "Rhythm") assert.ok(await paired.locator(".paired-reference .paired-duration").count() > 0);
        if (layer === "Melody") {
          assert.ok(await paired.locator(".paired-reference-trace circle").count() > 0);
          assert.ok(await paired.locator(".paired-learner-trace circle").count() > 0);
        }
        await paired.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(artifacts, `paired-${layer.toLowerCase()}-${viewport.width}.png`), fullPage: true });
        await paired.locator(".stage-two-layer-canvas").screenshot({ path: join(artifacts, `paired-${layer.toLowerCase()}-canvas-${viewport.width}.png`) });
      }
      assert.equal(uploads.length, 1, "only the explicitly consented microphone recording was uploaded");
      assert.equal(attempts.size, 1);
      assert.ok(apiMutations.every(item => item.method === "POST" && item.contentType.includes("application/json")
        && (item.path === "/api/practice/attempts" || /^\/api\/practice\/attempts\/[^/]+\/analysis$/.test(item.path))
        || item.method === "PUT" && /^\/api\/practice\/attempts\/[^/]+\/analysis\/audio$/.test(item.path)),
      "no reference media API exists in the local path");

      await page.getByRole("button", { name: "Next sentence", exact: true }).click();
      await reference.getByText(/has not been fully captured/).waitFor();
      assert.equal(await page.locator(".layer-comparison").count(), 0, "another sentence cannot borrow local or saved word evidence");
      assert.equal(await page.locator(".stage-two-alignment-status").count(), 0);
      await page.getByRole("button", { name: "Previous sentence", exact: true }).click();
      await page.getByText("Local word and phoneme alignment ready. Reference audio stays on this device.", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__localAlignmentResults.length), 1, "returning to the sentence reuses alignment");
      assert.equal(await page.evaluate(() => window.__localBufferRequests.filter(item => item.action === "extract").length), extractsBefore);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "page fits the viewport");
      assert.deepEqual(errors, []);
      writeFileSync(join(artifacts, `network-${viewport.width}.json`), JSON.stringify({ apiMutations, assetRequests, uploads }, null, 2));
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `failure-${viewport.width}.png`), fullPage: true });
      writeFileSync(join(artifacts, `failure-${viewport.width}.txt`), `${error.stack}\n\n${await page.locator("body").innerText()}\n\n${JSON.stringify(errors)}`);
      console.error(`Browser evidence: ${artifacts}`);
      throw error;
    } finally { await context.close(); }
  }
  console.log(`PASS: real browser-local Charsiu reference word/phone inference, REF display, simulated saved-learner pairing, layer/cache/sentence isolation and no reference upload. Evidence: ${artifacts}`);
} finally { await browser.close(); }
