import { MAX_AUDIO_SECONDS } from "./signal.ts";
import type { AcousticWindow } from "./types.ts";

export function validateAudioWindow(durationMs: number, window?: AcousticWindow): AcousticWindow {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_AUDIO_SECONDS * 1000) {
    throw new Error("Audio analysis supports recordings up to 65 seconds.");
  }
  const selected = window ?? { startMs: 0, endMs: durationMs };
  if (!Number.isFinite(selected.startMs) || !Number.isFinite(selected.endMs) ||
      selected.startMs < 0 || selected.endMs <= selected.startMs || selected.endMs > durationMs) {
    throw new Error("The reference capture does not contain the complete selected sentence. Please capture it again.");
  }
  return selected;
}
