import type { AcousticComparison, AcousticFeatures } from "./types.ts";

/** Describes timing/range differences; it cannot establish pronunciation correctness. */
export function compareAcoustics(reference: AcousticFeatures, user: AcousticFeatures): AcousticComparison {
  const issues = [
    ...reference.quality.issues.map((issue) => `reference_${issue}`),
    ...user.quality.issues.map((issue) => `user_${issue}`),
  ];
  const available = reference.quality.status === "usable" && user.quality.status === "usable" &&
    reference.speechSpanMs !== null && reference.speechSpanMs > 0 && user.speechSpanMs !== null &&
    reference.speechDurationMs > 0;
  return {
    status: available ? "available" : "insufficient",
    durationRatio: available ? user.speechSpanMs! / reference.speechSpanMs! : null,
    speechDurationRatio: available ? user.speechDurationMs / reference.speechDurationMs : null,
    pauseCountDifference: available ? user.pauseCount - reference.pauseCount : null,
    pitchRangeDifferenceSemitones: available && reference.pitchRangeSemitones !== null && user.pitchRangeSemitones !== null
      ? user.pitchRangeSemitones - reference.pitchRangeSemitones : null,
    issues,
  };
}
