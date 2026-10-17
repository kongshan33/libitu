import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {installSignedInPractice} from './helpers/signed-in-practice.mjs';
import {contentContextFixture} from './helpers/content-context-fixture.mjs';
import {practiceTokens} from '../features/stage-two/practice/flow.ts';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.LIBITU_PLAYWRIGHT_MODULE??'playwright');
const origin=process.env.LIBITU_TEST_URL??'http://localhost:3000';
const output=process.env.LIBITU_ARTIFACTS??'/tmp/libitu-stage5-history';await mkdir(output,{recursive:true});
const content='aa000000-0000-4000-8000-000000000055';
const texts=['We practice speaking every day.','Yes.','Keep going together now.','I am here.','All right.','Let us go.'];
const blueprint={id:'directory-blueprint',content_id:content,title:'History and navigation',source_url:'https://www.youtube.com/watch?v=history1234',summary:'Practice.',chapters:[],logic_flow:[],corpus_items:[],scenario_suggestions:[],
  transcript:texts.map((text,i)=>({id:`sentence-v2-directory-${i}`,time:`0:${String(i*3+1).padStart(2,'0')}`,parts:[text],start_ms:i*3000+1000,end_ms:i*3000+4000,source_token_start:i*5,source_token_end:i*5+practiceTokens(text).length,segmentation_version:'sentence-v2',boundary_source:'syntax_merge',boundary_confidence:'medium'})),
  segments:[{id:'directory-segment',sequence:1,title:'Opening',summary:'Practice.',start_ms:1000,end_ms:13000,transcript_start_index:0,transcript_end_index:4,phonology_tags:[]},
    {id:'short-segment',sequence:2,title:'Short sentences',summary:'Practice.',start_ms:13000,end_ms:19000,transcript_start_index:4,transcript_end_index:6,phonology_tags:[]}]};
