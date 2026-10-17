import type { AnalysisInput, AttemptInput, PracticeApi } from "./practice-api.ts";

type Entry = {
  input: AttemptInput; blob: Blob | null; retain: boolean;
  analyze: boolean; referenceId: string | null; analysisInput: AnalysisInput | null;
  status: "saving" | "error"; error: string | null;
  onSaved?: (attemptId: string) => void;
  resolveReference?: () => Promise<string | null>;
};
export type PracticeSaveState = {
  pending: number; pendingSentences: { contentId: string; sentenceId: string }[];
  errors: { id: string; sentenceId: string; message: string }[]; savedVersion: number;
};
export const MAX_PENDING_TAKES = 5;

/** Account-bound, page-lifetime queue. Owns Blob bytes before recorder URLs are revoked. */
export class PracticeOutbox {
  private entries = new Map<string, Entry>();
  private running = new Set<string>();
  private controller = new AbortController();
  private listeners = new Set<(state: PracticeSaveState) => void>();
  state: PracticeSaveState = { pending: 0, pendingSentences: [], errors: [], savedVersion: 0 };
  constructor(private api: PracticeApi) {}

  subscribe(listener: (state: PracticeSaveState) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  canRecord() { return this.entries.size < MAX_PENDING_TAKES && !this.controller.signal.aborted; }

  enqueue(input: Omit<AttemptInput, "client_id" | "recording">, blob: Blob, retain: boolean, analysis?: { referenceId: string | null; resolveReference?: () => Promise<string | null> }, onSaved?: (attemptId: string) => void) {
    if (!this.canRecord()) throw new Error("Retry pending saves before recording another take.");
    const id = crypto.randomUUID();
    const entry: Entry = { input: { ...structuredClone(input), client_id: id, recording: null }, blob: retain || analysis ? blob : null,
      analyze: Boolean(analysis), referenceId: analysis?.referenceId ?? null, analysisInput: null,
      retain, status: "saving", error: null, onSaved, resolveReference: analysis?.resolveReference };
    this.entries.set(id, entry);
    this.publish();
    void this.save(id);
  }

  retry() { for (const id of this.entries.keys()) void this.save(id); }
  dispose() { this.controller.abort(); this.entries.clear(); this.listeners.clear(); }

  private publish() {
    this.state = { ...this.state, pending: this.entries.size,
      pendingSentences: [...this.entries.values()].map(({input}) => ({contentId: input.content_id, sentenceId: input.sentence_id})),
      errors: [...this.entries.values()].filter((entry) => entry.error).map((entry) => ({
        id: entry.input.client_id, sentenceId: entry.input.sentence_id, message: entry.error!
      })) };
    for (const listener of this.listeners) listener(this.state);
  }

  private async save(id: string) {
    const entry = this.entries.get(id);
    if (!entry || this.running.has(id) || this.controller.signal.aborted) return;
    this.running.add(id);
    entry.status = "saving"; entry.error = null; this.publish();
    try {
      if (entry.blob && ((entry.retain && !entry.input.recording) || (entry.analyze && !entry.analysisInput))) {
        const mime = entry.blob.type.split(";")[0];
        if (!["audio/webm", "audio/ogg", "audio/mp4"].includes(mime) || entry.blob.size > 8 * 1024 * 1024) {
          throw new Error("This recording format or size cannot be saved. Keep the page open to replay it.");
        }
        const hash = await crypto.subtle.digest("SHA-256", await entry.blob.arrayBuffer());
        const metadata = { size: entry.blob.size, mime_type: mime,
          sha256: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("") };
        if (entry.retain) entry.input.recording = { ...metadata, consent_version: "recording-retention-v1" };
        if (entry.analyze) entry.analysisInput = { ...metadata, consent_version: "practice-analysis-v1", reference_id: entry.referenceId };
      }
      let attempt;
      if (entry.analysisInput && entry.blob) {
        if (entry.resolveReference) {
          entry.analysisInput.reference_id = await entry.resolveReference();
          entry.resolveReference = undefined;
        }
        attempt = await this.api.submit(entry.input, entry.analysisInput, entry.blob, this.controller.signal);
      } else {
        attempt = await this.api.create(entry.input, this.controller.signal);
        if (entry.blob && attempt.recording_state === "pending") {
          await this.api.upload(attempt.id, entry.blob, this.controller.signal);
        }
      }
      this.controller.signal.throwIfAborted();
      this.entries.delete(id);
      this.state = { ...this.state, savedVersion: this.state.savedVersion + 1 };
      entry.onSaved?.(attempt.id);
    } catch (error) {
      if (!this.controller.signal.aborted) {
        entry.status = "error";
        entry.error = error instanceof Error ? error.message : "Save failed. Keep this page open and retry.";
      }
    } finally {
      this.running.delete(id);
      if (!this.controller.signal.aborted) this.publish();
    }
  }
}
