import type { AcousticFeatures, AcousticWindow } from "../acoustics/types.ts";
import type { LocalReferenceAlignment } from "../alignment/types.ts";

export type ReferenceAnalysisClip = { blob: Blob; startOffsetMs: number; endOffsetMs: number; captureId?: string };
export type ReferenceAlignmentSource = { contentId: string; sentenceId: string; text: string; startMs: number; endMs: number };
export type ReferenceAlignmentSnapshot = {
  phase: "missing" | "aligning" | "ready" | "unsupported" | "unreliable" | "error";
  source: ReferenceAlignmentSource | null;
  captureId: string | null;
  audioSha256: string | null;
  result: LocalReferenceAlignment | null;
  error: string | null;
  canRetry: boolean;
};
export const MISSING_REFERENCE_ALIGNMENT: ReferenceAlignmentSnapshot = Object.freeze({
  phase: "missing", source: null, captureId: null, audioSha256: null, result: null, error: null, canRetry: false,
});
export type ReferenceAnalysisSnapshot = {
  phase: "missing" | "analyzing" | "ready" | "error";
  features: AcousticFeatures | null;
  error: string | null;
  canRetry: boolean;
  alignment: ReferenceAlignmentSnapshot;
};
export const MISSING_REFERENCE_ANALYSIS: ReferenceAnalysisSnapshot = Object.freeze({
  phase: "missing", features: null, error: null, canRetry: false, alignment: MISSING_REFERENCE_ALIGNMENT,
});
const MAX_ENTRIES = 20;
const MAX_BLOBS = 2;
const MAX_BLOB_BYTES = 12 * 1024 * 1024;
const ERROR_BLOB_TTL_MS = 60_000;
const CAPTURE_AGAIN = "Play the sentence again to prepare its reference.";
const boundedLimit = (value: number | undefined, maximum: number) =>
  value === undefined || !Number.isFinite(value) ? maximum : Math.max(1, Math.min(maximum, Math.floor(value)));

type Analyze = (blob: Blob, signal: AbortSignal, window: AcousticWindow) => Promise<AcousticFeatures>;
type Align = (blob: Blob, signal: AbortSignal, window: AcousticWindow, source: ReferenceAlignmentSource) =>
  Promise<{ result: LocalReferenceAlignment; audioSha256: string }>;
type Entry = {
  key: string;
  result: ReferenceAnalysisSnapshot;
  clip: ReferenceAnalysisClip | null;
  expiry: ReturnType<typeof setTimeout> | null;
  source: ReferenceAlignmentSource | null;
};
type Job = { entry: Entry; abort: AbortController };

/** Include the complete source identity and exact caption bounds, not just sentence text. */
export function buildReferenceKey(contentId: string, sourceUrl: string, sentenceId: string, startMs: number, endMs: number): string {
  return JSON.stringify(["reference-analysis-v1", "local-acoustics-v1", contentId, sourceUrl, sentenceId, startMs, endMs]);
}

/** Guard a clip that arrives in the same render as a different selected sentence. */
export function referenceKeyMatchesClip(key: string, clip: ReferenceAnalysisClip & {
  sentenceId: string; rangeStart?: number; rangeEnd?: number;
}): boolean {
  try {
    const fields: unknown = JSON.parse(key);
    return Array.isArray(fields) && fields.length === 7 && fields[0] === "reference-analysis-v1" &&
      fields[1] === "local-acoustics-v1" && fields[4] === clip.sentenceId &&
      typeof fields[5] === "number" && Number.isFinite(fields[5]) &&
      typeof fields[6] === "number" && Number.isFinite(fields[6]) && fields[6] > fields[5] &&
      (clip.rangeStart === undefined || Math.abs(fields[5] - clip.rangeStart * 1000) < 0.001) &&
      (clip.rangeEnd === undefined || Math.abs(fields[6] - clip.rangeEnd * 1000) < 0.001);
  } catch { return false; }
}