const job={id:'directory-job',content_id:content,status:'ready',blueprint_id:blueprint.id,analysis_version:'mvp-v9',processing_stage:'completed',analysis_preview:null,error_message:null};
const entry=(sentence=blueprint.transcript[0].id,segment='directory-segment')=>`${origin}/practice/${content}/shadow?shadowMode=detailed&segmentId=${segment}${sentence?`&sentenceId=${sentence}`:''}`;
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
try {for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000},permissions:['microphone']});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await installSignedInPractice(page);
  await page.addInitScript(()=>{
    window.__players=[];window.__micCalls=0;window.__playCalls=0;
    const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=(options)=>{window.__micCalls++;return gum(options);};
    window.YT={Player:class{time=0;rate=1;playing=false;
      constructor(_el,{events}){this.events=events;window.__players.push(this);queueMicrotask(()=>events.onReady());}
      getCurrentTime(){return this.time;}seekTo(t){this.time=t;}playVideo(){window.__playCalls++;this.playing=true;this.events.onStateChange({data:1});}
      pauseVideo(){this.playing=false;this.events.onStateChange({data:2});}getPlaybackRate(){return this.rate;}
      getAvailablePlaybackRates(){return [.5,.75,1,1.25];}setPlaybackRate(rate){this.rate=rate;this.events.onPlaybackRateChange?.({data:rate});}destroy(){this.playing=false;}
    }};
    window.addEventListener('message',({data})=>{if(data?.type==='LIBITU_BUFFER_REQUEST'&&data.action==='ping')
      window.postMessage({type:'LIBITU_BUFFER_EVENT',version:4,sessionId:data.sessionId,requestId:data.requestId,status:'available'},location.origin);});
  });
  let failProgress=true,holdCreate=false,releaseCreate=null,failedHistory=false;
  const takes=[],analysisReads=[];
  function take(sentence,index){const source=blueprint.transcript[sentence];return {
    id:`bb000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,content_id:content,sentence_id:source.id,sentence_text:source.parts[0],
    start_ms:source.start_ms,end_ms:source.end_ms,reference_version:'fixture',duration_ms:400,playback_rate:1,text_visible:false,
    text_support:{version:'text-support-v1',mode:'hidden',visible_source_indices_at_start:[],revealed_source_indices:[]},
    recording_state:'ready',created_at:new Date(Date.UTC(2026,9,12,0,0,index)).toISOString(),evidence_source:'browser_recording'};}
  for(let i=0;i<25;i++)takes.push(take(0,i));takes.push(take(2,25));
  const audio=Buffer.alloc(44+1600);audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);
  audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(16000,24);audio.writeUInt32LE(32000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(1600,40);
  await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname;
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS'};
    const json=(value,status=200)=>route.fulfill({json:value,status,headers});
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
    if(path===`/api/content/${content}`)return json(contentContextFixture(blueprint,job));
    if(path===`/api/jobs/${job.id}`)return json(job);
    if(path===`/api/blueprints/${content}`)return json(blueprint);
    if(path.endsWith('/sound'))return json({detail:'Guide unavailable in this fixture'},404);
    if(path==='/api/corpus')return json([]);
    if(path==='/api/references/capability')return json({available:false,input_mode:null});
    if(path==='/api/references/captures/latest')return json(null);
    if(path.startsWith('/api/profile/videos/'))return json({});
    if(path==='/api/practice/attempts/progress')return failProgress?json({detail:'Progress temporarily unavailable'},503):json({practiced_sentence_ids:[...new Set(takes.map(t=>t.sentence_id))]});
    if(path==='/api/practice/attempts'){
      if(req.method()==='GET'){
        if(failedHistory)return json({detail:'History temporarily unavailable'},503);
        const rows=takes.filter(t=>t.sentence_id===url.searchParams.get('sentence_id')).slice().reverse(),offset=Number(url.searchParams.get('offset')??0);
        return json({items:rows.slice(offset,offset+20),next_offset:offset+20<rows.length?offset+20:null});
      }
      const input=req.postDataJSON(),source=blueprint.transcript.find(s=>s.id===input.sentence_id);
      const saved={...input,id:input.client_id,sentence_text:source.parts[0],start_ms:source.start_ms,end_ms:source.end_ms,recording_state:'none',created_at:new Date().toISOString(),reference_version:'fixture',evidence_source:'browser_recording'};
      takes.push(saved);
      if(holdCreate)await new Promise(resolve=>{releaseCreate=resolve;});
      return json(saved,201);
    }
    const id=path.split('/')[4],saved=takes.find(t=>t.id===id);
    if(path.endsWith('/analysis')){analysisReads.push(id);return json(null);}
    if(path.endsWith('/recording')){
      if(req.method()==='GET')return route.fulfill({body:audio,contentType:'audio/wav',headers});
      saved.recording_state='deleted';return route.fulfill({status:204,headers});
    }
    if(req.method()==='DELETE'&&saved){takes.splice(takes.indexOf(saved),1);return route.fulfill({status:204,headers});}
    return json({detail:`Unexpected fixture endpoint ${path}`},404);
  });
  const directory=page.locator('.stage-two-sentences ol button');
  const history=page.locator('.practice-history li');
  const selectedRow=()=>page.locator('.practice-history li[data-selected="true"]');
  await page.goto(entry(),{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Retry progress',exact:true}).waitFor();
  failProgress=false;await page.getByRole('button',{name:'Retry progress',exact:true}).click();
  await directory.nth(2).getByText('Practiced',{exact:true}).waitFor();
  assert.equal(await directory.nth(0).getByText('Practiced',{exact:true}).count(),1);
  assert.equal(await history.count(),20);assert.equal(await selectedRow().getByRole('button',{name:'View analysis'}).getAttribute('aria-pressed'),'true');
  for(const text of texts)assert.equal(await page.locator('.stage-two-sentences').getByText(text,{exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>window.__micCalls+window.__playCalls),0);
  await page.getByRole('button',{name:'Load older takes',exact:true}).click();
  await history.last().getByRole('button',{name:'View analysis',exact:true}).waitFor();assert.equal(await history.count(),25);
  await history.last().getByRole('button',{name:'View analysis',exact:true}).click();
  const oldestTime=await selectedRow().locator('time').getAttribute('datetime');
  await selectedRow().getByRole('button',{name:'Load recording',exact:true}).click();await selectedRow().locator('audio').waitFor();
  assert.equal(await selectedRow().locator('audio').evaluate(el=>el.paused),true,'loading history audio does not autoplay');
  await page.getByRole('button',{name:'Next sentence',exact:true}).click();
  assert.equal(new URL(page.url()).searchParams.get('sentenceId'),blueprint.transcript[2].id,'four-word target is eligible');
  assert.equal(await page.getByRole('button',{name:'Next sentence',exact:true}).isDisabled(),true,'trailing three-word sentence is skipped');
  await directory.first().click();await selectedRow().locator('time').waitFor();
  assert.equal(await selectedRow().locator('time').getAttribute('datetime'),oldestTime,'selection survives sentence navigation');
  assert.equal(await history.count(),25,'older selected take is restored beyond page one');
  await page.getByRole('button',{name:'Record sentence',exact:true}).click();await page.getByText('Recording your voice',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Cancel recording',exact:true}).click();
  await page.locator('.shadow-practice-outcome').waitFor();
  assert.equal(await selectedRow().locator('time').getAttribute('datetime'),oldestTime,'canceling a replacement restores historical review');
  assert.equal(takes.length,26,'canceling a capture does not create a practice record');
  await selectedRow().getByRole('button',{name:'Delete saved audio',exact:true}).click();
  await selectedRow().getByText('No retained audio',{exact:true}).waitFor();assert.equal(await directory.first().getByText('Practiced',{exact:true}).count(),1);
  assert.equal(await selectedRow().locator('time').getAttribute('datetime'),oldestTime);
  // Saving finishes after a historical selection. Its acknowledgement must not take over the result.
  holdCreate=true;
  await page.getByRole('button',{name:'Record sentence',exact:true}).click();await page.getByText('Recording your voice',{exact:true}).waitFor();
  await page.waitForTimeout(350);await page.getByRole('button',{name:'Stop recording',exact:true}).click();
  await page.getByText('Saving your take…',{exact:true}).waitFor();
  await history.last().getByRole('button',{name:'View analysis',exact:true}).click();
  while(!releaseCreate)await page.waitForTimeout(10);releaseCreate();holdCreate=false;
  await page.waitForFunction(()=>document.querySelectorAll('.practice-history li').length===26);
  assert.equal(await selectedRow().locator('time').getAttribute('datetime'),oldestTime);
  await selectedRow().getByRole('button',{name:'Delete practice record',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.practice-history li:first-child[data-selected="true"]'));
  assert.notEqual(await selectedRow().locator('time').getAttribute('datetime'),oldestTime);
  assert.equal(await history.count(),25);
  // Deleting the final saved record clears progress; a saved local clip must not keep it marked.
  await directory.nth(2).click();await selectedRow().getByRole('button',{name:'Delete practice record',exact:true}).click();
  await page.locator('.shadow-practice-prompt').waitFor();await directory.nth(2).getByText('4 words',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Record sentence',exact:true}).click();await page.getByText('Recording your voice',{exact:true}).waitFor();
  await page.waitForTimeout(350);await page.getByRole('button',{name:'Stop recording',exact:true}).click();
  await history.first().getByRole('button',{name:'Delete practice record',exact:true}).waitFor();
  await directory.nth(2).getByText('Practiced',{exact:true}).waitFor();
  await history.first().getByRole('button',{name:'Delete practice record',exact:true}).click();
  await page.locator('.shadow-practice-prompt').waitFor();await directory.nth(2).getByText('4 words',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Replay recording',exact:true}).count(),0);
  await directory.nth(1).click();assert.equal(new URL(page.url()).searchParams.get('sentenceId'),blueprint.transcript[1].id,'manual short sentence remains selectable');
  await page.getByRole('button',{name:'Next sentence',exact:true}).click();assert.equal(new URL(page.url()).searchParams.get('sentenceId'),blueprint.transcript[2].id);
  await directory.nth(3).click();assert.equal(new URL(page.url()).searchParams.get('sentenceId'),blueprint.transcript[3].id);
  await page.getByRole('button',{name:'Previous sentence',exact:true}).click();assert.equal(new URL(page.url()).searchParams.get('sentenceId'),blueprint.transcript[2].id);
  await directory.nth(1).focus();await page.keyboard.press('End');assert.equal(new URL(page.url()).searchParams.get('sentenceId'),blueprint.transcript[3].id);
  await page.keyboard.press('Home');assert.equal(new URL(page.url()).searchParams.get('sentenceId'),blueprint.transcript[0].id);
  assert.equal(await page.evaluate(()=>window.__players.length),1,'navigation and folding retain one source player');
  assert.equal(await page.evaluate(()=>window.__playCalls),0,'navigation never autoplays');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:`${output}/history-${width}.png`,fullPage:true});
  // Refresh restores the latest surviving take, while an explicit short URL stays selected.
  await page.reload({waitUntil:'domcontentloaded'});await directory.nth(0).getByText('Practiced',{exact:true}).waitFor();await selectedRow().locator('time').waitFor();
  assert.equal(await selectedRow().locator('time').getAttribute('datetime'),takes.filter(t=>t.sentence_id===blueprint.transcript[0].id).at(-1).created_at);
  failedHistory=true;await directory.nth(2).click();await page.getByRole('button',{name:'Reload history',exact:true}).waitFor();
  failedHistory=false;await page.getByRole('button',{name:'Reload history',exact:true}).click();await page.getByText('No saved takes yet.',{exact:true}).waitFor();
  await page.goto(entry(blueprint.transcript[1].id),{waitUntil:'domcontentloaded'});await directory.nth(1).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('sentenceId'),blueprint.transcript[1].id);
  await page.goto(entry(null,'short-segment'),{waitUntil:'domcontentloaded'});await page.getByText('Select a sentence to practice.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Next sentence',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Previous sentence',exact:true}).isDisabled(),true);
  await page.getByLabel('Skip sentences under 4 words').uncheck();await page.locator('.shadow-practice-prompt').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('sentenceId'),blueprint.transcript[4].id);
  await page.getByRole('button',{name:'Next sentence',exact:true}).click();assert.equal(new URL(page.url()).searchParams.get('sentenceId'),blueprint.transcript[5].id);
  assert.equal(await page.getByRole('button',{name:'Next sentence',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Record sentence',exact:true}).click();await page.getByText('Recording your voice',{exact:true}).waitFor();
  await page.waitForTimeout(350);await page.getByRole('button',{name:'Stop recording',exact:true}).click();
  await page.getByRole('button',{name:'Finish segment',exact:true}).click();
  await page.waitForURL(`**/practice/${content}/segments**`);
  assert.equal(await page.evaluate(()=>window.__players.length),1,'finishing retains the content media host');
  assert.deepEqual(errors,[]);assert.ok(analysisReads.length>0);await context.close();
  console.log(`History/navigation passed at ${width}px`);
}}finally{await browser.close();}
console.log(`Screenshots: ${output}`);
