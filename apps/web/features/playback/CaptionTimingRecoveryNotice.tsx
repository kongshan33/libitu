"use client";

import { Button } from "@/components/ui/button";

import type { CaptionRecoveryState } from "../stage-one/components/use-caption-timing-recovery";

export function CaptionTimingRecoveryNotice({ state, inPractice = false, onRetry }: {
  state: CaptionRecoveryState; inPractice?: boolean; onRetry(): void;
}) {
  if (state.phase === "idle" || state.phase === "applied") return null;
  const message = state.phase === "checking" ? "Checking the open YouTube tab for word timing. You can keep reading and listening."
    : state.phase === "updating" ? "Restoring caption timing without rerunning the content analysis. You can keep practising."
    : state.phase === "ready" ? inPractice
      ? "Word timing is ready. Return to Stage 1 to apply it when you are ready to leave practice. Leaving practice clears local recordings."
      : "Word timing is ready. Pause the video to apply it."
    : state.message;
  return <div className="caption-timing-recovery" data-caption-recovery-phase={state.phase} role="status" aria-live="polite">
    <span>{message}</span>
    {state.phase === "failed" ? <Button variant="secondary" size="inherit" type="button" onClick={onRetry}>Retry word timing</Button> : null}
  </div>;
}
