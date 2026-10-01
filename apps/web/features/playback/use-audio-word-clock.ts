"use client";
import { useEffect, type RefObject } from 'react';
import type { CaptionWordClock } from './caption-word-clock';
export function useAudioWordClock(ref:RefObject<HTMLAudioElement|null>,source:string|null,clock:CaptionWordClock|undefined,enabled=true,offset=0) {
  useEffect(()=>{
    const audio=ref.current;if(!audio||!source||!clock||!enabled)return;
    let timer:ReturnType<typeof setInterval>|undefined;
    const sample=()=>clock.publish(audio.currentTime+offset,!audio.paused&&!audio.ended);
    const update=()=>{clearInterval(timer);sample();if(!audio.paused&&!audio.ended)timer=setInterval(sample,50);};
    const events=['play','pause','ended','timeupdate','seeking','seeked','emptied','error'];
    events.forEach(e=>audio.addEventListener(e,update));update();
    return ()=>{clearInterval(timer);events.forEach(e=>audio.removeEventListener(e,update));clock.reset();};
  },[ref,source,clock,enabled,offset]);
}
