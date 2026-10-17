export type TextSupport = {
  version: "text-support-v1"; mode: "hidden" | "keywords" | "full";
  visible_source_indices_at_start: number[]; revealed_source_indices: number[];
};
export type RecognitionFeedback = { kind: "recognition_error"; created_at: string };

export type PracticeAttempt = {
  id: string; content_id: string; sentence_id: string; sentence_text: string;
  start_ms: number; end_ms: number; reference_version: string; duration_ms: number;
  playback_rate: number; text_visible: boolean;
  recording_state: "none" | "pending" | "ready" | "deleted"; created_at: string;
  evidence_source: "browser_recording";
  text_support?: TextSupport | null;
  recognition_feedback?: RecognitionFeedback | null;
};

export type AttemptInput = {
  client_id: string; content_id: string; sentence_id: string; duration_ms: number;
  playback_rate: number; text_visible: boolean;
  recording: { consent_version: "recording-retention-v1"; sha256: string; size: number; mime_type: string } | null;
  text_support?: TextSupport | null;
};
export type AttemptPage = { items: PracticeAttempt[]; next_offset: number | null };
export type WordMatchCounts = { matched_count: number; source_count: number };
export type PracticeProgress = { practiced_sentence_ids: string[]; best_word_matches?: Record<string, WordMatchCounts> };
export type AnalysisInput = { consent_version: "practice-analysis-v1"; sha256: string; size: number; mime_type: string; reference_id: string | null };
export type WordProsody = { text: string; start_sec: number; end_sec: number; duration_ms: number;
  pause_after_ms: number | null; pitch_st: number | null; pitch_curve_st: (number | null)[];
  phones?: { label: string; duration_ms: number }[]; boundary_pause_ms?: number | null;
  source_index?: number | null; recognized_index?: number | null };
export type SimilarityScore = { value: number | null; compared: number; eligible: number; reason: string | null; experimental: true };
export type SoundCheck = { kind: string; status: "measured" | "insufficient_evidence" | "unsupported" | "no_targets";
  score: SimilarityScore; realization: "not_evaluated"; note: string;
  pairs: { word_index: number; end_index: number; reference: number; learner: number; unit: "ms"; similarity: number }[] };
export type LayerAssessment = { version: string; sound: SoundCheck[]; rhythm: SimilarityScore; melody: SimilarityScore };
export type SignalProsody = {
  version: "server-prominence-v1"; feature_version: string; aggregation_version: string;
  boundary_source: "subtitle_word" | "asr_word" | "mfa"; duration_evaluated: boolean;
  duration_sec: number; time_step_sec: number; pitch_st: (number | null)[]; prominence: (number | null)[];
  words: { text: string; source_index: number | null; start_sec: number; end_sec: number;
    value: number | null; sensitivity_range: number[]; uncertain: boolean; reasons: string[] }[];
  reasons: string[]; experimental: true;
};
export type SignalPair = { learner: SignalProsody; reference: SignalProsody | null };
export type VoiceProsody = { content: { status: "matched" | "mismatch" | "uncertain" | "unavailable" | "source_transcript"; transcript: string; reason: string | null };
  alignment_status: string; quality_issues: string[]; words: WordProsody[]; rhythm_signal?: SignalProsody | null };
export type CheckedToken = { normalized: string; display: string; start: number; end: number };
export type WordEdit = { kind: "matched" | "substituted" | "omitted" | "inserted";
  source_index: number | null; recognized_index: number | null; source_boundary: number | null };
export type WordCheck = { version: "word-match-v1"; status: "reliable" | "uncertain" | "unavailable";
  reason: string | null; transcript: string; source_tokens: CheckedToken[]; recognized_tokens: CheckedToken[];
  operations: WordEdit[]; matched_count: number; source_count: number;
  tier: "below_60" | "partial_60_85" | "full_85_plus" | null };
export type LayerAvailability = { state: "locked" | "pending" | "available" | "partial" | "unavailable"; reason: string | null };
export type PracticeAnalysis = { id: string; sentence_id: string; analysis_version: string;
  state: "awaiting_upload" | "queued" | "processing" | "completed" | "needs_review" | "failed" | "cancelled" | "deleted";
  error_code: string | null; retryable: boolean; created_at: string;
  phase?: "awaiting_upload" | "queued_word_check" | "checking_words" | "word_check_complete" | "waiting_reference"
    | "analyzing_sound" | "analyzing_all" | "coarse_ready" | "finished" | null;
  word_check?: WordCheck | null;
  coarse?: SignalPair | null;
  analysis_scope?: "none" | "sound_only" | "all_layers" | null;
  layers?: Partial<Record<"sound" | "rhythm" | "melody", LayerAvailability>> | null;
  recognition_feedback?: RecognitionFeedback | null;
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
    progress: async (content: string, signal: AbortSignal): Promise<PracticeProgress> =>
      (await request(`/progress?${new URLSearchParams({ content_id: content })}`, signal)).json(),
    markRecognitionError: async (id: string, signal: AbortSignal): Promise<RecognitionFeedback> =>
      (await request(`/${encodeURIComponent(id)}/recognition-feedback`, signal, { method: "PUT",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "recognition_error" }) })).json(),
    prepareAnalysis: async (id: string, input: AnalysisInput, signal: AbortSignal): Promise<PracticeAnalysis> =>
      (await request(`/${encodeURIComponent(id)}/analysis`, signal, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })).json(),
    uploadAnalysis: async (id: string, blob: Blob, signal: AbortSignal, retainRecording = false): Promise<PracticeAnalysis> =>
      (await request(`/${encodeURIComponent(id)}/analysis/audio${retainRecording ? '?retain_recording=true' : ''}`, signal, { method: "PUT", body: blob, headers: { "Content-Type": blob.type.split(";")[0] } })).json(),
    analysis: async (id: string, signal: AbortSignal): Promise<PracticeAnalysis | null> =>
      (await request(`/${encodeURIComponent(id)}/analysis`, signal)).json(),
    controlAnalysis: async (id: string, action: "retry" | "cancel" | "delete", signal: AbortSignal) => {
      const response = await request(`/${encodeURIComponent(id)}/analysis${action === "delete" ? "" : `/${action}`}`, signal,
        { method: action === "delete" ? "DELETE" : "POST" });
      return action === "delete" ? null : response.json() as Promise<PracticeAnalysis>;
    },
    submit: async (attempt: AttemptInput, analysis: AnalysisInput, blob: Blob, signal: AbortSignal): Promise<PracticeAttempt> => {
      const body = new FormData();
      body.append("metadata", JSON.stringify({ attempt, analysis }));
      body.append("audio", new Blob([blob], { type: blob.type.split(";")[0] }), "take");
      return (await request("/submit", signal, { method: "POST", body })).json();
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
