"use client";

import { useEffect, useRef } from "react";

/** Monitor the recorder's existing stream. Never opens a microphone or routes it to speakers. */
export function RecordingWaveform({ stream }: { stream: MediaStream | null }) {
  const view = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!stream || !view.current || typeof AudioContext === "undefined") return;
    const element = view.current;
    const bars = element.querySelectorAll("rect");
    let context: AudioContext | undefined, source: MediaStreamAudioSourceNode | undefined, analyser: AnalyserNode | undefined;
    let frame = 0, previous = 0, stopped = false;
    const heights = new Array<number>(16).fill(2);
    const cleanup = () => {
      stopped = true; cancelAnimationFrame(frame);
      source?.disconnect(); analyser?.disconnect();
      if (context && context.state !== "closed") void context.close().catch(() => undefined);
      element.dataset.active = "false";
    };
    try {
      context = new AudioContext();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser(); analyser.fftSize = 256;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      element.dataset.active = "true";
      void context.resume().catch(() => undefined);
      const draw = (now: number) => {
        if (stopped) return;
        if (now - previous >= 70) {
          previous = now;
          analyser!.getByteTimeDomainData(samples);
          let energy = 0;
          for (const value of samples) energy += ((value - 128) / 128) ** 2;
          heights.shift(); heights.push(2 + Math.min(1, Math.sqrt(energy / samples.length) * 5) * 22);
          bars.forEach((bar, index) => {
            bar.setAttribute("height", String(heights[index]));
            bar.setAttribute("y", String((26 - heights[index]) / 2));
          });
        }
        frame = requestAnimationFrame(draw);
      };
      frame = requestAnimationFrame(draw);
    } catch { cleanup(); }
    return cleanup;
  }, [stream]);
  return <svg ref={view} className="shadow-recording-waveform" viewBox="0 0 96 26" width="96" height="26" aria-hidden="true">
    {Array.from({length:16},(_,index)=><rect key={index} x={index*6+1} y="12" width="3" height="2" rx="1.5" />)}
  </svg>;
}