async function analyzeLocally(blob: Blob, signal: AbortSignal, window: AcousticWindow): Promise<AcousticFeatures> {
  const { analyzeLocalAudio } = await import("../acoustics/client.ts");
  if (signal.aborted) throw new DOMException("Reference analysis cancelled.", "AbortError");
  return analyzeLocalAudio(blob, signal, window);
}

async function alignLocally(blob: Blob, signal: AbortSignal, window: AcousticWindow, source: ReferenceAlignmentSource) {
  const { alignReferenceBlob } = await import("../alignment/reference-blob.ts");
  signal.throwIfAborted();
  return alignReferenceBlob(blob, signal, window, source);
}

function validSource(key: string, source: ReferenceAlignmentSource): boolean {
  try {
    const fields: unknown = JSON.parse(key);
    return Array.isArray(fields) && fields.length === 7 && fields[0] === "reference-analysis-v1"
      && fields[1] === "local-acoustics-v1" && fields[2] === source.contentId && fields[4] === source.sentenceId
      && fields[5] === source.startMs && fields[6] === source.endMs
      && Number.isFinite(source.startMs) && source.startMs >= 0 && Number.isFinite(source.endMs) && source.endMs > source.startMs
      && typeof source.text === "string" && source.text.trim().length > 0 && source.text.length <= 6000;
  } catch { return false; }
}

function sameSource(a: ReferenceAlignmentSource | null, b: ReferenceAlignmentSource): boolean {
  return a?.contentId === b.contentId && a.sentenceId === b.sentenceId && a.text === b.text
    && a.startMs === b.startMs && a.endMs === b.endMs;
}

/** Page-memory LRU: one inference at a time, at most two bounded raw clips. */
export class ReferenceAnalysisCache {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: Entry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly clipListeners = new Set<(key: string, clip: ReferenceAnalysisClip, source: ReferenceAlignmentSource) => void>();
  private readonly localAlignment: boolean;
  private active: Job | null = null;
  private readonly analyze: Analyze;
  private readonly align: Align;
  private readonly maxEntries: number;
  private readonly maxBlobs: number;
  private readonly maxBlobBytes: number;

