import type { SoundAnnotation, SoundKind } from "@libitu/types/stage-two";

export type SoundSource = { contentId: string; sentenceId: string; text: string };
export const SOUND_VERSION = "sound-rules-v1";
const kinds = new Set<SoundKind>(["linking", "weak_form", "flap", "assimilation", "elision"]);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const boundedText = (value: unknown, max = 1000): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const texts = (value: unknown, maxItems: number, maxLength = 1000): value is string[] => Array.isArray(value)
  && value.length <= maxItems && value.every((item) => boundedText(item, maxLength));

/** Reject stale, malformed and non-source spans before they reach interactive highlights. */
export function parseSoundAnnotation(value: unknown, source: SoundSource): SoundAnnotation {
  const invalid = () => new Error("The sound guide does not match this sentence. Reload the practice and try again.");
  if (!record(value) || value.version !== SOUND_VERSION || value.content_id !== source.contentId
    || value.sentence_id !== source.sentenceId || value.sentence_text !== source.text
    || value.dialect !== "en-US" || value.provider !== "cmudict-rules" || !boundedText(value.lexicon_version, 150)
    || !Array.isArray(value.tokens) || value.tokens.length > 300 || !Array.isArray(value.candidates)
    || value.candidates.length > 80 || !texts(value.warnings, 20) || !record(value.coverage)) throw invalid();
  let end = 0;
  let known = 0;
  for (const [index, token] of value.tokens.entries()) {
    if (!record(token) || token.index !== index || !boundedText(token.text, 6000)
      || !Number.isInteger(token.start) || !Number.isInteger(token.end)
      || (token.start as number) < end || (token.end as number) <= (token.start as number)
      || (token.end as number) > source.text.length || source.text.slice(token.start as number, token.end as number) !== token.text
      || !["known", "unknown", "ambiguous"].includes(String(token.status))
      || !Array.isArray(token.pronunciations) || token.pronunciations.length > 10
      || !token.pronunciations.every((phones) => texts(phones, 100, 8) && phones.length > 0)
      || !texts(token.ipa, 10, 400) || token.ipa.length !== token.pronunciations.length
      || (token.status === "unknown" ? token.pronunciations.length !== 0 : token.pronunciations.length === 0)) throw invalid();
    end = token.end as number;
    if (token.status === "known") known++;
  }
  if (value.coverage.total !== value.tokens.length || value.coverage.known !== known) throw invalid();
  const ids = new Set<string>();
  for (const candidate of value.candidates) {
    if (!record(candidate) || !boundedText(candidate.id, 250) || ids.has(candidate.id)
      || !kinds.has(candidate.kind as SoundKind) || candidate.status !== "candidate"
      || !Number.isInteger(candidate.token_start) || !Number.isInteger(candidate.token_end)
      || (candidate.token_start as number) < 0 || (candidate.token_end as number) <= (candidate.token_start as number)
      || (candidate.token_end as number) > value.tokens.length || !boundedText(candidate.rule_id, 150)
      || !boundedText(candidate.phonemes_before) || !boundedText(candidate.phonemes_after)
      || !boundedText(candidate.explanation) || !texts(candidate.conditions, 12) || candidate.conditions.length === 0) throw invalid();
    const first = value.tokens[candidate.token_start as number];
    const last = value.tokens[(candidate.token_end as number) - 1];
    if (candidate.source_text !== source.text.slice(first.start, last.end)) throw invalid();
    ids.add(candidate.id);
  }
  return value as SoundAnnotation;
}

export async function fetchSoundAnnotation(source: SoundSource, signal: AbortSignal): Promise<SoundAnnotation> {
  signal.throwIfAborted();
  const abort = new AbortController();
  const cancel = () => abort.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => abort.abort(new Error("The sound guide took too long to load. Try again.")), 15_000);
  try {
    const origin = (process.env.NEXT_PUBLIC_LIBITU_API_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");
    const response = await fetch(`${origin}/api/blueprints/${encodeURIComponent(source.contentId)}/sentences/${encodeURIComponent(source.sentenceId)}/sound`,
      { signal: abort.signal, cache: "no-store" });
    if (!response.ok) {
      if (response.status === 404 || response.status === 409) throw new Error("This sentence's sound guide is unavailable. Reload the practice to use the latest sentence list.");
      if (response.status === 422) throw new Error("This sentence is outside the sound guide's supported text limits. Listening and recording are still available.");
      if (response.status === 503) throw new Error("The pronunciation dictionary is unavailable. Try the sound guide again later.");
      throw new Error("The sound guide could not load. Try again.");
    }
    const result = parseSoundAnnotation(await response.json(), source);
    abort.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (abort.signal.aborted) throw abort.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

export const soundSourceKey = (source: SoundSource) => JSON.stringify([SOUND_VERSION, source.contentId, source.sentenceId, source.text]);

/** This cache belongs to one mounted practice, not a browser account or recording. */
export class SoundGuideCache {
  private entries = new Map<string, SoundAnnotation>();
  get(source: SoundSource) {
    const key = soundSourceKey(source);
    const value = this.entries.get(key);
    if (value) { this.entries.delete(key); this.entries.set(key, value); }
    return value;
  }
  set(source: SoundSource, value: SoundAnnotation) {
    const valid = parseSoundAnnotation(value, source);
    const key = soundSourceKey(source);
    this.entries.delete(key);
    this.entries.set(key, valid);
    while (this.entries.size > 20) this.entries.delete(this.entries.keys().next().value!);
  }
  clear() { this.entries.clear(); }
}
