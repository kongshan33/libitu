import type { AcousticFeatures } from "../acoustics/types";

type Input = { available: boolean; pending: boolean; error: string | null; features: AcousticFeatures | null };
export type SoundObservation = { status: "not_evaluated"; label: string; reason: string };

/** Sentence VAD/pitch has no aligned phone evidence. Even usable audio must abstain. */
export function soundObservation(input: Input): SoundObservation {
  const result = (label: string, reason: string): SoundObservation => ({ status: "not_evaluated", label, reason });
  if (input.pending) return result("Not evaluated", "Timing and pitch analysis is running; it does not check this sound.");
  if (input.error) return result("Not evaluated", "Audio analysis is unavailable. No sound judgement was made.");
  if (input.features?.quality.status === "insufficient") return result("Not evaluated", "The recording has too little usable speech for analysis.");
  if (!input.available && !input.features) return result("No recording", "No recording is available for this sentence.");
  return result("Not evaluated", "Checking this sound needs word and phoneme alignment plus a validated sound detector.");
}
