export type PracticeAttempt = {
  id: string; content_id: string; sentence_id: string; sentence_text: string;
  start_ms: number; end_ms: number; reference_version: string; duration_ms: number;
  playback_rate: number; text_visible: boolean;
  recording_state: "none" | "pending" | "ready" | "deleted"; created_at: string;
  evidence_source: "browser_recording";
};

export type AttemptInput = {
  client_id: string; content_id: string; sentence_id: string; duration_ms: number;
  playback_rate: number; text_visible: boolean;
  recording: { consent_version: "recording-retention-v1"; sha256: string; size: number; mime_type: string } | null;
};
export type AttemptPage = { items: PracticeAttempt[]; next_offset: number | null };
export type AnalysisInput = { consent_version: "practice-analysis-v1"; sha256: string; size: number; mime_type: string; reference_id: string | null };
export type WordProsody = { text: string; start_sec: number; end_sec: number; duration_ms: number;
  pause_after_ms: number | null; pitch_st: number | null; pitch_curve_st: (number | null)[];
  phones?: { label: string; duration_ms: number }[]; boundary_pause_ms?: number | null };
export type SimilarityScore = { value: number | null; compared: number; eligible: number; reason: string | null; experimental: true };
export type SoundCheck = { kind: string; status: "measured" | "insufficient_evidence" | "unsupported" | "no_targets";
  score: SimilarityScore; realization: "not_evaluated"; note: string;
  pairs: { word_index: number; end_index: number; reference: number; learner: number; unit: "ms"; similarity: number }[] };
export type LayerAssessment = { version: string; sound: SoundCheck[]; rhythm: SimilarityScore; melody: SimilarityScore };
export type VoiceProsody = { content: { status: "matched" | "mismatch" | "uncertain" | "unavailable"; transcript: string; reason: string | null };
  alignment_status: string; quality_issues: string[]; words: WordProsody[] };
export type PracticeAnalysis = { id: string; sentence_id: string; analysis_version: string;
  state: "awaiting_upload" | "queued" | "processing" | "completed" | "needs_review" | "failed" | "cancelled" | "deleted";
  error_code: string | null; retryable: boolean; created_at: string;
  result: { learner: VoiceProsody; reference: VoiceProsody | null; comparison: "available" | "unavailable"; reason: string | null;
    assessment?: LayerAssessment | null } | null };

export function createPracticeApi(owner: string, getToken: () => Promise<string | null>) {
  async function request(path: string, signal: AbortSignal, init: RequestInit = {}) {
    signal.throwIfAborted();
    const token = await getToken();
    signal.throwIfAborted();
    if (!token) throw new Error("Sign in again to save your practice.");
    // Account-switch guard only. The API verifies the Clerk signature and subject.
    const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (claims.sub !== owner) throw new Error("Account changed. This take belongs to your previous account.");
    const response = await fetch(`${(process.env.NEXT_PUBLIC_LIBITU_API_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "")}/api/practice/attempts${path}`, {
      ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      headers: { ...init.headers, Authorization: `Bearer ${token}` }, cache: "no-store"
    });
    if (!response.ok) {
      const message = await response.json().catch(() => null);
      throw new Error(typeof message?.detail === "string" ? message.detail : "Practice could not be saved. Keep this page open and retry.");
    }
    signal.throwIfAborted();
    return response;
  }
  return {
    prepareAnalysis: async (id: string, input: AnalysisInput, signal: AbortSignal): Promise<PracticeAnalysis> =>
      (await request(`/${encodeURIComponent(id)}/analysis`, signal, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })).json(),
    uploadAnalysis: async (id: string, blob: Blob, signal: AbortSignal): Promise<PracticeAnalysis> =>
      (await request(`/${encodeURIComponent(id)}/analysis/audio`, signal, { method: "PUT", body: blob, headers: { "Content-Type": blob.type.split(";")[0] } })).json(),
    analysis: async (id: string, signal: AbortSignal): Promise<PracticeAnalysis | null> =>
      (await request(`/${encodeURIComponent(id)}/analysis`, signal)).json(),
    controlAnalysis: async (id: string, action: "retry" | "cancel" | "delete", signal: AbortSignal) => {
      const response = await request(`/${encodeURIComponent(id)}/analysis${action === "delete" ? "" : `/${action}`}`, signal,
        { method: action === "delete" ? "DELETE" : "POST" });
      return action === "delete" ? null : response.json() as Promise<PracticeAnalysis>;
    },
    create: async (input: AttemptInput, signal: AbortSignal): Promise<PracticeAttempt> =>
      (await request("", signal, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })).json(),
    upload: async (id: string, blob: Blob, signal: AbortSignal): Promise<PracticeAttempt> =>
      (await request(`/${encodeURIComponent(id)}/recording`, signal, { method: "PUT", body: blob, headers: { "Content-Type": blob.type.split(";")[0] } })).json(),
    list: async (content: string, sentence: string, offset: number, signal: AbortSignal): Promise<AttemptPage> =>
      (await request(`?${new URLSearchParams({ content_id: content, sentence_id: sentence, offset: String(offset) })}`, signal)).json(),
    audio: async (id: string, signal: AbortSignal): Promise<Blob> => (await request(`/${encodeURIComponent(id)}/recording`, signal)).blob(),
    remove: async (id: string, audioOnly: boolean, signal: AbortSignal) => {
      await request(`/${encodeURIComponent(id)}${audioOnly ? "/recording" : ""}`, signal, { method: "DELETE" });
    }
  };
}
export type PracticeApi = ReturnType<typeof createPracticeApi>;
