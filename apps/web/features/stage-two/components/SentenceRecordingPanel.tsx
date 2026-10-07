"use client";

import { Button } from "@/components/ui/button";

import { Mic, Pause, Play, Square, Trash2, X } from "lucide-react";
import type { useSentenceRecording } from "../recording/use-sentence-recording";

type Props = {
  recording: ReturnType<typeof useSentenceRecording>;
  sentenceNumber: number | null;
  disabled?: boolean;
  compact?: boolean;
};

export function SentenceRecordingPanel({ recording, sentenceNumber, disabled = false, compact = false }: Props) {
  const { state, replaying, replayError } = recording;
  const busy = state.phase === "requesting" || state.phase === "recording" || state.phase === "stopping";
  const status = state.phase === "requesting" ? "Waiting for microphone permission…"
    : state.phase === "recording" ? "Recording your voice"
    : state.phase === "stopping" ? "Finishing your recording…"
    : state.clip ? "Your take is ready to replay"
    : "Listen first, then record your voice.";

  return (
    <section className={`stage-two-recording ${compact ? "stage-two-recording-compact" : ""}`} aria-label="Sentence recording">
      <div className="stage-two-recording-heading">
        <h2><Mic aria-hidden="true" /> Your voice{sentenceNumber ? ` · Sentence ${sentenceNumber}` : ""}</h2>
        {!compact ? <span>On this device · 60 sec max</span> : null}
      </div>
      <div className="stage-two-recording-controls">
        {state.phase === "recording" ? (
          <Button variant="record" size="inherit" shape="pill" recording type="button" className="stage-two-record-stop" aria-label="Stop recording" onClick={() => recording.recorder.stop()}>
            <Square aria-hidden="true" /> {compact ? "Stop" : "Stop recording"}
          </Button>
        ) : (
          <Button variant="record" size="inherit" shape="pill" type="button" className="stage-two-record-start" aria-label={state.clip ? "Record again" : "Record sentence"}
            loading={state.phase === "requesting" || state.phase === "stopping"} loadingLabel={state.phase === "stopping" ? "Finishing…" : "Waiting…"} disabled={!sentenceNumber || busy || disabled} onClick={recording.start}>
            <Mic aria-hidden="true" /> {state.clip ? "Record again" : compact ? "Record" : "Record sentence"}
          </Button>
        )}
        {busy ? (
          <Button variant="secondary" size="inherit" shape="pill" type="button" className="stage-two-record-cancel" aria-label="Cancel recording"
            onClick={() => recording.recorder.cancel()}><X aria-hidden="true" /> {compact ? "Cancel" : "Cancel recording"}</Button>
        ) : null}
        {state.clip ? (
          <>
            <Button variant="secondary" size="inherit" shape="pill" type="button" className="stage-two-record-replay"
              aria-label={replaying ? "Pause recording" : "Replay recording"}
              disabled={busy || disabled} onClick={() => void recording.toggleReplay()}>
              {replaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              {replaying ? compact ? "Pause mine" : "Pause recording" : compact ? "Replay mine" : "Replay recording"}
            </Button>
            <Button variant="danger" size="inherit" type="button" className="stage-two-record-delete" aria-label="Clear local recording" title="Clear local take; saved history is kept"
              disabled={busy || disabled} onClick={recording.clear}><Trash2 aria-hidden="true" />
              {!compact ? "Clear local recording" : null}</Button>
            <audio key={state.clip.url} ref={recording.attachAudio} src={state.clip.url} preload="metadata"
              onPlay={recording.onReplayPlay} onPause={recording.onReplayPause} onEnded={recording.onReplayPause}
              onError={() => recording.onReplayError(state.clip!.url)} />
          </>
        ) : null}
        {state.phase === "recording" || state.phase === "stopping" || state.clip ? (
          <span className={`stage-two-recording-timer ${state.phase === "recording" ? "is-live" : ""}`}
            role="timer" aria-label="Recording duration">
            {duration(busy ? state.elapsedMs : state.clip?.durationMs ?? 0)}
          </span>
        ) : null}
      </div>
      <p className="stage-two-recording-status" role="status">
        {sentenceNumber ? status : "Sentence text is needed to record a practice take."}
      </p>
      {state.error || replayError ? <p className="stage-two-recording-error" role="alert">{state.error ?? replayError}</p> : null}
      {!compact ? <p className="stage-two-recording-note">Audio stays on this device and is cleared when you change sentences, leave Stage 2, or refresh. Leaving the browser tab cancels an unfinished take. Switching practice layers keeps your take.</p> : null}
    </section>
  );
}

function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
