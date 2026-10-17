"use client";

import { Button } from "@/components/ui/button";

import { useState } from "react";
import { referenceStatus } from "../practice/reference-status";
import type { ServerReferenceSession } from "./use-server-reference";

export function ServerReferencePanel({ session, sentenceId, analysisEnabled }: { session: ServerReferenceSession; sentenceId?: string; analysisEnabled: boolean }) {
  const { reference, busy, error } = session;
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  async function act(command: "cancel" | "retry" | "delete") {
    if (busy || pendingAction) return;
    setPendingAction(command);
    try { await session.act(command); } finally { setPendingAction(null); }
  }
  const status = referenceStatus(reference, sentenceId);
  const pending = reference?.state === "queued" || reference?.state === "processing";
  return <div className="server-reference-status" data-state={reference?.state}>
    <p role="status">{status ? `${status.title} · ${status.description}` : analysisEnabled ? "Original audio enables comparison with your recording." : "Enable Server analysis in Audio settings to prepare this file reference."}</p>
    {reference?.state === "awaiting_upload" ? <label className="server-reference-upload">Registered reference file
      <input type="file" accept="audio/*" disabled={busy || !analysisEnabled} onChange={event => {
        const file = event.target.files?.[0]; if (file) void session.act(file); event.target.value = "";
      }} /></label> : null}
    {pending ? <Button variant="secondary" size="inherit" type="button" disabled={busy || !!pendingAction} loading={pendingAction === "cancel"} loadingLabel="Cancelling…" onClick={() => void act("cancel")}>Cancel preparation</Button> : null}
    {reference && ["failed", "cancelled", "partially_completed"].includes(reference.state)
      ? <Button variant="secondary" size="inherit" type="button" disabled={busy || !!pendingAction || !analysisEnabled} loading={pendingAction === "retry"} loadingLabel="Requesting…" onClick={() => void act("retry")}>{status?.action ?? "Retry preparation"}</Button> : null}
    {reference && reference.state !== "deleted" ? <Button variant="danger" size="inherit" type="button" disabled={busy || !!pendingAction} loading={pendingAction === "delete"} loadingLabel="Deleting…" onClick={() => void act("delete")}>Delete file reference</Button> : null}
    {busy ? <p role="status">Updating reference…</p> : null}
    {error ? <p role="alert">{error} <Button variant="secondary" size="inherit" type="button" onClick={session.retryConnection}>Check again</Button></p> : null}
    <small>Private file reference · retained for up to 30 days, within the source permission period. No pronunciation score.</small>
  </div>;
}
