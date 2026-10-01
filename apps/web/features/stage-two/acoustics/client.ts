import { validateAudioWindow } from "./window.ts";
import type { AcousticFeatures, AcousticWindow, AcousticWorkerRequest, AcousticWorkerResponse } from "./types.ts";

export type { AcousticFeatures, AcousticComparison, AcousticWindow } from "./types.ts";
export { compareAcoustics } from "./comparison.ts";

const MAX_BLOB_BYTES = 32 * 1024 * 1024;
const ANALYSIS_TIMEOUT_MS = 90_000;

/** Decodes and analyzes in the browser. No audio is sent to any server. */
export function analyzeLocalAudio(blob: Blob, signal?: AbortSignal, window?: AcousticWindow): Promise<AcousticFeatures> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Audio analysis cancelled.", "AbortError"));
      return;
    }
    if (!blob.size || blob.size > MAX_BLOB_BYTES) {
      reject(new Error("The recording is empty or too large to analyze locally."));
      return;
    }
    if (typeof AudioContext === "undefined" || typeof Worker === "undefined") {
      reject(new Error("Local audio analysis is unavailable in this browser."));
      return;
    }
    let finished = false;
    let context: AudioContext | null = null;
    let worker: Worker | null = null;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker?.terminate();
      worker = null;
      if (context) void context.close().catch(() => undefined);
      context = null;
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };
    const abort = () => fail(new DOMException("Audio analysis cancelled.", "AbortError"));
    const timeout = setTimeout(() => fail(new Error("Local analysis took too long. Please try a shorter recording.")), ANALYSIS_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    void (async () => {
      context = new AudioContext();
      const encoded = await blob.arrayBuffer();
      if (finished) return;
      const decoded = await context.decodeAudioData(encoded);
      if (finished) return;
      const range = validateAudioWindow(decoded.duration * 1000, window);
      if (decoded.numberOfChannels > 2 || decoded.numberOfChannels < 1) throw new Error("Only mono or stereo recordings can be analyzed locally.");
      const start = Math.floor(range.startMs * decoded.sampleRate / 1000);
      const end = Math.min(decoded.length, Math.ceil(range.endMs * decoded.sampleRate / 1000));
      const samples = new Float32Array(end - start);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const source = decoded.getChannelData(channel);
        for (let index = 0; index < samples.length; index++) samples[index] += source[start + index] / decoded.numberOfChannels;
      }
      await context.close();
      context = null;
      if (finished) return;
      worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" });
      worker.onerror = () => fail(new Error("The local analysis worker could not start. Please reload and retry."));
      worker.onmessageerror = () => fail(new Error("The local analysis result could not be read."));
      worker.onmessage = ({ data }: MessageEvent<AcousticWorkerResponse>) => {
        if (finished) return;
        if (data.type === "error") {
          fail(new Error(data.message));
        } else if (data.type === "complete") {
          finished = true;
          cleanup();
          resolve(data.features);
        }
      };
      const request: AcousticWorkerRequest = { samples, sampleRate: decoded.sampleRate, assetOrigin: location.origin };
      worker.postMessage(request, [samples.buffer]);
    })().catch((error: unknown) => fail(error instanceof Error ? error : new Error("The recording could not be decoded for local analysis.")));
  });
}
