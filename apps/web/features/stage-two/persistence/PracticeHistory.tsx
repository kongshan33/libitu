"use client";

import { Button } from "@/components/ui/button";

import { useEffect, useRef, useState } from "react";
import { usePracticePersistence } from "./PracticePersistence";
import type { PracticeAttempt } from "./practice-api";
import type { CaptionWordClock } from '../../playback/caption-word-clock';
import { useAudioWordClock } from '../../playback/use-audio-word-clock';

export function PracticeHistory({ contentId, sentenceId, onPlay, blocked, onAnalysisSelect, onAnalysisRestore, selectedAnalysisId, playbackClock }: {
  contentId: string; sentenceId: string | null; onPlay: () => void; blocked: boolean;
  onAnalysisSelect?(id: string | null): void; onAnalysisRestore?(id: string | null): void; selectedAnalysisId?: string | null;
  playbackClock?: CaptionWordClock;
}) {
  const persistence = usePracticePersistence();
  const api = persistence?.api;
  const version = persistence?.state.savedVersion ?? 0;
  const [items, setItems] = useState<PracticeAttempt[]>([]);
  const [offset, setOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [audio, setAudio] = useState<{ id: string; url: string } | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const active = useRef<AbortController | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busy = busyAction !== null;
  useAudioWordClock(audioRef,audio?.url??null,playbackClock,!blocked && audio?.id===selectedAnalysisId);

  useEffect(() => {
    const abort = new AbortController();
    active.current = abort;
    setItems([]); setOffset(null); setError(null); setAudio(null); setBusyAction(null);
    if (api && sentenceId) {
      setLoading(true);
      void api.list(contentId, sentenceId, 0, abort.signal).then((page) => {
        if (!abort.signal.aborted) { setItems(page.items); setOffset(page.next_offset);
          onAnalysisRestore?.(page.items[0]?.id ?? null); }
      }).catch((reason) => { if (!abort.signal.aborted) setError(reason.message); })
        .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    }
    return () => { abort.abort(); };
  }, [api, contentId, sentenceId, version, refresh, onAnalysisRestore]);

  useEffect(() => {
    const element = audioRef.current;
    return () => { element?.pause(); if (audio) URL.revokeObjectURL(audio.url); };
  }, [audio]);
  useEffect(() => { if (blocked) audioRef.current?.pause(); }, [blocked]);
  // All practice playback paths emit this before playing; history playback participates too.
  useEffect(() => {
    const pause = () => audioRef.current?.pause();
    window.addEventListener("libitu:practice-playback", pause);
    const hide = () => { if (document.visibilityState === "hidden") pause(); };
    document.addEventListener("visibilitychange", hide);
    return () => { window.removeEventListener("libitu:practice-playback", pause); document.removeEventListener("visibilitychange", hide); };
  }, []);

  async function action(key: string, run: (signal: AbortSignal) => Promise<void>) {
    const abort = active.current;
    if (!abort || busy) return;
    setBusyAction(key); setError(null);
    try { await run(abort.signal); }
    catch (reason) { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Please retry."); }
    finally { if (!abort.signal.aborted) setBusyAction(null); }
  }

  return <section className="practice-history" aria-label="Saved practice">
    <h2>Saved practice for this sentence</h2>
    <p>Practice records are saved to your account. Retained recordings stay private until you delete them; they are not used for model training.</p>
    {loading ? <p role="status">Loading saved practice…</p> : !items.length ? <p>No saved takes yet.</p> : null}
    {error ? <p role="alert">{error} <Button variant="secondary" size="inherit" onClick={() => setRefresh((n) => n + 1)}>Reload history</Button></p> : null}
    <ul>{items.map((item) => <li key={item.id}>
      <span>{new Date(item.created_at).toLocaleString()} · {(item.duration_ms / 1000).toFixed(1)} sec · {item.playback_rate}× · {item.text_visible ? "Text visible" : "Text hidden"}</span>
      {onAnalysisSelect ? <button type="button" disabled={busy} aria-pressed={selectedAnalysisId === item.id}
        onClick={() => onAnalysisSelect(item.id)}>View analysis</button> : null}
      {item.recording_state === "ready" ? <>
        <Button variant="secondary" size="inherit" type="button" disabled={busy || blocked} loading={busyAction === `audio:${item.id}`} loadingLabel="Loading…" onClick={() => void action(`audio:${item.id}`, async (signal) => {
          const blob = await api!.audio(item.id, signal);
          if (signal.aborted) return;
          onPlay();
          setAudio({ id: item.id, url: URL.createObjectURL(blob) });
        })}>Load recording</Button>
        <Button variant="danger" size="inherit" type="button" disabled={busy} loading={busyAction === `remove-audio:${item.id}`} loadingLabel="Deleting…" onClick={() => void action(`remove-audio:${item.id}`, async (signal) => {
          await api!.remove(item.id, true, signal);
          if (!signal.aborted) setRefresh((n) => n + 1);
        })}>Delete saved audio</Button>
      </> : <small>{item.recording_state === "pending" ? "Audio upload incomplete" : "No retained audio"}</small>}
      <Button variant="danger" size="inherit" type="button" disabled={busy} loading={busyAction === `remove:${item.id}`} loadingLabel="Deleting…" onClick={() => void action(`remove:${item.id}`, async (signal) => {
        await api!.remove(item.id, false, signal);
        if (!signal.aborted) {
          if (selectedAnalysisId === item.id) onAnalysisSelect?.(null);
          setRefresh((n) => n + 1);
        }
      })}>Delete practice record</Button>
      {audio?.id === item.id ? <audio ref={audioRef} src={audio.url} controls preload="metadata"
        onPlay={() => { if (blocked) audioRef.current?.pause(); else onPlay(); }}
        onError={() => setError("This recording could not play. Try loading it again.")} /> : null}
    </li>)}</ul>
    {offset !== null ? <Button variant="secondary" size="inherit" type="button" disabled={busy} loading={busyAction === "older"} loadingLabel="Loading…" onClick={() => void action("older", async (signal) => {
      const page = await api!.list(contentId, sentenceId!, offset, signal);
      if (!signal.aborted) { setItems((current) => [...current, ...page.items]); setOffset(page.next_offset); }
    })}>Load older takes</Button> : null}
  </section>;
}
