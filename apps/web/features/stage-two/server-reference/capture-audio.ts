import type { ReferenceAnalysisClip } from '../analysis/reference-analysis-cache';
import { validateAudioWindow } from '../acoustics/window';

/** Upload only the selected sentence, excluding lead-in/tail captured by MediaRecorder. */
export async function captureWav(clip: ReferenceAnalysisClip, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await clip.blob.arrayBuffer());
    signal.throwIfAborted();
    const range = validateAudioWindow(decoded.duration*1000, { startMs: clip.startOffsetMs, endMs: clip.endOffsetMs });
    const start = Math.round(range.startMs*decoded.sampleRate/1000), end = Math.min(decoded.length, Math.round(range.endMs*decoded.sampleRate/1000));
    const count = end-start, bytes = new ArrayBuffer(44+count*2), view = new DataView(bytes);
    const tag = (offset: number, value: string) => [...value].forEach((c,i) => view.setUint8(offset+i,c.charCodeAt(0)));
    tag(0,'RIFF'); view.setUint32(4,36+count*2,true); tag(8,'WAVE'); tag(12,'fmt ');
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
    view.setUint32(24,decoded.sampleRate,true); view.setUint32(28,decoded.sampleRate*2,true);
    view.setUint16(32,2,true); view.setUint16(34,16,true); tag(36,'data'); view.setUint32(40,count*2,true);
    const channels = Array.from({length:decoded.numberOfChannels},(_,i)=>decoded.getChannelData(i));
    for (let i=0;i<count;i++) {
      const sample = Math.max(-1,Math.min(1,channels.reduce((n,c)=>n+c[start+i],0)/channels.length));
      view.setInt16(44+i*2,Math.round(sample*(sample<0?32768:32767)),true);
    }
    return new Blob([bytes],{type:'audio/wav'});
  } finally { await context.close(); }
}
