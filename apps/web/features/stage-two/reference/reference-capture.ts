export type ReferenceRange = { start: number; end: number };
export type ReferenceTelemetry = { time: number; state: number; rate: number; wallTime: number; epochTime?: number };
export type ReferenceClip = {
  blob: Blob;
  /** One continuous capture; never interchangeable with another recording of the same sentence. */
  captureId?: string;
  sentenceId: string;
  rangeStart: number;
  rangeEnd: number;
  /** Browser telemetry estimates relative to the encoded capture, not acoustic alignment. */
  startOffsetMs: number;
  endOffsetMs: number;
};
export type ReferenceCaptureState = {
  sessionPhase: "idle" | "checking" | "armed" | "enabling" | "enabled" | "error";
  phase: "idle" | "starting" | "capturing" | "stopping" | "ready" | "error";
  sentenceId: string | null;
  clip: ReferenceClip | null;
  elapsedMs: number;
  error: string | null;
  sessionError: string | null;
};
export type ReferenceRequest = {
  type: "LIBITU_REFERENCE_REQUEST";
  version: 2;
  sessionId: string;
  requestId: string;
  action: "ping" | "arm" | "begin" | "stop" | "cancel" | "close" | "heartbeat";
  sentenceId?: string;
  start?: number;
  end?: number;
};
type Timer = ReturnType<typeof globalThis.setTimeout>;
export type ReferenceEnvironment = {
  send(request: ReferenceRequest): void;
  requestId(): string;
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): Timer;
  clearTimeout(timer: Timer): void;
};
export const REFERENCE_PING_TIMEOUT_MS = 2_000;
// The extension bounds the toolbar wait (30s) and stream initialization (10s).
export const REFERENCE_ARM_TIMEOUT_MS = 40_000;
export const REFERENCE_ENCODER_TIMEOUT_MS = 5_000;
export const REFERENCE_START_TIMEOUT_MS = 3_000;
export const REFERENCE_FINISH_TIMEOUT_MS = 6_000;
export const REFERENCE_HEARTBEAT_MS = 10_000;
export const REFERENCE_MAX_SECONDS = 60;
const END_TOLERANCE_SECONDS = 0.12;
const MAX_ENCODED_LENGTH = 8 * 1024 * 1024;
const ID_PATTERN = /^[a-zA-Z0-9.:_-]{1,200}$/;

const browserEnvironment: ReferenceEnvironment = {
  send: (request) => window.postMessage(request, window.location.origin),
  requestId: () => crypto.randomUUID(),
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (timer) => globalThis.clearTimeout(timer)
};

type Session = { id: string; deadline: Timer | null; heartbeat: Timer | null };
type Attempt = {
  requestId: string;
  session: Session;
  sentenceId: string;
  range: ReferenceRange;
  deadline: Timer | null;
  captureDeadline: Timer | null;
  captureStartedAt: number | null;
  first: ReferenceTelemetry | null;
  previous: ReferenceTelemetry | null;
  startOffsetMs: number | null;
  endOffsetMs: number | null;
};

function initialState(): ReferenceCaptureState {
  return { sessionPhase: "idle", phase: "idle", sentenceId: null, clip: null,
    elapsedMs: 0, error: null, sessionError: null };
}

/** One tab authorization supports many bounded, individually validated sentence captures. */
export class ReferenceCaptureController {
  private state = initialState();
  private range: ReferenceRange | null = null;
  private session: Session | null = null;
  private attempt: Attempt | null = null;
  private eligible = false;
  private referenceReady = false;
  private nativeRetryBlocked = false;
  private nativeState: number | null = null;
  private readonly environment: ReferenceEnvironment;

  constructor(private readonly events: {
    change(state: ReferenceCaptureState): void;
    prepare(range: ReferenceRange): void;
    play(): void;
    pause(): void;
  }, environment?: Partial<ReferenceEnvironment>) {
    this.environment = { ...browserEnvironment, ...environment };
  }

