import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHistoryPages } from '../features/stage-two/persistence/history-pages.ts';
import { PracticeOutbox } from '../features/stage-two/persistence/practice-outbox.ts';

test('refresh retains selected older take beyond the loaded page after new saves', async () => {
  const rows=Array.from({length:45},(_,i)=>({id:`take-${i}`})), offsets=[];
  const api={list:async(_content,_sentence,offset)=>{
    offsets.push(offset);return {items:rows.slice(offset,offset+20),next_offset:offset+20<rows.length?offset+20:null};
  }};
  const signal=new AbortController().signal;
  const page=await loadHistoryPages(api,'content','sentence',20,'take-41',signal);
  assert.deepEqual(offsets,[0,20,40]);assert.equal(page.items.length,45);assert.equal(page.next_offset,null);
  offsets.length=0;
  const latest=await loadHistoryPages(api,'content','sentence',20,'take-3',signal);
  assert.deepEqual(offsets,[0]);assert.equal(latest.next_offset,20);
});

test('deleted selection exhausts pages, deduplicates overlap and permits latest surviving recovery',async()=>{
  const offsets=[];
  const api={list:async(_c,_s,offset)=>{offsets.push(offset);return offset===0
    ?{items:[{id:'latest'},{id:'middle'}],next_offset:20}
    :{items:[{id:'middle'},{id:'oldest'}],next_offset:null};}};
  const page=await loadHistoryPages(api,'content','sentence',2,'deleted',new AbortController().signal);
  assert.deepEqual(offsets,[0,20]);assert.deepEqual(page.items.map(t=>t.id),['latest','middle','oldest']);
});

test('history rejects stalled pagination and cancels before requesting another sentence page',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(loadHistoryPages({list:async()=>({items:[],next_offset:0})},'c','s',20,null,controller.signal),/pagination/);
  await assert.rejects(loadHistoryPages({list:async()=>{calls++;controller.abort();return {items:[],next_offset:20};}},'c','s',20,null,controller.signal),{name:'AbortError'});
  assert.equal(calls,1);
});

test('pending progress survives failed saves and is scoped to content until acknowledged',async()=>{
  let release, fail=true;
  const queue=new PracticeOutbox({create:async()=>{
    if(fail)throw Error('offline');return new Promise(resolve=>{release=resolve;});
  }});
  queue.enqueue({content_id:'content-a',sentence_id:'sentence-a',duration_ms:300,playback_rate:1,text_visible:false},new Blob(['bytes']),false);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(queue.state.errors.length,1);
  assert.deepEqual(queue.state.pendingSentences,[{contentId:'content-a',sentenceId:'sentence-a'}]);
  fail=false;queue.retry();await new Promise(resolve=>setTimeout(resolve,0));
  release({id:'saved',recording_state:'none'});await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(queue.state.pendingSentences,[]);assert.equal(queue.state.savedVersion,1);queue.dispose();
});
