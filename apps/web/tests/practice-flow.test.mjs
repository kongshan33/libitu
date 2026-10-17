import assert from 'node:assert/strict';
import {test} from 'node:test';
import {practiceTokens,visiblePositions,supportSnapshot,layerLocks,nextPracticeIndex,matchLabel} from '../features/stage-two/practice/flow.ts';
import {layerPresentation} from '../features/stage-two/practice/layer-presentation.ts';
import {comparisonView} from '../features/stage-two/comparison/view.ts';

test('prompt positions preserve NFKC, contractions and original DOM offsets',()=>{
 const source="Ｗｅ don’t re-enter ﬃ, 42!";
 const tokens=practiceTokens(source);
 assert.deepEqual(tokens.map(t=>t.normalized),['we',"don't",'re','enter','ffi','42']);
 assert.ok(tokens.every(t=>source.slice(t.start,t.end)===t.display));
});
test('recording support freezes start visibility while later peeks remain separately attributable',()=>{
 const tokens=practiceTokens('We practice in the morning.');
 assert.deepEqual(visiblePositions(tokens,'hidden',[1]),[1]);
 assert.deepEqual(visiblePositions(tokens,'keywords',[]),[1,4]);
 const initial=[1],peeks=[1,3];const take=supportSnapshot('hidden',initial,peeks);
 initial.push(2);peeks.splice(0);assert.deepEqual(take.visible_source_indices_at_start,[1]);assert.deepEqual(take.revealed_source_indices,[1,3]);
});
test('locked layers follow server scope, not rounded percentages or recognition feedback',()=>{
 const data={word_check:{source_count:199,matched_count:169,status:'reliable'},analysis_scope:'sound_only',recognition_feedback:{kind:'recognition_error'}};
 assert.deepEqual(layerLocks(data,true),{sound:false,rhythm:true,melody:true});
 assert.equal(matchLabel(data),'84.9% of words matched');
 assert.deepEqual(layerLocks({...data,analysis_scope:'none'},true),{sound:true,rhythm:true,melody:true});
 assert.deepEqual(layerLocks({...data,analysis_scope:'all_layers'},false),{sound:true,rhythm:true,melody:true});
});
test('legacy measurements are viewable without inventing a matching tier',()=>{
 assert.deepEqual(layerLocks({analysis_version:'practice-comparison-v2',state:'completed',result:{}},true),{sound:false,rhythm:false,melody:false});
 assert.deepEqual(layerLocks({analysis_version:'practice-gated-v3',state:'processing'},true),{sound:true,rhythm:true,melody:true});
});
test('automatic navigation skips one to three words, preserves four, and handles segment boundaries',()=>{
 const sentences=['We practice speaking every day.','Yes.','We keep going together.'].map(text=>({text}));
 assert.equal(nextPracticeIndex(sentences,0,1,true),2);assert.equal(nextPracticeIndex(sentences,2,-1,true),0);
 assert.equal(nextPracticeIndex(sentences,0,1,false),1);assert.equal(nextPracticeIndex(sentences,2,1,true),null);
});
test('gated result maps repeated words by source position and leaves omitted pitch slots empty',()=>{
 const text='Go go now please.';const source_tokens=practiceTokens(text);
 const actual=practiceTokens('go now please');
 const operations=[{kind:'omitted',source_index:0,recognized_index:null},{kind:'matched',source_index:1,recognized_index:0},
 {kind:'matched',source_index:2,recognized_index:1},{kind:'matched',source_index:3,recognized_index:2}];
 const words=actual.map((t,i)=>({text:t.display,source_index:i+1,recognized_index:i,start_sec:i,end_sec:i+.5,duration_ms:500,
 pitch_curve_st:[1,2,3,2,1],boundary_pause_ms:0,phones:[]}));
 const sentence={id:'s',text};
 const data={sentence_id:'s',state:'completed',word_check:{source_count:4,source_tokens,operations},result:{learner:{alignment_status:'aligned',words},comparison:'unavailable'}};
 const view=comparisonView({sentence,guide:null,data,server:{sentence_id:'s',prosody:{content:{status:'matched'},alignment_status:'aligned',words}},reference:null,yours:null});
 assert.equal(view.yours.words.length,4);assert.equal(view.yours.words[0].duration,null);assert.equal(view.yours.words[1].duration,500);
 assert.ok(view.yours.curve.filter(point=>point.pitch!==null).every(point=>point.x>=.25));
 assert.ok(view.reference.words.every(word=>word.duration===null),'fresh reference cannot replace an unbound historical reference');
});


