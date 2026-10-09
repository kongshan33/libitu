import type { ReferenceAnalysisClip, ReferenceAlignmentSource } from '../analysis/reference-analysis-cache.ts';
import type { ReferenceApi, ServerReference } from './api.ts';

export type CaptureEntry = { source: ReferenceAlignmentSource; segment: string; clip: ReferenceAnalysisClip | null;
  row: ServerReference | null; error: string | null; pending: boolean; running?: Promise<string | null>; timer?: ReturnType<typeof setTimeout> };
export const captureKey = (content: string, segment: string, sentence: string) => JSON.stringify([content,segment,sentence]);
const keyOf = (entry: CaptureEntry) => captureKey(entry.source.contentId,entry.segment,entry.source.sentenceId);

/** Account/page-owned uploads survive sentence and stage navigation. Raw inputs are bounded. */
export class CaptureUploads {
  private entries = new Map<string,CaptureEntry>();
  private listeners = new Set<()=>void>();
  private abort = new AbortController();
  constructor(private api: ReferenceApi, private encode = async (clip: ReferenceAnalysisClip, signal: AbortSignal) =>
    (await import('./capture-audio')).captureWav(clip,signal)) {}
  subscribe(listener:()=>void) { this.listeners.add(listener); return ()=>{this.listeners.delete(listener);}; }
  get(key: string) { return this.entries.get(key); }
  get pending() { return [...this.entries.values()].filter(e=>e.pending).length; }
  get pendingUploads() { return [...this.entries.values()].filter(e=>e.pending && e.clip).length; }
  private publish() { for (const notify of this.listeners) notify(); }
  enqueue(segment: string, source: ReferenceAlignmentSource, clip: ReferenceAnalysisClip) {
    const key=captureKey(source.contentId,segment,source.sentenceId), old=this.entries.get(key);
    if (old?.clip || old?.row) return;
    if ([...this.entries.values()].filter(e=>e.clip).length>=3) {
      if(old){old.error='Reference upload queue is full. Retry after other uploads finish.';this.publish();}return;
    }
    // Preserve an arriving legacy capture while recovery is in flight. Recovery
    // either reuses a durable reference or uploads these exact bytes.
    if(old?.pending){old.clip=clip;return;}
    const entry: CaptureEntry={source:{...source},segment,clip,row:null,error:null,pending:false};
    this.entries.set(key,entry); void this.run(entry).catch(()=>undefined);
  }
  async restore(segment: string, source: ReferenceAlignmentSource) {
    const key=captureKey(source.contentId,segment,source.sentenceId);
    if (this.entries.has(key)) return;
    const entry: CaptureEntry={source:{...source},segment,clip:null,row:null,error:null,pending:true};
    this.entries.set(key,entry); this.publish();
    try { entry.row=await this.api.latestCapture(source.contentId,segment,source.sentenceId,this.abort.signal); }
    catch(error) { if (!this.abort.signal.aborted) entry.error=error instanceof Error?error.message:'Reference recovery failed.'; }
    finally { entry.pending=false; if (!this.abort.signal.aborted) {
      if(entry.row)entry.clip=null;
      this.publish();if(entry.row)this.poll(entry);
      if(entry.clip&&!entry.error)void this.run(entry).catch(()=>undefined);
    } }
  }
  freeze(key: string): (()=>Promise<string|null>) | undefined {
    const entry=this.entries.get(key);
    return entry && entry.row?.state!=='deleted' && (entry.row || entry.clip) ? ()=>this.run(entry) : undefined;
  }
  async retry(key: string) {
    const entry=this.entries.get(key); if(!entry) return;
    if(entry.row && ['failed','cancelled','partially_completed'].includes(entry.row.state)) {
      try { entry.row=await this.api.control(entry.row.id,'retry',this.abort.signal); entry.error=null; this.poll(entry); }
      catch(error) { entry.error=error instanceof Error?error.message:'Retry failed.'; }
      this.publish();
    } else if(entry.clip) await this.run(entry).catch(()=>undefined);
    else if(entry.row?.state==='awaiting_upload'||entry.row?.state==='deleted') {
      if(entry.row.state!=='deleted')await this.remove(key);
      if(entry.row.state==='deleted'){this.entries.delete(key);this.publish();}
    } else { this.entries.delete(key); await this.restore(entry.segment,entry.source); }
  }
  async remove(key: string) {
    const entry=this.entries.get(key); if(!entry?.row) return;
    try { await this.api.remove(entry.row.id,this.abort.signal);
      clearTimeout(entry.timer); entry.clip=null; entry.row={...entry.row,state:'deleted',audio_ready:false,results:[]}; entry.error=null;
    } catch(error) { entry.error=error instanceof Error?error.message:'Reference deletion failed. Try again.'; }
    if(!this.abort.signal.aborted)this.publish();
  }
  dispose() { this.abort.abort(); for(const entry of this.entries.values()) clearTimeout(entry.timer); this.entries.clear(); this.listeners.clear(); }
  private run(entry: CaptureEntry): Promise<string|null> {
    if(entry.running) return entry.running;
    if(entry.row && entry.row.state!=='awaiting_upload') return Promise.resolve(entry.row.state==='deleted'?null:entry.row.id);
    if(!entry.clip) return entry.row ? Promise.reject(new Error('Play and capture this sentence again to finish uploading its reference.')) : Promise.resolve(null);
    entry.pending=true; entry.error=null; this.publish();
    const clip=entry.clip;
    entry.running=(async()=>{
      const wav=await this.encode(clip,this.abort.signal);
      const hash=await crypto.subtle.digest('SHA-256',await wav.arrayBuffer());
      this.abort.signal.throwIfAborted();
      const digest=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
      entry.row ??= await this.api.prepareCapture({content_id:entry.source.contentId,segment_id:entry.segment,
        sentence_id:entry.source.sentenceId,capture_id:clip.captureId??digest,start_ms:entry.source.startMs,end_ms:entry.source.endMs,
        sha256:digest,size:wav.size,consent_version:'reference-analysis-v1'},this.abort.signal);
      this.publish();
      if(entry.row.state==='awaiting_upload') {
        const row=await this.api.upload(entry.row.id,wav,this.abort.signal);
        // A late upload acknowledgement must never resurrect a deleted row.
        if((entry.row as ServerReference).state==='deleted')return null;
        entry.row=row;
      }
      this.abort.signal.throwIfAborted(); entry.clip=null; this.poll(entry); return entry.row.id;
    })().catch(error=>{ entry.error=error instanceof Error?error.message:'Reference upload failed. Keep this page open and retry.'; throw error; })
      .finally(()=>{entry.running=undefined;entry.pending=false;if(!this.abort.signal.aborted)this.publish();});
    return entry.running;
  }
  private poll(entry: CaptureEntry) {
    clearTimeout(entry.timer);
    if(!entry.row || !['queued','processing'].includes(entry.row.state) || this.abort.signal.aborted) return;
    entry.timer=setTimeout(async()=>{
      try { const row=await this.api.status(entry.row!.id,this.abort.signal);
        if(this.entries.get(keyOf(entry))!==entry || entry.row?.state==='deleted') return;
        entry.row=row; entry.error=null;
      } catch(error) { if(!this.abort.signal.aborted) entry.error=error instanceof Error?error.message:'Reference status unavailable.'; }
      if(!this.abort.signal.aborted) {this.publish();this.poll(entry);}
    },2500);
  }
}
