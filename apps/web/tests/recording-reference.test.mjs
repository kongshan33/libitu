import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingReference} from '../features/stage-two/practice/recording-reference.ts';
const now=1000,sentence={id:'s',startMs:1000,endMs:4000};
const row={id:'ref',content_id:'c',segment_id:'seg',source_kind:'browser_capture',start_ms:1000,end_ms:4000,
 state:'completed',audio_ready:true,expires_at:new Date(2000).toISOString(),results:[{sentence_id:'s',status:'completed'}]};
const eligible=value=>recordingReference(value,'c','seg',sentence,now);
test('only uploaded queued or processing audio binds an optional Reference before analysis completes',()=>{
 for(const state of ['queued','processing']){
  assert.equal(eligible({...row,state,results:[]})?.id,'ref');
  assert.equal(eligible({...row,state,audio_ready:false}),null);
 }
 for(const state of ['awaiting_upload','failed','cancelled','deleted'])assert.equal(eligible({...row,state}),null);
 assert.equal(eligible(null),null);
});
test('completed results must belong to the selected sentence; partial segment may contain a completed sentence',()=>{
 assert.equal(eligible(row)?.id,'ref');
 assert.equal(eligible({...row,results:[{sentence_id:'other',status:'completed'}]}),null);
 assert.equal(eligible({...row,state:'partially_completed',results:[{sentence_id:'s',status:'partial'}]}),null);
 assert.equal(eligible({...row,state:'partially_completed'})?.id,'ref');
});
test('source, bounds and expiry cannot leak across sentence navigation',()=>{
 for(const change of [{content_id:'other'},{segment_id:'other'},{start_ms:2000},{end_ms:3000},
  {start_ms:0},{expires_at:new Date(now).toISOString()},{expires_at:'invalid'}])assert.equal(eligible({...row,...change}),null);
 assert.equal(eligible({...row,source_kind:'registered',start_ms:0,end_ms:6000})?.id,'ref');
 assert.equal(recordingReference(row,'c','seg',null,now),null);
});
