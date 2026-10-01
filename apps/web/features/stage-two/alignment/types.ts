import type { SoundAnnotation } from "@libitu/types/stage-two";

export const LOCAL_ALIGNMENT_VERSION = "charsiu-en-fc-10ms-v1" as const;

export type LocalAlignedPhone = {
  /** Dictionary target, not recognized IPA. Stress is omitted for ambiguous variants. */
  phone: string;
  startMs: number;
  endMs: number;
};

export type LocalAlignedWord = {
  tokenIndex: number;
  token: string;
  startMs: number;
  endMs: number;
  /** First variant for the selected stressless path; collapsed stress may be unknown. */
  pronunciationIndex: number;
  phones: LocalAlignedPhone[];
};

/** Acoustic boundaries conditioned on caption/lexicon text, never content verification. */
export type LocalReferenceAlignment = {
  status: "ready" | "unsupported" | "unreliable";
  engineVersion: typeof LOCAL_ALIGNMENT_VERSION;
  contentVerification: "not_independently_verified";
  phoneLabels: "dictionary_targets";
  durationMs: number;
  words: LocalAlignedWord[];
  reason?: string;
};

export type LocalAlignmentInput = {
  samples: Float32Array;
  sampleRate: number;
  annotation: SoundAnnotation;
  signal?: AbortSignal;
};

export type LocalAlignmentWorkerRequest = Omit<LocalAlignmentInput, "signal"> & { assetOrigin: string };
export type LocalAlignmentWorkerResponse =
  | { type: "complete"; result: LocalReferenceAlignment }
  | { type: "error"; message: string };
