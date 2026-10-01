import type { SoundAnnotation } from "@libitu/types/stage-two";
import { PHONE_IDS } from "./assets.ts";
import { LOCAL_ALIGNMENT_VERSION, type LocalAlignedWord, type LocalReferenceAlignment } from "./types.ts";

export const MAX_ALIGNMENT_SECONDS = 20;
const MAX_WORDS = 120;
const MAX_STATES = 1500;
const MAX_CELLS = 3_000_000;
const FRAME_MS = 10;
const SILENCE_FRAMES = 4;

type State = { phone: string; label: number; token: number; variant: number; previous: number[] };
export type AlignmentGraph = { states: State[]; starts: number[]; ends: number[]; annotation: SoundAnnotation };

export function alignmentUnavailable(status: "unsupported" | "unreliable", durationMs: number, reason: string): LocalReferenceAlignment {
  return { status, engineVersion: LOCAL_ALIGNMENT_VERSION, contentVerification: "not_independently_verified", phoneLabels: "dictionary_targets", durationMs, words: [], reason };
}

/** Each pronunciation is a separate branch. Word/phone identity survives repeated labels. */
export function buildAlignmentGraph(annotation: SoundAnnotation): AlignmentGraph | string {
  if (!annotation.tokens.length || annotation.tokens.length > MAX_WORDS) return "This sentence has too many words or no alignable words.";
  const states: State[] = [];
  const starts: number[] = [];
  let previousEnds: number[] = [];
  for (let tokenIndex = 0; tokenIndex < annotation.tokens.length; tokenIndex++) {
    const token = annotation.tokens[tokenIndex];
    if (token.index !== tokenIndex || !token.text || token.status === "unknown" || !token.pronunciations.length) {
      return "Some words have no supported dictionary pronunciation. Their phone boundaries cannot be aligned locally.";
    }
    const nextEnds: number[] = [];
    const seen = new Map<string, number[]>();
    for (let variant = 0; variant < token.pronunciations.length; variant++) {
      const phones = token.pronunciations[variant];
      const labels = phones.map((phone) => PHONE_IDS[phone.replace(/[012]$/, "")]);
      if (!phones.length || phones.some((phone) => !/^[A-Z]+[012]?$/.test(phone)) || labels.some((id) => !Number.isInteger(id) || id < 1 || id > 39)) {
        return "The dictionary contains a phone outside the local English alignment model.";
      }
      const key = labels.join(",");
      const existing = seen.get(key);
      if (existing) {
        // The acoustic model has no stress classes. Collapsed stress variants
        // cannot identify which dictionary stress pattern the speaker intended.
        if (existing.some((id, index) => states[id].phone !== phones[index])) {
          for (const id of existing) states[id].phone = states[id].phone.replace(/[012]$/, "");
        }
        continue;
      }
      const branch: number[] = [];
      for (let phoneIndex = 0; phoneIndex < phones.length; phoneIndex++) {
        const id = states.length;
        if (id >= MAX_STATES) return "This sentence has too many pronunciation alternatives for local alignment.";
        branch.push(id);
        if (tokenIndex === 0 && phoneIndex === 0) starts.push(id);
        states.push({ phone: phones[phoneIndex], label: labels[phoneIndex], token: tokenIndex, variant, previous: phoneIndex === 0 ? previousEnds : [id - 1] });
      }
      seen.set(key, branch);
      nextEnds.push(states.length - 1);
    }
    previousEnds = nextEnds;
  }
  return { states, starts, ends: previousEnds, annotation };
}

export function normalizeAlignmentAudio(samples: Float32Array): Float32Array {
  let mean = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new Error("The local audio contains invalid samples.");
    mean += sample;
  }
  mean /= samples.length;
  let variance = 0;
  for (const sample of samples) variance += (sample - mean) ** 2;
  const scale = Math.sqrt(variance / samples.length + 1e-7);
  const normalized = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) normalized[i] = (samples[i] - mean) / scale;
  return normalized;
}

