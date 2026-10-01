import * as ort from "onnxruntime-web/wasm";
import { ACOUSTIC_ASSET_PATH, SILERO_MODEL_FILE, SILERO_MODEL_SHA256 } from "./assets";
import { extractAcousticFeatures, VAD_FRAME_SAMPLES } from "./features";
import { resampleMono } from "./signal";
import type { AcousticWorkerRequest, AcousticWorkerResponse } from "./types";

// Each analysis owns one worker and one model session. Termination cancels inference.
const worker = self as unknown as {
  location: Location;
  onmessage: ((event: MessageEvent<AcousticWorkerRequest>) => void) | null;
  postMessage: (message: AcousticWorkerResponse) => void;
};
let started = false;
worker.onmessage = async ({ data }) => {
  if (started) return;
  started = true;
  let session: ort.InferenceSession | null = null;
  try {
    if (data.assetOrigin !== worker.location.origin) throw new Error("Local model origin mismatch.");
    const samples = resampleMono(data.samples, data.sampleRate);
    const assetBase = new URL(ACOUSTIC_ASSET_PATH, data.assetOrigin).href;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = assetBase;
    const response = await fetch(`${assetBase}${SILERO_MODEL_FILE}`, { credentials: "same-origin" });
    if (!response.ok) throw new Error("The local speech model is unavailable. Please retry after reloading.");
    const model = await response.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", model)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== SILERO_MODEL_SHA256) throw new Error("The local speech model failed its integrity check.");
    session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    const sampleRate = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
    let state: ort.Tensor = new ort.Tensor("float32", new Float32Array(256), [2, 1, 128]);
    const probabilities: number[] = [];
    try {
      for (let start = 0; start < samples.length; start += VAD_FRAME_SAMPLES) {
        const frame = new Float32Array(VAD_FRAME_SAMPLES);
        frame.set(samples.subarray(start, start + VAD_FRAME_SAMPLES));
        const input = new ort.Tensor("float32", frame, [1, VAD_FRAME_SAMPLES]);
        let output: ort.InferenceSession.ReturnType | null = null;
        try {
          output = await session.run({ input, state, sr: sampleRate });
          const probability = Number(output.output?.data[0]);
          if (!Number.isFinite(probability) || probability < 0 || probability > 1 || !output.stateN) {
            throw new Error("The local speech detector returned invalid data.");
          }
          probabilities.push(probability);
          state.dispose();
          state = output.stateN;
        } finally {
          input.dispose();
          if (output) for (const tensor of Object.values(output)) if (tensor !== state) tensor.dispose();
        }
      }
    } finally {
      state.dispose();
      sampleRate.dispose();
    }
    const features = extractAcousticFeatures(samples, probabilities);
    await session.release();
    session = null;
    worker.postMessage({ type: "complete", features });
  } catch (error) {
    if (session) await session.release().catch(() => undefined);
    worker.postMessage({ type: "error", message: error instanceof Error ? error.message : "Local acoustic analysis failed." });
  }
};
