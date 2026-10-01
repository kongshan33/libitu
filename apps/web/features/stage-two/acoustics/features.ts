import { PitchDetector } from "pitchy";
import { ANALYSIS_SAMPLE_RATE, quantile, rmsDbfs } from "./signal.ts";
import type { AcousticFeatures, AcousticInterval, AcousticIssue } from "./types.ts";

export const VAD_FRAME_SAMPLES = 512;
export const VAD_FRAME_MS = VAD_FRAME_SAMPLES / ANALYSIS_SAMPLE_RATE * 1000;
const HOP_SAMPLES = 160;
const PITCH_WINDOW_SAMPLES = 640;

/** Hysteresis on Silero probabilities, not an amplitude-based substitute for VAD. */
export function speechSegmentsFromProbabilities(probabilities: number[], durationMs: number): AcousticInterval[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || probabilities.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("Invalid voice detector output.");
  }
  const segments: AcousticInterval[] = [];
  let start: number | null = null;
  let quietStart: number | null = null;
  const finish = (end: number) => {
    if (start !== null && end - start >= 160) segments.push({ startMs: start, endMs: Math.min(end, durationMs) });
    start = null;
    quietStart = null;
  };
  probabilities.forEach((probability, index) => {
    const time = index * VAD_FRAME_MS;
    if (time >= durationMs) return;
    if (start === null) {
      if (probability >= 0.5) start = time;
    } else if (probability < 0.35) {
      quietStart ??= time;
      if (time + VAD_FRAME_MS - quietStart >= 160) finish(quietStart);
    } else {
      quietStart = null;
    }
  });
  if (start !== null) finish(quietStart ?? durationMs);
  return segments;
}

/** Input is mono 16 kHz PCM with a real detector result for every 512-sample frame. */
export function extractAcousticFeatures(samples: Float32Array, probabilities: number[]): AcousticFeatures {
  const durationMs = samples.length / ANALYSIS_SAMPLE_RATE * 1000;
  if (!samples.length || probabilities.length !== Math.ceil(samples.length / VAD_FRAME_SAMPLES)) {
    throw new Error("Voice detector output does not match the recording.");
  }
  const speechSegments = speechSegmentsFromProbabilities(probabilities, durationMs);
  const speechDurationMs = speechSegments.reduce((sum, segment) => sum + segment.endMs - segment.startMs, 0);
  const internalPauses = speechSegments.slice(1).flatMap((segment, index) => {
    const startMs = speechSegments[index].endMs;
    return segment.startMs - startMs >= 200 ? [{ startMs, endMs: segment.startMs }] : [];
  });
  const detector = PitchDetector.forFloat32Array(PITCH_WINDOW_SAMPLES);
  const frame = new Float32Array(PITCH_WINDOW_SAMPLES);
  const pitchCurve: AcousticFeatures["pitchCurve"] = [];
  const energyCurve: AcousticFeatures["energyCurve"] = [];
  const pitches: number[] = [];
  let segmentIndex = 0;
  let voicedDurationMs = 0;
  for (let start = 0; start < samples.length; start += HOP_SAMPLES) {
    // A centered window keeps pitch/energy coordinates on the VAD time axis.
    frame.fill(0);
    const frameStart = start - PITCH_WINDOW_SAMPLES / 2;
    const availableStart = Math.max(0, frameStart);
    const availableEnd = Math.min(samples.length, frameStart + PITCH_WINDOW_SAMPLES);
    frame.set(samples.subarray(availableStart, availableEnd), availableStart - frameStart);
    const timeMs = start / ANALYSIS_SAMPLE_RATE * 1000;
    const dbfs = rmsDbfs(frame);
    energyCurve.push({ timeMs, dbfs });
    while (segmentIndex < speechSegments.length && timeMs >= speechSegments[segmentIndex].endMs) segmentIndex++;
    const segment = speechSegments[segmentIndex];
    const isSpeech = segment && timeMs >= segment.startMs && timeMs < segment.endMs;
    let hz: number | null = null;
    let clarity = 0;
    if (isSpeech && dbfs > -50) {
      const detected = detector.findPitch(frame, ANALYSIS_SAMPLE_RATE);
      clarity = Number.isFinite(detected[1]) ? Math.max(0, Math.min(1, detected[1])) : 0;
      if (Number.isFinite(detected[0]) && detected[0] >= 60 && detected[0] <= 600 && clarity >= 0.85) {
        hz = detected[0];
        pitches.push(hz);
        voicedDurationMs += Math.min(HOP_SAMPLES, samples.length - start) / ANALYSIS_SAMPLE_RATE * 1000;
      }
    }
    pitchCurve.push({ timeMs, hz, semitones: null, clarity });
  }
  const issues: AcousticIssue[] = [];
  if (rmsDbfs(samples) < -55) issues.push("silent");
  if (durationMs < 500) issues.push("too_short");
  if (speechDurationMs < 400) issues.push("insufficient_speech");
  const enoughPitch = voicedDurationMs >= 200 && voicedDurationMs >= speechDurationMs * 0.15;
  if (!enoughPitch) issues.push("insufficient_pitch");
  const sortedPitches = pitches.sort((a, b) => a - b);
  const pitchMedianHz = enoughPitch ? quantile(sortedPitches, 0.5) : null;
  if (pitchMedianHz !== null) {
    for (const point of pitchCurve) {
      if (point.hz !== null) point.semitones = 12 * Math.log2(point.hz / pitchMedianHz);
    }
  } else {
    // Do not plot a melody from a handful of unreliable voiced frames.
    for (const point of pitchCurve) point.hz = null;
  }
  const speechStartMs = speechSegments[0]?.startMs ?? null;
  const speechEndMs = speechSegments.at(-1)?.endMs ?? null;
  let speechEnergy = 0;
  let speechSamples = 0;
  for (const segment of speechSegments) {
    for (let index = Math.floor(segment.startMs * 16); index < Math.min(samples.length, Math.ceil(segment.endMs * 16)); index++) {
      speechEnergy += samples[index] * samples[index];
      speechSamples++;
    }
  }
  return {
    version: "local-acoustics-v1",
    durationMs,
    speechStartMs,
    speechEndMs,
    speechSpanMs: speechStartMs !== null && speechEndMs !== null ? speechEndMs - speechStartMs : null,
    speechDurationMs,
    speechSegments,
    internalPauses,
    pauseCount: internalPauses.length,
    internalPauseDurationMs: internalPauses.reduce((sum, pause) => sum + pause.endMs - pause.startMs, 0),
    rmsDbfs: speechSamples ? Math.max(-100, 10 * Math.log10(Math.max(1e-10, speechEnergy / speechSamples))) : null,
    pitchMedianHz,
    pitchRangeSemitones: enoughPitch ? 12 * Math.log2(quantile(sortedPitches, 0.9) / quantile(sortedPitches, 0.1)) : null,
    voicedDurationMs,
    pitchCurve,
    energyCurve,
    quality: { status: issues.some((issue) => issue !== "insufficient_pitch") ? "insufficient" : "usable", issues },
  };
}
