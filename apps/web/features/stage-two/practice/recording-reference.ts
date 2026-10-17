import type { ServerReference } from '../server-reference/api';

type Sentence = { id: string; startMs: number; endMs: number };

/** Select an optional uploaded Reference for this exact source; null allows learner-only analysis. */
export function recordingReference(row: ServerReference | null, content: string, segment: string,
  sentence: Sentence | null, now = Date.now()): ServerReference | null {
  if (!row || !sentence || row.content_id !== content || row.segment_id !== segment || !row.audio_ready
    || !(Date.parse(row.expires_at) > now) || row.start_ms > sentence.startMs || row.end_ms < sentence.endMs) return null;
  if (row.source_kind === 'browser_capture' && (row.start_ms !== sentence.startMs || row.end_ms !== sentence.endMs)) return null;
  if (row.state === 'queued' || row.state === 'processing') return row;
  if (row.state === 'completed' || row.state === 'partially_completed') {
    return row.results.some(result => result.sentence_id === sentence.id && result.status === 'completed') ? row : null;
  }
  return null;
}