  constructor(options: { onChange?: () => void; analyze?: Analyze; align?: Align; localAlignment?: boolean; maxEntries?: number; maxBlobs?: number; maxBlobBytes?: number } = {}) {
    this.analyze = options.analyze ?? analyzeLocally;
    this.align = options.align ?? alignLocally;
    this.localAlignment = options.localAlignment ?? Boolean(options.align);
    this.maxEntries = boundedLimit(options.maxEntries, MAX_ENTRIES);
    this.maxBlobs = boundedLimit(options.maxBlobs, MAX_BLOBS);
    this.maxBlobBytes = boundedLimit(options.maxBlobBytes, MAX_BLOB_BYTES);
    if (options.onChange) this.listeners.add(options.onChange);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribeClips(listener: (key: string, clip: ReferenceAnalysisClip, source: ReferenceAlignmentSource) => void): () => void {
    this.clipListeners.add(listener);
    for (const entry of this.entries.values()) if (entry.clip && entry.source) listener(entry.key, entry.clip, entry.source);
    return () => { this.clipListeners.delete(listener); };
  }

  get(key: string): ReferenceAnalysisSnapshot {
    const entry = this.entries.get(key);
    if (!entry) return MISSING_REFERENCE_ANALYSIS;
    this.touch(entry);
    return entry.result;
  }

  /** Includes in-flight, failed and insufficient-quality attempts to avoid an automatic capture loop. */
  has(key: string): boolean { return this.entries.has(key); }

  isReady(key: string): boolean {
    const result = this.entries.get(key)?.result;
    return result?.phase === "ready" && result.features?.quality.status === "usable";
  }

  /** True means ownership was accepted or the duplicate handled; the caller may release its clip. */
  ingest(key: string, clip: ReferenceAnalysisClip, source?: ReferenceAlignmentSource): boolean {
    if (!key || key.length > 8192) return false;
    if (source && !validSource(key, source)) return false;
    const existing = this.entries.get(key);
    if (existing) {
      if (source && !sameSource(existing.source, source)) return false;
      this.touch(existing);
      return true;
    }
    const invalid = !clip.blob.size || clip.blob.size > this.maxBlobBytes ||
      !Number.isFinite(clip.startOffsetMs) || !Number.isFinite(clip.endOffsetMs) ||
      clip.startOffsetMs < 0 || clip.endOffsetMs <= clip.startOffsetMs || clip.endOffsetMs > 65_000;
    if (!invalid && !this.makeBlobRoom(clip.blob.size)) return false;
    if (!this.makeEntryRoom()) return false;
    const entry: Entry = {
      key, expiry: null, clip: invalid ? null : { ...clip }, source: source ? { ...source } : null,
      result: invalid
        ? { phase: "error", features: null, error: `The reference clip is empty, too large, or has invalid timing. ${CAPTURE_AGAIN}`, canRetry: false, alignment: MISSING_REFERENCE_ALIGNMENT }
        : { phase: "analyzing", features: null, error: null, canRetry: false, alignment: {
          ...MISSING_REFERENCE_ALIGNMENT, source: source ? { ...source } : null, captureId: clip.captureId ?? null,
        } },
    };
    this.entries.set(key, entry);
    if (!invalid && source) for (const listener of this.clipListeners) listener(key, clip, source);
    if (!invalid) this.queue.push(entry);
    this.pump();
    this.publish();
    return true;
  }

  /** A model failure can be retried briefly without recapturing; insufficient-quality results cannot. */
  retry(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || entry.result.phase !== "error" || !entry.clip) return false;
    this.clearExpiry(entry);
    entry.result = { ...entry.result, phase: "analyzing", features: null, error: null, canRetry: false };
    this.touch(entry);
    this.queue.push(entry);
    this.pump();
    this.publish();
    return true;
  }

