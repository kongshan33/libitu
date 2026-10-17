"use client";

import { Button } from "@/components/ui/button";

import { useMemo, useState } from 'react';
import type { ComparisonView } from '../comparison/view';
import { emptyPhenomenon, phenomena, soundMarks, type Phenomenon } from '../sound/phenomena';

export function SoundComparison({view,concealed,onConcealedChange,filter,onFilterChange}:{
  filter:Phenomenon|'all';onFilterChange(value:Phenomenon|'all'):void;
  view:ComparisonView;concealed:boolean;onConcealedChange?(value:boolean):void;
}) {
  const [revealed,setRevealed]=useState<number[]>([]);
  const marks=useMemo(()=>soundMarks(view),[view]);
  // Keep the default text reading stable when acoustic results arrive. Dense
  // measurements belong to their explicit filter, not every word in All.
  const visible=marks.filter(m=>filter==='all'?m.kind!=='vowel_length':m.kind===filter);
  const count=view.reference.words.length;
  return <>
    <div className="sound-phenomenon-strip" role="group" aria-label="Sound phenomenon filters">
      <button type="button" aria-pressed={filter==='all'} onClick={()=>onFilterChange('all')}>All</button>
      {phenomena.map(p=><button key={p.id} type="button" data-phenomenon={p.id} aria-pressed={filter===p.id}
        onClick={()=>onFilterChange(p.id)}><span aria-hidden="true">{p.symbol}</span> {p.label}</button>)}
    </div>
    <div className="sound-reveal-bar">
      <span><strong>Shadow mode</strong> · {concealed?'click a covered word to peek':'hover a reference word for IPA'}</span>
      <Button variant="secondary" size="inherit" type="button" onClick={()=>{setRevealed([]);onConcealedChange?.(!concealed);}}>{concealed?'Reveal all':'Hide text'}</Button>
      {concealed?<small role="status">{revealed.length} / {count} revealed</small>:null}
    </div>
    <div className="sound-comparison-text">
      {[view.reference,view.yours].map((voice,v)=><div key={v} className={`comparison-voice paired-${v?'learner':'reference'}`}>
        <h3>{v?'Your voice':'Reference'}</h3>
        <div className="sound-word-flow" aria-label={`${v?'Your voice':'Reference'} sound-marked text`}>
          {voice.words.map((word,i)=>{
            const covered=concealed&&!revealed.includes(i);
            const targets=visible.filter(m=>i>=m.start&&i<m.end);
            const highlighted=filter!=='all'&&targets.length>0;
            const linking=targets.find(m=>m.kind==='linking'&&i<m.end-1);
            const badges=phenomena.filter(p=>p.id!=='linking'&&targets.some(m=>m.kind===p.id));
            return <div key={i} className={`sound-word-group${filter!=='all'&&!targets.length?' is-muted':''}`} data-word-index={i}>
              <div className={`sound-word-card${highlighted?' is-highlighted':''}`} tabIndex={covered?undefined:0}>
                <span className="sound-word-ipa">{!covered&&word.ipa?word.ipa:'\u00a0'}</span>
                {covered?<button className="comparison-peek" aria-label={`Reveal word ${i+1}`}
                  onClick={()=>setRevealed(items=>items.includes(i)?items:[...items,i])}>•••</button>:<strong>{word.text}</strong>}
                <span className="sound-word-marks">{!covered?badges.map(p=>{
                  const measured=p.id==='vowel_length'&&word.vowel!==null;
                  const note=measured?`${Math.round(word.vowel!)} ms vowel duration`:
                    `${p.label}: ${v?'practice target, not evaluated in your voice':'possible reading'}`;
                  return <span key={p.id} className="sound-inline-badge" data-phenomenon={p.id} data-evidence={measured?'measured':'target'}
                    title={`${note}. ${targets.filter(m=>m.kind===p.id).map(m=>m.description).join(' ')}`} aria-label={note}>
                    {p.badge}{measured?` ${Math.round(word.vowel!)} ms`:v?' ?':''}
                  </span>;
                }):null}</span>
              </div>
              {!covered&&linking&&(!concealed||revealed.includes(i+1))?<span className={`sound-link${highlighted?' is-highlighted':''}`} data-phenomenon="linking"
                title={`${linking.description} ${v?'Your voice: not evaluated.':''}`} aria-label={v?'Possible linking boundary; your voice not evaluated':'Possible linking boundary'}>
                <span aria-hidden="true">⌢</span><small>{v?'LK ?':'LK'}</small>
              </span>:null}
              {!covered&&filter==='linking'&&word.pause!==null&&word.pause>0?<span className="sound-boundary-pause"
                title="Measured silence at this word boundary; not a linking verdict" aria-label={`After ${word.text}: measured pause ${(word.pause/1000).toFixed(2)} seconds`}>
                <i aria-hidden="true"/>{(word.pause/1000).toFixed(2)} s
              </span>:null}
            </div>;
          })}
        </div>
        {voice.status?<p className="comparison-status">{voice.status}</p>:null}
      </div>)}
      {!visible.length?<p className="comparison-status" role="status">{emptyPhenomenon(filter)}</p>:null}
    </div>
    <div className="sound-phenomenon-legend" aria-label="Sound marker legend">
      {phenomena.map(p=><span key={p.id}><span className="sound-inline-badge" data-phenomenon={p.id}>{p.badge}</span>{p.label}</span>)}
    </div>
    <p className="comparison-footnote">Colored marks are possible readings from the text. “?” means your voice has not been evaluated for that sound. Choose Vowel len. for measured vowel durations, or Linking for measured pauses.</p>
  </>;
}