test('analysis visibility follows recording and durable word check, including legacy and deletion',()=>{
 const done={state:'completed',analysis_version:'practice-gated-v3',word_check:{status:'reliable'},analysis_scope:'all_layers'};
 for(const data of [null,{state:'awaiting_upload'},{state:'processing',phase:'checking_words'},{state:'failed'}])assert.equal(layerPresentation(data,true,false).visible,false);
 assert.equal(layerPresentation(done,false,false).visible,false);
 assert.equal(layerPresentation(done,true,true).visible,false);
 assert.equal(layerPresentation(done,true,false).visible,true);
 assert.equal(layerPresentation({...done,state:'deleted'},true,false).visible,false);
 assert.equal(layerPresentation({state:'completed',analysis_version:'practice-comparison-v2',result:{}},true,false).visible,true);
});
test('layer badges respect gates, pending evidence, real scores and interrupted analysis',()=>{
 const done={state:'completed',analysis_version:'practice-gated-v3',word_check:{status:'reliable'},analysis_scope:'sound_only',result:{}};
 assert.deepEqual(Object.values(layerPresentation({...done,analysis_scope:'none'},true,false).badges).map(b=>b.text),['🔒','🔒','🔒']);
 assert.deepEqual(Object.values(layerPresentation(done,true,false).badges).map(b=>b.text),['✓*','🔒','🔒']);
 const pending={...done,state:'queued',phase:'waiting_reference',layers:{sound:{state:'pending'}}};
 assert.equal(layerPresentation(pending,true,false).badges.sound.text,'…');
 assert.equal(layerPresentation(pending,true,false).badges.sound.title,'Waiting for reference analysis');
 for(const state of ['failed','cancelled'])assert.equal(layerPresentation({...pending,state},true,false).badges.sound.text,'—');
 const full={...done,analysis_scope:'all_layers',result:{assessment:{rhythm:{value:86.2},melody:{value:null}}}};
 const view=layerPresentation(full,true,false);
 assert.deepEqual(Object.values(view.badges).map(b=>b.text),['✓','86','✓']);
 assert.match(view.badges.rhythm.title,/Experimental/);
 assert.match(view.badges.sound.title,/no overall Sound score/);
 assert.equal(layerPresentation({...full,result:null},true,false).badges.sound.text,'—');
 assert.equal(layerPresentation({...full,layers:{melody:{state:'unavailable'}}},true,false).badges.melody.text,'—');
});

test('coarse output stays hidden during processing and failure, then upgrades to final results',()=>{
 const data={state:'processing',phase:'coarse_ready',analysis_version:'practice-gated-v3',word_check:{status:'reliable'},analysis_scope:'all_layers',
  layers:{sound:{state:'pending',reason:null},rhythm:{state:'partial',reason:'preliminary'},melody:{state:'partial',reason:'preliminary'}}};
 const preview=layerPresentation(data,true,false);
 assert.equal(preview.badges.rhythm.text,'…');assert.equal(preview.badges.sound.text,'…');
 assert.equal(layerPresentation({...data,state:'failed'},true,false).badges.melody.text,'—');
 assert.equal(layerPresentation({...data,analysis_scope:'sound_only'},true,false).badges.rhythm.text,'🔒');
 assert.equal(layerPresentation(data,true,true).visible,false);
 const final={...data,state:'completed',layers:{rhythm:{state:'available',reason:null}},result:{assessment:{rhythm:{value:80}}}};
 assert.equal(layerPresentation(final,true,false).badges.rhythm.text,'80');
});

test('final learner data remains visible when the server retains an unavailable Reference preview',()=>{
 const data={state:'completed',analysis_version:'practice-gated-v3',word_check:{status:'reliable'},analysis_scope:'all_layers',
  layers:{rhythm:{state:'partial',reason:'preliminary'},melody:{state:'partial',reason:'preliminary'}},
  result:{learner:{alignment_status:'aligned',words:[0,1,2].map(source_index=>({source_index,pitch_curve_st:[0,null,1]}))}}};
 const view=layerPresentation(data,true,false);
 assert.equal(view.badges.rhythm.text,'✓');assert.equal(view.statuses.rhythm.reason,'learner_only');
 assert.equal(view.badges.melody.text,'✓');
 assert.equal(layerPresentation({...data,result:null},true,false).badges.rhythm.text,'—');
 assert.equal(layerPresentation({...data,state:'cancelled'},true,false).badges.rhythm.text,'—');
});
