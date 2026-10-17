'use client';
import { useEffect, useState } from 'react';
import type { SentenceUnit } from '@libitu/types/stage-two';
import { usePracticePersistence } from '../persistence/PracticePersistence';
import { captureKey } from '../server-reference/capture-uploads';
import { useServerReference } from '../server-reference/use-server-reference';

export function useQuickReference(content: string, segment: string, sentences: SentenceUnit[], selected: SentenceUnit | null, rate: number) {
  const persistence = usePracticePersistence();
  const captures = persistence?.captures;
  const api = persistence?.referenceApi;
  const cloud = useServerReference(api, content, segment, selected, null, 'sentence', rate, false, Boolean(persistence?.analyze));
  useEffect(() => {
    if (!captures || cloud.checking || cloud.available) return;
    let stopped = false;
    const remaining = [...sentences];
    void Promise.all(Array.from({length: Math.min(3, remaining.length)}, async () => {
      for (let sentence = remaining.shift(); sentence && !stopped; sentence = remaining.shift()) {
        await captures.restore(segment, {contentId: content, sentenceId: sentence.id, text: sentence.text, startMs: sentence.startMs, endMs: sentence.endMs});
      }
    }));
    return () => { stopped = true; };
  }, [captures, content, segment, sentences, cloud.available, cloud.checking]);
  const rowFor = (sentence: SentenceUnit) => cloud.available ? cloud.reference : captures?.get(captureKey(content, segment, sentence.id))?.row ?? null;
  const playable = (sentence: SentenceUnit) => {
    const row = rowFor(sentence);
    return row?.audio_ready && row.state !== 'deleted' && Date.parse(row.expires_at) > Date.now() ? row : null;
  };
  const row = selected ? playable(selected) : null;
  const [audio, setAudio] = useState<{key: string; url: string} | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = row && selected ? `${row.id}:${selected.id}` : '';
  const id = row?.id, sentenceId = selected?.id;
  useEffect(() => {
    setAudio(null); setError(null);
    if (!api || !id || !sentenceId || cloud.available) return;
    const abort = new AbortController();
    let url: string | undefined;
    void api.audio(id, sentenceId, abort.signal).then(blob => {
      if (abort.signal.aborted) return;
      url = URL.createObjectURL(blob); setAudio({key, url});
    }).catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Reference audio could not load.'); });
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [api, id, sentenceId, key, cloud.available]);
  const url = cloud.available ? cloud.audioUrl : audio?.key === key ? audio.url : null;
  const loading = Boolean(row && !url && !(cloud.available ? cloud.error : error));
  return {row, url, loading, error: cloud.available ? cloud.error : error,
    readyCount: sentences.filter(sentence => playable(sentence)).length};
}
