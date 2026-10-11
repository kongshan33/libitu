import { contentContextFixture } from "./helpers/content-context-fixture.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
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

try {
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
  const context=await browser.newContext({viewport}),page=await context.newPage();page.setDefaultTimeout(20000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let reference=null,attempt=null,analysis=null,allowReference=false,uploads=0,prepares=0;
  const row=blueprint.transcript[1],voice=analysisFixture({sentence_text:row.parts[0]}).result.reference;
  await page.addInitScript(installFixture);

    await page.addInitScript(({audioBase64})=>{
      const post=data=>window.postMessage({type:'LIBITU_BUFFER_EVENT',version:4,...data},location.origin);
      window.addEventListener('message',({data})=>{
        if(data?.type!=='LIBITU_BUFFER_REQUEST')return;
        const reply={sessionId:data.sessionId,requestId:data.requestId};
        if(data.action==='ping')post({...reply,status:'available'});
        if(data.action==='arm') {post({...reply,status:'armed'});setTimeout(()=>{post({...reply,status:'enabled'});setTimeout(()=>post({...reply,status:'coverage',ranges:[{start:4,end:7}],retainedBytes:96000,recording:false}),100);},100);}
        if(data.action==='extract')post({...reply,status:'complete',captureId:data.requestId,start:data.start,end:data.end,durationMs:3000,mimeType:'audio/wav',audioBase64});
      });
    },{audioBase64:audioBytes().toString('base64')});

  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS'};
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
    const json=(value,status=200)=>route.fulfill({json:value,status,headers});
    if(url.pathname.startsWith('/api/')) {
      if (url.pathname === `/api/content/${blueprint.content_id}`) return json(contentContextFixture(blueprint, job));
      if(url.pathname===`/api/jobs/${job.id}`)return json(job);
      if(url.pathname===`/api/blueprints/${content}`)return json(blueprint);
      if(url.pathname.endsWith('/sound'))return json({version:'sound-rules-v1',content_id:content,sentence_id:row.id,sentence_text:row.parts[0],dialect:'en-US',provider:'cmudict-rules',lexicon_version:'fixture',tokens:[],candidates:[],coverage:{total:0,known:0},warnings:[]});
      if(url.pathname==='/api/references/capability')return json({available:false,input_mode:null});
      if(url.pathname==='/api/references/captures/latest')return json(reference?.state==='deleted'?null:reference);
      if(url.pathname==='/api/references/captures') {
        const data=req.postDataJSON();assert.equal(data.sentence_id,row.id);assert.equal(data.start_ms,4000);assert.equal(data.end_ms,7000);assert.match(data.sha256,/^[0-9a-f]{64}$/);prepares++;
        reference={id:'capture-ref',content_id:content,segment_id:'practice-segment',source_kind:'browser_capture',state:'awaiting_upload',input_mode:'upload',start_ms:4000,end_ms:7000,audio_ready:false,results:[],analysis_version:'fixture',expires_at:'2099-01-01T00:00:00Z',error_code:null};return json(reference,202);
      }
      if(url.pathname==='/api/references/capture-ref/audio') {
        const wav=req.postDataBuffer();assert.equal(wav.subarray(0,4).toString(),'RIFF');assert.ok(wav.length>96000);uploads++;reference.state='queued';reference.audio_ready=true;return json(reference);
      }
      if(url.pathname==='/api/references/capture-ref') {
        if(req.method()==='DELETE'){reference.state='deleted';return route.fulfill({status:204,headers});}
        if(allowReference){reference.state='completed';reference.results=[{sentence_id:row.id,status:'completed',prosody:voice}];}return json(reference);
      }
      if(url.pathname==='/api/practice/attempts') {
        if(req.method()==='POST'){attempt={...req.postDataJSON(),id:'take',sentence_text:row.parts[0],start_ms:4000,end_ms:7000,reference_version:'v1',recording_state:'none',created_at:new Date().toISOString()};return json(attempt,201);}
        return json({items:attempt?[attempt]:[],next_offset:null});
      }
      if(url.pathname==='/api/practice/attempts/take/analysis/audio'){analysis.state='queued';analysis.error_code='reference_pending';return json({...analysis,result:null});}
      if(url.pathname==='/api/practice/attempts/take/analysis') {
        if(req.method()==='POST'){assert.equal(req.postDataJSON().reference_id,'capture-ref');analysis=analysisFixture(attempt);return json({...analysis,result:null},202);}
        if(allowReference&&analysis)analysis.state='completed';if(reference?.state==='deleted'&&analysis){analysis.result.reference=null;analysis.result.comparison='unavailable';}return json(analysis?{...analysis,result:analysis.state==='completed'?analysis.result:null}:null);
      }
      if(url.pathname==='/api/corpus')return json([]);return json({detail:'Unexpected '+url.pathname},404);
    }
    if(url.origin===origin)return route.continue();return route.fulfill({contentType:'application/javascript',body:''});
  });
  await page.goto(entry,{waitUntil:'domcontentloaded',timeout:60000});
  await page.locator('.stage-two-audio-settings > summary').click();
  await page.getByRole('checkbox',{name:'Analyze captured reference audio on the server',exact:true}).check();
  await page.getByRole('button',{name:'Enable reference audio',exact:true}).click();
  await page.getByText('Analyzing reference words and pitch…',{exact:true}).waitFor();
  assert.equal(uploads,1);assert.equal(prepares,1);
  await page.getByRole('checkbox',{name:'Analyze new recordings on the server',exact:true}).check();
  await page.getByRole('button',{name:'Record sentence',exact:true}).click();
  await page.getByText('Recording your voice',{exact:true}).waitFor();await page.waitForTimeout(2000);
  await page.getByRole('button',{name:'Stop recording',exact:true}).click();
  await page.getByText(/Waiting for reference analysis/).waitFor();
  allowReference=true;
  await page.getByText('Analysis saved. Compare your recording in Sound, Rhythm and Melody.',{exact:true}).waitFor();
  for(const layer of ['Sound','Rhythm','Melody']) {
    await page.getByRole('tab',{name:layer,exact:true}).click();
    const panel=page.getByRole('region',{name:`Saved ${layer.toLowerCase()} word comparison`,exact:true});
    await panel.waitFor();
    if(layer==='Melody'){assert.equal(await panel.locator('svg').count(),1);assert.equal(await panel.locator('.comparison-word-slot').count(),5);assert.ok(await panel.locator('.paired-reference-trace circle').count()>0);assert.ok(await panel.locator('.paired-learner-trace circle').count()>0);}
    else assert.equal(await panel.locator('.comparison-voice').count(),2);
    assert.equal(await panel.locator('.paired-score,.paired-filters').count(),0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await panel.screenshot({path:join(artifacts,`browser-${layer.toLowerCase()}-${viewport.width}.png`)});
  }
  await page.getByRole('checkbox',{name:'Analyze captured reference audio on the server',exact:true}).uncheck();
  assert.equal(await page.locator('.practice-save-banner').count(),0,'all uploads finish before refreshing');await page.reload({waitUntil:'domcontentloaded',timeout:60000});await page.getByText('Reference analysis ready.',{exact:true}).waitFor();
  await page.getByText('Analysis saved. Compare your recording in Sound, Rhythm and Melody.',{exact:true}).waitFor();
  assert.equal(uploads,1,'refresh and opt-out never upload again');
  await page.getByRole('button',{name:'Delete captured reference',exact:true}).click();await page.getByText('Reference deleted.',{exact:true}).waitFor();
  await page.getByRole('tab',{name:'Melody',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.paired-reference-trace circle').length===0);
  assert.deepEqual(errors,[]);await context.close();
 }
 console.log(`PASS: browser capture -> WAV upload -> pending bound take -> dual comparisons -> refresh -> delete, desktop/mobile. Screenshots: ${artifacts}`);
}finally{await browser.close();}
