import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {installSignedInPractice} from './helpers/signed-in-practice.mjs';
import {contentContextFixture} from './helpers/content-context-fixture.mjs';
import {practiceTokens} from '../features/stage-two/practice/flow.ts';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.LIBITU_PLAYWRIGHT_MODULE??'playwright');
const origin=process.env.LIBITU_TEST_URL??'http://localhost:3000';
const output=process.env.LIBITU_ARTIFACTS??'/tmp/libitu-stage4-practice';await mkdir(output,{recursive:true});
const content='aa000000-0000-4000-8000-000000000044';
const texts=['We practice speaking every day.','Yes.','We keep going together now.'];
const blueprint={id:'practice-blueprint',content_id:content,title:'Practice flow',source_url:'https://www.youtube.com/watch?v=practice123',summary:'Practice.',chapters:[],logic_flow:[],corpus_items:[],scenario_suggestions:[],
 transcript:texts.map((text,i)=>({id:`sentence-v2-flow-${i}`,time:`0:0${i*3+1}`,parts:[text],start_ms:i*3000+1000,end_ms:i*3000+4000,source_token_start:i*5,source_token_end:i*5+practiceTokens(text).length,segmentation_version:'sentence-v2',boundary_source:'syntax_merge',boundary_confidence:'medium'})),
 segments:[{id:'flow-segment',sequence:1,title:'Opening',summary:'Practice.',start_ms:1000,end_ms:10000,transcript_start_index:0,transcript_end_index:3,phonology_tags:[]}]};
