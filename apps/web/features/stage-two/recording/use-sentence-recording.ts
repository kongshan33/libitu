"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LocalSentenceRecorder, type RecordingState } from "./local-recorder";

export function useSentenceRecording(sentenceId: string | null, pauseReference: () => void,
  onCompleted?: (clip: NonNullable<RecordingState["clip"]>) => void) {
  const [state, setState] = useState<RecordingState>({
    phase: "idle", sentenceId: null, clip: null, elapsedMs: 0, error: null
  });
  const completedRef = useRef(onCompleted);
  useEffect(() => { completedRef.current = onCompleted; }, [onCompleted]);
  const lastClip = useRef<RecordingState["clip"]>(null);
  const [recorder] = useState(() => new LocalSentenceRecorder((next) => {
    setState(next);
    if (next.clip && next.clip !== lastClip.current) {
      lastClip.current = next.clip;
      completedRef.current?.(next.clip);
    }
    if (!next.clip) lastClip.current = null;
  }));
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const replayEpoch = useRef(0);
  const [replaying, setReplaying] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);

  const pauseReplay = useCallback(() => {
    replayEpoch.current += 1;
    audioRef.current?.pause();
    setReplaying(false);
  }, []);

  const attachAudio = useCallback((audio: HTMLAudioElement | null) => {
    const previous = audioRef.current;
    if (previous && previous !== audio) {
      replayEpoch.current += 1;
      previous.pause();
      previous.removeAttribute("src");
      previous.load();
    }
    audioRef.current = audio;
    // Strict Mode can detach and reattach this same DOM node without reapplying src.
    const url = recorder.getSnapshot().clip?.url;
    if (audio && url && audio.getAttribute("src") !== url) audio.src = url;
  }, [recorder]);

  useEffect(() => {
    pauseReplay();
    setReplayError(null);
    recorder.setSentence(sentenceId);
  }, [sentenceId, recorder, pauseReplay]);

  useEffect(() => {
    function hidePage() {
      pauseReference();
      pauseReplay();
      recorder.clear();
    }
    function changeVisibility() {
      if (document.visibilityState !== "hidden") return;
      pauseReference();
      pauseReplay();
      recorder.cancel();
    }
    window.addEventListener("pagehide", hidePage);
    document.addEventListener("visibilitychange", changeVisibility);
    return () => {
      window.removeEventListener("pagehide", hidePage);
      document.removeEventListener("visibilitychange", changeVisibility);
      replayEpoch.current += 1;
      recorder.dispose();
    };
  }, [recorder, pauseReference, pauseReplay]);

  function isBusy() {
    const phase = recorder.getSnapshot().phase;
    return phase === "requesting" || phase === "recording" || phase === "stopping";
  }

  function changeSentence(next: string) {
    pauseReplay();
    setReplayError(null);
    recorder.cancel();
    recorder.setSentence(next);
  }

  function start() {
    if (!sentenceId || isBusy()) return;
    pauseReference();
    pauseReplay();
    setReplayError(null);
    recorder.setSentence(sentenceId);
    void recorder.start();
  }

  async function toggleReplay() {
    const audio = audioRef.current;
    if (!audio || !recorder.getSnapshot().clip || isBusy()) return;
    if (!audio.paused) { pauseReplay(); return; }
    pauseReference();
    setReplayError(null);
    const epoch = ++replayEpoch.current;
    try {
      await audio.play();
    } catch {
      if (epoch !== replayEpoch.current || audio !== audioRef.current) return;
      setReplaying(false);
      setReplayError("The recording could not play. Try Replay again or record a new take.");
    }
  }

  function onReplayPlay() {
    if (isBusy()) { pauseReplay(); return; }
    pauseReference();
    setReplaying(true);
  }

  function clear() {
    pauseReplay();
    setReplayError(null);
    recorder.clear();
  }

  return {
    state, recorder, isBusy, changeSentence, start, clear, pauseReplay, attachAudio, audioRef,
    replaying, replayError, toggleReplay, onReplayPlay,
    onReplayPause: () => setReplaying(false),
    onReplayError: (url: string) => {
      if (recorder.getSnapshot().clip?.url !== url) return;
      setReplaying(false);
      setReplayError("This recording could not be decoded. Please record a new take.");
    }
  };
}
