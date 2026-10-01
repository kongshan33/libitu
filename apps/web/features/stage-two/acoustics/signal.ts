export const ANALYSIS_SAMPLE_RATE = 16_000;
export const MAX_AUDIO_SECONDS = 65;

/** Windowed-sinc low-pass resampling avoids aliasing browser 44.1/48 kHz capture. */
export function resampleMono(samples: Float32Array, sourceRate: number): Float32Array {
  if (!Number.isFinite(sourceRate) || sourceRate < 8_000 || sourceRate > 192_000) {
    throw new Error("Unsupported audio sample rate.");
  }
  if (!samples.length || samples.length / sourceRate > MAX_AUDIO_SECONDS) {
    throw new Error("Audio must contain between 0 and 65 seconds of samples.");
  }
  if (samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error("Audio contains invalid samples.");
  }
  if (sourceRate === ANALYSIS_SAMPLE_RATE) return samples;
  const ratio = sourceRate / ANALYSIS_SAMPLE_RATE;
  const output = new Float32Array(Math.ceil(samples.length / ratio));
  const cutoff = Math.min(1, 1 / ratio) * 0.94;
  const radius = Math.ceil(16 / cutoff);
  for (let index = 0; index < output.length; index++) {
    const center = index * ratio;
    let sum = 0;
    let weights = 0;
    for (let source = Math.max(0, Math.ceil(center - radius)); source <= Math.min(samples.length - 1, Math.floor(center + radius)); source++) {
      const distance = source - center;
      const phase = Math.PI * distance * cutoff;
      const sinc = Math.abs(phase) < 1e-9 ? 1 : Math.sin(phase) / phase;
      const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / radius);
      const weight = sinc * window * cutoff;
      sum += samples[source] * weight;
      weights += weight;
    }
    output[index] = weights ? sum / weights : 0;
  }
  return output;
}

export function rmsDbfs(samples: Float32Array): number {
  if (!samples.length) return -100;
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.max(-100, 10 * Math.log10(Math.max(1e-10, energy / samples.length)));
}

export function quantile(sorted: number[], position: number): number {
  const index = Math.max(0, Math.min(1, position)) * (sorted.length - 1);
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}