  /** Alignment retries never rerun or erase completed VAD/F0 measurements. */
  retryAlignment(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry?.clip || !entry.source || entry.result.alignment.phase !== "error" || !entry.result.alignment.canRetry) return false;
    this.clearExpiry(entry);
    entry.result = { ...entry.result, alignment: { ...entry.result.alignment, phase: "aligning", error: null, canRetry: false } };
    this.touch(entry);
    this.queue.push(entry);
    this.pump();
    this.publish();
    return true;
  }

  /** Explicitly prepare a new take after failure or insufficient evidence. */
  invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.remove(entry);
    this.pump();
    this.publish();
  }

  clear(): void {
    this.active?.abort.abort();
    this.active = null;
    this.queue.length = 0;
    for (const entry of this.entries.values()) {
      this.clearExpiry(entry);
      entry.clip = null;
    }
    this.entries.clear();
    this.publish();
  }

  /** Remains reusable for React Strict Mode's effect cleanup/setup cycle. */
  dispose(): void { this.clear(); }

  getUsage(): { entries: number; rawBlobs: number; rawBytes: number; active: number; queued: number } {
    let rawBlobs = 0;
    let rawBytes = 0;
    for (const entry of this.entries.values()) if (entry.clip) {
      rawBlobs++;
      rawBytes += entry.clip.blob.size;
    }
    return { entries: this.entries.size, rawBlobs, rawBytes, active: this.active ? 1 : 0, queued: this.queue.length };
  }

  private publish(): void { for (const listener of this.listeners) listener(); }
  private touch(entry: Entry): void { this.entries.delete(entry.key); this.entries.set(entry.key, entry); }
  private clearExpiry(entry: Entry): void {
    if (entry.expiry !== null) clearTimeout(entry.expiry);
    entry.expiry = null;
  }

  private remove(entry: Entry): void {
    this.clearExpiry(entry);
    entry.clip = null;
    this.entries.delete(entry.key);
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
    if (this.active?.entry === entry) {
      this.active.abort.abort();
      this.active = null;
    }
  }

  private makeEntryRoom(): boolean {
    while (this.entries.size >= this.maxEntries) {
      const oldest = [...this.entries.values()].find((entry) => this.active?.entry !== entry
        && !this.queue.includes(entry) && entry.result.phase !== "analyzing");
      if (!oldest) return false;
      this.remove(oldest);
    }
    return true;
  }

  private releaseErrorClip(entry: Entry): void {
    this.clearExpiry(entry);
    entry.clip = null;
    entry.result = entry.result.alignment.phase === "error"
      ? { ...entry.result, alignment: { ...entry.result.alignment, error: `Local word alignment could not finish. ${CAPTURE_AGAIN}`, canRetry: false } }
      : { ...entry.result, error: CAPTURE_AGAIN, canRetry: false };
  }

  private makeBlobRoom(bytes: number): boolean {
    let usage = this.getUsage();
    while (usage.rawBlobs >= this.maxBlobs || usage.rawBytes + bytes > this.maxBlobBytes) {
      const oldest = [...this.entries.values()].find((entry) => entry.clip && this.active?.entry !== entry
        && !this.queue.includes(entry) && (entry.result.phase === "error" || entry.result.alignment.phase === "error"));
      if (!oldest) return false;
      this.releaseErrorClip(oldest);
      this.publish();
      usage = this.getUsage();
    }
    return true;
  }

  private pump(): void {
    if (this.active) return;
    const entry = this.queue.shift();
    if (!entry?.clip) return;
    const job: Job = { entry, abort: new AbortController() };
    this.active = job;
    const { blob, startOffsetMs, endOffsetMs } = entry.clip;
    const isCurrent = () => this.active === job && this.entries.get(entry.key) === entry && !job.abort.signal.aborted;
    void Promise.resolve().then(async () => {
      if (!isCurrent()) throw new DOMException("Reference analysis cancelled.", "AbortError");
      const window = { startMs: startOffsetMs, endMs: endOffsetMs };
      const features = entry.result.features ?? await this.analyze(blob, job.abort.signal, window);
      if (!isCurrent()) return;
      entry.result = { ...entry.result, phase: "ready", features, error: null, canRetry: false };
      if (!this.localAlignment || !entry.source || features.quality.status !== "usable") {
        if (this.localAlignment && entry.source) entry.result = { ...entry.result, alignment: { ...entry.result.alignment,
          phase: "unreliable", error: "This reference has insufficient speech for word alignment.", canRetry: false } };
        entry.clip = null;
        return;
      }
      entry.result = { ...entry.result, alignment: { ...entry.result.alignment, phase: "aligning", error: null, canRetry: false } };
      // Publish the cheap measurements before the larger phoneme model finishes.
      this.publish();
      const aligned = await this.align(blob, job.abort.signal, window, entry.source);
      if (!isCurrent()) return;
      entry.result = { ...entry.result, alignment: { ...entry.result.alignment,
        phase: aligned.result.status, result: aligned.result, audioSha256: aligned.audioSha256,
        error: aligned.result.reason ?? null, canRetry: false } };
      entry.clip = null;
    }).catch((error: unknown) => {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : "Local reference analysis failed. Try again.";
      entry.result = entry.result.features
        ? { ...entry.result, alignment: { ...entry.result.alignment, phase: "error", error: message, canRetry: true } }
        : { ...entry.result, phase: "error", features: null, error: message, canRetry: true };
      entry.expiry = setTimeout(() => {
        if (this.entries.get(entry.key) !== entry || (entry.result.phase !== "error" && entry.result.alignment.phase !== "error")) return;
        this.releaseErrorClip(entry);
        this.publish();
      }, ERROR_BLOB_TTL_MS);
    }).finally(() => {
      if (this.active !== job) return;
      this.active = null;
      this.pump();
      this.publish();
    });
  }
}
