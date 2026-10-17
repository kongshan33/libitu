"use client";
import { useEffect, useMemo, useRef } from 'react';
import type { SentenceUnit } from '@libitu/types/stage-two';
import type { TextSupport } from '../persistence/practice-api';
import { practiceTokens, visiblePositions } from '../practice/flow';
import { captionWordAtTime, qualifyCaptionWords, type CaptionWordClock } from '../../playback/caption-word-clock';

export function PracticePrompt({sentence,mode,revealed,onReveal,clock,disabled=false}:{
  sentence:SentenceUnit;mode:TextSupport['mode'];revealed:number[];onReveal(index:number):void;clock:CaptionWordClock;disabled?:boolean;
}) {
  const root=useRef<HTMLDivElement>(null);
  const tokens=useMemo(()=>practiceTokens(sentence.text),[sentence.text]);
  const visible=visiblePositions(tokens,mode,revealed);
  useEffect(()=>{
    const words=qualifyCaptionWords(sentence.text,sentence.sourceTokenStart,sentence.timingSource,sentence.wordTimings);
    const nodes=root.current?.querySelectorAll<HTMLElement>('[data-practice-word]');
    if(!nodes)return;
    return clock.subscribe(sample=>{
      const index=sample.playing?captionWordAtTime(words,sample.timeMs):null;
      const active=words.find(word=>word.index===index);
      nodes.forEach(node=>{const token=tokens[Number(node.dataset.practiceWord)];
        node.classList.toggle('is-playing',Boolean(active&&token.start<active.charEnd&&token.end>active.charStart));});
    });
  },[sentence,clock,tokens,mode,revealed]);
  return <div ref={root} className="shadow-practice-prompt" aria-label="Practice sentence">
    {tokens.map((token,i)=>visible.includes(i)?<span key={i} data-practice-word={i} className={revealed.includes(i)?'is-peeked':''}>
      {sentence.text.slice(token.start,tokens[i+1]?.start??sentence.text.length).trim()}
    </span>:<button key={i} type="button" className="shadow-word-mask" data-practice-word={i} aria-label={`Reveal word ${i+1}`}
      disabled={disabled} style={{width:`${Math.min(150,Math.max(40,token.normalized.length*13))}px`}} onClick={()=>onReveal(i)}><span aria-hidden="true">•••</span></button>)}
    {!tokens.length?<p>Sentence text is unavailable.</p>:null}
  </div>;
}
