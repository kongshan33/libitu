"use client";

import { Button } from "@/components/ui/button";

import { useEffect, useRef, useState } from "react";
import type { PracticeAnalysis, PracticeApi } from "../persistence/practice-api";

function analysisFailure(code: string | null) {
  if (code === "recording_duration_invalid") return "This recording is too short or too long. Record the sentence again.";
  if (code === "audio_decode_failed" || code === "recording_integrity_failed") return "This recording could not be read. Please record another take.";
  if (code === "asr_timeout") return "The speech check took too long. You can retry this analysis.";
  if (code === "reference_not_ready") return "The reference is still being prepared. Retry when it is ready.";
  return "Analysis could not finish. Retry if available, or record another take.";
}

export function PracticeAnalysisPanel({ api, attemptId, data, error, loading, reload }: {
  api: PracticeApi | undefined; attemptId: string | null; data: PracticeAnalysis | null;
  error: string | null; loading: boolean; reload(): void;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busy = busyAction !== null;
  const active = useRef<AbortController | null>(null);
  useEffect(() => { const abort = new AbortController(); active.current = abort; return () => abort.abort(); }, [attemptId]);
  async function act(action: "retry" | "cancel" | "delete") {
    if (!api || !attemptId || !active.current || busy) return;
    const signal = active.current.signal;
    setBusyAction(action); setFailure(null);
    try { await api.controlAnalysis(attemptId, action, signal); if (!signal.aborted) reload(); }
    catch (cause) { if (!signal.aborted) setFailure(cause instanceof Error ? cause.message : "Please retry."); }
    finally { if (!signal.aborted) setBusyAction(null); }
  }
  if (!attemptId) return null;
  const content = data?.result?.learner.content;
  return <section className="practice-analysis-status" aria-label="Saved take analysis">
    <strong>Your recording · selected saved take</strong>
    <p role="status">{loading ? "Loading analysis…" : error ? "Analysis could not load." : !data ? "Server analysis was not requested for this take."
      : data.state === "queued" ? data.error_code === 'reference_pending' ? 'Waiting for reference analysis. Comparison will continue automatically.' : "Queued for analysis. You can keep practicing."
        : data.state === "processing" ? "Checking spoken words and aligning your recording…"
          : data.state === "completed" ? "Analysis saved. Compare your recording in Sound, Rhythm and Melody."
            : data.state === "needs_review" ? "Comparison withheld: the words or alignment need review. This is not a pronunciation grade."
              : data.state === "failed" ? analysisFailure(data.error_code)
                : data.state === "awaiting_upload" ? "Waiting for the recording upload. Keep this page open."
                  : data.state === "deleted" ? "Analysis deleted." : "Analysis cancelled."}</p>
    {content ? <p>Content check: {content.status === "matched" ? "recognized words match the practice text" : content.status === "mismatch" ? "recognized words differ from the practice text; recognition can be mistaken" : "not enough reliable evidence"}.</p> : null}
    {content?.transcript ? <p>Recognized: “{content.transcript}”</p> : null}
    {data?.result?.comparison === "unavailable" && content?.status === "matched" ? <p>This take has no verified paired reference. Your available measurements are shown below.</p> : null}
    {error || failure ? <p role="alert">{error ?? failure} <Button variant="secondary" size="inherit" type="button" loading={loading} loadingLabel="Loading…" onClick={reload}>Reload analysis</Button></p> : null}
    {data?.retryable ? <Button variant="secondary" size="inherit" disabled={busy} loading={busyAction === "retry"} loadingLabel="Requesting…" onClick={() => void act("retry")}>Retry analysis</Button> : null}
    {data && ["queued", "processing", "awaiting_upload"].includes(data.state) ? <Button variant="secondary" size="inherit" disabled={busy} loading={busyAction === "cancel"} loadingLabel="Cancelling…" onClick={() => void act("cancel")}>Cancel analysis</Button> : null}
    {data && data.state !== "deleted" ? <Button variant="danger" size="inherit" disabled={busy} loading={busyAction === "delete"} loadingLabel="Deleting…" onClick={() => void act("delete")}>Delete analysis</Button> : null}
  </section>;
}
