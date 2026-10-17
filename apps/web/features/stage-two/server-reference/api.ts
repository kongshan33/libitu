import type { VoiceProsody, SignalProsody } from "../persistence/practice-api";
export type CaptureInput = { content_id: string; segment_id: string; sentence_id: string; capture_id: string;
  start_ms: number; end_ms: number; sha256: string; size: number; consent_version: "reference-analysis-v1" };
export type AlignmentInterval = { start_sec: number; end_sec: number; label: string | null };
export type SentenceMeasurement = {
  sentence_id: string; status: "completed" | "partial" | "failed" | "coarse_ready";
  coarse?: SignalProsody | null;
  prosody?: VoiceProsody | null;
  alignment: { status: "aligned" | "unavailable" | "failed"; reason: string | null;
    content_gate: "not_checked"; words: AlignmentInterval[]; phones: AlignmentInterval[] };
  measurements: null | {
    duration_sec: number; rms_dbfs: number; f0_valid_fraction: number; clipping_fraction: number;
    frames: { time_sec: number; f0_hz: number | null; energy_dbfs: number }[];
    speech: AlignmentInterval[]; pauses: AlignmentInterval[]; quality_issues: string[];
  };
};
export type ServerReference = {
  id: string; state: "awaiting_upload" | "queued" | "processing" | "completed" | "partially_completed" | "failed" | "cancelled" | "deleted";
  content_id: string; segment_id: string; input_mode: "file" | "upload";
  start_ms: number; end_ms: number; audio_ready: boolean; analysis_version: string;
  results: SentenceMeasurement[]; error_code: string | null; expires_at: string;
  source_kind?: "registered" | "browser_capture";
};

export class ReferenceApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function createReferenceApi(owner: string, getToken: () => Promise<string | null>) {
  async function request(path: string, signal: AbortSignal, init: RequestInit = {}) {
    signal.throwIfAborted();
    const token = await getToken();
    signal.throwIfAborted();
    if (!token) throw new Error("Sign in again to load your reference.");
    const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (claims.sub !== owner) throw new Error("Account changed. Reload your practice.");
    const response = await fetch(`${(process.env.NEXT_PUBLIC_LIBITU_API_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "")}/api/references${path}`, {
      ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), cache: "no-store",
      headers: { ...init.headers, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new ReferenceApiError(typeof body?.detail === "string" ? body.detail : "Reference preparation is unavailable. Please retry.", response.status);
    }
    signal.throwIfAborted();
    return response;
  }
  return {
    prepareCapture: async (input: CaptureInput, signal: AbortSignal): Promise<ServerReference> =>
      (await request('/captures', signal, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).json(),
    latestCapture: async (content: string, segment: string, sentence: string, signal: AbortSignal): Promise<ServerReference | null> =>
      (await request(`/captures/latest?${new URLSearchParams({ content_id: content, segment_id: segment, sentence_id: sentence })}`, signal)).json(),
    capability: async (content: string, segment: string, signal: AbortSignal): Promise<{ available: boolean; input_mode: "file" | "upload" | null }> =>
      (await request(`/capability?${new URLSearchParams({ content_id: content, segment_id: segment })}`, signal)).json(),
    prepare: async (content: string, segment: string, signal: AbortSignal): Promise<ServerReference> =>
      (await request("", signal, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content_id: content, segment_id: segment }) })).json(),
    status: async (id: string, signal: AbortSignal): Promise<ServerReference> => (await request(`/${encodeURIComponent(id)}`, signal)).json(),
    watch: async (id: string, signal: AbortSignal, update: (row: ServerReference) => void) => {
      const response = await request(`/${encodeURIComponent(id)}/events`, signal);
      if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) throw new Error("Reference updates unavailable.");
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            if (event.startsWith("event: unavailable")) throw new Error("Reference updates interrupted.");
            const data = event.split("\n").find(line => line.startsWith("data: "));
            if (event.startsWith("event: reference") && data) update(JSON.parse(data.slice(6)) as ServerReference);
          }
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    },
    audio: async (id: string, sentence: string | null, signal: AbortSignal): Promise<Blob> =>
      (await request(`/${encodeURIComponent(id)}/audio${sentence ? `?${new URLSearchParams({ sentence_id: sentence })}` : ""}`, signal)).blob(),
    control: async (id: string, action: "cancel" | "retry", signal: AbortSignal): Promise<ServerReference> =>
      (await request(`/${encodeURIComponent(id)}/${action}`, signal, { method: "POST" })).json(),
    upload: async (id: string, file: Blob, signal: AbortSignal): Promise<ServerReference> => {
      if (file.size > 32 * 1024 * 1024) throw new Error("Reference upload exceeds 32 MiB.");
      return (await request(`/${encodeURIComponent(id)}/audio`, signal, { method: "PUT", body: file })).json();
    },
    remove: async (id: string, signal: AbortSignal) => { await request(`/${encodeURIComponent(id)}`, signal, { method: "DELETE" }); }
  };
}
export type ReferenceApi = ReturnType<typeof createReferenceApi>;
