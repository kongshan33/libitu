import type { PracticeAnalysis } from '../persistence/practice-api';
import { practiceTokens } from '../practice/flow.ts';

export type QuickPhase = 'idle' | 'loading' | 'listening' | 'preparing' | 'requesting' | 'recording' | 'saving' | 'gap' | 'wait' | 'paused' | 'done';
export type QuickStatus = 'matched' | 'close' | 'redo' | 'pending' | 'unchecked' | 'failed';
export function repeatDuration(sentence: { startMs: number; endMs: number }) {
  return Math.max(1, Math.round((sentence.endMs - sentence.startMs) * 2));
}
export function quickQueue<T extends { text: string }>(sentences: readonly T[], first: number, last: number, skipShort: boolean): T[] {
  return sentences.slice(first, last + 1).filter(sentence => !skipShort || practiceTokens(sentence.text).length >= 4);
}
export function quickStatus(data: PracticeAnalysis | null | undefined, requested: boolean, saved: boolean): QuickStatus {
  if (!saved || data && ['awaiting_upload', 'queued', 'processing'].includes(data.state) && !data.word_check) return 'pending';
  if (data?.state === 'failed' || data?.state === 'cancelled' || data?.state === 'deleted') return 'failed';
  const check = data?.word_check;
  if (check?.status === 'reliable' && check.source_count > 0) {
    return check.matched_count * 100 >= check.source_count * 85 ? 'matched'
      : check.matched_count * 100 >= check.source_count * 60 ? 'close' : 'redo';
  }
  return data || !requested ? 'unchecked' : 'pending';
}
export function clock(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
