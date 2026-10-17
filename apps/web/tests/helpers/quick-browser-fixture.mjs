// Local-only browser QA harness. No real account, microphone, provider, or database.
// Start Next dev, then: node apps/web/tests/helpers/quick-browser-fixture.mjs
// Open http://127.0.0.1:3011/practice/aa000000-0000-4000-8000-000000000044/shadow?segmentId=quick-segment
import http from 'node:http';
const content='aa000000-0000-4000-8000-000000000044';
const texts=['We practice speaking every day.','Yes.','We keep going together now.','This longer sentence gives us time to practice speaking slowly.'];
const bounds=[[1000,4000],[4000,5000],[5000,9000],[9000,54000]];
const blueprint={id:'quick-blueprint',content_id:content,title:'Quick shadowing fixture',source_url:'https://www.youtube.com/watch?v=practice123',summary:'Local fixture.',chapters:[],logic_flow:[],corpus_items:[],scenario_suggestions:[],
 transcript:texts.map((text,i)=>({id:`sentence-v2-quick-${i}`,time:`0:0${i+1}`,parts:[text],start_ms:bounds[i][0],end_ms:bounds[i][1],source_token_start:i*10,source_token_end:i*10+text.split(' ').length,segmentation_version:'sentence-v2',boundary_source:'syntax_merge',boundary_confidence:'medium'})),
 segments:[{id:'quick-segment',sequence:1,title:'Practice with a steady rhythm',summary:'Practice.',start_ms:1000,end_ms:54000,transcript_start_index:0,transcript_end_index:4,phonology_tags:[]}]};
