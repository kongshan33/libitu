"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SentenceUnit } from "@libitu/types/stage-two";
import type { ReferenceApi, ServerReference } from "./api";

export function useServerReference(api: ReferenceApi | undefined, content: string, segment: string,
  selected: SentenceUnit | null, next: SentenceUnit | null, scope: "sentence" | "segment", rate: number, loop: boolean) {
  const [available, setAvailable] = useState(false);
  const [reference, setReference] = useState<ServerReference | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [audioSource, setAudioSource] = useState<{ key: string; url: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const operation = useRef<AbortController | null>(null);
  const statusRequest = useRef<AbortController | null>(null);
  const urls = useRef(new Map<string, string>());
  const selectedId = scope === "sentence" ? selected?.id ?? null : null;
  const audioUrl = audioSource?.key === `${reference?.id}:${selectedId ?? "segment"}` ? audioSource.url : null;
  const pause = useCallback(() => { audioRef.current?.pause(); setPlaying(false); }, []);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    statusRequest.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(id: string) {
      try {
        const row = await api!.status(id, controller.signal);
        setReference(row);
        if (row.state === "queued" || row.state === "processing") timer = setTimeout(() => void poll(id), 2000);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Reference status is unavailable.");
      }
    }
    void (async () => {
      try {
        setError(null);
        const capability = await api.capability(content, segment, controller.signal);
        setAvailable(capability.available);
        if (!capability.available) return;
        const row = await api.prepare(content, segment, controller.signal);
        setReference(row);
        if (row.state === "queued" || row.state === "processing") {
          try { await api.watch(row.id, controller.signal, setReference); }
          catch { /* Reconcile from durable status when streaming is interrupted. */ }
          if (!controller.signal.aborted) timer = setTimeout(() => void poll(row.id), 1000);
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Reference preparation failed.");
      }
    })();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, content, segment, revision]);

  useEffect(() => {
    const cache = urls.current;
    return () => { operation.current?.abort(); for (const url of cache.values()) URL.revokeObjectURL(url); cache.clear(); };
  }, [api, content, segment]);

  const referenceId = reference?.id;
  const audioReady = reference?.audio_ready;
  const nextId = next?.id;
  useEffect(() => {
    pause();
    setAudioSource(null);
    if (!api || !audioReady || !referenceId) return;
    const controller = new AbortController();
    async function load(id: string | null, primary: boolean) {
      const key = `${referenceId}:${id ?? "segment"}`;
      try {
        let url = urls.current.get(key);
        if (!url) {
          const blob = await api!.audio(referenceId!, id, controller.signal);
          controller.signal.throwIfAborted();
          url = URL.createObjectURL(blob);
          urls.current.set(key, url);
        }
        if (primary) setAudioSource({ key, url });
        const keep = new Set([`${referenceId}:${selectedId ?? "segment"}`, `${referenceId}:${nextId ?? "segment"}`]);
        for (const [oldKey, oldUrl] of urls.current) if (!keep.has(oldKey)) { URL.revokeObjectURL(oldUrl); urls.current.delete(oldKey); }
      } catch (failure) {
        if (!controller.signal.aborted && primary) setError(failure instanceof Error ? failure.message : "Reference playback unavailable.");
      }
    }
    void load(selectedId, true);
    if (scope === "sentence" && nextId) void load(nextId, false);
    return () => { controller.abort(); pause(); };
  }, [api, referenceId, audioReady, selectedId, nextId, scope, pause]); // Stable job updates must not interrupt playback.

  const expiresAt = reference?.expires_at;
  useEffect(() => {
    if (!expiresAt) return;
    const remaining = new Date(expiresAt).getTime() - Date.now();
    // Recheck long retention periods without overflowing the browser's timer range.
    const timer = setTimeout(() => {
      if (Date.now() < new Date(expiresAt).getTime()) { setRevision(value => value + 1); return; }
      statusRequest.current?.abort(); pause(); setAudioSource(null);
      for (const url of urls.current.values()) URL.revokeObjectURL(url);
      urls.current.clear();
      setReference(row => row ? { ...row, state: "failed", error_code: "reference_expired", audio_ready: false, results: [] } : row);
      setError("This reference has expired. A renewed source is required.");
    }, Math.max(0, Math.min(remaining, 2_000_000_000)));
    return () => clearTimeout(timer);
  }, [expiresAt, pause, revision]);

  useEffect(() => { if (audioRef.current) { audioRef.current.playbackRate = rate; audioRef.current.loop = loop; } }, [rate, loop, audioUrl]);
  useEffect(() => {
    function hide() { if (document.visibilityState === "hidden") pause(); }
    window.addEventListener("libitu:practice-playback", pause);
    document.addEventListener("visibilitychange", hide);
    return () => { window.removeEventListener("libitu:practice-playback", pause); document.removeEventListener("visibilitychange", hide); };
  }, [pause]);

  async function act(action: "retry" | "cancel" | "delete" | File) {
    if (!api || !reference) return;
    operation.current?.abort();
    statusRequest.current?.abort();
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(null);
    try {
      if (action === "delete") {
        pause(); await api.remove(reference.id, controller.signal);
        setReference({ ...reference, state: "deleted", audio_ready: false, results: [] });
        setAudioSource(null);
        for (const url of urls.current.values()) URL.revokeObjectURL(url);
        urls.current.clear();
      } else {
        const row = typeof action === "string" ? await api.control(reference.id, action, controller.signal)
          : await api.upload(reference.id, action, controller.signal);
        setReference(row);
        if (row.state === "queued") setRevision(value => value + 1);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Reference request failed.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function play() {
    if (!audioRef.current || !audioUrl) return;
    window.dispatchEvent(new Event("libitu:practice-playback"));
    try { await audioRef.current.play(); setPlaying(true); }
    catch { setError("Reference playback could not start. Press Play again."); }
  }
  return { available, reference, error, retryConnection: () => setRevision(value => value + 1),
    audioRef, audioUrl, playing, setPlaying, play, pause, act, busy,
    result: reference?.results.find(result => result.sentence_id === selected?.id) ?? null };
}
export type ServerReferenceSession = ReturnType<typeof useServerReference>;
