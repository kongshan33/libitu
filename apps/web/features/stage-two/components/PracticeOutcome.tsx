"use client";
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { PracticeAnalysis, PracticeApi } from '../persistence/practice-api';
import { matchLabel } from '../practice/flow';

export function PracticeOutcome({data,loading,pendingSave,requested,text,api,takeId,onMarked}:{
  data:PracticeAnalysis|null;loading:boolean;pendingSave:boolean;requested:boolean;text:string;
  api:PracticeApi|undefined;takeId:string|null;onMarked():void;
}) {
  const check=data?.word_check;
  const [busy,setBusy]=useState(false),[marked,setMarked]=useState(false),[error,setError]=useState<string|null>(null);
  const abort=useRef<AbortController|null>(null);
  useEffect(()=>{const current=new AbortController();abort.current=current;return()=>current.abort();},[takeId]);
  const disagreement=marked||Boolean(data?.recognition_feedback);
  const differing=check?.status==='reliable'&&check.operations.some(op=>op.kind!=='matched');
  async function mark() {
    const signal=abort.current?.signal;
    if(!api||!takeId||!signal||busy)return;
    setBusy(true);setError(null);
    try {await api.markRecognitionError(takeId,signal);if(!signal.aborted){setMarked(true);onMarked();}}
    catch(cause){if(!signal.aborted)setError(cause instanceof Error?cause.message:'Please retry.');}
    finally{if(!signal.aborted)setBusy(false);}
  }
  const label=matchLabel(data);
  return <div className="shadow-practice-outcome" data-tier={check?.tier??undefined}>
    {check?.status==='reliable'?<>
      <div className="shadow-word-differences" aria-label="Word matching result">
        {check.operations.map((op,i)=>op.kind==='inserted'?<span className="shadow-diff inserted" key={i}>+ {check.recognized_tokens[op.recognized_index!]?.display}</span>:
          <span className={`shadow-diff ${op.kind}`} key={i}><strong>{check.source_tokens[op.source_index!]?.display}</strong>
            {op.kind==='substituted'?<small>recognized “{check.recognized_tokens[op.recognized_index!]?.display}”</small>:
              op.kind==='omitted'?<small>not recognized</small>:null}</span>)}
      </div>
      <p role="status"><span className="shadow-tier-dot"/>{label} · {check.tier==='below_60'?'word check only':check.tier==='partial_60_85'?'Sound on matched words':'three-layer analysis eligible'}</p>
      {differing?<div className="shadow-recognition-feedback">{disagreement?<span>Recognition error marked. Original recognition results are retained.</span>:
        <Button variant="ghost" size="sm" disabled={busy||!takeId} loading={busy} loadingLabel="Saving…" onClick={()=>void mark()}>Recognition error</Button>}</div>:null}
    </>:check?<><p className="shadow-revealed-text">{text}</p><p role="status">Not enough reliable recognition to check the words. Try another take.</p></>:
      data?.result?<><p className="shadow-revealed-text">{text}</p><p role="status">Saved take · legacy analysis. No word-matching percentage was recorded.</p></>:
      <p role="status">{pendingSave?'Saving your take…':loading||data&&['queued','processing','awaiting_upload'].includes(data.state)?'Checking your words…':
        requested?'Word check is unavailable for this take.':'Word check was not requested. Enable recording analysis in Audio settings for your next take.'}</p>}
    {error?<p role="alert">{error}</p>:null}
    {check?.tier==='below_60'?<p>Listen more slowly or try with key words, then record again. Sound, Rhythm and Melody stay locked below 60%.</p>:
      check?.tier==='partial_60_85'?<p>Only reliably matched words enter Sound comparison. Rhythm and Melody unlock at 85%.</p>:null}
  </div>;
}
