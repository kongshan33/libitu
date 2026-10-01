"use client";

import { useEffect, useMemo } from 'react';
import type { SentenceUnit } from '@libitu/types/stage-two';
import type { ReferenceAnalysisCache, ReferenceAlignmentSource } from '../analysis/reference-analysis-cache';
import type { BufferedReferenceSession } from '../reference/use-buffered-reference';
import { usePracticePersistence } from '../persistence/PracticePersistence';
import { captureKey } from './capture-uploads';

export function useCapturedReference(content: string, segment: string, sentence: SentenceUnit|null,
  cache: ReferenceAnalysisCache, buffer: BufferedReferenceSession|null|undefined, enabled: boolean) {
  const persistence=usePracticePersistence(), uploads=persistence?.captures;
  const revision=persistence?.captureVersion;
  const source=useMemo<ReferenceAlignmentSource|null>(()=>sentence?{contentId:content,sentenceId:sentence.id,text:sentence.text,startMs:sentence.startMs,endMs:sentence.endMs}:null,[content,sentence]);
  const key=sentence?captureKey(content,segment,sentence.id):'';
  const entry=uploads?.get(key);
  useEffect(()=>{if(uploads&&source)void uploads.restore(segment,source);},[uploads,source,segment]);
  useEffect(()=>{
    if(!enabled||!uploads) return;
    return cache.subscribeClips((_key,clip,clipSource)=>{
      if(clipSource.contentId===content&&clipSource.sentenceId===source?.sentenceId)uploads.enqueue(segment,clipSource,clip);
    });
  },[cache,uploads,enabled,content,segment,source]);
  const covered=Boolean(sentence&&buffer?.covers({start:sentence.startMs/1000,end:sentence.endMs/1000}));
  const extract=buffer?.extract;
  useEffect(()=>{
    if(!enabled||!uploads||!source||!sentence||!extract||!covered||entry?.pending||entry?.row||entry?.clip||entry?.error) return;
    const abort=new AbortController();
    void extract(sentence,abort.signal).then(clip=>{if(clip&&!abort.signal.aborted)uploads.enqueue(segment,source,clip);}).catch(()=>undefined);
    return ()=>abort.abort();
  },[enabled,uploads,source,sentence,extract,covered,segment,entry,revision]);
  return {key,entry,row:entry?.row??null, freeze:()=>uploads?.freeze(key),
    retry:()=>{if(uploads)void uploads.retry(key);}, remove:()=>uploads?.remove(key)};
}
