import { contentContextFixture } from "./helpers/content-context-fixture.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const artifacts = await mkdtemp(join(tmpdir(), "libitu-shadow-persistence-"));
// Exercise actual MediaRecorder decoding and local Silero/Pitchy inference. All
// server analysis below remains a fixture; this synthetic voice is not accuracy evidence.
const speechInput = process.env.LIBITU_SPEECH_WAV ?? join(artifacts, "voice.aiff");
if (!process.env.LIBITU_SPEECH_WAV) {
  execFileSync("say", ["-v", "Samantha", "-r", "155", "-o", speechInput,
    "This is the second sentence. We practice speaking clearly."]);
}
const speechWav = join(artifacts, "voice.wav");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", speechInput, "-af", "apad=whole_dur=5",
  "-t", "5", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", speechWav]);
const content = "71303ef5-b347-42b8-ae5f-f51be4354ab5";
const job = { id: "practice-test", content_id: content, status: "ready", blueprint_id: "practice-blueprint",
  analysis_version: "mvp-v9", processing_stage: "completed", analysis_preview: null, error_message: null };
const blueprint = { id: job.blueprint_id, content_id: content, title: "Save your Shadow practice",
  source_url: "https://www.youtube.com/watch?v=practice123", summary: "Practice and recover saved takes.", chapters: [],
  logic_flow: [{ id: "logic-1", title: "Opening", subtitle: "An introduction", time: "0:01" }], corpus_items: [],
  transcript: ["We practice together, then pause.", "This is the second sentence."].map((text, index) => ({
    id: `sentence-v2-persistence-${index}`, time: `0:0${index * 3 + 1}`, parts: [text],
    start_ms: index * 3000 + 1000, end_ms: index * 3000 + 4000,
    source_token_start: index * 5, source_token_end: index * 5 + text.split(" ").length,
    segmentation_version: "sentence-v2", boundary_source: "syntax_merge", boundary_confidence: "medium"
  })),
  segments: [{ id: "practice-segment", sequence: 1, title: "Opening", summary: "Practice the opening.",
    start_ms: 1000, end_ms: 7000, transcript_start_index: 0, transcript_end_index: 2, phonology_tags: [], recommended: true }] };
const entry = `${origin}/practice/${content}/shadow?${new URLSearchParams({ learnerLevel: "B2", segmentId: "practice-segment", sentenceId: blueprint.transcript[1].id })}#practice`;

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
  window.__setUser(sessionStorage.getItem("test-owner") || "user-a");
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


const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
  `--use-file-for-fake-audio-capture=${speechWav}`] });
function audioBytes() {
  const data = Buffer.alloc(44 + 96000); data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24);
  data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(96000, 40);
  for (let n = 0; n < 48000; n++) data.writeInt16LE(Math.round(4000 * Math.sin(n * 2 * Math.PI * 220 / 16000)), 44 + n * 2);
  return data;
}

function analysisFixture(attempt, duration = 300, state = "awaiting_upload") {
  const words = attempt.sentence_text.split(" ").map((text, index) => ({ text, start_sec: index * .6,
    end_sec: index * .6 + duration / 1000, duration_ms: duration, pause_after_ms: index === 2 ? 350 : null,
    pitch_st: index === 1 ? null : index - 2, pitch_curve_st: index === 1 ? [null, null, null, null, null] : [1, null, null, -1, -2],
    boundary_pause_ms: index === 2 ? 350 : 0, phones: [{ label: "IY1", duration_ms: 140 }] }));
  const voice = { content: { status: "matched", transcript: attempt.sentence_text, reason: null },
    alignment_status: "aligned", quality_issues: [], words };
  return { id: attempt.id, sentence_id: attempt.sentence_id, analysis_version: "fixture-v1", state,
    error_code: null, retryable: false, created_at: new Date().toISOString(),
    result: { learner: voice, reference: { ...voice, words: words.map(word => ({ ...word, duration_ms: 250,
      pitch_curve_st: word.pitch_st === null ? [null, null, null, null, null] : [2, null, null, 0, -1],
      phones: [{ label: "IY1", duration_ms: 160 }] })) }, comparison: "available", reason: null,
      assessment: { version: "fixture-comparison-v1", rhythm: { value: 84, compared: 8, eligible: 9, reason: null, experimental: true },
        melody: { value: 62, compared: 15, eligible: 20, reason: null, experimental: true },
        sound: [{ kind: "vowel_length", status: "measured", realization: "not_evaluated", note: "Aligned vowel timing, not vowel identity.",
          score: { value: 87, compared: 5, eligible: 5, reason: null, experimental: true },
          pairs: words.map((_, index) => ({ word_index: index, end_index: index + 1, reference: 160, learner: 140, unit: "ms", similarity: 87 })) },
        { kind: "flap", status: "unsupported", realization: "not_evaluated", note: "A validated tap detector is required.",
          score: { value: null, compared: 0, eligible: 0, reason: "detector_not_validated", experimental: true }, pairs: [] }] } } };
}

