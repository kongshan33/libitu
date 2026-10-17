"use client";
// Installed temporarily by the opt-in benchmark runner; never shipped as a route.
import { useMemo, useState } from "react";
import { createPracticeApi } from "@/features/stage-two/persistence/practice-api";
import { PracticeOutbox } from "@/features/stage-two/persistence/practice-outbox";
import { usePracticeAnalysis } from "@/features/stage-two/persistence/use-practice-analysis";
import type { SentenceUnit } from '@libitu/types/stage-two';
import type { PracticeAnalysis } from '@/features/stage-two/persistence/practice-api';
import { comparisonView } from '@/features/stage-two/comparison/view';
import { layerPresentation } from '@/features/stage-two/practice/layer-presentation';
import { PracticeLayers, type PracticeLayer } from '@/features/stage-two/components/PracticeLayers';
import { PracticeLayerState } from '@/features/stage-two/components/PracticeLayerState';
import { LayerComparison } from '@/features/stage-two/components/LayerComparison';
import { ProgressiveComparison } from "@/features/stage-two/components/ProgressiveComparison";

export default function SubmissionBenchmark() {
  const [attempt, setAttempt] = useState<string|null>(null);
  const [error, setError] = useState("");
  const [config, setConfig] = useState<{owner:string;content:string;sentence:string;reference:string|null;duration:number;mode:string;text:string;final_results?:boolean}|null>(null);
  const api = useMemo(()=>config?createPracticeApi(config.owner,async()=>`header.${btoa(JSON.stringify({sub:config.owner}))}.fixture`):undefined,[config]);
  const analysis=usePracticeAnalysis(api,attempt);
  return <main style={{maxWidth:1000,margin:"32px auto"}}>
    <input aria-label="Fixture configuration" onChange={e=>{setAttempt(null);setConfig(JSON.parse(e.target.value));}}/>
    <input type="file" aria-label="Public audio" onChange={async e=>{
      const file=e.target.files?.[0];if(!file||!api||!config)return;
      const blob=new Blob([await file.arrayBuffer()],{type:"audio/ogg"});
      const input={content_id:config.content,sentence_id:config.sentence,duration_ms:config.duration,playback_rate:1,text_visible:true};
      try{
        if(config.mode!=="legacy"){
          const queue=new PracticeOutbox(api);
          queue.subscribe(state=>{if(state.errors.length)setError(state.errors[0].message);});
          queue.enqueue(input,blob,false,{referenceId:config.reference},setAttempt);
        }else{
          const hash=await crypto.subtle.digest("SHA-256",await blob.arrayBuffer());
          const meta={consent_version:"practice-analysis-v1" as const,sha256:Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,"0")).join(""),size:blob.size,mime_type:"audio/ogg",reference_id:config.reference};
          const take=await api.create({...input,client_id:crypto.randomUUID(),recording:null},new AbortController().signal);
          await api.prepareAnalysis(take.id,meta,new AbortController().signal);
          await api.uploadAnalysis(take.id,blob,new AbortController().signal);
          setAttempt(take.id);
        }
      }catch(e){setError(String(e));}
    }}/>
    <div data-testid="error">{error||analysis.error}</div>
    <div data-testid="attempt">{attempt}</div>
    <div data-testid="state">{analysis.data?.state}</div>
    {analysis.data?.word_check?<p data-testid="word-check">{analysis.data.word_check.matched_count}/{analysis.data.word_check.source_count} · {analysis.data.word_check.tier}</p>:null}
    {!config?.final_results && analysis.data?.coarse?<div data-testid="coarse" data-reference={Boolean(analysis.data.coarse.reference)}>
      <ProgressiveComparison pair={analysis.data.coarse} layer="rhythm"/>
      <ProgressiveComparison pair={analysis.data.coarse} layer="melody"/>
    </div>:null}
    {config?.final_results && analysis.data ? <FinalLayers data={analysis.data} text={config.text} duration={config.duration}/> : null}
  </main>;
}

function FinalLayers({data,text,duration}:{data:PracticeAnalysis;text:string;duration:number}) {
  const [active,setActive]=useState<PracticeLayer>('sound');
  const sentence:SentenceUnit={id:data.sentence_id,segmentId:'segment',text,sourceTokenStart:0,sourceTokenEnd:text.split(' ').length,
    transcriptStartIndex:0,transcriptEndIndex:1,startMs:120000,endMs:120000+duration,timingSource:'caption_estimate',timingConfidence:'approximate'};
  const presentation=layerPresentation(data,true,false);
  const view=comparisonView({sentence,guide:null,data,server:null,reference:null,yours:null});
  const ready=data.state==='completed' && ['sound','rhythm','melody'].every(layer=>['partial','available'].includes(presentation.statuses[layer as PracticeLayer].state));
  const content=(layer:PracticeLayer)=><PracticeLayerState label={layer} status={presentation.statuses[layer]} waitingReference={data.phase==='waiting_reference'}>
    <LayerComparison layer={layer} view={view}/>
    {layer==='rhythm' && data.result?.learner.rhythm_signal?<ProgressiveComparison fine layer='rhythm' pair={{learner:data.result.learner.rhythm_signal,reference:data.result.reference?.rhythm_signal??null}}/>:null}
  </PracticeLayerState>;
  return <div data-testid={ready?'final':undefined} data-reference={Boolean(data.result?.reference)}>
    <PracticeLayers active={active} onChange={setActive} locked={presentation.locked} badges={presentation.badges}
      sound={content('sound')} rhythm={content('rhythm')} melody={content('melody')}/>
  </div>;
}
