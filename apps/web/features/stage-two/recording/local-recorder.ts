export type RecordingState = {
  phase: "idle" | "requesting" | "recording" | "stopping" | "ready" | "error";
  sentenceId: string | null;
  clip: { url: string; blob: Blob; mimeType: string; durationMs: number; sentenceId: string } | null;
  elapsedMs: number;
  error: string | null;
};

export const MAX_RECORDING_DURATION_MS = 60_000;
export const RECORDING_FINALIZATION_TIMEOUT_MS = 5_000;

type Timer = ReturnType<typeof globalThis.setTimeout>;

export type RecordingEnvironment = {
  getSupportError: () => string | null;
  getUserMedia: () => Promise<MediaStream>;
  createRecorder: (stream: MediaStream) => MediaRecorder;
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => Timer;
  clearTimeout: (timer: Timer) => void;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
};

const browserEnvironment: RecordingEnvironment = {
  getSupportError: () => {
    if (typeof window === "undefined" || !window.isSecureContext) {
      return "Microphone recording requires HTTPS or localhost.";
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      return "Microphone recording is unavailable in this browser. Try a current browser.";
    }
    return null;
  },
  getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
  createRecorder: (stream) => {
    for (const mimeType of ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"]) {
      if (typeof MediaRecorder.isTypeSupported !== "function" || !MediaRecorder.isTypeSupported(mimeType)) continue;
      try {
        return new MediaRecorder(stream, { mimeType });
      } catch {
        // A reported capability is not a guarantee that this encoder can initialize.
      }
    }
    return new MediaRecorder(stream);
  },
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url)
};

type Attempt = {
  sentenceId: string;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  startedAt: number | null;
  stoppedAt: number | null;
  tick: Timer | null;
  autoStop: Timer | null;
  finalizing: Timer | null;
  recorderListeners: (() => void)[];
  trackListeners: (() => void)[];
};

function stopStream(stream: MediaStream) {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Release the other tracks even if one device has already disconnected.
    }
  }
}

function recordingError(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was denied. Allow microphone access in your browser settings, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No available microphone was found. Connect a microphone, then try again.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "The microphone could not start. Check that it is connected and available, then try again.";
  }
  if (name === "NotSupportedError") {
    return "This browser could not record audio in a supported format. Try another browser.";
  }
  return "The recording could not be completed. Try recording again.";
}

/** Owns one temporary take. No media leaves the browser or survives disposal. */
export class LocalSentenceRecorder {
  private state: RecordingState = { phase: "idle", sentenceId: null, clip: null, elapsedMs: 0, error: null };
  private attempt: Attempt | null = null;
  private readonly environment: RecordingEnvironment;

  constructor(private readonly onChange: (state: RecordingState) => void, environment?: Partial<RecordingEnvironment>) {
    this.environment = { ...browserEnvironment, ...environment };
  }

  getSnapshot(): RecordingState {
    return this.state;
  }

  setSentence(sentenceId: string | null) {
    if (sentenceId === this.state.sentenceId) return;
    this.abandonAttempt();
    this.revokeClip();
    this.publish({ phase: "idle", sentenceId, clip: null, elapsedMs: 0, error: null });
  }

