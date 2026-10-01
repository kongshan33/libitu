"use client";

import { AudioLines, Power, X } from "lucide-react";
import type { useReferenceCapture } from "../reference/use-reference-capture";
import type { AcousticFeatures } from "../acoustics/types";

export function ReferenceAudioPanel({ capture, playable, eligible, pending, features, analysisError, compact = false }: {
  capture: ReturnType<typeof useReferenceCapture>;
  playable: boolean;
  eligible: boolean;
  pending: boolean;
  features: AcousticFeatures | null;
  analysisError: string | null;
  compact?: boolean;
}) {
  const { state } = capture;
  const enabled = state.sessionPhase === "enabled";
  const setup = ["checking", "armed", "enabling"].includes(state.sessionPhase);
  const status = state.sessionPhase === "checking" ? "Checking the Libitu extension…"
    : state.sessionPhase === "armed" ? "Click Libitu in Chrome’s toolbar on this tab to enable audio for this practice. You only need to do this once while the session remains connected."
    : state.sessionPhase === "enabling" ? "Enabling practice audio…"
    : state.phase === "starting" ? "Preparing reference audio automatically…"
    : state.phase === "capturing" ? "Preparing reference audio as you listen…"
    : state.phase === "stopping" || pending ? "Analyzing the reference on this device…"
    : features?.quality.status === "usable" ? "Reference ready for this sentence. You can record your voice."
    : features ? "There was not enough reliable speech in the reference. Play this sentence again to retry."
    : analysisError ? "Reference analysis needs attention. You can retry below or play this sentence again."
    : !enabled ? "Enable practice audio once, then listen and record as usual."
    : !eligible ? "Choose Sentence at 1× to prepare its reference automatically."
    : "Practice audio is enabled. Play this sentence to prepare its reference automatically.";
  if (compact) {
    const connection = state.phase === "starting" || state.phase === "capturing" || state.phase === "stopping"
      ? "Preparing reference"
      : enabled ? "Reference connected"
        : setup ? "Finish setup in Chrome"
          : "Reference audio off";
    return <section className="stage-two-reference stage-two-reference-compact" aria-label="Practice audio">
      <div className="stage-two-reference-connection">
        <span className={`stage-two-reference-dot ${enabled ? "is-connected" : ""}`} aria-hidden="true" />
        <div className="stage-two-reference-copy">
          <strong>{connection}</strong>
          <span role="status">{status}</span>
        </div>
        <div className="stage-two-recording-controls">
          {enabled ? <button type="button" aria-label="Turn off practice audio" onClick={capture.disable}><Power aria-hidden="true" /> Turn off</button>
            : setup ? <button type="button" aria-label="Cancel audio setup" onClick={capture.disable}><X aria-hidden="true" /> Cancel</button>
              : <button type="button" disabled={!playable} onClick={capture.enable}><AudioLines aria-hidden="true" /> Enable practice audio</button>}
        </div>
      </div>
      {state.sessionError || state.error ? <p className="stage-two-recording-error" role="alert">{state.sessionError ?? state.error}</p> : null}
    </section>;
  }
  return <section className="stage-two-reference" aria-label="Practice audio">
    <div className="stage-two-recording-heading">
      <h2><AudioLines aria-hidden="true" /> Reference audio</h2>
      <span>{enabled ? "Practice audio enabled" : "Chrome 116+ · Libitu extension"}</span>
    </div>
    <div className="stage-two-recording-controls">
      {enabled ? <button type="button" onClick={capture.disable}><Power aria-hidden="true" /> Turn off practice audio</button>
        : setup ? <button type="button" onClick={capture.disable}><X aria-hidden="true" /> Cancel audio setup</button>
          : <button type="button" disabled={!playable} onClick={capture.enable}><AudioLines aria-hidden="true" /> Enable practice audio</button>}
    </div>
    <p className="stage-two-recording-status" role="status">{status}</p>
    {state.sessionError || state.error ? <p className="stage-two-recording-error" role="alert">{state.sessionError ?? state.error}</p> : null}
    <p className="stage-two-recording-note">Reference preparation runs while you listen to a sentence at 1×, up to 60 seconds. It pauses when you record or replay your voice. Start after any advertisement has ended.</p>
    <p className="stage-two-recording-note">Prepared references stay available during this practice. Leaving Stage 2 or refreshing ends the audio session and clears its results.</p>
  </section>;
}
