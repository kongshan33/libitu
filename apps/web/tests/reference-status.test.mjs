import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceStatus } from '../features/stage-two/practice/reference-status.ts';

const row = {state:'queued',audio_ready:true,expires_at:'2099-01-01T00:00:00Z',results:[]};
const incomplete = {sentence_id:'sentence',status:'partial',alignment:{status:'unavailable',reason:'reference_content_unverified'},prosody:{content:{status:'mismatch'}}};
test('upload success survives queued -> processing -> content mismatch -> retry -> ready', () => {
  assert.equal(referenceStatus(null,'sentence'),null);
  for (const state of ['queued','processing']) {
    const status=referenceStatus({...row,state},'sentence');
    assert.equal(status.phase,'analyzing');
    assert.equal(status.needsUpload,false);
    assert.equal(status.action,null);
    assert.match(status.description,/Reference uploaded/);
  }
  const partial=referenceStatus({...row,state:'partially_completed',results:[incomplete]},'sentence');
  assert.equal(partial.title,'Reference analysis incomplete');
  assert.match(partial.description,/audio is uploaded.*Recognized words differ/);
  assert.equal(partial.needsUpload,false);
  assert.equal(partial.action,'Retry reference analysis');
  assert.equal(referenceStatus(row,'sentence').phase,'analyzing');
  assert.equal(referenceStatus({...row,state:'completed',results:[{...incomplete,status:'completed'}]},'sentence').phase,'ready');
});
test('status follows the selected sentence and terminal asset lifecycle, not segment completion alone', () => {
  const partial={...row,state:'partially_completed',results:[incomplete,{sentence_id:'other',status:'completed'}]};
  assert.equal(referenceStatus(partial,'sentence').phase,'review');
  assert.equal(referenceStatus(partial,'other').phase,'ready');
  assert.equal(referenceStatus({...partial,state:'completed'},'missing').phase,'review');
  for(const expired of [{state:'deleted'},{expires_at:'2000-01-01T00:00:00Z'}]) {
    const status=referenceStatus({...partial,...expired},'other');
    assert.equal(status.phase,'review');
    assert.equal(status.needsUpload,true);
    assert.equal(status.action,'Prepare reference');
  }
  assert.equal(referenceStatus({...row,state:'awaiting_upload',audio_ready:false},'sentence').needsUpload,true);
  assert.doesNotMatch(referenceStatus({...row,audio_ready:false},'sentence').description,/uploaded/);
  for(const state of ['failed','cancelled']) {
    const status=referenceStatus({...row,state},'sentence');
    assert.match(status.description,/uploaded/);
    assert.equal(status.needsUpload,false);
  }
});

test('source transcript readiness and alignment failures have their own explanation',()=>{
 const result={sentence_id:'sentence',status:'completed',alignment:{status:'aligned'},prosody:{content:{status:'source_transcript'}}};
 assert.match(referenceStatus({...row,state:'completed',results:[result]},'sentence').description,/aligned to the source transcript/);
 const status=referenceStatus({...row,state:'partially_completed',results:[{...result,status:'partial',alignment:{status:'unavailable',reason:'reference_alignment_invalid'}}]},'sentence');
 assert.match(status.description,/timing and coverage checks/);
 assert.doesNotMatch(status.description,/Recognized words/);
 assert.equal(status.needsUpload,false);
});

test('dictionary coverage failure does not ask to upload audio again',()=>{
 const status=referenceStatus({...row,state:'partially_completed',results:[{sentence_id:'sentence',status:'partial',alignment:{status:'unavailable',reason:'mfa_dictionary_word_unavailable'},prosody:{content:{status:'source_transcript'}}}]},'sentence');
 assert.match(status.description,/pronunciation dictionary/);
 assert.equal(status.action,'Retry reference analysis');
 assert.equal(status.needsUpload,false);
});

test('service failure and timeout are not presented as incomplete sentence coverage',()=>{
 for(const [reason,copy] of [['mfa_version_mismatch',/service is unavailable/],['mfa_startup_failed',/service is unavailable/],['mfa_timeout',/timed out/],['mfa_alignment_failed',/could not finish/]]) {
  const status=referenceStatus({...row,state:'partially_completed',results:[{sentence_id:'sentence',status:'partial',alignment:{reason},prosody:{content:{status:'source_transcript'}}}]},'sentence');
  assert.match(status.description,copy);
  assert.doesNotMatch(status.description,/Word alignment is incomplete|Recognized words/);
  assert.equal(status.needsUpload,false);assert.equal(status.action,'Retry reference analysis');
 }
});

test('coarse reference status stays distinct from alignment success or failure',()=>{
 const base={state:'processing',audio_ready:true,expires_at:'2099-01-01T00:00:00Z',results:[{sentence_id:'s',status:'coarse_ready',coarse:{prominence:[.2]},alignment:{status:'unavailable',reason:'alignment_pending'}}]};
 assert.equal(referenceStatus(base,'s').title,'Reference preliminary results ready');
 assert.equal(referenceStatus(base,'s').action,null);
 assert.match(referenceStatus({...base,state:'failed'},'s').description,/Precise word alignment did not finish/);
 assert.equal(referenceStatus({...base,state:'deleted'},'s').needsUpload,true);
});
