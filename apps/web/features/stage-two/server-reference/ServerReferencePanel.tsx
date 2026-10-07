"use client";

import { Button } from "@/components/ui/button";

import { useState } from "react";
import type { ServerReferenceSession } from "./use-server-reference";

export function ServerReferencePanel({ session }: { session: ServerReferenceSession }) {
  const { reference, busy, error } = session;
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  async function act(command: "cancel" | "retry" | "delete") {
    if (busy || pendingAction) return;
    setPendingAction(command);
    try { await session.act(command); } finally { setPendingAction(null); }
  }
  const pending = reference?.state === "queued" || reference?.state === "processing";
  return <div className="server-reference-status">
    <p role="status">{!reference ? "Checking file reference…" : reference.state === "deleted" ? "Reference deleted."
      : reference.state === "awaiting_upload" ? "Choose the registered reference file to prepare this segment."
        : pending ? `Preparing reference · ${reference.results.length} sentence(s) analyzed. You can keep practicing.`
          : reference.state === "completed" ? "File reference ready."
            : reference.state === "partially_completed" ? "Reference measurements ready. Some sentence alignments are unavailable."
              : reference.state === "cancelled" ? "Reference preparation cancelled."
                : "Reference analysis could not finish. You can retry."}</p>
    {reference?.state === "awaiting_upload" ? <label className="server-reference-upload">Registered reference file
      <input type="file" accept="audio/*" disabled={busy} onChange={event => {
        const file = event.target.files?.[0]; if (file) void session.act(file); event.target.value = "";
      }} /></label> : null}
    {pending ? <Button variant="secondary" size="inherit" type="button" disabled={busy || !!pendingAction} loading={pendingAction === "cancel"} loadingLabel="Cancelling…" onClick={() => void act("cancel")}>Cancel preparation</Button> : null}
    {reference && ["failed", "cancelled", "partially_completed"].includes(reference.state)
      ? <Button variant="secondary" size="inherit" type="button" disabled={busy || !!pendingAction} loading={pendingAction === "retry"} loadingLabel="Requesting…" onClick={() => void act("retry")}>Retry preparation</Button> : null}
    {reference && reference.state !== "deleted" ? <Button variant="danger" size="inherit" type="button" disabled={busy || !!pendingAction} loading={pendingAction === "delete"} loadingLabel="Deleting…" onClick={() => void act("delete")}>Delete file reference</Button> : null}
    {busy ? <p role="status">Updating reference…</p> : null}
    {error ? <p role="alert">{error} <Button variant="secondary" size="inherit" type="button" onClick={session.retryConnection}>Check again</Button></p> : null}
    <small>Private file reference · retained for up to 30 days, within the source permission period. No pronunciation score.</small>
  </div>;
}
