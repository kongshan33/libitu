import type { SentenceUnit } from "@libitu/types/stage-two";
import type { ReferenceClip, ReferenceRange, ReferenceTelemetry } from "./reference-types";

export type BufferedReferenceState = {
  sourceKey: string | null;
  phase: "idle" | "checking" | "preparing" | "armed" | "enabled" | "error";
  ranges: ReferenceRange[];
  retainedBytes: number;
  recording: boolean;
  error: string | null;
};
export type BufferedTelemetry = ReferenceTelemetry & { epochTime: number; generation: number };
export type BufferedReferenceRequest = {
  type: "LIBITU_BUFFER_REQUEST";
  version: 4;
  contentId?: string;
  videoId?: string;
  sessionId: string;
  requestId: string;
  action: "ping" | "arm" | "heartbeat" | "close" | "observe" | "extract";
  telemetry?: BufferedTelemetry;
  start?: number;
  end?: number;
};
type Timer = ReturnType<typeof globalThis.setTimeout>;
export type BufferedReferenceEnvironment = {
  send(request: BufferedReferenceRequest): void;
  requestId(): string;
  now(): number;
  wallTime(): number;
  setTimeout(callback: () => void, milliseconds: number): Timer;
  clearTimeout(timer: Timer): void;
};
export const BUFFER_PING_TIMEOUT_MS = 2_000;
export const BUFFER_PREPARE_TIMEOUT_MS = 10_000;
export const BUFFER_ARM_TIMEOUT_MS = 40_000;
export const BUFFER_EXTRACT_TIMEOUT_MS = 10_000;
export const BUFFER_HEARTBEAT_MS = 10_000;
export const BUFFER_OBSERVATION_INTERVAL_MS = 250;
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_BASE64_LENGTH = 32 * 1024 * 1024 + 64;
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;
const MAX_RANGES = 4_096;
const MAX_SECONDS = 604_800;
const ID_PATTERN = /^[a-zA-Z0-9.:_-]{1,200}$/;
const browserEnvironment: BufferedReferenceEnvironment = {
  send: (request) => window.postMessage(request, window.location.origin),
  requestId: () => crypto.randomUUID(),
  now: () => Date.now(),
  wallTime: () => performance.now(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (timer) => globalThis.clearTimeout(timer)
};
type Session = { id: string; deadline: Timer | null; heartbeat: Timer | null };
type Extraction = {
  id: string; session: Session; sourceKey: string; sentenceId: string; range: ReferenceRange;
  resolve(clip: ReferenceClip | null): void; reject(reason: unknown): void;
  deadline: Timer | null; detachAbort(): void;
};

export function emptyBufferedReferenceState(sourceKey: string | null = null): BufferedReferenceState {
  return { sourceKey, phase: "idle", ranges: [], retainedBytes: 0, recording: false, error: null };
}

/** A clip must fit one uninterrupted capture run; adjacent runs cannot be stitched. */
export function bufferedRangeCovered(ranges: readonly ReferenceRange[], range: ReferenceRange): boolean {
  if (!validRange(range.start, range.end)) return false;
  return ranges.some((candidate) => candidate.start <= range.start && candidate.end >= range.end);
}

/** Source-owned capture session. Playback is observed, never initiated here. */
export class BufferedReferenceController {
  private state = emptyBufferedReferenceState();
  private session: Session | null = null;
  private readonly requests = new Map<string, Extraction>();
  private lastObservation: BufferedTelemetry | null = null;
  private lastSent: BufferedTelemetry | null = null;
  private readonly environment: BufferedReferenceEnvironment;

  constructor(private readonly change: (state: BufferedReferenceState) => void,
    environment?: Partial<BufferedReferenceEnvironment>) {
    this.environment = { ...browserEnvironment, ...environment };
  }

  getSnapshot(): BufferedReferenceState { return this.state; }

  setSource(sourceKey: string | null) {
    if (this.state.sourceKey === sourceKey) return;
    this.releaseSession(abortError("The reference source changed."));
    this.publish(emptyBufferedReferenceState(sourceKey));
  }

  enable() {
    if (this.session) return;
    if (!this.state.sourceKey) {
      this.publish({ ...this.state, phase: "error", error: "Open a supported video before enabling practice audio." });
      return;
    }
    const session: Session = { id: this.environment.requestId(), deadline: null, heartbeat: null };
    this.session = session;
    this.publish({ ...this.state, phase: "checking", error: null });
    this.deadline(session, BUFFER_PING_TIMEOUT_MS,
      "The updated Libitu extension is unavailable. Reload the extension and this page, then try again.");
    this.sendSession(session, "ping");
  }

  disable() {
    this.releaseSession(abortError("Practice audio was disabled."));
    this.publish(emptyBufferedReferenceState(this.state.sourceKey));
  }

  /** Keep the lease and completed coverage when the player pauses or its view unmounts. */
  suspend() {
    const previous = this.lastObservation;
    if (this.session && this.state.phase === "enabled" && previous) {
      const stopped = { ...previous, state: 2, epochTime: this.environment.now(), wallTime: this.environment.wallTime() };
      this.sendObservation(stopped);
      this.lastObservation = stopped;
    }
    if (this.state.recording) this.publish({ ...this.state, recording: false });
  }

  sample(telemetry: ReferenceTelemetry, generation: number) {
    if (!this.session || this.state.phase !== "enabled") return;
    if (this.lastObservation && Number.isSafeInteger(generation) && generation < this.lastObservation.generation) return;
    if (!validTelemetry(telemetry, generation)) { this.suspend(); return; }
    const sample: BufferedTelemetry = { time: telemetry.time, state: telemetry.state, rate: telemetry.rate,
      wallTime: telemetry.wallTime, epochTime: telemetry.epochTime!, generation };
    const previous = this.lastObservation;
    this.lastObservation = sample;
    const discontinuity = previous !== null && (
      sample.state !== previous.state || sample.rate !== previous.rate || sample.generation !== previous.generation
      || sample.wallTime < previous.wallTime || sample.epochTime < previous.epochTime
      || Math.abs((sample.epochTime - previous.epochTime) - (sample.wallTime - previous.wallTime)) > 150
      || Math.abs((sample.time - previous.time) * 1000 - (sample.wallTime - previous.wallTime) * sample.rate) > 200
    );
    if (!this.lastSent || discontinuity || sample.wallTime - this.lastSent.wallTime >= BUFFER_OBSERVATION_INTERVAL_MS) {
      this.sendObservation(sample);
    }
  }

  covers(range: ReferenceRange): boolean { return bufferedRangeCovered(this.state.ranges, range); }

  extract(sentence: Pick<SentenceUnit, "id" | "startMs" | "endMs">, signal?: AbortSignal): Promise<ReferenceClip | null> {
    if (signal?.aborted) return Promise.reject(abortError());
    const range = { start: sentence.startMs / 1000, end: sentence.endMs / 1000 };
    if (!ID_PATTERN.test(sentence.id) || !validRange(range.start, range.end) || range.end - range.start > 60) {
      return Promise.reject(new Error("This sentence cannot be prepared as a bounded reference clip."));
    }
    const session = this.session;
    if (!session || this.state.phase !== "enabled" || !this.state.sourceKey || !this.covers(range)) return Promise.resolve(null);
    if (this.requests.size >= 2) return Promise.reject(new Error("Reference preparation is busy. Try again shortly."));
    const sourceKey = this.state.sourceKey;
    return new Promise((resolve, reject) => {
      const request: Extraction = { id: this.environment.requestId(), session, sourceKey, sentenceId: sentence.id,
        range, resolve, reject, deadline: null, detachAbort: () => {} };
      const cancel = () => this.finish(request, undefined, abortError());
      signal?.addEventListener("abort", cancel, { once: true });
      request.detachAbort = () => signal?.removeEventListener("abort", cancel);
      this.requests.set(request.id, request);
      request.deadline = this.environment.setTimeout(() => this.finish(request, undefined,
        new Error("The extension did not return this reference clip. Try again.")), BUFFER_EXTRACT_TIMEOUT_MS);
      try {
        this.send({ type: "LIBITU_BUFFER_REQUEST", version: 4, sessionId: session.id,
          requestId: request.id, action: "extract", ...range });
      } catch { this.finish(request, undefined, new Error("The reference connection was interrupted.")); }
    });
  }

  /** Caller checks MessageEvent origin and source before passing its data. */
  handleMessage(value: unknown) {
    if (!value || typeof value !== "object") return;
    const message = value as Record<string, unknown>;
    const session = this.session;
    if (!session || message.type !== "LIBITU_BUFFER_EVENT" || message.version !== 4 || message.sessionId !== session.id) return;
    if (message.requestId === session.id) {
      if (message.status === "available" && this.state.phase === "checking") {
        this.publish({ ...this.state, phase: "preparing", error: null });
        this.deadline(session, BUFFER_PREPARE_TIMEOUT_MS, "Audio setup did not finish. Enable reference audio again to retry.");
        this.sendSession(session, "arm");
      } else if (message.status === "armed" && this.state.phase === "preparing") {
        this.publish({ ...this.state, phase: "armed", error: null });
        this.deadline(session, BUFFER_ARM_TIMEOUT_MS,
          "Click the Libitu Chrome toolbar button on this tab to enable practice audio, or enable it again to retry.");
      } else if (message.status === "enabled" && ["preparing", "armed"].includes(this.state.phase)) {
        this.clearDeadline(session);
        this.lastObservation = null;
        this.lastSent = null;
        this.publish({ ...this.state, phase: "enabled", error: null });
        this.heartbeat(session);
      } else if (message.status === "coverage" && this.state.phase === "enabled") {
        const ranges = validatedRanges(message.ranges);
        if (!ranges || !Number.isInteger(message.retainedBytes) || (message.retainedBytes as number) < 0
          || (message.retainedBytes as number) > MAX_RETAINED_BYTES || typeof message.recording !== "boolean") return;
        if (message.retainedBytes === this.state.retainedBytes && message.recording === this.state.recording
          && ranges.length === this.state.ranges.length && ranges.every((range, index) =>
            range.start === this.state.ranges[index].start && range.end === this.state.ranges[index].end)) return;
        this.publish({ ...this.state, ranges, retainedBytes: message.retainedBytes as number, recording: message.recording });
      } else if (message.status === "closed" || message.status === "error") {
        this.failSession(session, messageText(message.error, "Practice audio disconnected. Enable it again to keep preparing references."));
      }
      return;
    }
    const request = typeof message.requestId === "string" ? this.requests.get(message.requestId) : undefined;
    if (!request || request.session !== session || request.sourceKey !== this.state.sourceKey) return;
    if (message.status === "missing") {
      // The ring can evict audio after its last progress event. Invalidate the
      // affected stale runs so a paused page does not keep promising availability.
      const ranges = this.state.ranges.filter((range) =>
        !(range.start <= request.range.start && range.end >= request.range.end));
      this.finish(request, null);
      if (ranges.length !== this.state.ranges.length) this.publish({ ...this.state, ranges });
    }
    else if (message.status === "error") this.finish(request, undefined,
      new Error(messageText(message.error, "This reference clip could not be prepared.")));
    else if (message.status === "complete") {
      try {
        const clip = decodeReference(message, request);
        this.finish(request, clip);
      } catch (error) { this.finish(request, undefined, error); }
    }
  }

  /** Reusable after React Strict Mode cleanup; no state notification after unmount. */
  dispose() {
    this.releaseSession(abortError("Practice audio was closed."));
    this.state = emptyBufferedReferenceState();
  }

  private send(request: BufferedReferenceRequest) {
    let contentId: string | undefined;
    let videoId: string | undefined;
    try {
      const [id, source] = JSON.parse(this.state.sourceKey ?? "null");
      contentId = id; videoId = new URL(source).searchParams.get("v") ?? undefined;
    } catch { /* An invalid identity is rejected by the extension. */ }
    this.environment.send({ ...request, contentId, videoId });
  }

  private sendObservation(telemetry: BufferedTelemetry) {
    const session = this.session;
    if (!session) return;
    this.lastSent = telemetry;
    try {
      this.send({ type: "LIBITU_BUFFER_REQUEST", version: 4, sessionId: session.id,
        requestId: session.id, action: "observe", telemetry });
    } catch { this.failSession(session, "The reference connection was interrupted. Enable practice audio again."); }
  }

  private sendSession(session: Session, action: "ping" | "arm" | "heartbeat") {
    if (this.session !== session) return;
    try {
      this.send({ type: "LIBITU_BUFFER_REQUEST", version: 4, sessionId: session.id,
        requestId: session.id, action });
    } catch { this.failSession(session, "The reference connection was interrupted. Enable practice audio again."); }
  }

  private heartbeat(session: Session) {
    if (this.session !== session) return;
    session.heartbeat = this.environment.setTimeout(() => {
      session.heartbeat = null;
      this.sendSession(session, "heartbeat");
      this.heartbeat(session);
    }, BUFFER_HEARTBEAT_MS);
  }

  private deadline(session: Session, milliseconds: number, message: string) {
    this.clearDeadline(session);
    session.deadline = this.environment.setTimeout(() => this.failSession(session, message), milliseconds);
  }

  private clearDeadline(session: Session) {
    if (session.deadline !== null) this.environment.clearTimeout(session.deadline);
    session.deadline = null;
  }

  private failSession(session: Session, error: string) {
    if (this.session !== session) return;
    this.releaseSession(new Error(error));
    this.publish({ ...emptyBufferedReferenceState(this.state.sourceKey), phase: "error", error });
  }

  private releaseSession(reason: Error) {
    const session = this.session;
    this.session = null;
    this.lastObservation = null;
    this.lastSent = null;
    for (const request of [...this.requests.values()]) this.finish(request, undefined, reason);
    if (!session) return;
    this.clearDeadline(session);
    if (session.heartbeat !== null) this.environment.clearTimeout(session.heartbeat);
    try {
      this.send({ type: "LIBITU_BUFFER_REQUEST", version: 4, sessionId: session.id,
        requestId: session.id, action: "close" });
    } catch { /* Local references are already released if the bridge disappeared. */ }
  }

  private finish(request: Extraction, clip?: ReferenceClip | null, error?: unknown) {
    if (this.requests.get(request.id) !== request) return;
    this.requests.delete(request.id);
    if (request.deadline !== null) this.environment.clearTimeout(request.deadline);
    request.detachAbort();
    if (error !== undefined) request.reject(error);
    else request.resolve(clip ?? null);
  }

  private publish(state: BufferedReferenceState) { this.state = state; this.change(state); }
}

function validRange(start: unknown, end: unknown): start is number {
  return typeof start === "number" && typeof end === "number" && Number.isFinite(start) && Number.isFinite(end)
    && start >= 0 && end > start && end <= MAX_SECONDS;
}

function validTelemetry(value: ReferenceTelemetry, generation: number): boolean {
  return [value.time, value.rate, value.wallTime, value.epochTime].every((number) => typeof number === "number" && Number.isFinite(number))
    && value.time >= 0 && value.time <= MAX_SECONDS && value.wallTime >= 0 && value.epochTime! > 0
    && value.rate > 0 && value.rate <= 16 && [-1, 0, 1, 2, 3, 5].includes(value.state)
    && Number.isSafeInteger(generation) && generation >= 0;
}

function validatedRanges(value: unknown): ReferenceRange[] | null {
  if (!Array.isArray(value) || value.length > MAX_RANGES) return null;
  const result: ReferenceRange[] = [];
  for (const range of value) {
    // Replayed sections overlap and capture order need not match video order.
    // Preserve each run as-is rather than merging away its continuity boundary.
    if (!range || typeof range !== "object" || !validRange(range.start, range.end)) return null;
    result.push({ start: range.start, end: range.end });
  }
  return result;
}

function decodeReference(message: Record<string, unknown>, request: Extraction): ReferenceClip {
  const failure = () => new Error("The extension returned an invalid or incomplete reference clip. Try listening to this sentence again.");
  const { audioBase64, durationMs, mimeType, captureId, start, end } = message;
  if (typeof audioBase64 !== "string" || audioBase64.length === 0 || audioBase64.length > MAX_BASE64_LENGTH
    || audioBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64)
    || mimeType !== "audio/wav" || typeof captureId !== "string" || !ID_PATTERN.test(captureId)
    || typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_150
    || typeof start !== "number" || !Number.isFinite(start) || Math.abs(start - request.range.start) > 0.001
    || typeof end !== "number" || !Number.isFinite(end) || Math.abs(end - request.range.end) > 0.001
    || Math.abs(durationMs - (request.range.end - request.range.start) * 1000) > 150) throw failure();
  const binary = atob(audioBase64);
  if (binary.length < 44 || binary.length > MAX_AUDIO_BYTES) throw failure();
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const sampleRate = view.getUint32(24, true);
  const dataBytes = view.getUint32(40, true);
  // The extension exports one deliberately narrow PCM-WAV format; arbitrary RIFF files are not accepted here.
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt " || tag(36) !== "data"
    || view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16
    || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1
    || sampleRate < 8_000 || sampleRate > 192_000 || view.getUint32(28, true) !== sampleRate * 2
    || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16
    || dataBytes !== bytes.length - 44 || dataBytes === 0 || dataBytes % 2 !== 0
    || Math.abs(dataBytes / (sampleRate * 2) * 1000 - durationMs) > 1) throw failure();
  return { blob: new Blob([bytes], { type: "audio/wav" }), sentenceId: request.sentenceId, captureId,
    rangeStart: request.range.start, rangeEnd: request.range.end,
    startOffsetMs: 0, endOffsetMs: dataBytes / (sampleRate * 2) * 1000 };
}

function messageText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.slice(0, 300) : fallback;
}
function abortError(message = "Reference preparation was cancelled."): Error {
  return new DOMException(message, "AbortError");
}
