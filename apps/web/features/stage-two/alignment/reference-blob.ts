import type { ReferenceAlignmentSource } from "../analysis/reference-analysis-cache.ts";
import type { AcousticWindow } from "../acoustics/types.ts";
import { validateAudioWindow } from "../acoustics/window.ts";
import { fetchSoundAnnotation } from "../sound/sound-api.ts";
import { alignLocalReference } from "./client.ts";

/** Only the sentence's dictionary is requested from the API. Audio never leaves this browser. */
export async function alignReferenceBlob(blob: Blob, signal: AbortSignal, window: AcousticWindow, source: ReferenceAlignmentSource) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  deadline.throwIfAborted();
  if (!blob.size || blob.size > 12 * 1024 * 1024) throw new Error("The reference is empty or too large for local alignment.");
  if (typeof AudioContext === "undefined" || typeof Worker === "undefined") throw new Error("Local word alignment is unavailable in this browser.");
  const [annotation, bytes] = await Promise.all([fetchSoundAnnotation(source, deadline), blob.arrayBuffer()]);
  deadline.throwIfAborted();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const audioSha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  deadline.throwIfAborted();
  const context = new AudioContext();
  const close = () => { if (context.state !== "closed") void context.close().catch(() => undefined); };
  deadline.addEventListener("abort", close, { once: true });
  try {
    const decoded = await context.decodeAudioData(bytes);
    deadline.throwIfAborted();
    const range = validateAudioWindow(decoded.duration * 1000, window);
    if (decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2) throw new Error("Only mono or stereo reference audio can be aligned locally.");
    const start = Math.floor(range.startMs * decoded.sampleRate / 1000);
    const end = Math.min(decoded.length, Math.ceil(range.endMs * decoded.sampleRate / 1000));
    const samples = new Float32Array(end - start);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const input = decoded.getChannelData(channel);
      for (let index = 0; index < samples.length; index++) samples[index] += input[start + index] / decoded.numberOfChannels;
    }
    close();
    const result = await alignLocalReference({ samples, sampleRate: decoded.sampleRate, annotation, signal: deadline });
    deadline.throwIfAborted();
    return { result, audioSha256 };
  } finally {
    deadline.removeEventListener("abort", close);
    close();
  }
}
