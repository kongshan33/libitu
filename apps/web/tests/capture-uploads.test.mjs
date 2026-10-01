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
 const restore=queue.restore('segment',source);queue.enqueue('segment',source,clip);resume(null);await restore;
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
 assert.equal(await queue.freeze(key)(),'existing');assert.equal(calls.length,0);assert.equal(queue.get(key).clip,null);queue.dispose();
});