  getSnapshot(): ReferenceCaptureState { return this.state; }
  isBusy(): boolean { return this.attempt !== null; }
  setEligible(eligible: boolean) { this.eligible = eligible; }
  setReferenceReady(ready: boolean) { this.referenceReady = ready; }

  setSentence(sentenceId: string | null, range: ReferenceRange | null) {
    if (sentenceId === this.state.sentenceId && range?.start === this.range?.start && range?.end === this.range?.end) return;
    this.abandonAttempt();
    this.range = range ? { ...range } : null;
    this.referenceReady = false;
    this.nativeRetryBlocked = false;
    this.publish({ ...this.state, sentenceId, clip: null, phase: "idle", elapsedMs: 0, error: null });
  }

  /** Enabling never starts playback or a MediaRecorder. The toolbar grants one tab session. */
  enable() {
    if (this.session) return;
    const session: Session = { id: this.environment.requestId(), deadline: null, heartbeat: null };
    this.session = session;
    this.publish({ ...this.state, sessionPhase: "checking", sessionError: null });
    if (this.session !== session) return;
    this.sessionDeadline(session, REFERENCE_PING_TIMEOUT_MS,
      "The Libitu Chrome extension is unavailable. Enable it, reload this page, and try again.");
    this.sendSession(session, "ping");
  }

  /** Returns true when capture owns playback, false when the caller should play normally. */
  play(): boolean {
    if (this.attempt) return true;
    this.nativeRetryBlocked = false;
    return this.begin();
  }

  private canCapture(): boolean {
    const { sentenceId } = this.state;
    const range = this.range;
    return Boolean(this.session && this.state.sessionPhase === "enabled" && this.eligible
      && !this.referenceReady && !this.state.clip && sentenceId && ID_PATTERN.test(sentenceId) && range
      && Number.isFinite(range.start) && Number.isFinite(range.end) && range.start >= 0
      && range.end > range.start && range.end - range.start <= REFERENCE_MAX_SECONDS);
  }

  private begin(): boolean {
    if (!this.canCapture() || this.attempt) return false;
    const attempt: Attempt = {
      session: this.session!, requestId: this.environment.requestId(), sentenceId: this.state.sentenceId!,
      range: { ...this.range! }, deadline: null, captureDeadline: null,
      captureStartedAt: null, first: null, previous: null, startOffsetMs: null, endOffsetMs: null
    };
    this.attempt = attempt;
    this.publish({ ...this.state, phase: "starting", error: null, elapsedMs: 0 });
    if (this.attempt !== attempt) return true;
    try {
      this.events.prepare(attempt.range);
      if (this.attempt !== attempt) return true;
      this.setDeadline(attempt, REFERENCE_ENCODER_TIMEOUT_MS, () => this.fail(attempt,
        "Reference capture could not start. Press Play sentence to try again."));
      this.sendAttempt(attempt, "begin");
    } catch {
      this.fail(attempt, "The reference player could not be prepared. Try again after the video is ready.");
    }
    return true;
  }