let activePage;
try {
  for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport }); const page = await context.newPage(); activePage=page;
    page.setDefaultTimeout(30000);
    const errors = []; let prepares = 0, downloads = 0;
    const guideRequests = [];
    const attempts = [];
    const analyses = new Map(), analysisReads = new Map();
    let learnerJob = null, analysisPolls = 0, analysisUploads = 0, attemptSequence = 0, saveGate = null;
    let allowAnalysisCompletion = false;
    page.on("pageerror", error => errors.push(error.message));
    const reference = { id: "reference-test", content_id: content, segment_id: "practice-segment", state: "processing", input_mode: "file",
      start_ms: 1000, end_ms: 7000, audio_ready: false, analysis_version: "fixture-measurements-v1", expires_at: "2099-01-01T00:00:00Z", error_code: null,
      results: blueprint.transcript.map((s, i) => ({ sentence_id: s.id, status: "completed",
        prosody: analysisFixture({sentence_text:s.parts[0]}).result.reference,
        alignment: { status: "aligned", reason: null, content_gate: "not_checked",
          words: s.parts[0].split(" ").map((word, n) => ({ label: word.toLowerCase().replace(/[.,]/g, ""),
            start_sec: i * 3 + [0, .2, .7, 1.55, 1.8][n], end_sec: i * 3 + [.2, .7, 1.2, 1.8, 2.3][n] })), phones: [] },
        measurements: { duration_sec: 3, rms_dbfs: -20, f0_valid_fraction: .7, clipping_fraction: 0,
          frames: Array.from({ length: 30 }, (_, n) => ({ time_sec: i * 3 + n / 10, f0_hz: n === 5 ? null : 190 + n, energy_dbfs: -20 })),
          speech: [{ start_sec: i * 3, end_sec: i * 3 + 1.2 }, { start_sec: i * 3 + 1.55, end_sec: i * 3 + 2.3 }],
          pauses: [{ start_sec: i * 3 + 1.2, end_sec: i * 3 + 1.55 }], quality_issues: [] } })) };
    await page.addInitScript(installFixture);
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,authorization", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname === `/api/content/${blueprint.content_id}`) return route.fulfill({ json: contentContextFixture(blueprint, job), headers });
        if (url.pathname === `/api/jobs/${job.id}`) return route.fulfill({ json: job, headers });
        if (url.pathname === `/api/blueprints/${content}`) return route.fulfill({ json: blueprint, headers });
        const sentence = blueprint.transcript.find(s => url.pathname === `/api/blueprints/${content}/sentences/${s.id}/sound`);
        if (sentence) {
          guideRequests.push(sentence.id);
          const text = sentence.parts[0];
          const phones = { practice: ["P", "R", "AE1", "K", "T", "AH0", "S"], together: ["T", "AH0", "G", "EH1", "DH", "ER0"] };
          const tokens = [...text.matchAll(/[A-Za-z]+/g)].map((m, index) => ({ index, text: m[0], start: m.index,
            end: m.index + m[0].length, status: "known", pronunciations: [phones[m[0].toLowerCase()] ?? ["AH1"]], ipa: ["test"] }));
          return route.fulfill({ headers, json: { version: "sound-rules-v1", content_id: content, sentence_id: sentence.id,
            sentence_text: text, dialect: "en-US", provider: "cmudict-rules", lexicon_version: "rhythm-fixture",
            tokens, candidates: sentence.id.endsWith('-1') ? [
              {id:'fixture-link',kind:'linking',token_start:0,token_end:2,source_text:'This is',phonemes_before:'S IH',phonemes_after:'S‿IH',rule_id:'fixture-linking',conditions:['Connected speech'],explanation:'A final consonant may link to the next vowel.',status:'candidate'},
              {id:'fixture-weak',kind:'weak_form',token_start:2,token_end:3,source_text:'the',phonemes_before:'DH IY',phonemes_after:'DH AH',rule_id:'fixture-weak',conditions:['Unstressed'],explanation:'The may use an unstressed vowel.',status:'candidate'}
            ] : [], coverage: { total: tokens.length, known: tokens.length }, warnings: [] } });
        }
        if (url.pathname === "/api/references/captures/latest") return route.fulfill({json:null,headers});
        if (url.pathname === "/api/references/capability") return route.fulfill({ json: { available: true, input_mode: "file" }, headers });
        if (url.pathname === "/api/references") { prepares++; return route.fulfill({ status: 202, json: reference, headers }); }
        if (url.pathname === "/api/references/reference-test/events") {
          if (viewport.width < 500) return route.fulfill({ status: 503, json: { detail: "Stream interrupted" }, headers });
          reference.state = "completed"; reference.audio_ready = true;
          return route.fulfill({ contentType: "text/event-stream", body: `event: reference\ndata: ${JSON.stringify(reference)}\n\n`, headers });
        }
        if (url.pathname === "/api/references/reference-test/audio") { downloads++; return route.fulfill({ contentType: "audio/wav", body: audioBytes(), headers }); }
        if (url.pathname === "/api/references/reference-test") {
          if (request.method() === "DELETE") { reference.state = "deleted"; return route.fulfill({ status: 204, headers }); }
          if (reference.state === "processing") { reference.state = "completed"; reference.audio_ready = true; }
          return route.fulfill({ json: reference, headers });
        }
        if(url.pathname === "/api/practice/attempts/submit"){
          const form=await new Response(request.postDataBuffer(),{headers:{"content-type":request.headers()["content-type"]}}).formData();
          const {attempt:input,analysis:metadata}=JSON.parse(form.get("metadata"));
          assert.equal(input.recording,null);assert.equal(metadata.consent_version,"practice-analysis-v1");
          assert.ok(form.get("audio").size);
          const s=blueprint.transcript.find(item=>item.id===input.sentence_id);
          const id=attemptSequence++===0?"learner-take":`learner-take-${attemptSequence}`;
          const attempt={...input,id,sentence_text:s.parts[0],start_ms:s.start_ms,end_ms:s.end_ms,reference_version:"fixture",recording_state:"none",created_at:new Date().toISOString(),evidence_source:"browser_recording"};
          attempts.push(attempt);
          const current=analysisFixture(attempt);current.state="processing";analyses.set(id,current);
          if(id==="learner-take")learnerJob=current;
          analysisUploads++;
          if(saveGate){const gate=saveGate;saveGate=null;gate.reached();await gate.release;}
          return route.fulfill({status:202,json:attempt,headers});
        }
        if (url.pathname === "/api/practice/attempts") {
          if (request.method() === "POST") {
            const input = request.postDataJSON();
            assert.equal(input.recording, null, "analysis consent does not retain recordings");
            const s = blueprint.transcript.find(item => item.id === input.sentence_id);
            const id = attemptSequence++ === 0 ? "learner-take" : `learner-take-${attemptSequence}`;
            const attempt = { ...input, id, sentence_text: s.parts[0], start_ms: s.start_ms, end_ms: s.end_ms,
              reference_version: "fixture", recording_state: "none", created_at: new Date().toISOString(), evidence_source: "browser_recording" };
            attempts.push(attempt);
            if (saveGate) {
              const gate = saveGate; saveGate = null;
              gate.reached();
              await gate.release;
            }
            return route.fulfill({ status: 201, json: attempt, headers });
          }
          return route.fulfill({ json: { items: attempts.filter(a => a.sentence_id === url.searchParams.get("sentence_id"))
            .sort((a, b) => b.created_at.localeCompare(a.created_at)), next_offset: null }, headers });
        }
        const analysisRoute = url.pathname.match(/^\/api\/practice\/attempts\/([^/]+)\/analysis(\/audio)?$/);
        if (analysisRoute) {
          const id = analysisRoute[1];
          let current = analyses.get(id) ?? null;
          if (analysisRoute[2]) {
            assert.ok(current, "the analysis must be registered before upload");
            analysisUploads++; current.state = "processing";
            assert.ok(request.postDataBuffer().length > 0);
            return route.fulfill({ json: { ...current, result: null }, headers });
          }
          if (request.method() === "POST") {
            assert.equal(request.postDataJSON().consent_version, "practice-analysis-v1");
            current = analysisFixture(attempts.find(attempt => attempt.id === id));
            analyses.set(id, current);
            if (id === "learner-take") learnerJob = current;
          } else if (request.method() === "DELETE") {
            current.state = "deleted"; current.result = null;
            return route.fulfill({ status: 204, headers });
          } else {
            analysisReads.set(id, (analysisReads.get(id) ?? 0) + 1);
            if (current?.state === "processing" && allowAnalysisCompletion && ++analysisPolls >= 2) current.state = "completed";
          }
          return route.fulfill({ json: current ? { ...current,
            result: current.state === "completed" || current.state === "needs_review" ? current.result : null } : null, headers });
        }
        if (url.pathname === "/api/corpus") return route.fulfill({ json: [], headers });
        return route.fulfill({ status: 404, json: { detail: "Outside reference fixture" }, headers });
      }
      if (url.origin === origin) return route.continue();
      return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    });
    await page.goto(entry,{waitUntil:'domcontentloaded',timeout:60000});
    await page.getByText("File reference ready.", { exact: true }).waitFor();
    const play = page.getByRole("button", { name: "Play sentence", exact: true });
    await page.waitForFunction(() => document.querySelector('button[aria-label="Play sentence"]')?.disabled === false);
    assert.equal(await page.getByRole("button", { name: /Enable practice audio/ }).count(), 0);
    await play.click();
    await page.waitForFunction(() => [...document.querySelectorAll("audio")].some(audio => !audio.paused));
    assert.equal(await page.evaluate(() => window.__player.playing), false);
    await page.evaluate(() => { document.querySelector("audio").currentTime = 1.5; });
    await page.waitForFunction(() => document.querySelector(".stage-two-shadow-player-meta")?.textContent.includes("0:05"));

    await page.getByRole("button", { name: "Previous sentence", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("audio")].every(audio => audio.paused));
    await page.getByRole("tab", { name: "Rhythm", exact: true }).click();
    const rhythm = page.getByRole("region", { name: "Current rhythm word comparison", exact: true });
    await rhythm.waitFor();
    assert.equal(await rhythm.locator('.comparison-voice').count(),2);
    assert.equal(await rhythm.locator('.paired-reference .paired-duration').count(),5);
    assert.equal(guideRequests.filter(id=>id===blueprint.transcript[0].id).length,1);
    await rhythm.screenshot({path:join(artifacts,`rhythm-${viewport.width}.png`)});
    await page.getByRole('button',{name:'Next sentence',exact:true}).click();
    await page.getByRole('tab',{name:'Melody',exact:true}).click();
    await page.getByRole('img',{name:/Reference and your voice pitch curves/}).waitFor();
    await page.reload({waitUntil:'domcontentloaded',timeout:60000});
    await page.getByText("File reference ready.", { exact: true }).waitFor();
    assert.equal(prepares, 2);
    assert.ok(downloads >= 2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: join(artifacts, `file-reference-${viewport.width}.png`), fullPage: true });
    await page.locator(".stage-two-audio-settings > summary").click();
    await page.getByRole("checkbox", { name: "Server analysis", exact: true }).check();
    await page.getByRole("button", { name: "Record sentence", exact: true }).click();
    await page.getByText("Recording your voice", { exact: true }).waitFor();
    await page.waitForTimeout(3000);
    await page.getByRole("button", { name: "Stop recording", exact: true }).click();
    await page.getByText("Checking spoken words and aligning your recording…", { exact: true }).waitFor();
    for(const layer of ['Sound','Rhythm','Melody']) {
      await page.getByRole('tab',{name:layer,exact:true}).click();
      const panel=page.getByRole('region',{name:`Current ${layer.toLowerCase()} word comparison`,exact:true});
      await panel.waitFor();
      assert.equal(await panel.locator('.paired-learner .paired-duration').count(),0,'pending word alignment has no invented durations');
      assert.equal(await panel.locator('.paired-score,.paired-filters').count(),0);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }
    allowAnalysisCompletion = true;
    await page.getByText("Analysis saved. Compare your recording in Sound, Rhythm and Melody.", { exact: true }).waitFor();
    assert.equal(analysisUploads, 1);
    await page.getByRole("tab", { name: "Sound", exact: true }).click();
    const soundComparison = page.getByRole("region", {name:"Saved sound word comparison",exact:true});
    await soundComparison.waitFor();
    assert.equal(await soundComparison.locator(".sound-word-flow").count(),2);
    assert.equal(await soundComparison.locator('.paired-score,.paired-filters').count(),0);
    assert.equal(await soundComparison.locator('.paired-learner .sound-word-card').count(),5);
    assert.ok(await page.evaluate(()=>Boolean(document.querySelector('.stage-two-practice-media')?.compareDocumentPosition(document.querySelector('.stage-two-layers')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'video and controls precede layers');
    const filters = soundComparison.getByRole('group',{name:'Sound phenomenon filters'});
    assert.equal(await filters.getByRole('button').count(),11);
    const linking = filters.getByRole('button',{name:'Linking',exact:true});
    await linking.click();
    assert.equal(await soundComparison.locator('.sound-word-card.is-highlighted').count(),4);
    assert.equal(await soundComparison.locator('.sound-link').count(),2);
    assert.equal(await soundComparison.locator('.sound-word-group.is-muted').count(),6);
    const soundFocus = soundComparison.getByRole('complementary',{name:'Sound layer focus'});
    await soundFocus.getByText('Linking',{exact:true}).waitFor();
    await soundFocus.getByText('This is',{exact:true}).waitFor();
    const canvasBox = await soundComparison.locator('.stage-two-comparison-canvas').boundingBox();
    const focusBox = await soundFocus.boundingBox();
    assert.ok(viewport.width > 1000 ? focusBox.x >= canvasBox.x + canvasBox.width - 1 : focusBox.y >= canvasBox.y + canvasBox.height - 1, 'guidance sits beside desktop canvas and below mobile canvas');

    await page.getByRole('tab',{name:'Rhythm',exact:true}).click();
    await page.getByRole('tab',{name:'Sound',exact:true}).click();
    assert.equal(await linking.getAttribute('aria-pressed'),'true','filter survives tab change');
    await filters.getByRole('button',{name:'Weak',exact:true}).click();
    assert.equal(await soundComparison.locator('.sound-word-card.is-highlighted').count(),2);
    assert.equal(await soundComparison.locator('.sound-word-flow .sound-inline-badge[data-phenomenon="weak_form"]').count(),2);
    assert.equal(await soundComparison.locator('.paired-learner .sound-inline-badge[data-phenomenon="weak_form"]').innerText(),'WK ?');
    await filters.getByRole('button',{name:'Glottal',exact:true}).click();
    await soundComparison.getByText('Automatic identification of this phenomenon is not available yet.',{exact:true}).waitFor();
    await filters.getByRole('button',{name:'All',exact:true}).click();
    await soundComparison.getByRole('button',{name:'Hide text',exact:true}).click();
    assert.equal(await soundComparison.locator('.sound-word-flow .sound-inline-badge,.sound-link').count(),0,'covered words do not leak sound marks');
    assert.equal(await soundFocus.getByText('This is',{exact:true}).count(),0,'guidance does not reveal concealed text');
    assert.ok((await soundComparison.locator('.sound-word-ipa').allTextContents()).every(t=>!t.trim()));
    await soundComparison.getByRole('button',{name:'Reveal word 1',exact:true}).first().click();
    assert.equal(await soundComparison.locator('.sound-word-card strong').count(),2,'peek reveals the same occurrence in both rows');
    await soundComparison.getByRole('button',{name:'Reveal all',exact:true}).click();
    await soundComparison.locator('.paired-reference .sound-word-card').first().focus();
    assert.equal(await soundComparison.locator('.paired-reference .sound-word-ipa').first().evaluate(el=>getComputedStyle(el).opacity),'1');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await soundComparison.screenshot({path:join(artifacts,`paired-sound-${viewport.width}.png`)});
    await page.getByRole("tab", { name: "Rhythm", exact: true }).click();
    const comparison = page.getByRole("region", { name: "Saved rhythm word comparison", exact: true });
    await comparison.waitFor();
    assert.equal(await comparison.locator(".paired-word").count(), 10);
    assert.equal(await comparison.locator(".paired-syllables i").count(),10);
    assert.ok(await comparison.locator(".paired-pause").count() >= 2);
    assert.equal(await comparison.locator(".paired-reference .paired-duration").first().innerText(),"250 ms");
    assert.equal(await comparison.locator(".paired-learner .paired-duration").first().innerText(),"300 ms");
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
    await comparison.screenshot({path:join(artifacts,`paired-rhythm-${viewport.width}.png`)});
    await page.getByRole("button", { name: "Previous sentence", exact: true }).click();
    assert.equal(await page.getByRole("region", {name:"Saved rhythm word comparison",exact:true}).count(),0,"saved result cannot follow into another sentence");
    await page.getByRole("button", { name: "Next sentence", exact: true }).click();
    await comparison.waitFor();
    await page.getByRole("tab", { name: "Melody", exact: true }).click();
    const melody=page.getByRole('region',{name:'Saved melody word comparison',exact:true});
    const labels=melody.locator('.comparison-word-slot');
    assert.equal(await labels.count(),5);
    await labels.nth(2).click();
    assert.equal(await labels.nth(2).getAttribute('aria-current'),'true');
    await labels.nth(2).press('ArrowRight');
    assert.equal(await labels.nth(3).getAttribute('aria-current'),'true');
    await melody.locator('.comparison-word-hit').first().hover();
    assert.equal(await labels.first().getAttribute('aria-current'),'true');
    await page.mouse.move(0,0);
    await play.click();
    await page.evaluate(()=>{const a=[...document.querySelectorAll('audio')].find(a=>!a.paused);a.playbackRate=.25;a.currentTime=.05;a.dispatchEvent(new Event('timeupdate'));});
    await page.waitForFunction(()=>document.querySelector('.comparison-chart-scroll')?.dataset.playingVoice==='reference'&&document.querySelector('.comparison-word-slot')?.getAttribute('aria-current')==='true');
    await page.getByRole('button',{name:'Pause',exact:true}).click();
    await melody.screenshot({path:join(artifacts,`learner-melody-${viewport.width}.png`)});
    await page.reload({waitUntil:'domcontentloaded',timeout:60000});
    await page.getByText("Analysis saved. Compare your recording in Sound, Rhythm and Melody.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("checkbox", { name: "Server analysis", exact: true }).isChecked(), true);

    // A choice about future uploads must not hide previously saved analysis.
    await page.locator(".stage-two-audio-settings > summary").click();
    await page.getByRole("checkbox", { name: "Server analysis", exact: true }).uncheck();
    await page.reload({waitUntil:'domcontentloaded',timeout:60000});
    await page.getByText("Analysis saved. Compare your recording in Sound, Rhythm and Melody.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("checkbox", { name: "Server analysis", exact: true }).isChecked(), false);
    for (const layer of ["Sound", "Rhythm", "Melody"]) {
      await page.getByRole("tab", { name: layer, exact: true }).click();
      const restored = page.getByRole("region", { name: `Saved ${layer.toLowerCase()} word comparison`, exact: true });
      await restored.waitFor();
      await restored.getByRole("complementary",{name:`${layer} layer focus`}).getByRole("heading",{name:"Tip",exact:true}).waitFor();
      if(layer!=="Melody") assert.equal(await restored.locator(layer==="Sound"?".paired-learner .sound-word-card":".paired-learner .paired-word").count(), 5, `${layer} restores the saved learner row without new-analysis consent`);
      if (layer === "Rhythm") assert.equal(await restored.locator(".paired-learner .paired-duration").first().innerText(), "300 ms");
      if (layer === "Melody") assert.ok(await restored.locator(".paired-learner-trace circle").count() > 0, "saved learner pitch is drawn after refresh");
    }

    const history = page.getByRole("region", { name: "Saved practice", exact: true });
    const originalAttempt = attempts[0];
    const olderAttempt = { ...originalAttempt, id: "older-analysis-take", duration_ms: 4300,
      created_at: new Date(Date.parse(originalAttempt.created_at) - 60_000).toISOString() };
    attempts.push(olderAttempt);
    analyses.set(olderAttempt.id, analysisFixture(olderAttempt, 480, "completed"));
    await page.reload({waitUntil:'domcontentloaded',timeout:60000});
    await history.getByRole("button", { name: "View analysis", exact: true }).nth(1).click();
    await page.getByRole("tab", { name: "Rhythm", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".layer-comparison-rhythm .paired-learner .paired-duration")?.textContent === "480 ms");

    const attemptsBeforeCancel = attempts.length;
    await page.getByRole("button", { name: "Record sentence", exact: true }).click();
    await page.getByText("Recording your voice", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Cancel recording", exact: true }).click();
    assert.equal(await history.getByRole("button", { name: "View analysis", exact: true }).nth(1).getAttribute("aria-pressed"), "true",
      "cancelling a new recording preserves the selected historical analysis");
    assert.equal(await comparison.locator(".paired-learner .paired-duration").first().innerText(), "480 ms");
    assert.equal(attempts.length, attemptsBeforeCancel, "cancelled recordings create no practice attempt");

    async function saveRecordOnly(selectWhileSaving, afterSelection) {
      const expectedCount = attempts.length + 1;
      const visibleBeforeSave = [...attempts].sort((a, b) => b.created_at.localeCompare(a.created_at));
      let release;
      const reached = new Promise(resolve => {
        saveGate = { reached: resolve, release: new Promise(unblock => { release = unblock; }) };
      });
      await page.getByRole("button", { name: /^Record (sentence|again)$/ }).click();
      await page.getByText("Recording your voice", { exact: true }).waitFor();
      await page.waitForTimeout(400);
      const created = page.waitForResponse(response => new URL(response.url()).pathname === "/api/practice/attempts"
        && response.request().method() === "POST");
      await page.getByRole("button", { name: "Stop recording", exact: true }).click();
      let deadline;
      try {
        await Promise.race([reached, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("The stopped recording did not reach the pending-save fixture.")), 30_000);
        })]);
      } finally { clearTimeout(deadline); }
      try {
        const index = visibleBeforeSave.findIndex(attempt => attempt.id === selectWhileSaving);
        assert.ok(index >= 0);
        const select = history.getByRole("button", { name: "View analysis", exact: true }).nth(index);
        await select.click();
        assert.equal(await select.getAttribute("aria-pressed"), "true", "the learner explicitly chooses a historical take while the new save is pending");
        await afterSelection?.();
      } finally { release(); }
      const attempt = await (await created).json();
      await page.waitForFunction(count => document.querySelectorAll(".practice-history li").length === count, expectedCount);
      return attempt;
    }

    const newUnanalyzed = await saveRecordOnly(olderAttempt.id);
    await comparison.waitFor();
    assert.equal(await comparison.locator(".paired-learner .paired-duration").first().innerText(), "480 ms",
      "a late save acknowledgement refreshes history without replacing the learner's explicit historical selection");
    assert.equal(analysisUploads, 1, "record-only saves do not silently enable analysis");

    // The selected ID stays unchanged: an outbox save revision must invalidate an
    // earlier null analysis response after the server has made its result available.
    await history.getByRole("button", { name: "View analysis", exact: true }).first().click();
    await page.getByText("Server analysis was not requested for this take.", { exact: true }).waitFor();
    let readsBeforeSave;
    await saveRecordOnly(newUnanalyzed.id, async () => {
      await page.getByText("Server analysis was not requested for this take.", { exact: true }).waitFor();
      readsBeforeSave = analysisReads.get(newUnanalyzed.id);
      assert.ok(readsBeforeSave > 0);
      analyses.set(newUnanalyzed.id, analysisFixture(newUnanalyzed, 390, "completed"));
    });
    await page.waitForFunction(() => document.querySelector(".layer-comparison-rhythm .paired-learner .paired-duration")?.textContent === "390 ms");
    assert.ok(analysisReads.get(newUnanalyzed.id) > readsBeforeSave, "a save revision reloads analysis even when the selected attempt ID is unchanged");
    assert.equal(analysisUploads, 1);

    // Resume the original take for the reference-unavailable and review states.
    const originalIndex = [...attempts].sort((a, b) => b.created_at.localeCompare(a.created_at))
      .findIndex(attempt => attempt.id === originalAttempt.id);
    await history.getByRole("button", { name: "View analysis", exact: true }).nth(originalIndex).click();
    await page.waitForFunction(() => document.querySelector(".layer-comparison-rhythm .paired-learner .paired-duration")?.textContent === "300 ms");
    learnerJob.result.reference = null;
    learnerJob.result.assessment = null;
    learnerJob.result.comparison = "unavailable";
    // Keep only this take for cold-start restoration; history selection itself is
    // deliberately page-local and was already verified independently above.
    attempts.splice(0, attempts.length, originalAttempt);
    await page.reload({waitUntil:'domcontentloaded',timeout:60000});
    await page.getByRole("tab", { name: "Sound", exact: true }).click();
    await soundComparison.waitFor();
    const learnerSound = soundComparison.locator(".paired-learner");
    assert.equal(await learnerSound.locator(".sound-word-card").count(), 5);
    await soundComparison.getByRole('button',{name:'Vowel len.',exact:true}).click();
    await learnerSound.locator('.sound-inline-badge[data-evidence="measured"]').first().waitFor();
    assert.ok(await learnerSound.getByText("VL 140 ms", { exact: true }).count() > 0, "learner vowel timing does not require reference evidence");
    assert.equal(await soundComparison.locator('.paired-reference .sound-inline-badge[data-evidence="measured"]').count(),0);
    await soundComparison.getByRole('button',{name:'Linking',exact:true}).click();
    assert.ok(await learnerSound.locator('.sound-boundary-pause').count()>0);
    await soundComparison.screenshot({ path: join(artifacts, `learner-only-sound-${viewport.width}.png`) });
    await page.getByRole("tab", { name: "Rhythm", exact: true }).click();
    await comparison.waitFor();
    assert.equal(await comparison.locator(".paired-learner .paired-duration").first().innerText(), "300 ms");
    assert.equal(await comparison.locator(".paired-reference .paired-duration").count(), 0);
    await page.getByRole("tab", {name:"Melody",exact:true}).click();
    const noReference = page.getByRole("region", {name:"Saved melody word comparison",exact:true});
    await noReference.locator('.stage-two-comparison-canvas').getByText('Reference: Reference unavailable for this take.',{exact:true}).waitFor();
    assert.ok(await noReference.locator(".paired-learner-trace circle").count() > 0);
    assert.equal(await noReference.locator(".paired-reference-trace circle").count(), 0);
    learnerJob.state = "needs_review";
    learnerJob.result.learner = { content: { status: "mismatch", transcript: "Something else", reason: "recognized_words_differ" }, alignment_status: "not_run", quality_issues: [], words: [] };
    learnerJob.result.comparison = "unavailable";
    await page.reload({waitUntil:'domcontentloaded',timeout:60000});
    await page.getByText(/Comparison withheld: the words or alignment need review/).waitFor();
    assert.equal(await page.locator(".paired-learner-trace circle").count(),0,"mismatched content cannot receive a curve");
    await page.getByRole("button", { name: "Delete analysis", exact: true }).click();
    await page.getByText("Analysis deleted.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Delete file reference", exact: true }).click();
    await page.getByText("Reference deleted.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Play sentence", exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(`PASS: file playback with real local learner inference, asynchronous analysis, saved-result recovery without opt-in, cancelled recording selection, manual history selection, same-ID analysis refresh, learner-only measurements, content mismatch, sentence isolation, deletion, desktop/mobile. Screenshots: ${artifacts}`);
} catch(error) {
 await activePage?.screenshot({path:join(artifacts,'failure.png'),fullPage:true});
 await writeFile(join(artifacts,'failure.txt'),await activePage.locator('body').innerText());
 console.error('Failure artifacts:',artifacts);throw error;
} finally { await browser.close(); }