/** Charsiu frame posterior alignment, extended to a lexicon DAG (not CTC spikes). */
export function alignPhoneLogits(logits: ArrayLike<number>, frames: number, vocab: number, graph: AlignmentGraph, durationMs: number): LocalReferenceAlignment {
  const unavailable = (reason: string) => alignmentUnavailable("unreliable", durationMs, reason);
  if (vocab !== 42 || !Number.isInteger(frames) || frames < 1 || logits.length !== frames * vocab || frames * FRAME_MS > durationMs + FRAME_MS) {
    throw new Error("The local alignment model returned invalid dimensions.");
  }
  const probabilities = new Float32Array(logits.length);
  const predictions = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const offset = frame * vocab;
    let best = -Infinity;
    let bestId = 0;
    for (let label = 0; label < vocab; label++) {
      const value = logits[offset + label];
      if (!Number.isFinite(value)) throw new Error("The local alignment model returned invalid logits.");
      if (value > best) { best = value; bestId = label; }
    }
    predictions[frame] = bestId;
    let total = 0;
    for (let label = 0; label < vocab; label++) total += probabilities[offset + label] = Math.exp(logits[offset + label] - best);
    for (let label = 0; label < vocab; label++) probabilities[offset + label] /= total;
  }
  // As in Charsiu, retain >=40 ms model-predicted silence and align speech frames.
  const silence = new Uint8Array(frames);
  for (let start = 0; start < frames;) {
    let end = start + 1;
    while (end < frames && predictions[end] === predictions[start]) end++;
    if (predictions[start] === 0 && end - start >= SILENCE_FRAMES) silence.fill(1, start, end);
    start = end;
  }
  const speech: number[] = [];
  for (let frame = 0; frame < frames; frame++) if (!silence[frame]) speech.push(frame);
  if (speech.length < 40) return unavailable("There is too little speech for local phone alignment.");
  const count = graph.states.length;
  if (speech.length * count > MAX_CELLS) return alignmentUnavailable("unsupported", durationMs, "This sentence exceeds the local alignment memory limit.");
  let previous = new Float64Array(count).fill(-Infinity);
  let current = new Float64Array(count);
  const back = new Int16Array(speech.length * count).fill(-1);
  for (const state of graph.starts) previous[state] = probabilities[speech[0] * vocab + graph.states[state].label];
  for (let frame = 1; frame < speech.length; frame++) {
    current.fill(-Infinity);
    const offset = speech[frame] * vocab;
    const afterSilence = speech[frame] !== speech[frame - 1] + 1;
    for (let state = 0; state < count; state++) {
      const node = graph.states[state];
      // A detected silence must fall between target phones, never inside one.
      let score = afterSilence ? -Infinity : previous[state];
      let from = state;
      for (const predecessor of node.previous) {
        if (previous[predecessor] >= score) { score = previous[predecessor]; from = predecessor; }
      }
      if (!Number.isFinite(score)) continue;
      current[state] = score + probabilities[offset + node.label];
      back[frame * count + state] = from;
    }
    [previous, current] = [current, previous];
  }
  let last = graph.ends[0];
  for (const state of graph.ends) if (previous[state] > previous[last]) last = state;
  if (!Number.isFinite(previous[last])) return unavailable("The available speech cannot cover the dictionary phone sequence.");
  const path = new Int16Array(speech.length);
  for (let frame = speech.length - 1; frame >= 0; frame--) {
    path[frame] = last;
    if (frame > 0) last = back[frame * count + last];
    if (last < 0) return unavailable("No complete local alignment path was found.");
  }
  for (let frame = 1; frame < path.length; frame++) {
    if (path[frame] !== path[frame - 1] && graph.states[path[frame]].label === graph.states[path[frame - 1]].label && speech[frame] === speech[frame - 1] + 1) {
      return unavailable("Adjacent identical dictionary phones have no observable separating boundary in this audio.");
    }
  }
  // A low-emission path can be forced even through unrelated audio. This only
  // rejects gross failure; passing is explicitly NOT independent text matching.
  let supportedFrames = 0;
  let posteriorSum = 0;
  for (let i = 0; i < path.length; i++) {
    const label = graph.states[path[i]].label;
    if (predictions[speech[i]] === label) supportedFrames++;
    posteriorSum += probabilities[speech[i] * vocab + label];
  }
  if (supportedFrames / speech.length < 0.1 || posteriorSum / speech.length < 0.05) {
    return unavailable("The audio does not sufficiently support the supplied dictionary sequence. Check the sentence and try again.");
  }
  const words: LocalAlignedWord[] = [];
  for (let start = 0; start < path.length;) {
    let end = start + 1;
    while (end < path.length && path[end] === path[start]) end++;
    const node = graph.states[path[start]];
    // Do not include detected silence in a phone's apparent duration.
    if (speech[end - 1] - speech[start] !== end - start - 1) return unavailable("A phone crosses a detected silence; the local boundary is ambiguous.");
    const startMs = speech[start] * FRAME_MS;
    const endMs = Math.min(durationMs, (speech[end - 1] + 1) * FRAME_MS);
    let word = words.at(-1);
    if (!word || word.tokenIndex !== node.token) {
      const token = graph.annotation.tokens[node.token];
      word = { tokenIndex: token.index, token: token.text, startMs, endMs, pronunciationIndex: node.variant, phones: [] };
      words.push(word);
    }
    word.phones.push({ phone: node.phone, startMs, endMs });
    word.endMs = endMs;
    start = end;
  }
  if (words.length !== graph.annotation.tokens.length) return unavailable("Some source words could not be aligned.");
  if (words.some((word) => word.endMs - word.startMs <= FRAME_MS)) return unavailable("A word was compressed to a single model frame; its boundaries are not reliable.");
  return { status: "ready", engineVersion: LOCAL_ALIGNMENT_VERSION, contentVerification: "not_independently_verified", phoneLabels: "dictionary_targets", durationMs, words };
}
