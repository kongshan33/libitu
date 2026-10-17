// Opt-in real-network benchmark; Python runner supplies public-audio fixtures.
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {installSignedInPractice} from './helpers/signed-in-practice.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.LIBITU_PLAYWRIGHT_MODULE??'playwright');
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true});
const runs=[];
let activeMode;
let observations=[];
try{
 const page=await browser.newPage({viewport:{width:1280,height:1000}});
 await installSignedInPractice(page);
 await page.route('**/api/practice/attempts**',async route=>{
   const req=route.request();
   const headers={'access-control-allow-origin':'*','access-control-allow-headers':'content-type,authorization','access-control-allow-methods':'GET,POST,PUT,OPTIONS'};
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
   const url=new URL(req.url());
   const analysis=url.pathname.match(/\/api\/practice\/attempts\/([^/]+)\/analysis$/);
   const path=activeMode==='serial_read'&&req.method()==='GET'&&analysis?'/benchmark/serial/'+analysis[1]:url.pathname+url.search;
   const response=await route.fetch({url:'http://127.0.0.1:8001'+path,timeout:120000});
   if(req.method()==='GET'&&analysis){const data=await response.json();observations.push({epoch_ms:Date.now(),state:data?.state,phase:data?.phase,coarse_ready:Boolean(data?.coarse),has_result:Boolean(data?.result),layers:data?.layers});}
   return route.fulfill({response,headers:{...response.headers(),...headers}});
 });
 const modes=config.final_results?Array(config.trials).fill('final'):config.compare_reads?['serial_read','snapshot_read','serial_read','snapshot_read','serial_read','snapshot_read']:['legacy','merged','legacy','merged','legacy','merged'];
 for(const mode of modes){
  activeMode=mode;observations=[];
  await page.goto('http://localhost:3000/dev/submission-benchmark',{waitUntil:'networkidle'});
  await page.getByLabel('Fixture configuration').fill(JSON.stringify({...config,mode}));
  await page.evaluate(()=>{
    window.__bench={start:performance.now(),epoch:Date.now(),word:null,coarse:null,final:null};
    const observer=new MutationObserver(()=>{
      for(const [key,selector] of [['word','[data-testid="word-check"]'],['coarse','[data-testid="coarse"]'],['final','[data-testid="final"]']]){
       if(window.__bench[key]===null&&document.querySelector(selector)){
        window.__bench[key]=-1;
        requestAnimationFrame(()=>requestAnimationFrame(()=>window.__bench[key]=performance.now()-window.__bench.start));
       }
      }
    });observer.observe(document.body,{childList:true,subtree:true});
  });
  const requests=[],polls=[];
  const listener=request=>{if(request.method()==='GET'&&request.url().endsWith('/analysis'))polls.push(request);if(request.method()!=='GET'&&request.method()!=='OPTIONS'&&request.url().includes('/api/practice/attempts'))requests.push(request);};
  page.on('request',listener);
  await page.getByLabel('Public audio').setInputFiles(config.audio);
  await page.waitForFunction(final=>window.__bench[final?'final':'coarse']>0||document.querySelector('[data-testid="error"]')?.textContent||['failed','needs_review'].includes(document.querySelector('[data-testid="state"]')?.textContent),config.final_results,{timeout:240000});
  const error=await page.getByTestId('error').textContent();if(error)throw Error(error);
  const timings=await page.evaluate(()=>window.__bench);
  if(config.final_results&&!(timings.final>0))throw Error('Final layer evidence not available: '+await page.getByTestId('state').textContent());
  const network=requests.map(r=>({path:new URL(r.url()).pathname,method:r.method(),...r.timing()}));
  const item={mode,start_epoch_ms:timings.epoch,word_visible_sec:timings.word/1000,coarse_visible_sec:timings.coarse===null?null:timings.coarse/1000,final_visible_sec:timings.final===null?null:timings.final/1000,observations:observations.slice(),
    reference_visible:await page.getByTestId(config.final_results?'final':'coarse').getAttribute('data-reference'),word_check:await page.getByTestId('word-check').textContent(),
    attempt:await page.getByTestId('attempt').textContent(),requests:network,polls:polls.map(r=>({...r.timing()}))};
  runs.push(item);console.log(JSON.stringify(item));await writeFile(config.output,JSON.stringify(runs,null,2));
  await page.screenshot({path:config.output.replace('.json',`-${runs.length}.png`),fullPage:true});
  if(config.final_results){for(const layer of ['Rhythm','Melody']){await page.getByRole('tab',{name:layer,exact:true}).click();await page.screenshot({path:config.output.replace('.json',`-${runs.length}-${layer}.png`),fullPage:true});}}
  await page.waitForFunction(()=>['completed','failed','needs_review'].includes(document.querySelector('[data-testid="state"]')?.textContent),{timeout:180000});
  item.final_state=await page.getByTestId('state').textContent();
  if(item.final_state!=='completed')throw Error('Fine analysis did not complete: '+item.final_state);
  page.off('request',listener);await writeFile(config.output,JSON.stringify(runs,null,2));
 }
}finally{await browser.close();}
