"use client";
import type { ServerReferenceSession } from "./use-server-reference";

export function ServerReferencePanel({ session }: { session: ServerReferenceSession }) {
  const { reference, busy, error } = session;
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
    {pending ? <button type="button" disabled={busy} onClick={() => void session.act("cancel")}>Cancel preparation</button> : null}
    {reference && ["failed", "cancelled", "partially_completed"].includes(reference.state)
      ? <button type="button" disabled={busy} onClick={() => void session.act("retry")}>Retry preparation</button> : null}
    {reference && reference.state !== "deleted" ? <button type="button" disabled={busy} onClick={() => void session.act("delete")}>Delete file reference</button> : null}
    {busy ? <p role="status">Updating reference…</p> : null}
    {error ? <p role="alert">{error} <button type="button" onClick={session.retryConnection}>Check again</button></p> : null}
    <small>Private file reference · retained for up to 30 days, within the source permission period. No pronunciation score.</small>
  </div>;
}
