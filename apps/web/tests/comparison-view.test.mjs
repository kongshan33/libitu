import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonView, comparisonWordAtTime, trace, wordCurve } from '../features/stage-two/comparison/view.ts';
import { soundMarks } from '../features/stage-two/sound/phenomena.ts';
const sentence={id:'s',text:'Hello world.'};
const word={text:'hello',start_sec:0,end_sec:.3,duration_ms:300,pause_after_ms:100,pitch_curve_st:[2,null,-1],phones:[]};
const voice={content:{status:'matched'},alignment_status:'aligned',words:[word,{...word,text:'world',start_sec:.4,end_sec:.8}]};
const args={sentence,guide:null,server:null,reference:null,yours:null};
test('sound candidates retain exact occurrences and reject stale or misaligned guides',()=>{
 const repeated={id:'repeat',text:'Can you can it?'};
 const guide={sentence_id:repeated.id,sentence_text:repeated.text,
   tokens:[['Can',0],['you',4],['can',8],['it',12]].map(([text,start],index)=>({index,text,start,end:start+text.length,ipa:['test'],pronunciations:[['AH1']]})),
   candidates:[{id:'weak',kind:'weak_form',token_start:0,token_end:1,explanation:'Possible weak auxiliary.'},
     {id:'bad',kind:'linking',token_start:3,token_end:5,explanation:'Out of range'}]};
 const view=comparisonView({...args,sentence:repeated,guide});
 assert.deepEqual(soundMarks(view).map(m=>[m.kind,m.start,m.end]),[['weak_form',0,1]]);
 for(const invalid of [{...guide,sentence_id:'other'}, {...guide,sentence_text:'Different.'}, {...guide,tokens:guide.tokens.toReversed()}]) {
   assert.equal(comparisonView({...args,sentence:repeated,guide:invalid}).sound,null);
 }
});
test('learner-only vowel evidence produces duration marks without a realization verdict',()=>{
 const learner={...voice,words:voice.words.map(w=>({...w,phones:[{label:'IY1',duration_ms:140}]}))};
 const view=comparisonView({...args,data:{sentence_id:'s',state:'completed',result:{learner,comparison:'unavailable'}}});
 assert.deepEqual(soundMarks(view).map(m=>[m.kind,m.start,m.end]),[['vowel_length',0,1],['vowel_length',1,2]]);
 assert.ok(view.reference.words.every(w=>w.vowel===null));
});
test('saved attempt owns both curves, ignores a newly selected live reference',()=>{
 const view=comparisonView({...args,data:{sentence_id:'s',state:'completed',result:{learner:voice,comparison:'unavailable'}},server:{sentence_id:'s',prosody:voice}});
 assert.equal(view.saved,true);assert.equal(view.reference.curve.length,0);assert.ok(view.yours.curve.length);assert.equal(view.yours.words[1].text,'world.');
});
test('unaligned or wrong-sentence results never manufacture measured words',()=>{
 const view=comparisonView({...args,data:{sentence_id:'other',state:'completed',result:{learner:voice,comparison:'available',reference:voice}}});
 assert.equal(view.saved,false);assert.equal(view.wordAligned,false);assert.ok(view.yours.words.every(w=>w.duration===null));
});
test('word slots preserve unvoiced gaps and highlight only valid half-open intervals',()=>{
 const view=comparisonView({...args,data:{sentence_id:'s',state:'completed',result:{learner:voice,comparison:'available',reference:voice}}});
 assert.equal(comparisonWordAtTime(view.yours.words,250),0);assert.equal(comparisonWordAtTime(view.yours.words,300),null);
 assert.equal(comparisonWordAtTime(view.yours.words,450),1);assert.equal(comparisonWordAtTime(view.yours.words,800),null);
 assert.equal(comparisonWordAtTime([view.yours.words[0],view.yours.words[0]],20),null);
 const path=trace(wordCurve(voice.words),0,100,6);assert.equal((path.match(/M/g)||[]).length,4);assert.equal((path.match(/L/g)||[]).length,0);
});
