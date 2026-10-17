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
    result: { learner: voice, reference: { ...voice, content: {status:'source_transcript',transcript:'',reason:'source_transcript_not_asr_verified'}, words: words.map(word => ({ ...word, duration_ms: 250,
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
  let reference=null,attempt=null,analysis=null,allowReference=false,uploads=0,prepares=0,recoveryFails=true,learnerUploads=0;
  let fileMode=false,filePrepares=0;
  const fileReference={id:'registered-ref',content_id:content,segment_id:'practice-segment',source_kind:'registered',state:'awaiting_upload',input_mode:'upload',start_ms:1000,end_ms:7000,audio_ready:false,results:[],analysis_version:'fixture',expires_at:'2099-01-01T00:00:00Z',error_code:null};
  let releaseRecovery;
  const recoveryGate=new Promise(resolve=>{releaseRecovery=resolve;});
  const row=blueprint.transcript[1],voice=analysisFixture({sentence_text:row.parts[0]}).result.reference;
  await page.addInitScript(installFixture);

    await page.addInitScript(({audioBase64})=>{
      const post=data=>window.postMessage({type:'LIBITU_BUFFER_EVENT',version:4,...data},location.origin);
      window.addEventListener('message',({data})=>{
        if(data?.type!=='LIBITU_BUFFER_REQUEST')return;
        const reply={sessionId:data.sessionId,requestId:data.requestId};
        if(data.action==='ping')post({...reply,status:'available'});
        if(data.action==='arm') {post({...reply,status:'armed'});window.__grantReference=()=>{post({...reply,status:'enabled'});setTimeout(()=>post({...reply,status:'coverage',ranges:[{start:4,end:7}],retainedBytes:96000,recording:false}),100);};}
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
      if(url.pathname.endsWith('/sound')) {
        const tokens=[...row.parts[0].matchAll(/[A-Za-z]+/g)].map((m,index)=>({index,text:m[0],start:m.index,end:m.index+m[0].length,status:'known',pronunciations:[['AH1']],ipa:['test']}));
        return json({version:'sound-rules-v1',content_id:content,sentence_id:row.id,sentence_text:row.parts[0],dialect:'en-US',provider:'cmudict-rules',lexicon_version:'fixture',tokens,candidates:[
          {id:'fixture-link',kind:'linking',token_start:0,token_end:2,source_text:'This is',phonemes_before:'S IH',phonemes_after:'S‿IH',rule_id:'fixture-linking',conditions:['Connected speech'],explanation:'A final consonant may link to the next vowel.',status:'candidate'},
          {id:'fixture-weak',kind:'weak_form',token_start:2,token_end:3,source_text:'the',phonemes_before:'DH IY',phonemes_after:'DH AH',rule_id:'fixture-weak',conditions:['Unstressed'],explanation:'The may use an unstressed vowel.',status:'candidate'}
        ],coverage:{total:tokens.length,known:tokens.length},warnings:[]});
      }
      if(url.pathname.startsWith('/api/profile/videos/'))return json({});
      if(url.pathname==='/api/practice/attempts/progress')return json({practiced_sentence_ids:attempt?[attempt.sentence_id]:[]});
      if(url.pathname==='/api/references/capability')return json({available:fileMode,input_mode:fileMode?'upload':null});
      if(url.pathname==='/api/references'&&req.method()==='POST'){filePrepares++;return json(fileReference,202);}
      if(url.pathname==='/api/references/registered-ref')return json(fileReference);
      if(url.pathname==='/api/references/captures/latest') {
        await recoveryGate;
        return recoveryFails ? json({detail:'Sentence not found'},404) : json(reference?.state==='deleted'?null:reference);
      }
      if(url.pathname==='/api/references/captures') {
        const data=req.postDataJSON();assert.equal(data.sentence_id,row.id);assert.equal(data.start_ms,4000);assert.equal(data.end_ms,7000);assert.match(data.sha256,/^[0-9a-f]{64}$/);prepares++;
        reference={id:'capture-ref',content_id:content,segment_id:'practice-segment',source_kind:'browser_capture',state:'awaiting_upload',input_mode:'upload',start_ms:4000,end_ms:7000,audio_ready:false,results:[],analysis_version:'fixture',expires_at:'2099-01-01T00:00:00Z',error_code:null};return json(reference,202);
      }
      if(url.pathname==='/api/references/capture-ref/audio') {
        const wav=req.postDataBuffer();assert.equal(wav.subarray(0,4).toString(),'RIFF');assert.ok(wav.length>96000);uploads++;reference.state='queued';reference.audio_ready=true;return json(reference);
      }
      if(url.pathname==='/api/references/capture-ref/retry') { reference.state='queued'; reference.results=[]; return json(reference); }
      if(url.pathname==='/api/references/capture-ref') {
        if(req.method()==='DELETE'){reference.state='deleted';return route.fulfill({status:204,headers});}
        if(allowReference){reference.state='completed';reference.results=[{sentence_id:row.id,status:'completed',prosody:voice}];}return json(reference);
      }
      if(url.pathname==='/api/practice/attempts/submit'){
        const form=await new Response(req.postDataBuffer(),{headers:{'content-type':req.headers()['content-type']}}).formData();
        const {attempt:data,analysis:metadata}=JSON.parse(form.get('metadata'));
        assert.equal(metadata.reference_id,'capture-ref');assert.ok(data.recording);assert.ok(form.get('audio').size);
        attempt={...data,id:'take',sentence_text:row.parts[0],start_ms:4000,end_ms:7000,reference_version:'v1',recording_state:'ready',created_at:new Date().toISOString()};
        analysis=analysisFixture(attempt);analysis.state='queued';analysis.error_code='reference_pending';learnerUploads++;
        return json(attempt,202);
      }
      if(url.pathname==='/api/practice/attempts') {
        if(req.method()==='POST'){const data=req.postDataJSON();attempt={...data,id:'take',sentence_text:row.parts[0],start_ms:4000,end_ms:7000,reference_version:'v1',recording_state:data.recording?'pending':'none',created_at:new Date().toISOString()};return json(attempt,201);}
        return json({items:attempt?[attempt]:[],next_offset:null});
      }
      if(url.pathname==='/api/practice/attempts/take/analysis/audio'){
        assert.equal(url.searchParams.get('retain_recording'),'true');assert.ok(attempt.recording);
        learnerUploads++;attempt.recording_state='ready';analysis.state='queued';analysis.error_code='reference_pending';return json({...analysis,result:null});
      }
      if(url.pathname==='/api/practice/attempts/take/recording' && req.method()==='PUT')assert.fail('Recording must share the analysis upload');
      if(url.pathname==='/api/practice/attempts/take/analysis') {
        if(req.method()==='POST'){assert.equal(req.postDataJSON().reference_id,'capture-ref');analysis=analysisFixture(attempt);return json({...analysis,result:null},202);}
        if(allowReference&&analysis)analysis.state='completed';if(reference?.state==='deleted'&&analysis){analysis.result.reference=null;analysis.result.comparison='unavailable';}return json(analysis?{...analysis,result:analysis.state==='completed'?analysis.result:null}:null);
      }
      if(url.pathname==='/api/corpus')return json([]);return json({detail:'Unexpected '+url.pathname},404);
    }
    if(url.origin===origin)return route.continue();return route.fulfill({contentType:'application/javascript',body:''});
  });
  await page.goto(entry,{waitUntil:'domcontentloaded',timeout:60000});
  await page.locator('.shadow-reference-module[data-phase="off"]').waitFor().catch(async error=>{
    console.error({errors,body:await page.locator('body').innerText()});throw error;
  });
  assert.equal(await page.getByText('Checking reference…',{exact:true}).count(),0);
  assert.equal(await page.locator('.shadow-reference-spinner').count(),0,'read-only recovery has no analysis loading state');
  assert.equal(await page.getByText('Uploading reference audio…',{exact:true}).count(),0);
  assert.equal(await page.getByText('Uploading the original audio for analysis.',{exact:true}).count(),0);
  assert.equal(prepares,0);assert.equal(uploads,0,'checking references is read-only');
  await page.locator('.stage-two-audio-settings > summary').click();
  const analysisToggle=page.getByRole('checkbox',{name:'Server analysis',exact:true});
  const retentionToggle=page.getByRole('checkbox',{name:'Keep new recordings in my account for later playback',exact:true});
  assert.equal(await page.locator('.stage-two-audio-settings input[type=checkbox]').count(),2);
  assert.equal(await analysisToggle.isChecked(),true,'server analysis defaults on');
  assert.equal(await retentionToggle.isChecked(),false,'history audio retention stays separately off');
  await analysisToggle.uncheck();
  assert.equal(await page.locator('.shadow-reference-guide').count(),0);
  assert.equal(await retentionToggle.isChecked(),false);
  await analysisToggle.check();
  await page.getByRole('checkbox',{name:'Keep new recordings in my account for later playback',exact:true}).check();
  await page.locator('.shadow-reference-module[data-phase="off"]').waitFor();
  assert.equal(await page.getByText('Checking reference…',{exact:true}).count(),0);
  assert.equal(await page.locator('.shadow-reference-spinner').count(),0,'read-only recovery has no analysis loading state');
  assert.equal(await page.locator('.shadow-reference-guide').count(),0);
  await page.locator('.stage-two-audio-settings > summary').click();
  releaseRecovery();
  await page.locator('.capture-analysis-status').getByRole('alert').waitFor();
  assert.equal(await page.getByText('Play the sentence to capture its reference audio.',{exact:true}).count(),0,
    'failed recovery must not show the idle capture instruction');
  recoveryFails=false;
  await page.locator('.capture-analysis-status').getByRole('button',{name:'Retry reference analysis',exact:true}).click();
  await page.getByText('Reference audio is off',{exact:true}).waitFor();
  assert.equal(prepares,0);assert.equal(uploads,0,'read-only recovery retry must not prepare or upload audio');
  await page.locator('.stage-two-audio-settings > summary').click();
  await page.getByRole('checkbox',{name:'Server analysis',exact:true}).check();
  assert.equal(await page.getByRole('button',{name:'Record sentence',exact:true}).isDisabled(),false);
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('r');
  await page.getByText('Recording your voice',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__micCalls),1,'missing reference allows the record shortcut');
  await page.getByRole('button',{name:'Cancel recording',exact:true}).click();
  await page.getByRole('region',{name:'Sentence practice',exact:true}).screenshot({path:join(artifacts,`reference-guide-${viewport.width}.png`)});
  await page.getByRole('button',{name:'Enable reference audio',exact:true}).click();
  await page.getByText('Click Libitu in Chrome’s toolbar',{exact:true}).waitFor();
  assert.equal(await page.locator('.shadow-reference-spinner').count(),0,'waiting for the toolbar grant is not loading');
  assert.equal(await page.getByRole('button',{name:'Cancel audio setup',exact:true}).isEnabled(),true);
  assert.equal(await page.locator('.shadow-reference-steps').isVisible(),true);
  await page.evaluate(()=>window.__grantReference());
  await page.getByText('Reference queued for analysis…',{exact:true}).waitFor();
  await page.getByText('Reference uploaded. You can record while its analysis finishes.',{exact:true}).first().waitFor();
  assert.equal(uploads,1);assert.equal(prepares,1);
  assert.equal(await page.evaluate(()=>window.__micCalls),1,'reference preparation never starts another microphone');
  assert.equal(await page.getByRole('button',{name:'Record sentence',exact:true}).isDisabled(),false);
  reference.state='partially_completed';
  reference.results=[{sentence_id:row.id,status:'partial',alignment:{status:'unavailable',reason:'reference_alignment_invalid'},prosody:{content:{status:'source_transcript'}}}];
  const guide=page.locator('.shadow-reference-module');
  await guide.getByText('Reference analysis incomplete',{exact:true}).waitFor();
  assert.match(await guide.textContent(),/Reference audio is uploaded.*timing and coverage checks/);
  assert.equal(await guide.locator('.shadow-reference-consent').count(),0,'uploaded reference must not request upload again');
  assert.equal(await page.getByRole('button',{name:'Record sentence',exact:true}).isDisabled(),false);
  await page.locator('.shadow-reference-module').getByText('Reference analysis incomplete',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await guide.screenshot({path:join(artifacts,`reference-incomplete-${viewport.width}.png`)});
  await guide.getByRole('button',{name:'Retry reference analysis',exact:true}).click();
  await page.getByText('Reference queued for analysis…',{exact:true}).waitFor();
  assert.equal(uploads,1,'retry analysis reuses uploaded audio');
  assert.equal(prepares,1,'retry analysis does not acquire another reference');
  await page.getByRole('button',{name:'Record sentence',exact:true}).click();
  await page.getByText('Recording your voice',{exact:true}).waitFor();await page.waitForTimeout(2000);
  await page.waitForFunction(()=>[...document.querySelectorAll('.shadow-recording-waveform rect')].some(bar=>Number(bar.getAttribute('height'))>2));
  await page.getByRole('button',{name:'Stop recording',exact:true}).click();
  await page.getByText(/Waiting for reference analysis/).waitFor();
  assert.equal(learnerUploads,1,'analysis and recording retention use one browser upload');
  allowReference=true;
  await page.getByText('Analysis saved. Available evidence appears in the three layers.',{exact:true}).waitFor();
  for(const layer of ['Sound','Rhythm','Melody']) {
    await page.getByRole('tab',{name:layer,exact:true}).click();
    const panel=page.getByRole('region',{name:`Saved ${layer.toLowerCase()} word comparison`,exact:true});
    await panel.waitFor();
    if(layer==='Sound') {
      assert.ok(await panel.locator('.paired-reference .sound-link').count()>0);
      assert.ok(await panel.locator('.paired-reference .sound-word-flow [data-phenomenon="weak_form"]').count()>0);
      assert.equal(await panel.locator('.sound-word-flow [data-evidence="measured"]').count(),0,'All keeps the reference text free of measurement badges');
      assert.equal(await panel.locator('.sound-boundary-pause').count(),0);
      await panel.getByRole('button',{name:'Vowel len.',exact:true}).click();
      assert.ok(await panel.locator('.sound-word-flow [data-evidence="measured"]').count()>0,'measurements remain available in their filter');
      await panel.getByRole('button',{name:'Linking',exact:true}).click();
      assert.ok(await panel.locator('.sound-boundary-pause').count()>0,'pause measurements remain available under Linking');
      await panel.getByRole('button',{name:'All',exact:true}).click();
      assert.equal(await panel.locator('.sound-word-flow [data-evidence="measured"]').count(),0);
    }
    if(layer==='Melody'){assert.equal(await panel.locator('svg').count(),1);assert.equal(await panel.locator('.comparison-word-slot').count(),5);assert.ok(await panel.locator('.paired-reference-trace circle').count()>0);assert.ok(await panel.locator('.paired-learner-trace circle').count()>0);}
    else assert.equal(await panel.locator('.comparison-voice').count(),2);
    assert.equal(await panel.locator('.paired-score,.paired-filters').count(),0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await panel.screenshot({path:join(artifacts,`browser-${layer.toLowerCase()}-${viewport.width}.png`)});
  }
  await page.getByRole('checkbox',{name:'Server analysis',exact:true}).uncheck();
  assert.equal(await page.locator('.practice-save-banner').count(),0,'all uploads finish before refreshing');await page.reload({waitUntil:'domcontentloaded',timeout:60000});await page.getByText('Reference audio ready',{exact:true}).waitFor();
  assert.equal(await page.locator('.shadow-reference-module').getAttribute('data-phase'),'ready');
  assert.equal(await page.locator('.shadow-reference-module').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(225, 245, 238)');
  await page.locator('.shadow-reference-module').screenshot({path:`${artifacts}/reference-ready-${viewport.width}.png`});
  await page.getByText('Analysis saved. Available evidence appears in the three layers.',{exact:true}).waitFor();
  assert.equal(uploads,1,'refresh and opt-out never upload again');
  await page.locator('.stage-two-audio-settings > summary').click();
  assert.equal(await analysisToggle.isChecked(),false,'off persists after refresh');
  assert.equal(await page.locator('.shadow-reference-guide').count(),0);
  await analysisToggle.check();
  assert.equal(await retentionToggle.isChecked(),false,'analysis never enables historical audio retention');
  await page.locator('.stage-two-audio-settings > summary').click();
  await page.locator('.shadow-reference-manage summary').click();
  await page.getByRole('button',{name:'Delete captured reference',exact:true}).click();await page.getByText('Reference deleted.',{exact:true}).first().waitFor();
  assert.equal(await page.getByRole('button',{name:'Record sentence',exact:true}).isDisabled(),false,'deleted reference does not block learner-only recording');
  await page.getByRole('tab',{name:'Melody',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.paired-reference-trace circle').length===0);
  await page.locator('.stage-two-audio-settings > summary').click();
  await analysisToggle.uncheck();fileMode=true;
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.stage-two-audio-settings > summary').click();
  assert.equal(await analysisToggle.isChecked(),false);
  assert.equal(filePrepares,0,'off must not automatically create registered-file analysis');
  await analysisToggle.check();
  await page.getByLabel('Registered reference file').waitFor();
  assert.equal(filePrepares,1);
  await analysisToggle.uncheck();
  assert.equal(await page.getByLabel('Registered reference file').isDisabled(),true);
  assert.equal(filePrepares,1,'disabling analysis only reads the existing reference');
  assert.deepEqual(errors,[]);await context.close();
 }
 console.log(`PASS: browser capture -> WAV upload -> pending bound take -> dual comparisons -> refresh -> delete, desktop/mobile. Screenshots: ${artifacts}`);
}finally{await browser.close();}