  async start(): Promise<void> {
    if (this.attempt || !this.state.sentenceId) return;
    const attempt: Attempt = {
      sentenceId: this.state.sentenceId,
      stream: null, recorder: null, chunks: [], startedAt: null, stoppedAt: null,
      tick: null, autoStop: null, finalizing: null, recorderListeners: [], trackListeners: []
    };
    this.attempt = attempt;
    // Publish before awaiting permission so rapid clicks cannot open competing sessions.
    this.publish({ ...this.state, phase: "requesting", elapsedMs: 0, error: null });
    if (this.attempt !== attempt) return;

    try {
      const supportError = this.environment.getSupportError();
      if (supportError) {
        this.fail(attempt, supportError);
        return;
      }
      const stream = await this.environment.getUserMedia();
      if (this.attempt !== attempt) {
        // Permission prompts cannot be aborted; a late grant must never retain the mic.
        stopStream(stream);
        return;
      }
      attempt.stream = stream;
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length || audioTracks.some((track) => track.readyState === "ended")) {
        this.fail(attempt, "The microphone disconnected. Reconnect it, then try again.");
        return;
      }
      for (const track of audioTracks) {
        const ended = () => this.fail(attempt, "The microphone disconnected. Reconnect it, then try again.");
        track.addEventListener("ended", ended);
        attempt.trackListeners.push(() => track.removeEventListener("ended", ended));
      }

      const recorder = this.environment.createRecorder(stream);
      attempt.recorder = recorder;
      const data = (event: BlobEvent) => {
        if (this.attempt === attempt && event.data.size > 0) attempt.chunks.push(event.data);
      };
      const stopped = () => this.finish(attempt);
      const failed = () => this.fail(attempt, "The recording was interrupted. Try recording again.");
      recorder.addEventListener("dataavailable", data);
      recorder.addEventListener("stop", stopped);
      recorder.addEventListener("error", failed);
      attempt.recorderListeners.push(
        () => recorder.removeEventListener("dataavailable", data),
        () => recorder.removeEventListener("stop", stopped),
        () => recorder.removeEventListener("error", failed)
      );
      attempt.startedAt = this.environment.now();
      recorder.start(250);
      if (this.attempt !== attempt) return;
      this.publish({ ...this.state, phase: "recording", elapsedMs: 0 });
      if (this.attempt !== attempt || this.state.phase !== "recording") return;
      attempt.autoStop = this.environment.setTimeout(() => {
        if (this.attempt === attempt) this.stop();
      }, MAX_RECORDING_DURATION_MS);
      this.scheduleTick(attempt);
    } catch (error) {
      this.fail(attempt, recordingError(error));
    }
  }

  stop() {
    const attempt = this.attempt;
    if (!attempt) return;
    if (this.state.phase === "requesting") {
      this.cancel();
      return;
    }
    if (this.state.phase !== "recording" || !attempt.recorder) return;
    attempt.stoppedAt = this.environment.now();
    this.clearCaptureTimers(attempt);
    this.removeTrackListeners(attempt);
    this.publish({ ...this.state, phase: "stopping", elapsedMs: this.elapsed(attempt) });
    if (this.attempt !== attempt) return;
    attempt.finalizing = this.environment.setTimeout(() => {
      this.fail(attempt, "The browser could not finish the recording. Try recording again.");
    }, RECORDING_FINALIZATION_TIMEOUT_MS);
    try {
      // The final dataavailable event is queued before stop. Only finish() creates a clip.
      if (attempt.recorder.state !== "inactive") attempt.recorder.stop();
    } catch (error) {
      this.fail(attempt, recordingError(error));
    } finally {
      this.releaseStream(attempt);
    }
  }

  cancel() {
    this.abandonAttempt();
    this.publish({ ...this.state, phase: this.state.clip ? "ready" : "idle", elapsedMs: this.state.clip?.durationMs ?? 0, error: null });
  }

  clear() {
    this.abandonAttempt();
    this.revokeClip();
    this.publish({ ...this.state, phase: "idle", clip: null, elapsedMs: 0, error: null });
  }

  /** Cleanup is silent and reusable, including React Strict Mode's effect replay. */
  dispose() {
    this.abandonAttempt();
    this.revokeClip();
    this.state = { phase: "idle", sentenceId: null, clip: null, elapsedMs: 0, error: null };
  }

  private publish(state: RecordingState) {
    this.state = state;
    this.onChange(state);
  }

  private elapsed(attempt: Attempt) {
    if (attempt.startedAt === null) return 0;
    return Math.max(0, (attempt.stoppedAt ?? this.environment.now()) - attempt.startedAt);
  }

  private scheduleTick(attempt: Attempt) {
    attempt.tick = this.environment.setTimeout(() => {
      if (this.attempt !== attempt || this.state.phase !== "recording") return;
      const elapsedMs = this.elapsed(attempt);
      if (elapsedMs >= MAX_RECORDING_DURATION_MS) {
        this.stop();
        return;
      }
      this.publish({ ...this.state, elapsedMs });
      if (this.attempt === attempt && this.state.phase === "recording") this.scheduleTick(attempt);
    }, 100);
  }

  private finish(attempt: Attempt) {
    if (this.attempt !== attempt) return;
    if (attempt.stoppedAt === null) {
      this.fail(attempt, "The recording stopped unexpectedly. Try recording again.");
      return;
    }
    try {
      const mimeType = attempt.recorder?.mimeType || attempt.chunks.find((chunk) => chunk.type)?.type || "";
      const blob = new Blob(attempt.chunks, { type: mimeType });
      if (!blob.size) {
        this.fail(attempt, "No audio was captured. Check your microphone and try recording again.");
        return;
      }
      const clip = {
        url: this.environment.createObjectURL(blob), blob, mimeType: blob.type,
        durationMs: this.elapsed(attempt), sentenceId: attempt.sentenceId
      };
      this.attempt = null;
      this.cleanup(attempt);
      this.revokeClip();
      this.publish({ ...this.state, phase: "ready", clip, elapsedMs: clip.durationMs, error: null });
    } catch (error) {
      this.fail(attempt, recordingError(error));
    }
  }

  private fail(attempt: Attempt, error: string) {
    if (this.attempt !== attempt) return;
    this.attempt = null;
    this.cleanup(attempt);
    this.publish({ ...this.state, phase: "error", elapsedMs: this.state.clip?.durationMs ?? 0, error });
  }

  private abandonAttempt() {
    const attempt = this.attempt;
    this.attempt = null;
    if (attempt) this.cleanup(attempt);
  }

  private clearCaptureTimers(attempt: Attempt) {
    if (attempt.tick !== null) this.environment.clearTimeout(attempt.tick);
    if (attempt.autoStop !== null) this.environment.clearTimeout(attempt.autoStop);
    attempt.tick = null;
    attempt.autoStop = null;
  }

  private removeTrackListeners(attempt: Attempt) {
    for (const remove of attempt.trackListeners.splice(0)) remove();
  }

  private releaseStream(attempt: Attempt) {
    const stream = attempt.stream;
    attempt.stream = null;
    if (stream) stopStream(stream);
  }

  private cleanup(attempt: Attempt) {
    this.clearCaptureTimers(attempt);
    if (attempt.finalizing !== null) this.environment.clearTimeout(attempt.finalizing);
    attempt.finalizing = null;
    for (const remove of attempt.recorderListeners.splice(0)) remove();
    this.removeTrackListeners(attempt);
    try {
      if (attempt.recorder && attempt.recorder.state !== "inactive") attempt.recorder.stop();
    } catch {
      // Track ownership is released even if the native recorder is already broken.
    }
    this.releaseStream(attempt);
    attempt.chunks.length = 0;
  }

  private revokeClip() {
    if (this.state.clip) this.environment.revokeObjectURL(this.state.clip.url);
  }
}
