import * as ort from "onnxruntime-web/wasm";
import { ACOUSTIC_ASSET_PATH } from "../acoustics/assets";
import { resampleMono, rmsDbfs } from "../acoustics/signal";
import { ALIGNMENT_ASSET_PATH, ALIGNMENT_MODEL_BYTES, ALIGNMENT_MODEL_FILE, ALIGNMENT_MODEL_SHA256 } from "./assets";
import { alignmentUnavailable, alignPhoneLogits, buildAlignmentGraph, MAX_ALIGNMENT_SECONDS, normalizeAlignmentAudio } from "./engine";
import type { LocalAlignmentWorkerRequest, LocalAlignmentWorkerResponse } from "./types";

const worker = self as unknown as {
  location: Location;
  onmessage: ((event: MessageEvent<LocalAlignmentWorkerRequest>) => void) | null;
  postMessage: (message: LocalAlignmentWorkerResponse) => void;
};
let started = false;
worker.onmessage = async ({ data }) => {
  if (started) return;
  started = true;
  let session: ort.InferenceSession | null = null;
  let input: ort.Tensor | null = null;
  let outputs: ort.InferenceSession.ReturnType | null = null;
  try {
    if (data.assetOrigin !== worker.location.origin) throw new Error("Local alignment model origin mismatch.");
    const durationMs = data.samples.length / data.sampleRate * 1000;
    if (!Number.isFinite(durationMs) || durationMs > MAX_ALIGNMENT_SECONDS * 1000 || durationMs < 400) throw new Error("Unsupported local alignment duration.");
    const graph = buildAlignmentGraph(data.annotation);
    if (typeof graph === "string") {
      worker.postMessage({ type: "complete", result: alignmentUnavailable("unsupported", durationMs, graph) });
      return;
    }
    const samples = resampleMono(data.samples, data.sampleRate);
    if (rmsDbfs(samples) < -60) {
      worker.postMessage({ type: "complete", result: alignmentUnavailable("unreliable", durationMs, "The audio is too quiet for local phone alignment.") });
      return;
    }
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = new URL(ACOUSTIC_ASSET_PATH, data.assetOrigin).href;
    const response = await fetch(new URL(`${ALIGNMENT_ASSET_PATH}${ALIGNMENT_MODEL_FILE}`, data.assetOrigin), { credentials: "same-origin" });
    if (!response.ok) throw new Error("The local word alignment model is unavailable. Reload and retry after the model has been prepared.");
    const model = await response.arrayBuffer();
    if (model.byteLength !== ALIGNMENT_MODEL_BYTES) throw new Error("The local alignment model has an invalid size.");
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", model)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== ALIGNMENT_MODEL_SHA256) throw new Error("The local alignment model failed its integrity check.");
    session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    input = new ort.Tensor("float32", normalizeAlignmentAudio(samples), [1, samples.length]);
    outputs = await session.run({ input_values: input });
    const logits = outputs.logits;
    if (!logits || logits.type !== "float32" || logits.dims.length !== 3 || logits.dims[0] !== 1) throw new Error("The local alignment model returned invalid output.");
    const result = alignPhoneLogits(logits.data as Float32Array, logits.dims[1], logits.dims[2], graph, durationMs);
    worker.postMessage({ type: "complete", result });
  } catch (error) {
    worker.postMessage({ type: "error", message: error instanceof Error ? error.message : "Local word alignment failed." });
  } finally {
    input?.dispose();
    if (outputs) for (const output of Object.values(outputs)) output.dispose();
    if (session) await session.release().catch(() => undefined);
  }
};
