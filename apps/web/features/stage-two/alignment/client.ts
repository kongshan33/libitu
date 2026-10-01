import { alignmentUnavailable, buildAlignmentGraph, MAX_ALIGNMENT_SECONDS } from "./engine.ts";
import type { LocalAlignmentInput, LocalAlignmentWorkerRequest, LocalAlignmentWorkerResponse, LocalReferenceAlignment } from "./types.ts";

/** A dedicated, cancellable browser worker receives PCM; no audio leaves the device. */
export function alignLocalReference(input: LocalAlignmentInput): Promise<LocalReferenceAlignment> {
  const { samples, sampleRate, annotation, signal } = input;
  if (signal?.aborted) return Promise.reject(new DOMException("Local alignment cancelled.", "AbortError"));
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || !samples.length) return Promise.reject(new Error("Invalid local alignment audio."));
  const durationMs = samples.length / sampleRate * 1000;
  if (durationMs > MAX_ALIGNMENT_SECONDS * 1000) return Promise.resolve(alignmentUnavailable("unsupported", durationMs, `Local word alignment supports sentences up to ${MAX_ALIGNMENT_SECONDS} seconds. Listening and recording remain available.`));
  if (durationMs < 400) return Promise.resolve(alignmentUnavailable("unreliable", durationMs, "The audio is too short for local phone alignment."));
  const graph = buildAlignmentGraph(annotation);
  if (typeof graph === "string") return Promise.resolve(alignmentUnavailable("unsupported", durationMs, graph));
  if (typeof Worker === "undefined") return Promise.reject(new Error("Local word alignment is unavailable in this browser."));
  return new Promise((resolve, reject) => {
    let finished = false;
    let worker: Worker | null = null;
    const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); worker?.terminate(); worker = null; };
    const fail = (error: Error) => { if (finished) return; finished = true; cleanup(); reject(error); };
    const abort = () => fail(new DOMException("Local alignment cancelled.", "AbortError"));
    const timeout = setTimeout(() => fail(new Error("Local word alignment took too long. Please try a shorter sentence.")), 180_000);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      worker = new Worker(new URL("./alignment.worker.ts", import.meta.url), { type: "module", name: "reference-alignment" });
      worker.onerror = () => fail(new Error("The local word alignment worker could not start. Please reload and retry."));
      worker.onmessageerror = () => fail(new Error("The local word alignment result could not be read."));
      worker.onmessage = ({ data }: MessageEvent<LocalAlignmentWorkerResponse>) => {
        if (finished) return;
        if (data.type === "error") { fail(new Error(data.message)); return; }
        if (data.type === "complete") { finished = true; cleanup(); resolve(data.result); }
      };
      const copy = samples.slice();
      const request: LocalAlignmentWorkerRequest = { samples: copy, sampleRate, annotation, assetOrigin: location.origin };
      worker.postMessage(request, [copy.buffer]);
    } catch (error) { fail(error instanceof Error ? error : new Error("Local word alignment could not start.")); }
  });
}
