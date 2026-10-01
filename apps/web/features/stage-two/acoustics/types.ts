export type AcousticInterval = { startMs: number; endMs: number };

export type AcousticIssue =
  | "silent"
  | "too_short"
  | "insufficient_speech"
  | "insufficient_pitch";

export type AcousticFeatures = {
  version: "local-acoustics-v1";
  durationMs: number;
  speechStartMs: number | null;
  speechEndMs: number | null;
  speechSpanMs: number | null;
  speechDurationMs: number;
  speechSegments: AcousticInterval[];
  internalPauses: AcousticInterval[];
  pauseCount: number;
  internalPauseDurationMs: number;
  rmsDbfs: number | null;
  pitchMedianHz: number | null;
  pitchRangeSemitones: number | null;
  voicedDurationMs: number;
  pitchCurve: { timeMs: number; hz: number | null; semitones: number | null; clarity: number }[];
  energyCurve: { timeMs: number; dbfs: number }[];
  /** Usable permits rhythm feedback. Pitch is separately gated by insufficient_pitch. */
  quality: { status: "usable" | "insufficient"; issues: AcousticIssue[] };
};

export type AcousticComparison = {
  status: "available" | "insufficient";
  /** Ratio of VAD speech spans; excludes leading/trailing capture silence. */
  durationRatio: number | null;
  speechDurationRatio: number | null;
  pauseCountDifference: number | null;
  pitchRangeDifferenceSemitones: number | null;
  issues: string[];
};

export type AcousticWindow = AcousticInterval;

export type AcousticWorkerRequest = {
  samples: Float32Array;
  sampleRate: number;
  assetOrigin: string;
};

export type AcousticWorkerResponse =
  | { type: "complete"; features: AcousticFeatures }
  | { type: "error"; message: string };