  /** Caller verifies MessageEvent source and origin before passing the data here. */
  handleMessage(value: unknown) {
    if (!value || typeof value !== "object") return;
    const message = value as Record<string, unknown>;
    const session = this.session;
    if (!session || message.type !== "LIBITU_REFERENCE_EVENT" || message.version !== 2
      || message.sessionId !== session.id) return;
    if (message.requestId === session.id) {
      if (message.status === "available" && this.state.sessionPhase === "checking") {
        this.publish({ ...this.state, sessionPhase: "armed", sessionError: null });
        if (this.session !== session) return;
        this.sessionDeadline(session, REFERENCE_ARM_TIMEOUT_MS,
          "Reference audio was not enabled. Enable it again, then click the Libitu toolbar button on this tab.");
        this.sendSession(session, "arm");
      } else if (message.status === "enabled" && (this.state.sessionPhase === "armed" || this.state.sessionPhase === "enabling")) {
        this.clearSessionDeadline(session);
        this.nativeRetryBlocked = false;
        this.publish({ ...this.state, sessionPhase: "enabled", sessionError: null });
        if (this.session === session) this.heartbeat(session);
      } else if (message.status === "error" || message.status === "closed") {
        this.failSession(session, typeof message.error === "string" && message.error
          ? message.error.slice(0, 300) : "Reference audio is no longer enabled. Enable it again to continue automatic capture.");
      }
      return;
    }
    const attempt = this.attempt;
    if (!attempt || attempt.session !== session || message.requestId !== attempt.requestId) return;
    if (message.status === "error") {
      this.fail(attempt, typeof message.error === "string" && message.error
        ? message.error.slice(0, 300) : "Reference capture was interrupted. Press Play sentence to try again.");
    } else if (message.status === "cancelled") {
      this.cancel();
    } else if (message.status === "recording" && this.state.phase === "starting" && attempt.captureStartedAt === null) {
      const capturedAt = message.captureStartedAt;
      const now = this.environment.now();
      if (typeof capturedAt !== "number" || !Number.isFinite(capturedAt) || capturedAt > now + 150 || now - capturedAt > 3000) {
        this.fail(attempt, "Reference capture timing could not be verified. Press Play sentence to try again.");
        return;
      }
      attempt.captureStartedAt = capturedAt;
      this.setDeadline(attempt, REFERENCE_START_TIMEOUT_MS, () => this.fail(attempt,
        "The video did not start at the sentence boundary. Let it load, then press Play sentence again."));
      attempt.captureDeadline = this.environment.setTimeout(() => this.fail(attempt,
        "Reference capture took too long. Press Play sentence to try again with uninterrupted playback."),
      (attempt.range.end - attempt.range.start) * 1000 + REFERENCE_START_TIMEOUT_MS + 1000);
      this.events.play();
    } else if (message.status === "complete" && this.state.phase === "stopping") {
      this.finish(attempt, message);
    }
  }

  sample(sample: ReferenceTelemetry) {
    const priorNativeState = this.nativeState;
    this.nativeState = sample.state;
    const attempt = this.attempt;
    if (!attempt) {
      // Only a new native Play edge is an action; enabling or recurring samples never autoplay.
      if (sample.state === 1 && priorNativeState !== null && priorNativeState !== 1
        && !this.nativeRetryBlocked && this.canCapture() && Math.abs(sample.rate - 1) <= 0.01
        && Number.isFinite(sample.time) && Math.abs(sample.time - this.range!.start) <= 0.15) this.begin();
      return;
    }
    if (this.state.phase === "stopping") return;
    // Preparing/pausing the player and starting the encoder can emit native events synchronously.
    if (attempt.captureStartedAt === null) return;
    if (![sample.time, sample.rate, sample.wallTime, sample.epochTime].every((value) => typeof value === "number" && Number.isFinite(value))) {
      this.fail(attempt, "Reference playback timing is unavailable. Press Play sentence to try again.");
      return;
    }
    if (Math.abs(sample.rate - 1) > 0.01) {
      this.fail(attempt, "Reference capture needs uninterrupted playback at 1× speed. Press Play sentence to try again.");
      return;
    }
    if (!this.eligible) {
      this.cancel();
      return;
    }
    if (!attempt.first) {
      if (sample.state !== 1) return;
      if (Math.abs(sample.time - attempt.range.start) > 0.15) {
        this.fail(attempt, "Playback did not start at the selected sentence. Press Play sentence to try again.");
        return;
      }
      const offset = sample.epochTime! - attempt.captureStartedAt - (sample.time - attempt.range.start) * 1000;
      if (offset < -150 || offset > REFERENCE_START_TIMEOUT_MS + 150) {
        this.fail(attempt, "Reference capture timing could not be verified. Press Play sentence to try again.");
        return;
      }
      attempt.startOffsetMs = Math.max(0, offset);
      attempt.first = sample;
      attempt.previous = sample;
      this.clearDeadline(attempt);
      this.publish({ ...this.state, phase: "capturing" });
      return;
    }
    const previous = attempt.previous!;
    const wallDelta = (sample.wallTime - previous.wallTime) / 1000;
    const mediaDelta = sample.time - previous.time;
    const wallTotal = (sample.wallTime - attempt.first.wallTime) / 1000;
    const mediaTotal = sample.time - attempt.first.time;
    const epochDelta = sample.epochTime! - previous.epochTime!;
    if (wallDelta < 0 || wallDelta > 1 || Math.abs(epochDelta - wallDelta * 1000) > 150
      || mediaDelta < -0.08 || Math.abs(mediaDelta - wallDelta) > 0.25 || Math.abs(mediaTotal - wallTotal) > 0.4) {
      this.fail(attempt, "Playback jumped or stalled during capture. Keep the sentence playing continuously and try again.");
      return;
    }
    attempt.previous = sample;
    const atEnd = sample.time >= attempt.range.end
      || ((sample.state === 0 || sample.state === 2) && sample.time >= attempt.range.end - END_TOLERANCE_SECONDS);
    if (atEnd) {
      attempt.endOffsetMs = attempt.startOffsetMs! + (attempt.range.end - attempt.range.start) * 1000;
      this.publish({ ...this.state, phase: "stopping", elapsedMs: (attempt.range.end - attempt.range.start) * 1000 });
      if (this.attempt !== attempt) return;
      this.clearCaptureDeadline(attempt);
      this.setDeadline(attempt, REFERENCE_FINISH_TIMEOUT_MS, () => this.fail(attempt,
        "The extension could not finish the reference recording. Press Play sentence to try again."));
      this.sendAttempt(attempt, "stop");
      this.events.pause();
      return;
    }
    if (sample.state !== 1) {
      this.fail(attempt, "Playback paused or buffered during capture. Let the video load, then try again.");
      return;
    }
    this.publish({ ...this.state, elapsedMs: Math.max(0, (sample.time - attempt.range.start) * 1000) });
  }

