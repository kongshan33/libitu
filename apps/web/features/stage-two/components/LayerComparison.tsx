"use client";

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { comparisonWordAtTime, trace, type ComparisonView } from '../comparison/view';
import type { CaptionClockSample, CaptionWordClock } from '../../playback/caption-word-clock';
import { SoundComparison } from './SoundComparison';
import { LayerFocus } from './LayerFocus';
import type { Phenomenon } from '../sound/phenomena';
import type { PracticeLayer } from './PracticeLayers';
export type ComparisonPlayback={reference:CaptionWordClock;yours:CaptionWordClock;referenceOffsetMs:number};
export function LayerComparison({layer,view,concealed=false,onConcealedChange,playback}:{layer:PracticeLayer;view:ComparisonView;concealed?:boolean;onConcealedChange?(v:boolean):void;playback?:ComparisonPlayback}) {
  const [soundFilter, setSoundFilter] = useState<Phenomenon | 'all'>('all');
  return <section className={`layer-comparison layer-comparison-${layer}`} aria-label={`${view.saved?'Saved':'Current'} ${layer} word comparison`}>
    <div className="stage-two-layer-workspace">
    <div className="stage-two-comparison-canvas">
    {layer==='sound'?<SoundComparison filter={soundFilter} onFilterChange={setSoundFilter} view={view} concealed={concealed} onConcealedChange={onConcealedChange}/>:layer==='melody'?<PitchOverlay view={view} playback={playback}/>:<>
      <div className="paired-scroll" tabIndex={0} role="region" aria-label={`${layer} reference and voice rows`}>
        <div className="paired-grid" style={{'--paired-count':Math.max(1,view.yours.words.length),'--paired-word-width':`${Math.max(92,...view.yours.words.map(w=>w.text.length*8+24))}px`} as CSSProperties}>
          {[view.reference,view.yours].map((voice,v)=><div key={v} className={`comparison-voice paired-${v?'learner':'reference'}`}>
            <h3>{v?'Your voice':'Reference'}</h3><div className="paired-row">
              {voice.words.map((word,i)=><div className="paired-word" key={i}>
                <>
                  {layer==='rhythm'?<span className="paired-syllables" role="img" aria-label={`${word.text}: dictionary syllable stress`}>
                    {word.stress?.map((s,k)=><i key={k} data-stress={s===1?'primary':s===2?'secondary':'unstressed'}/>)??<span>—</span>}</span>:null}
                  <strong title={word.ipa?`Dictionary IPA: ${word.ipa}`:undefined}>{word.text}</strong>
                  {word.duration!==null?<span className="paired-duration">{Math.round(word.duration)} ms</span>:null}
                  {word.pause!==null&&word.pause>0?<span className="paired-pause" role="img" aria-label={`After ${word.text}: pause ${(word.pause/1000).toFixed(2)} seconds`}><i/>{(word.pause/1000).toFixed(2)} s</span>:null}
                </>
              </div>)}
            </div>{voice.status?<p className="comparison-status">{voice.status}</p>:null}
          </div>)}
        </div>
      </div>
      <p className="comparison-footnote">Dots: dictionary syllable stress. Bars: measured pauses.</p>
    </>}
    </div>
    <LayerFocus layer={layer} view={view} soundFilter={soundFilter} concealed={concealed}/>
    </div>
  </section>;
}
function usePlayingWord(view:ComparisonView,playback?:ComparisonPlayback) {
  const [active,setActive]=useState<{voice:'reference'|'yours'|null;index:number|null}>({voice:null,index:null});
  const reference=playback?.reference,yours=playback?.yours,offset=playback?.referenceOffsetMs??0;
  useEffect(()=>{
    if(!reference||!yours||!view.wordAligned)return;
    let r:CaptionClockSample={timeMs:0,playing:false},y:CaptionClockSample={timeMs:0,playing:false};
    const update=()=>{const voice=y.playing?'yours':r.playing?'reference':null;
      const index=voice?comparisonWordAtTime(view[voice].words,voice==='yours'?y.timeMs:r.timeMs-offset):null;
      setActive(old=>old.voice===voice&&old.index===index?old:{voice,index});};
    const offR=reference.subscribe(s=>{r=s;update();}),offY=yours.subscribe(s=>{y=s;update();});
    return ()=>{offR();offY();};
  },[reference,yours,offset,view]);
  return view.wordAligned?active:{voice:null,index:null};
}
function PitchOverlay({view,playback}:{view:ComparisonView;playback?:ComparisonPlayback}) {
  const scroll=useRef<HTMLDivElement>(null),buttons=useRef<(HTMLButtonElement|null)[]>([]),keyboard=useRef(false);
  const [space,setSpace]=useState(0),[hover,setHover]=useState<number|null>(null),[selected,setSelected]=useState<number|null>(null);
  const playing=usePlayingWord(view,playback),active=playing.voice?playing.index:hover??selected;
  useEffect(()=>{if(!scroll.current)return;const observer=new ResizeObserver(([entry])=>setSpace(Math.floor(entry.contentRect.width)));observer.observe(scroll.current);return ()=>observer.disconnect();},[]);
  useEffect(()=>{const box=scroll.current,word=active===null?null:buttons.current[active];if(!box||!word||!playing.voice||!box.clientWidth)return;
    const b=box.getBoundingClientRect(),w=word.getBoundingClientRect();
    if(w.left<b.left+10)box.scrollLeft-=b.left+10-w.left;else if(w.right>b.right-10)box.scrollLeft+=w.right-b.right+10;
  },[active,playing.voice]);
  const words=view.yours.words,voices=[view.reference,view.yours],cell=Math.max(80,...words.map(w=>w.text.length*8+18));
  const left=38,plot=Math.max(440,space-50,words.length*cell),width=plot+left+12;
  const valid=voices.flatMap(v=>v.curve.filter(p=>p.pitch!==null&&Number.isFinite(p.pitch)&&p.x>=0&&p.x<=1));
  const extent=Math.max(6,...valid.map(p=>Math.ceil(Math.abs(p.pitch!))));
  return <figure className="comparison-melody"><figcaption><span className="paired-pitch-legend"><span>Reference</span><span>Your voice</span></span><span>Relative pitch · st</span></figcaption>
    <div ref={scroll} className="comparison-chart-scroll" tabIndex={0} role="region" aria-label="Pitch chart and aligned text" data-playing-voice={playing.voice??undefined} onPointerLeave={()=>setHover(null)}>
      <svg width={width} viewBox={`0 0 ${width} 185`} role="img" aria-label={`Reference and your voice pitch curves; ${view.wordAligned?'aligned by word':'normalized speech time, word alignment pending'}`} onPointerLeave={()=>setHover(null)}>
        {active!==null&&view.wordAligned?<rect className="comparison-active-band" x={left+active*plot/words.length} y="12" width={plot/words.length} height="155" rx="6"/>:null}
        {[-extent,0,extent].map(value=><g className="paired-axis-tick" key={value}><line className="paired-axis" x1={left} x2={left+plot} y1={92-value/extent*65} y2={92-value/extent*65}/><text x="30" y={96-value/extent*65} textAnchor="end">{value>0?'+':''}{value}</text></g>)}
        {voices.map((voice,v)=><g key={v} className={v?'paired-learner-trace':'paired-reference-trace'}>
          <path d={trace(voice.curve,left,plot,extent)} fill="none"/>
          {active!==null&&view.wordAligned?<path className="comparison-active-trace" d={trace(voice.curve.filter(p=>Math.floor(p.x*words.length)===active),left,plot,extent)} fill="none"/>:null}
          {voice.curve.map((p,i)=>p.pitch!==null&&Number.isFinite(p.pitch)&&p.x>=0&&p.x<=1?<circle key={i} cx={left+p.x*plot} cy={92-p.pitch/extent*65} r={active!==null&&view.wordAligned&&Math.floor(p.x*words.length)===active?3:1.3}/>:null)}
        </g>)}
        {view.wordAligned?words.map((_,i)=><rect key={i} className="comparison-word-hit" data-word-index={i} aria-hidden="true" x={left+i*plot/words.length} y="12" width={plot/words.length} height="155" fill="transparent" onPointerEnter={()=>{if(!keyboard.current)setHover(i);}} onPointerMove={()=>{keyboard.current=false;setHover(i);}} onClick={()=>setSelected(i)}/>):null}
      </svg>
      {view.wordAligned?<div className="comparison-word-labels" style={{width:plot,marginLeft:left,gridTemplateColumns:`repeat(${words.length},minmax(0,1fr))`}}>
        {words.map((word,i)=><button key={i} type="button" className={`comparison-word-slot${active===i?' is-active':''}`} data-word-index={i} aria-current={active===i?'true':undefined}
          aria-label={`Compare pitch for ${word.text}, word ${i+1}`} ref={el=>{buttons.current[i]=el;}} onPointerEnter={()=>{if(!keyboard.current)setHover(i);}} onPointerMove={()=>{keyboard.current=false;setHover(i);}} onPointerLeave={()=>setHover(null)} onFocus={()=>setSelected(i)} onClick={()=>setSelected(i)}
          onKeyDown={event=>{if(event.key==='Escape'){setSelected(null);setHover(null);return;}
            const next=event.key==='ArrowRight'?(i+1)%words.length:event.key==='ArrowLeft'?(i-1+words.length)%words.length:event.key==='Home'?0:event.key==='End'?words.length-1:null;
            if(next!==null){event.preventDefault();keyboard.current=true;setHover(null);setSelected(next);buttons.current[next]?.focus({preventScroll:true});
              const box=scroll.current,word=buttons.current[next];if(box&&word){const b=box.getBoundingClientRect(),w=word.getBoundingClientRect();box.scrollLeft+=w.left-b.left-(b.width-w.width)/2;}}}}>{word.text}</button>)}
      </div>:null}
    </div>
    {!valid.length?<p className="comparison-status">Reliable pitch is not available yet.</p>:null}
    {!view.wordAligned?<p className="comparison-pending-text">{words.map(w=>w.text).join(' ')}</p>:null}
    <p className="comparison-footnote">{view.wordAligned?'Pitch centered on each voice’s median · select a word to compare, or play either voice to follow along.':'Pitch centered on each voice’s median · sentence time normalized. Word alignment is pending.'}</p>
    {voices.map((v,i)=>v.status?<p className="comparison-status" key={i}>{i?'Your voice':'Reference'}: {v.status}</p>:null)}
  </figure>;
}