const job={id:'flow-job',content_id:content,status:'ready',blueprint_id:blueprint.id,analysis_version:'mvp-v9',processing_stage:'completed',analysis_preview:null,error_message:null};
const entry=`${origin}/practice/${content}/shadow?segmentId=flow-segment&sentenceId=${blueprint.transcript[0].id}`;
const wavePath=`${output}/microphone-tone.wav`,wave=Buffer.alloc(44+128000);
wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);
wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(128000,40);
for(let sample=0;sample<64000;sample++)wave.writeInt16LE(Math.round(7000*(.55+.45*Math.sin(sample*2*Math.PI*2/16000)**2)*Math.sin(sample*2*Math.PI*220/16000)),44+sample*2);
await writeFile(wavePath,wave);
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${wavePath}`]});
try {for(const width of [1440,390]){
 const context=await browser.newContext({viewport:{width,height:1000},permissions:['microphone']});const page=await context.newPage();page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await installSignedInPractice(page, {serverAnalysis:true});
 await page.addInitScript(()=>{
  window.__players=[];window.__micCalls=0;window.__referenceActions=[];window.__waveContexts=[];
  const AudioBase=window.AudioContext;window.AudioContext=class extends AudioBase{constructor(...args){super(...args);window.__waveContexts.push(this);}};
  const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=(options)=>{window.__micCalls++;return gum(options);};
  window.YT={Player:class{time=0;rate=1;playing=false;constructor(_el,{events}){this.events=events;window.__players.push(this);window.__player=this;queueMicrotask(()=>events.onReady());}getCurrentTime(){return this.time;}seekTo(t){this.time=t;}playVideo(){this.playing=true;this.events.onStateChange({data:1});}pauseVideo(){this.playing=false;this.events.onStateChange({data:2});}getPlaybackRate(){return this.rate;}getAvailablePlaybackRates(){return [.5,.75,1,1.25];}setPlaybackRate(rate){this.rate=rate;this.events.onPlaybackRateChange?.({data:rate});}destroy(){this.playing=false;}}};
  const post=data=>window.postMessage({type:'LIBITU_BUFFER_EVENT',version:4,...data},location.origin);
  window.addEventListener('message',({data})=>{if(data?.type!=='LIBITU_BUFFER_REQUEST')return;window.__referenceActions.push(data.action);
   const reply={sessionId:data.sessionId,requestId:data.requestId};if(data.action==='ping')post({...reply,status:'available'});
   if(data.action==='arm'){post({...reply,status:'armed'});setTimeout(()=>post({...reply,status:'enabled'}),100);}
  });
 });
 const reference={id:'flow-reference',content_id:content,segment_id:'flow-segment',source_kind:'browser_capture',start_ms:1000,end_ms:4000,state:'queued',audio_ready:false,results:[],expires_at:'2099-01-01T00:00:00Z'};
 const takes=[],analyses=new Map();let feedbacks=0,analysisCount=0,analysisStage='complete';
 function analysis(take){
  const source_tokens=practiceTokens(take.sentence_text),matched=[2,3,5][Math.min(analysisCount++,2)];
  const recognized_tokens=source_tokens.map((t,i)=>({...t,normalized:i<matched?t.normalized:`different${i}`,display:i<matched?t.display:`different${i}`}));
  const tier=matched<3?'below_60':matched<5?'partial_60_85':'full_85_plus';const scope=tier==='below_60'?'none':tier==='partial_60_85'?'sound_only':'all_layers';
  const operations=source_tokens.map((_,i)=>({kind:i<matched?'matched':'substituted',source_index:i,recognized_index:i,source_boundary:null}));
  const words=recognized_tokens.map((t,i)=>({text:t.display,source_index:i<matched?i:null,recognized_index:i,start_sec:i*.2,end_sec:(i+1)*.2,duration_ms:200,phones:[{label:'IY1',duration_ms:90}],boundary_pause_ms:0,pitch_curve_st:scope==='all_layers'?[1,0,null,-1,-2]:[]}));
  const voice={content:{status:matched===5?'matched':'mismatch',transcript:recognized_tokens.map(t=>t.display).join(' '),reason:null},alignment_status:scope==='none'?'not_run':'aligned',quality_issues:[],words:scope==='none'?[]:words};
  return {id:take.id,sentence_id:take.sentence_id,state:'completed',phase:'finished',analysis_version:'practice-gated-v3',analysis_scope:scope,created_at:new Date().toISOString(),error_code:null,retryable:false,
   word_check:{version:'word-match-v1',status:'reliable',reason:null,transcript:voice.content.transcript,source_tokens,recognized_tokens,operations,matched_count:matched,source_count:5,tier},
   layers:{sound:{state:scope==='none'?'locked':'partial',reason:null},rhythm:{state:scope==='all_layers'?'partial':'locked',reason:null},melody:{state:scope==='all_layers'?'partial':'locked',reason:null}},
   result:{learner:voice,reference:null,comparison:'unavailable',reason:'reference_unavailable'}};
 }
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;const headers={'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS'};
  const json=(value,status=200)=>route.fulfill({json:value,status,headers});if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
  if(path===`/api/content/${content}`)return json(contentContextFixture(blueprint,job));
  if(path===`/api/jobs/${job.id}`)return json(job);
  if(path===`/api/blueprints/${content}`)return json(blueprint);
  if(path.endsWith('/sound'))return json({detail:'Guide unavailable in this fixture'},404);
  if(path==='/api/corpus')return json([]);
  if(path==='/api/references/capability')return json({available:false,input_mode:null});
  if(path==='/api/references/captures/latest')return json(reference);
  if(path==='/api/references/flow-reference')return json(reference);
  if(path.startsWith('/api/profile/videos/')||path.includes('/visits')||path.endsWith('/visit'))return json({});
  if(path==='/api/practice/attempts/progress'){
   const best_word_matches={};for(const a of analyses.values()){const check=a.word_check;if(check?.status!=='reliable'||a.state==='deleted')continue;
    const prev=best_word_matches[a.sentence_id];if(!prev||check.matched_count*prev.source_count>prev.matched_count*check.source_count)best_word_matches[a.sentence_id]={matched_count:check.matched_count,source_count:check.source_count};}
   return json({practiced_sentence_ids:[...new Set(takes.map(t=>t.sentence_id))],best_word_matches});
  }
  if(path==='/api/practice/attempts/submit'){
   const form=await new Response(req.postDataBuffer(),{headers:{'content-type':req.headers()['content-type']}}).formData();
   const {attempt:input,analysis:request}=JSON.parse(form.get('metadata'));
   assert.equal(request.reference_id,null,'recording without prepared Reference submits learner-only analysis');
   assert.ok(form.get('audio').size>0);
   const sentence=blueprint.transcript.find(s=>s.id===input.sentence_id);
   const take={...input,id:input.client_id,sentence_text:sentence.parts[0],start_ms:sentence.start_ms,end_ms:sentence.end_ms,recording_state:'none',created_at:new Date().toISOString(),reference_version:'fixture',evidence_source:'browser_recording'};
   takes.push(take);analyses.set(take.id,analysis(take));return json(take,202);
  }
  if(path==='/api/practice/attempts'){
   if(req.method()==='GET')return json({items:takes.filter(t=>t.sentence_id===url.searchParams.get('sentence_id')).slice().reverse(),next_offset:null});
   const input=req.postDataJSON(),sentence=blueprint.transcript.find(s=>s.id===input.sentence_id);const take={...input,id:input.client_id,sentence_text:sentence.parts[0],start_ms:sentence.start_ms,end_ms:sentence.end_ms,recording_state:'none',created_at:new Date().toISOString(),reference_version:'fixture',evidence_source:'browser_recording'};takes.push(take);return json(take,201);
  }
  const id=path.split('/')[4];
  if(path.endsWith('/recognition-feedback')){const a=analyses.get(id);feedbacks++;a.recognition_feedback??={kind:'recognition_error',created_at:new Date().toISOString()};return json(a.recognition_feedback);}
  if(path.endsWith('/analysis/audio')){const a=analysis(takes.find(t=>t.id===id));analyses.set(id,a);return json(a);}
  if(path.endsWith('/analysis')){
   if(req.method()==='GET'){
    const a=analyses.get(id);if(!a||a.state!=='completed'||analysisStage==='complete')return json(a??null);
    if(analysisStage==='coarse'){
     const signal={version:'server-prominence-v1',boundary_source:'asr_word',duration_evaluated:false,duration_sec:1,time_step_sec:.05,
      pitch_st:[0,1,2,1,null,null,-1,-2,-1,0,1,2,1,0,null,1,2,1,0,0],prominence:[0,.2,.3,.5,.2,0,.1,.4,.5,.3,.1,0,.2,.5,.3,.1,0,.1,.2,0],
      words:a.word_check.source_tokens.map((t,i)=>({text:t.display,source_index:i,value:.1+i*.12,uncertain:i%2===0})),reasons:['duration_not_evaluated']};
     return json({...a,state:'processing',phase:'coarse_ready',result:null,coarse:{learner:signal,reference:null},
      layers:{sound:{state:'pending',reason:null},rhythm:{state:'partial',reason:'preliminary'},melody:{state:'partial',reason:'preliminary'}}});
    }
    if(analysisStage==='checking')return json({...a,state:'processing',phase:'checking_words',word_check:null,analysis_scope:null,layers:null,result:null});
    return json({...a,state:'processing',phase:'analyzing_sound',result:null,layers:{...a.layers,sound:{state:'pending',reason:null}}});
   }
   if(req.method()==='DELETE'){const a=analyses.get(id);a.state='deleted';a.word_check=null;a.result=null;return json(a);}
   if(req.method()==='POST'){const a={id,sentence_id:takes.find(t=>t.id===id).sentence_id,state:'awaiting_upload',analysis_version:'practice-gated-v3',result:null};analyses.set(id,a);return json(a,202);}
  }
  return json({detail:`Unexpected fixture endpoint ${path}`},404);
 });
 await page.goto(entry,{waitUntil:'domcontentloaded',timeout:90000});try{await page.locator('.shadow-practice-prompt').waitFor();}catch(error){await page.screenshot({path:`${output}/failed-initial-${width}.png`,fullPage:true});throw error;}
 assert.equal(await page.locator('.stage-two-layers').count(),0,'layers hidden before recording');
 assert.equal(await page.locator('.shadow-word-mask').count(),5);assert.equal(await page.locator('.stage-two-sentences').getByText(texts[0],{exact:true}).count(),1);
 assert.equal(await page.locator('.stage-two-record-start').evaluate(el=>getComputedStyle(el).borderRadius),'999px');
 assert.equal(await page.locator('.stage-two-record-start').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(0, 0, 0)');
 for(const text of ['Try another take, or move to the next sentence.','Sentence timings are approximate.','Listen first, then record your voice.'])assert.equal(await page.getByText(text,{exact:true}).count(),0);
 const originalUrl=page.url();
 await page.getByRole('button',{name:'Collapse sentence list',exact:true}).click();
 await page.waitForFunction(()=>Math.abs(document.querySelector('.stage-two-sentences').getBoundingClientRect().width-56)<1);
 assert.equal(await page.locator('.stage-two-sentences ol button').first().innerText(),'1');assert.equal(page.url(),originalUrl);
 await page.screenshot({path:`${output}/collapsed-${width}.png`,fullPage:true});
 await page.locator('.stage-two-sentences ol button').last().click();await page.locator('.stage-two-sentences ol button').first().click();
 await page.getByRole('button',{name:'Expand sentence list',exact:true}).click();
 await page.locator('.shadow-practice-settings summary').click();
 await page.getByRole('button',{name:'Playback speed 0.75×',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Playback speed 0.75×',exact:true}).getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'Playback speed 1×',exact:true}).click();
 await page.getByRole('button',{name:'Key words',exact:true}).click();await page.getByRole('button',{name:'Hidden',exact:true}).click();
 await page.getByLabel('Loop the sentence',{exact:true}).uncheck();await page.getByLabel('Loop the sentence',{exact:true}).check();
 await page.getByRole('combobox',{name:'Playback range',exact:true}).click();await page.getByRole('option',{name:'Whole segment',exact:true}).click();
 assert.equal(await page.locator('.shadow-practice-settings').evaluate(el=>el.open),true,'portal range selection keeps settings open');
 await page.getByRole('combobox',{name:'Playback range',exact:true}).click();await page.getByRole('option',{name:'Sentence',exact:true}).click();
 await page.getByRole('option',{name:'Sentence',exact:true}).waitFor({state:'hidden'});
 await page.screenshot({path:`${output}/settings-${width}.png`,fullPage:true});
 await page.keyboard.press('Escape');assert.equal(await page.locator('.shadow-practice-settings').evaluate(el=>el.open),false);
 await page.screenshot({path:`${output}/initial-${width}.png`,fullPage:true});
 assert.equal(await page.evaluate(()=>window.__micCalls),0);
 assert.equal(await page.getByRole('button',{name:'Record sentence',exact:true}).isEnabled(),true,'recording works before reference setup');
 await page.getByRole('button',{name:'Listen',exact:true}).click();assert.equal(await page.evaluate(()=>window.__micCalls),0,'listening cannot request microphone');
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 await page.getByRole('button',{name:'Enable reference audio',exact:true}).click();await page.getByText('Preparing reference audio…',{exact:true}).first().waitFor();
 assert.equal(await page.evaluate(()=>window.__referenceActions.filter(a=>a==='arm').length),1);
 await page.getByRole('button',{name:'Prepare this sentence at 1×',exact:true}).click();await page.getByRole('progressbar',{name:'Reference preparation progress'}).waitFor();
 await page.screenshot({path:`${output}/preparing-${width}.png`,fullPage:true});
 await page.getByRole('button',{name:'Cancel preparation',exact:true}).click();
 await page.getByRole('button',{name:'Reveal word 1',exact:true}).click();
 await page.locator('.stage-two-audio-settings summary').click();await page.getByLabel('Server analysis').check();
 await page.locator('.stage-two-audio-settings summary').click();
 assert.equal(await page.getByRole('button',{name:'Record sentence',exact:true}).isDisabled(),false,'unprepared Reference must not block recording');
 async function record(again=false){if(await page.locator('.shadow-practice-settings').evaluate(el=>el.open))await page.keyboard.press('Escape');await page.getByRole('button',{name:again?'Record again':'Record sentence',exact:true}).click();await page.getByText('Recording your voice',{exact:true}).waitFor();await page.waitForTimeout(400);await page.getByRole('button',{name:'Stop recording',exact:true}).click();await page.locator('.shadow-word-differences').waitFor();}
 analysisStage='checking';
 await page.getByRole('button',{name:'Record sentence',exact:true}).click();await page.getByText('Recording your voice',{exact:true}).waitFor();assert.equal(await page.locator('.stage-two-layers').count(),0,'layers hidden during recording');await page.getByRole('button',{name:'Reveal word 2',exact:true}).click();await page.waitForTimeout(600);
 await page.waitForFunction(()=>document.querySelector('.shadow-recording-waveform')?.dataset.active==='true');
 assert.equal(await page.evaluate(()=>window.__micCalls),1,'waveform shares the recording microphone');
 assert.equal(await page.locator('.shadow-recording-waveform rect').count(),16);
 assert.equal(await page.locator('.shadow-recording-waveform').evaluate(el=>el.getBoundingClientRect().width),96);
 await page.waitForFunction(()=>[...document.querySelectorAll('.shadow-recording-waveform rect')].some(bar=>Number(bar.getAttribute('height'))>2));
 assert.equal(await page.locator('.stage-two-record-stop').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(163, 55, 43)');
 await page.waitForFunction(()=>Math.abs(document.querySelector('.stage-two-sentences').getBoundingClientRect().width-56)<1);
 assert.equal(await page.getByRole('button',{name:'Expand sentence list',exact:true}).isDisabled(),true);
 assert.equal(await page.locator('.shadow-directory-text').first().isVisible(),false);
 const centers=await page.evaluate(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect();const area=rect('.shadow-practice-actions'), wave=rect('.shadow-recording-waveform');
  const controls=[...document.querySelectorAll('.shadow-practice-actions button')].filter(el=>el.getBoundingClientRect().width).map(el=>el.getBoundingClientRect());
  return {area:area.x+area.width/2,wave:wave.x+wave.width/2,buttons:(Math.min(...controls.map(r=>r.x))+Math.max(...controls.map(r=>r.right)))/2};});
 assert.ok(Math.abs(centers.area-centers.wave)<1,'wave centered in practice workspace');
 assert.ok(Math.abs(centers.area-centers.buttons)<1,'controls centered as a group');
 await page.screenshot({path:`${output}/recording-${width}.png`,fullPage:true});
 await page.getByRole('button',{name:'Stop recording',exact:true}).click();
 await page.getByText('Checking spoken words…',{exact:true}).waitFor();
 assert.equal(await page.locator('.stage-two-layers').count(),0,'layers hidden until word check completes');
 await page.screenshot({path:`${output}/checking-${width}.png`,fullPage:true});
 analysisStage='complete';await page.getByText('40% of words matched',{exact:false}).waitFor();
 await page.waitForFunction(()=>window.__waveContexts.every(context=>context.state==='closed'));
 await page.locator('.shadow-directory-status').first().filter({hasText:'Best 40% words'}).waitFor();
 assert.equal(await page.locator('.shadow-directory-text').first().isVisible(),true);
 assert.equal(await page.locator('.shadow-recording-waveform').count(),0);
 assert.deepEqual(takes[0].text_support.visible_source_indices_at_start,[0]);assert.deepEqual(takes[0].text_support.revealed_source_indices,[0,1]);
 for(const label of ['Sound','Rhythm','Melody'])assert.equal(await page.getByRole('tab',{name:label,exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Recognition error',exact:true}).click();await page.getByText('Recognition error marked.',{exact:false}).waitFor();assert.equal(feedbacks,1);assert.equal(analyses.get(takes[0].id).word_check.tier,'below_60');
 await page.locator('.shadow-practice-settings summary').click();await page.getByRole('button',{name:'Hidden',exact:true}).click();
 analysisStage='analyzing';await record(true);await page.getByText('60% of words matched',{exact:false}).waitFor();
 assert.equal(await page.getByRole('tab',{name:'Sound',exact:true}).locator('.paired-tab-badge').innerText(),'…');
 assert.equal(await page.locator('.layer-comparison').count(),0,'pending analysis cannot show unfinished or old graphs');
 await page.screenshot({path:`${output}/analyzing-${width}.png`,fullPage:true});
 analysisStage='complete';
 await page.locator('.sound-reveal-bar').waitFor();
 assert.deepEqual(await page.locator('.stage-two-layer-tabs .paired-tab-badge').allTextContents(),['✓*','🔒','🔒']);
 assert.equal(await page.getByRole('tab',{name:'Sound',exact:true}).locator('.paired-tab-badge').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(252, 235, 235)');
 assert.equal(await page.getByRole('tab',{name:'Sound',exact:true}).evaluate(el=>getComputedStyle(el).minHeight),'52px');
 await page.getByRole('button',{name:'Hide text',exact:true}).click();
 assert.ok(await page.locator('.sound-word-flow .comparison-peek').count()>0);
 await page.getByRole('button',{name:'Reveal all',exact:true}).click();
 assert.equal(await page.locator('.sound-word-flow .comparison-peek').count(),0);
 assert.equal(await page.getByRole('tab',{name:'Sound',exact:true}).isDisabled(),false);assert.equal(await page.getByRole('tab',{name:'Rhythm',exact:true}).isDisabled(),true);
 await page.locator('.stage-two-layers').scrollIntoViewIfNeeded();
 await page.locator('.stage-two-layers').screenshot({path:`${output}/partial-${width}.png`});
 analysisStage='coarse';await record(true);
 await page.getByRole('tab',{name:'Rhythm',exact:true}).click();await page.getByText('Analyzing your Rhythm… You can keep practicing.',{exact:true}).waitFor();
 assert.deepEqual(await page.locator('.stage-two-layer-tabs .paired-tab-badge').allTextContents(),['…','…','…']);
 assert.equal(await page.getByRole('region',{name:/Preliminary/}).count(),0,'coarse curves are not shown');
 await page.locator('.stage-two-layers').screenshot({path:`${output}/pending-rhythm-${width}.png`});
 await page.getByRole('tab',{name:'Melody',exact:true}).click();await page.getByText('Analyzing your Melody… You can keep practicing.',{exact:true}).waitFor();
 await page.locator('.stage-two-layers').screenshot({path:`${output}/pending-melody-${width}.png`});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 analysisStage='complete';await page.getByRole('region',{name:'Pitch chart and aligned text',exact:true}).waitFor();
 await page.getByText('100% of words matched',{exact:false}).waitFor();assert.equal(await page.getByRole('tab',{name:'Melody',exact:true}).isDisabled(),false);await page.getByRole('tab',{name:'Melody',exact:true}).click();await page.getByRole('region',{name:'Pitch chart and aligned text',exact:true}).waitFor();
 assert.deepEqual(await page.locator('.stage-two-layer-tabs .paired-tab-badge').allTextContents(),['✓','✓','✓']);
 assert.equal(await page.evaluate(()=>window.__players.length),1,'folding and recording keep one source player');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.locator('.shadow-directory-status').first().filter({hasText:'Passed · Best 100% words'}).waitFor();
 await page.locator('.stage-two-layers').scrollIntoViewIfNeeded();
 await page.locator('.stage-two-layers').screenshot({path:`${output}/full-${width}.png`});
 await page.getByRole('button',{name:'Record again',exact:true}).click();await page.getByText('Recording your voice',{exact:true}).waitFor();
 assert.equal(await page.locator('.stage-two-layers').count(),0,'replacement recording hides previous evidence');
 await page.getByRole('button',{name:'Cancel recording',exact:true}).click();await page.getByText('100% of words matched',{exact:false}).waitFor();
 assert.deepEqual(await page.locator('.stage-two-layer-tabs .paired-tab-badge').allTextContents(),['✓','✓','✓'],'cancel restores selected take');
 await page.getByRole('button',{name:'Next sentence',exact:true}).click();assert.equal(new URL(page.url()).searchParams.get('sentenceId'),blueprint.transcript[2].id,'navigation skips one-word sentence');
 await page.locator('.stage-two-sentences ol button').first().click();await page.locator('.shadow-word-differences').waitFor();
 await page.getByRole('button',{name:'View analysis',exact:true}).last().click();await page.getByText('40% of words matched',{exact:false}).waitFor();assert.equal(await page.getByRole('tab',{name:'Sound',exact:true}).isDisabled(),true);
 assert.equal(await page.locator('.stage-two-sentences ol button').first().getAttribute('data-passed'),'true','viewing a lower historical take does not lower the best');
 await page.reload({waitUntil:'domcontentloaded'});await page.locator('.shadow-directory-status').first().filter({hasText:'Passed · Best 100% words'}).waitFor();
 await page.getByRole('button',{name:'Delete analysis',exact:true}).click();
 await page.locator('.shadow-directory-status').first().filter({hasText:'Not passed · Best 60% words'}).waitFor();
 assert.equal(await page.locator('.stage-two-layers').count(),0,'deleted analysis hides layers');
 assert.equal(await page.locator('.stage-two-sentences ol button').first().getAttribute('data-practiced'),'true','analysis deletion keeps practiced but recomputes maximum');
 assert.deepEqual(errors,[]);await context.close();
 console.log(`Practice flow passed at ${width}px`);
 }}finally{await browser.close();}
console.log(`Screenshots: ${output}`);
