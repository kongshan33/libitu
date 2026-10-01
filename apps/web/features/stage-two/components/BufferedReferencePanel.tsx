"use client";

import { AudioLines, Power, X } from "lucide-react";
import type { useBufferedReference } from "../reference/use-buffered-reference";

export function BufferedReferencePanel({ capture, playable, children, compact = false }: {
  capture: ReturnType<typeof useBufferedReference>;
  playable: boolean;
  children?: React.ReactNode;
  compact?: boolean;
}) {
  const { state } = capture;
  const enabled = state.phase === "enabled";
  const setup = state.phase === "checking" || state.phase === "armed";
  const status = state.phase === "checking" ? "Checking the Libitu extension…"
    : state.phase === "armed" ? "Click Libitu in Chrome’s toolbar on this tab once to enable reference preparation."
    : state.recording ? "Preparing reference audio while you listen at 1×."
    : enabled ? "Ready to prepare audio during normal 1× listening. This session continues into Shadow."
    : "Enable once to prepare reference audio while you listen, then reuse it in Shadow.";
  if (compact) {
    const connection = state.recording ? "Preparing reference"
      : enabled ? "Reference connected"
        : state.phase === "checking" ? "Checking extension"
          : state.phase === "armed" ? "Finish setup in Chrome"
            : "Reference audio off";
    return <section className="stage-two-reference buffered-reference stage-two-reference-compact" aria-label="Reference preparation">
      <div className="stage-two-reference-connection">
        <span className={`stage-two-reference-dot ${enabled ? "is-connected" : ""}`} aria-hidden="true" />
        <div className="stage-two-reference-copy">
          <strong>{connection}</strong>
          <span role="status">{status}</span>
        </div>
        <div className="stage-two-recording-controls">
          {enabled ? <button type="button" aria-label="Turn off audio preparation" onClick={capture.disable}><Power aria-hidden="true" /> Turn off</button>
            : setup ? <button type="button" aria-label="Cancel audio setup" onClick={capture.disable}><X aria-hidden="true" /> Cancel</button>
              : <button type="button" disabled={!playable} onClick={capture.enable}><AudioLines aria-hidden="true" /> Enable reference audio</button>}
        </div>
      </div>
      {state.error ? <p role="alert" className="stage-two-recording-error">{state.error}</p> : null}
      {children ? <div className="stage-two-reference-result">{children}</div> : null}
    </section>;
  }
  return <section className="stage-two-reference buffered-reference" aria-label="Reference preparation">
    <div className="stage-two-recording-heading">
      <h2><AudioLines aria-hidden="true" /> Reference audio</h2>
      <span>{state.recording ? "Preparing as you listen" : enabled ? "Audio enabled" : "Chrome · Libitu extension"}</span>
    </div>
    <div className="stage-two-recording-controls">
      {enabled ? <button type="button" onClick={capture.disable}><Power aria-hidden="true" /> Turn off audio preparation</button>
        : setup ? <button type="button" onClick={capture.disable}><X aria-hidden="true" /> Cancel audio setup</button>
          : <button type="button" disabled={!playable} onClick={capture.enable}><AudioLines aria-hidden="true" /> Enable reference audio</button>}
    </div>
    <p role="status" className="stage-two-recording-status">{status}</p>
    {state.error ? <p role="alert" className="stage-two-recording-error">{state.error}</p> : null}
    {children}
    <p className="stage-two-recording-note">Audio stays on this device in a limited temporary buffer. Start after any advertisement. Seeking, buffering and speed changes may leave gaps. Refreshing or changing the source clears this session.</p>
  </section>;
}
