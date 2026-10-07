import type { FeedbackDimensionId, FeedbackStatus, SpeakingDifficulty, SpeakingScenario } from "@libitu/types/speaking";

export type HistoryKind = "all" | "shadowing" | "speaking";

export type ProfileRange = "4w" | "3m" | "all";

export type FeedbackUnavailableReason = "legacy_report" | "version_mismatch" | "invalid_result";
export interface ProfileFeedback {
  id: string;
  session_id: string;
  status: "ready" | "partial";
  rubric_version: string;
  analysis_version: string;
  goal: string;
  scenario_type: SpeakingScenario;
  difficulty: SpeakingDifficulty;
  created_at: string;
  updated_at: string;
  practiced_at: string;
  dimensions: { id: FeedbackDimensionId; score: number | null; basis: "ai_assessment" | "coverage"; summary: string }[];
}

export interface HistoryItem {
  id: string;
  kind: "shadowing" | "speaking";
  title: string;
  occurred_at: string;
  duration_ms: number | null;
  turn_count: number | null;
  status: "recorded" | "draft" | "active" | "completed" | "abandoned";
  content_id: string | null;
  source_url: string | null;
  sentence_id: string | null;
  session_id: string | null;
  feedback: { id: string; status: FeedbackStatus; available: boolean; unavailable_reason: FeedbackUnavailableReason | null } | null;
}
export interface HistoryPage { items: HistoryItem[]; next_offset: number | null }
export interface ActivityPoint {
  date: string;
  shadowing_attempts: number;
  speaking_turns: number;
  corpus_added: number | null;
}
export interface ProfileData {
  timezone: string;
  range: ProfileRange;
  generated_at: string;
  overview: {
    shadowing_attempts: number;
    speaking_sessions: number;
    corpus_total: number;
    corpus_structures: number;
    corpus_week_added: number | null;
    shadowing_duration_ms: number;
    current_streak_days: number;
    active_days: number;
  };
  activity: { bucket: "day" | "month"; start_date: string; end_date: string; items: ActivityPoint[] };
  resume_speaking: { session_id: string; goal: string; status: "draft" | "active"; turn_count: number; updated_at: string } | null;
  last_practiced_source: { content_id: string; source_url: string | null; sentence_id: string; sentence_text: string; title: string | null; start_ms: number; practiced_at: string } | null;
  recent_history: HistoryPage;
  latest_feedback: ProfileFeedback | null;
  latest_feedback_unavailable_reason: "not_available" | FeedbackUnavailableReason | null;
}
