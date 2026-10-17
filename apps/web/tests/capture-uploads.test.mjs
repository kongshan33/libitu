import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureUploads, captureKey } from '../features/stage-two/server-reference/capture-uploads.ts';
const source={contentId:'c',sentenceId:'s',text:'hello',startMs:1000,endMs:2000};
const key=captureKey('c','segment','s');
const clip={blob:new Blob(['wave']),captureId:'capture',startOffsetMs:0,endOffsetMs:1000};
async function until(ready) {
 for(let i=0;i<100;i++) {if(ready())return;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.fail('Timed out waiting for the upload state');
}
function setup(overrides={}) {
 const calls=[];
 const api={latestCapture:async()=>null,prepareCapture:async input=>{calls.push(input);return {id:'r',state:'awaiting_upload'};},
 upload:async()=>({id:'r',state:'completed'}),remove:async()=>{},...overrides};
 return {queue:new CaptureUploads(api,async c=>c.blob),calls};
}
test('capture arriving during restoration is uploaded once and frozen across sentence navigation',async()=>{
 let resume;const {queue,calls}=setup({latestCapture:()=>new Promise(r=>resume=r)});
 const restore=queue.restore('segment',source);queue.enqueue('segment',source,clip);
 assert.equal(queue.get(key).restoring,true,'queued bytes must not turn recovery into uploading');
 assert.equal(calls.length,0);resume(null);await restore;
 assert.equal(queue.get(key).restoring,false);assert.equal(queue.get(key).pending,true);
 const frozen=queue.freeze(key);assert.ok(frozen);assert.equal(await frozen(),'r');
 assert.equal(await frozen(),'r');assert.equal(calls.length,1);assert.equal(calls[0].start_ms,1000);
 assert.equal(calls[0].size,4);assert.match(calls[0].sha256,/^[a-f0-9]{64}$/);assert.equal(queue.get(key).clip,null);queue.dispose();
});
test('failed upload retains exact bytes and retry uses same reference',async()=>{
 let fail=true;const {queue,calls}=setup({upload:async()=>{if(fail)throw Error('offline');return {id:'r',state:'completed'};}});
 queue.enqueue('segment',source,clip);await until(()=>queue.get(key)?.error==='offline');assert.equal(queue.get(key).error,'offline');assert.equal(queue.get(key).clip,clip);
 fail=false;await queue.retry(key);assert.equal(calls.length,1);assert.equal(queue.get(key).row.state,'completed');queue.dispose();
});
test('delete wins a late successful upload acknowledgement',async()=>{
 let finish;const {queue}=setup({upload:()=>new Promise(r=>finish=r)});
 queue.enqueue('segment',source,clip);await until(()=>typeof finish==='function');const frozen=queue.freeze(key);await queue.remove(key);
 finish({id:'r',state:'queued'});assert.equal(await frozen(),null);assert.equal(queue.get(key).row.state,'deleted');
 assert.equal(queue.freeze(key),undefined);queue.dispose();
});
test('restored completed references release redundant raw audio without uploading',async()=>{
 let resume;const {queue,calls}=setup({latestCapture:()=>new Promise(r=>resume=r)});
 const restored=queue.restore('segment',source);queue.enqueue('segment',source,clip);resume({id:'existing',state:'completed'});await restored;
 assert.equal(await queue.freeze(key)(),'existing');assert.equal(calls.length,0);assert.equal(queue.get(key).clip,null);
 assert.equal(queue.get(key).restoring,false);assert.equal(queue.get(key).pending,false);queue.dispose();
});

test('read-only restoration does not report a pending upload',async()=>{
 let resume;const {queue}=setup({latestCapture:()=>new Promise(r=>resume=r)});
 const restored=queue.restore('segment',source);
 assert.equal(queue.pending,1);assert.equal(queue.pendingUploads,0);assert.equal(queue.get(key).restoring,true);
 resume(null);await restored;
 assert.equal(queue.get(key).restoring,false);
 queue.enqueue('segment',source,clip);assert.equal(queue.pendingUploads,1);assert.equal(queue.get(key).restoring,false);
 await until(()=>queue.pending===0);assert.equal(queue.pendingUploads,0);queue.dispose();
});

test('expired references are re-discovered instead of retrying an expired job',async()=>{
 for(const state of ['completed','failed','awaiting_upload']){
  let reads=0;
  const {queue,calls}=setup({latestCapture:async()=>++reads===1?{id:'expired',state,expires_at:'2000-01-01T00:00:00Z'}:null,
   control:async()=>assert.fail('Expired references cannot restart'),remove:async()=>assert.fail('Cache refresh must not delete remote audio')});
  await queue.restore('segment',source);await queue.retry(key);
  assert.equal(reads,2);assert.equal(queue.get(key).row,null);assert.equal(calls.length,0);queue.dispose();
 }
});

test('server deletion during upload stops retrying the stale ID and allows a fresh prepare',async()=>{
 const {ReferenceApiError}=await import('../features/stage-two/server-reference/api.ts');
 let deleted=true;
 const {queue,calls}=setup({upload:async()=>{if(deleted)throw new ReferenceApiError('This reference has expired or been deleted.',410);return {id:'r2',state:'completed'};}});
 queue.enqueue('segment',source,clip);
 await until(()=>queue.get(key)?.row?.state==='deleted');
 assert.equal(queue.get(key).error,null);assert.equal(queue.freeze(key),undefined);
 assert.equal(queue.get(key).clip,null);
 await queue.retry(key);deleted=false;
 queue.enqueue('segment',source,clip);await until(()=>queue.get(key)?.row?.state==='completed');
 assert.equal(calls.length,2);assert.equal(await queue.freeze(key)(),'r2');queue.dispose();
});

test('deleted references discovered by polling stop polling and lose recording readiness',async t=>{
 const {ReferenceApiError}=await import('../features/stage-two/server-reference/api.ts');
 const callbacks=[];
 t.mock.method(globalThis,'setTimeout',callback=>{callbacks.push(callback);return 123;});
 const {queue}=setup({latestCapture:async()=>({id:'gone',state:'processing',audio_ready:true}),
  status:async()=>{throw new ReferenceApiError('This reference has expired or been deleted.',410);}});
 await queue.restore('segment',source);assert.equal(callbacks.length,1);
 await callbacks.shift()();
 assert.equal(callbacks.length,0);assert.equal(queue.get(key).row.state,'deleted');
 assert.equal(queue.get(key).row.audio_ready,false);assert.equal(queue.get(key).error,null);
 assert.equal(queue.freeze(key),undefined);queue.dispose();
});