  /** Cancel the encoder while retaining tab authorization and an earlier reference. */
  cancel() {
    if (this.attempt) this.nativeRetryBlocked = true;
    this.abandonAttempt();
    this.publish({ ...this.state, phase: this.state.clip ? "ready" : "idle", elapsedMs: 0, error: null });
  }

  /** Disable tab access while preserving a current reference and the parent's derived cache. */
  disable() {
    this.abandonAttempt();
    this.closeSession();
    this.publish({ ...this.state, sessionPhase: "idle", sessionError: null,
      phase: this.state.clip ? "ready" : "idle", elapsedMs: 0, error: null });
  }

  clear() {
    this.disable();
    this.referenceReady = false;
    this.publish({ ...this.state, phase: "idle", clip: null });
  }

  releaseClip(clip?: ReferenceClip) {
    if (!this.state.clip || (clip && this.state.clip !== clip)) return;
    this.publish({ ...this.state, clip: null, phase: this.state.phase === "ready" ? "idle" : this.state.phase });
  }

  /** Silent, reusable cleanup supports React Strict Mode effect replay. */
  dispose() {
    this.abandonAttempt();
    this.closeSession();
    this.range = null;
    this.referenceReady = false;
    this.eligible = false;
    this.nativeRetryBlocked = false;
    this.nativeState = null;
    this.state = initialState();
  }