function bootstrap(blueprint) {
 const owner='quick-browser-fixture';
 localStorage.setItem(`libitu:server-analysis:v1:${owner}`,'on');
 const user={id:owner,organizationMemberships:[]};
 const session={id:'fixture',user,status:'active',lastActiveToken:{jwt:{claims:{sub:owner}}},getToken:async()=>`header.${btoa(JSON.stringify({sub:owner}))}.fixture`};
 const resources={user,session,client:{sessions:[session]},organization:null};
 window.Clerk={loaded:true,...resources,__internal_lastEmittedResources:resources,telemetry:{record(){}},__internal_environment:{},load:async()=>{},addListener(cb,options){if(!options?.skipInitialEmit)cb(resources);return()=>{};},mountUserButton(){},unmountUserButton(){},__internal_updateProps(){}};
 const flags={deny:false,saveFailure:false,pending:false};
 window.YT={Player:class {
  time=0;rate=1;playing=false;
  constructor(el,{events}){this.events=events;this.timer=setInterval(()=>{if(this.playing)this.time+=.05*this.rate;},50);const node=typeof el==='string'?document.getElementById(el):el;if(node){node.style.cssText='color:white;display:grid;place-items:center;height:100%;font:14px sans-serif';node.textContent='Fixture video · original audio';}queueMicrotask(()=>events.onReady());}
  getCurrentTime(){return this.time;}seekTo(t){this.time=t;}playVideo(){this.playing=true;this.events.onStateChange({data:1});}pauseVideo(){this.playing=false;this.events.onStateChange({data:2});}getPlaybackRate(){return this.rate;}setPlaybackRate(r){this.rate=r;this.events.onPlaybackRateChange?.({data:r});}getAvailablePlaybackRates(){return[.75,1,1.25];}getPlayerState(){return this.playing?1:2;}getDuration(){return 60;}destroy(){clearInterval(this.timer);}mute(){}unMute(){}isMuted(){return false;}
 }};
 navigator.mediaDevices.getUserMedia=async()=>{
  if(flags.deny)throw new DOMException('Fixture denial','NotAllowedError');
  const ctx=new AudioContext(),osc=ctx.createOscillator(),gain=ctx.createGain(),dest=ctx.createMediaStreamDestination();osc.frequency.value=220;gain.gain.value=.1;osc.connect(gain);gain.connect(dest);osc.start();await ctx.resume();
  for(const track of dest.stream.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{stop();void ctx.close();};}return dest.stream;
 };
 const content=blueprint.content_id;
 const job={id:'fixture-job',content_id:content,status:'ready',blueprint_id:blueprint.id,analysis_version:'mvp-v9',processing_stage:'completed',analysis_preview:null,error_message:null};
 const saved=JSON.parse(sessionStorage.getItem('quick-fixture-takes')??'[]');
 const blobs=new Map();
 function analysis(take){
  const words=take.sentence_text.match(/[a-z]+/gi);let offset=0;
  const source_tokens=words.map(word=>{const start=take.sentence_text.indexOf(word,offset);offset=start+word.length;return{display:word,normalized:word.toLowerCase(),start,end:offset};});
  const count=source_tokens.length,matched=take.sentence_id.endsWith('-2')?Math.ceil(count*.7):count;
  const recognized_tokens=source_tokens.map((token,i)=>i<matched?token:{...token,display:'different',normalized:'different'});
  const tier=matched*100>=count*85?'full_85_plus':'partial_60_85';
  const scope=tier==='full_85_plus'?'all_layers':'sound_only';
  const measures=source_tokens.slice(0,matched).map((token,i)=>({text:token.display,source_index:i,recognized_index:i,start_sec:i*.3,end_sec:(i+1)*.3,duration_ms:300,pause_after_ms:0,boundary_pause_ms:0,phones:[{label:'IY1',duration_ms:130}],pitch_curve_st:[0,1,2,1,0]}));
  const voice={content:{status:matched===count?'matched':'mismatch',transcript:recognized_tokens.map(t=>t.display).join(' '),reason:null},alignment_status:'aligned',quality_issues:[],words:measures};
  return{id:take.id,sentence_id:take.sentence_id,state:flags.pending?'processing':'completed',phase:flags.pending?'checking_words':'finished',analysis_version:'practice-gated-v3',analysis_scope:flags.pending?null:scope,created_at:take.created_at,error_code:null,retryable:false,
   word_check:flags.pending?null:{version:'word-match-v1',status:'reliable',reason:null,transcript:voice.content.transcript,source_tokens,recognized_tokens,operations:source_tokens.map((_,i)=>({kind:i<matched?'matched':'substituted',source_index:i,recognized_index:i,source_boundary:null})),matched_count:matched,source_count:count,tier},
   layers:{sound:{state:'partial',reason:'learner_only'},rhythm:{state:scope==='all_layers'?'partial':'locked',reason:'learner_only'},melody:{state:scope==='all_layers'?'partial':'locked',reason:'learner_only'}},result:flags.pending?null:{learner:voice,reference:null,comparison:'unavailable',reason:'reference_unavailable'}};
 }
 const nativeFetch=window.fetch.bind(window);
 window.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input.url??String(input),location.href),path=url.pathname;
  if(!path.startsWith('/api/'))return nativeFetch(input,init);
  const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  if(path===`/api/content/${content}`)return json({content:{content_id:content,kind:'youtube',source_url:blueprint.source_url,title:blueprint.title,language:'en'},processing:{analysis_version:'mvp-v9',blueprint_available:true,job:{...job,attempt_count:1}}});
  if(path===`/api/blueprints/${content}`)return json(blueprint);
  if(path===`/api/jobs/${job.id}`)return json(job);
  if(path.includes('/references/'))return json(path.endsWith('/capability')?{available:false,input_mode:null}:null);
  if(path.endsWith('/sound'))return json({detail:'Dictionary unavailable in this fixture'},404);
  if(path.endsWith('/attempts/progress'))return json({practiced_sentence_ids:[...new Set(saved.map(t=>t.sentence_id))],best_word_matches:{}});
  if(path.endsWith('/attempts/submit')||path==='/api/practice/attempts'&&init?.method==='POST'){
   if(flags.saveFailure)return json({detail:'Fixture upload failure. Retry saves.'},503);
   const input=path.endsWith('/submit')?JSON.parse(init.body.get('metadata')).attempt:JSON.parse(init.body);
   const old=saved.find(t=>t.id===input.client_id);if(old)return json(old,202);
   const sentence=blueprint.transcript.find(s=>s.id===input.sentence_id);
   const take={...input,id:input.client_id,sentence_text:sentence.parts[0],start_ms:sentence.start_ms,end_ms:sentence.end_ms,recording_state:input.recording?'ready':'none',created_at:new Date().toISOString(),reference_version:'fixture',evidence_source:'browser_recording'};
   saved.push(take);if(init.body instanceof FormData)blobs.set(take.id,init.body.get('audio'));sessionStorage.setItem('quick-fixture-takes',JSON.stringify(saved));return json(take,202);
  }
  if(path==='/api/practice/attempts')return json({items:saved.filter(t=>t.sentence_id===url.searchParams.get('sentence_id')).slice().reverse(),next_offset:null});
  if(path.endsWith('/analysis')){const take=saved.find(t=>t.id===path.split('/')[4]);return json(take?analysis(take):null);}
  if(path.endsWith('/recording')){const blob=blobs.get(path.split('/')[4]);return blob?new Response(blob):json({detail:'Fixture audio is no longer in memory'},404);}
  if(path==='/api/corpus')return json([]);
  return json({});
 };
 document.addEventListener('DOMContentLoaded',()=>{
  const bar=document.createElement('div');bar.style.cssText='position:fixed;bottom:0;left:0;z-index:99999;background:#fff8dc;padding:4px;font:11px sans-serif;display:flex;gap:8px';bar.textContent='LOCAL FIXTURE';
  for(const [key,label]of[['deny','Deny microphone'],['saveFailure','Fail saves'],['pending','Hold analysis']]){const button=document.createElement('button');button.textContent=label;button.onclick=()=>{flags[key]=!flags[key];button.textContent=label+(flags[key]?' ON':' OFF');};bar.append(button);}document.body.append(bar);
 });
}
const script=`<script>(${bootstrap.toString()})(${JSON.stringify(blueprint)})</script>`;
http.createServer((req,res)=>{
 const proxy=http.request({hostname:'127.0.0.1',port:3000,path:req.url,method:req.method,headers:{...req.headers,host:req.headers.host,'accept-encoding':'identity'}},upstream=>{
  const chunks=[];upstream.on('data',chunk=>chunks.push(chunk));upstream.on('end',()=>{
   let data=Buffer.concat(chunks);const headers={...upstream.headers};delete headers['content-length'];delete headers['content-security-policy']; if(headers.location)headers.location=headers.location.replace('http://localhost:3000','http://127.0.0.1:3011');
   if(headers['content-type']?.includes('text/html'))data=Buffer.from(data.toString().replace(/<script[^>]*src=["'][^"']*clerk[^"']*["'][^>]*><\/script>/gi,'').replace('<head>','<head>'+script));
   res.writeHead(upstream.statusCode,headers);res.end(data);
  });
 });proxy.on('error',()=>{res.writeHead(502);res.end('Start Next dev first.');});req.pipe(proxy);
}).listen(3011,'127.0.0.1',()=>console.log('Quick fixture: http://127.0.0.1:3011/practice/'+content+'/shadow?segmentId=quick-segment'));