  private finish(attempt: Attempt, message: Record<string, unknown>) {
    const encoded = message.audioBase64;
    const mimeType = message.mimeType;
    const durationMs = message.durationMs;
    if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > MAX_ENCODED_LENGTH
      || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
      || typeof mimeType !== "string" || !/^audio\/(webm|ogg|mp4|wav)(?:;[^\r\n]*)?$/i.test(mimeType)
      || typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 65_000
      || attempt.startOffsetMs === null || attempt.endOffsetMs === null
      || attempt.endOffsetMs > durationMs + 150 || attempt.startOffsetMs >= durationMs) {
      this.fail(attempt, "The extension returned an incomplete reference recording. Press Play sentence to try again.");
      return;
    }
    try {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      if (!bytes.length) throw new Error("Empty capture");
      const clip: ReferenceClip = {
        blob: new Blob([bytes], { type: mimeType }), sentenceId: attempt.sentenceId, captureId: attempt.requestId,
        rangeStart: attempt.range.start, rangeEnd: attempt.range.end,
        startOffsetMs: attempt.startOffsetMs, endOffsetMs: Math.min(attempt.endOffsetMs, durationMs)
      };
      this.attempt = null;
      this.clearTimers(attempt);
      this.events.pause();
      this.publish({ ...this.state, clip, phase: "ready", error: null, elapsedMs: clip.endOffsetMs - clip.startOffsetMs });
    } catch {
      this.fail(attempt, "The reference recording could not be read. Press Play sentence to try again.");
    }
  }

  private publish(state: ReferenceCaptureState) { this.state = state; this.events.change(state); }
  private sendSession(session: Session, action: "ping" | "arm" | "close" | "heartbeat") {
    try {
      this.environment.send({ type: "LIBITU_REFERENCE_REQUEST", version: 2, sessionId: session.id, requestId: session.id, action });
    } catch {
      if (action !== "close") this.failSession(session, "The extension connection was interrupted. Enable reference audio again.");
    }
  }
  private sendAttempt(attempt: Attempt, action: "begin" | "stop" | "cancel") {
    try {
      this.environment.send({ type: "LIBITU_REFERENCE_REQUEST", version: 2, sessionId: attempt.session.id,
        requestId: attempt.requestId, action, sentenceId: attempt.sentenceId, ...attempt.range });
    } catch {
      if (action !== "cancel") this.fail(attempt, "The extension connection was interrupted. Press Play sentence to try again.");
    }
  }
  private sessionDeadline(session: Session, delay: number, error: string) {
    this.clearSessionDeadline(session);
    session.deadline = this.environment.setTimeout(() => this.failSession(session, error), delay);
  }
  private clearSessionDeadline(session: Session) {
    if (session.deadline !== null) this.environment.clearTimeout(session.deadline);
    session.deadline = null;
  }
  private heartbeat(session: Session) {
    if (session.heartbeat !== null) this.environment.clearTimeout(session.heartbeat);
    session.heartbeat = this.environment.setTimeout(() => {
      if (this.session !== session || this.state.sessionPhase !== "enabled") return;
      this.sendSession(session, "heartbeat");
      if (this.session === session) this.heartbeat(session);
    }, REFERENCE_HEARTBEAT_MS);
  }
  private closeSession() {
    const session = this.session;
    this.session = null;
    if (!session) return;
    this.clearSessionDeadline(session);
    if (session.heartbeat !== null) this.environment.clearTimeout(session.heartbeat);
    session.heartbeat = null;
    this.sendSession(session, "close");
  }
  private failSession(session: Session, error: string) {
    if (this.session !== session) return;
    this.abandonAttempt();
    this.closeSession();
    this.publish({ ...this.state, sessionPhase: "error", sessionError: error,
      phase: this.state.clip ? "ready" : "idle", elapsedMs: 0 });
  }
  private setDeadline(attempt: Attempt, delay: number, callback: () => void) {
    this.clearDeadline(attempt);
    attempt.deadline = this.environment.setTimeout(() => { if (this.attempt === attempt) callback(); }, delay);
  }
  private clearDeadline(attempt: Attempt) {
    if (attempt.deadline !== null) this.environment.clearTimeout(attempt.deadline);
    attempt.deadline = null;
  }
  private clearCaptureDeadline(attempt: Attempt) {
    if (attempt.captureDeadline !== null) this.environment.clearTimeout(attempt.captureDeadline);
    attempt.captureDeadline = null;
  }
  private clearTimers(attempt: Attempt) { this.clearDeadline(attempt); this.clearCaptureDeadline(attempt); }
  private abandonAttempt() {
    const attempt = this.attempt;
    this.attempt = null;
    if (!attempt) return;
    this.clearTimers(attempt);
    this.sendAttempt(attempt, "cancel");
    this.events.pause();
  }
  private fail(attempt: Attempt, error: string) {
    if (this.attempt !== attempt) return;
    this.nativeRetryBlocked = true;
    this.abandonAttempt();
    this.publish({ ...this.state, phase: "error", error, elapsedMs: 0 });
  }
}
