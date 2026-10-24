import type { CorpusKind } from "./stage-one";

export type SpeakingScenario = "workplace" | "everyday";
export type SpeakingDifficulty = "guided" | "standard" | "challenging";
export type SpeakingFeedbackLevel = "light" | "balanced" | "detailed";
export type SpeakingSupportLevel = "model_frame" | "model_label" | "label_only" | "no_hint";
export type LogicTemplateId = "persuasive_pitch" | "technical_troubleshoot" | "stakeholder_alignment" | "status_update" | "disagreement" | "onboarding";
export type SpeakingLogicTemplate = { id: LogicTemplateId; title: string; description: string; steps: string[] };
export type SpeakingOptions = {
  logic_templates: SpeakingLogicTemplate[];
  max_structures: number;
  max_expressions: number;
  min_items: number;
};
export type SpeakingTargetRole = "primary" | "opportunity";
export type PracticeVariation = "details" | "role_swap";
export type ScenarioChange = { field: "setting" | "goal" | "user_role" | "ai_role"; before: string; after: string };
export type PracticeSource = { parent_session_id: string; root_session_id: string; variation: PracticeVariation; parent_snapshot_hash: string };
export type SpeakingPlanTarget = {
  corpus_item_id: string; role: SpeakingTargetRole; communicative_function: string;
  fit: "high" | "medium" | "low" | "unknown"; fit_reason: string;
  trigger_question: string; skip_when: string; metadata_status: "available" | "partial" | "unknown";
  sentence_frame?: string | null;
};
export type SpeakingPlanCandidate = {
  id: string; title: string; setting: string; goal: string; user_role: string; ai_role: string;
  register: "casual" | "neutral" | "professional" | "formal"; targets: SpeakingPlanTarget[];
  changes?: ScenarioChange[];
};
export type SpeakingPlanCreate = {
  scenario_type: SpeakingScenario; brief: string;
  candidate_count?: 1 | 2;
  targets: { corpus_item_id: string; role: SpeakingTargetRole }[];
};
export type SpeakingPlan = {
  id: string; version: 1; scenario_type: SpeakingScenario; brief: string; created_at: string;
  candidates: SpeakingPlanCandidate[];
  practice_source?: PracticeSource | null;
};
export type SpeakingMissionPlan = Omit<SpeakingPlanCandidate, "id" | "targets"> & {
  plan_id: string; candidate_id: string; version: 1; scenario_type: SpeakingScenario;
  targets: (SpeakingPlanTarget & { session_item_id: string; parent_session_item_id?: string | null })[];
};
export type SpeakingSessionCreate = {
  client_id: string;
  scenario_type: SpeakingScenario;
  goal: string;
  difficulty: SpeakingDifficulty;
  feedback_level: SpeakingFeedbackLevel;
  logic_template_id: LogicTemplateId | null;
  corpus_item_ids: string[];
  plan_id?: string;
  candidate_id?: string;
  support_level?: SpeakingSupportLevel | null;
};
export type SpeakingSessionItem = {
  id: string;
  corpus_item_id: string | null;
  source_corpus_item_id?: string | null;
  ordinal: number;
  kind: CorpusKind;
  text: string;
  meaning: string | null;
  tags: string[];
  slots: Record<string, string>;
  source_title: string | null;
  usage_note?: string | null;
  register?: string | null;
  scenario_tags?: string[];
  pattern_family?: string | null;
};
export type SpeakingSession = {
  id: string;
  user_id: string;
  client_id: string;
  scenario_type: SpeakingScenario;
  goal: string;
  difficulty: SpeakingDifficulty;
  feedback_level: SpeakingFeedbackLevel;
  logic_template: SpeakingLogicTemplate | null;
  status: "draft" | "active" | "completed" | "abandoned";
  created_at: string;
  turn_count: number;
  items: SpeakingSessionItem[];
  mission_plan?: SpeakingMissionPlan | null;
  support_level?: SpeakingSupportLevel | null;
  evidence_contract_version?: "speaking-evidence-v3" | null;
  practice?: { parent_session_id: string | null; root_session_id: string; variation: PracticeVariation; changes: ScenarioChange[] } | null;
};

export type SpeakingMessage = {
  id: string; ordinal: number; role: "user" | "assistant"; text: string;
  input_source: "voice" | "text"; status: "final" | "interrupted" | "unavailable";
  revision: number; provider_item_id: string | null; response_id: string | null;
  client_turn_id: string | null; created_at: string;
};
export type SpeakingEvidence = {
  id: string; session_item_id: string; message_id: string; transcript_revision: number;
  start: number; end: number; quote: string; match_type: "exact" | "variant" | "structure";
  appropriateness: "appropriate" | "uncertain" | "inappropriate"; prompted: boolean; reason: string;
  assistance?: "independent" | "direction" | "usage" | "example" | "overlap" | "unknown";
};
export type SpeakingLearningItem = {
  session_item_id: string; observed_uses: number; independent_uses: number;
  prompted_uses: number; last_message_id: string | null;
};
/** Public teaching policy deliberately excludes the provider instruction. */
export type SpeakingTeachingPolicy = {
  id: string; source_message_id: string; source_revision: number; learning_version: number;
  target_item_id: string | null; action: "continue_naturally" | "implicit_elicitation" | "model_then_transfer" | "explicit_hint" | "move_on";
  status: "pending" | "applied" | "expired"; response_id: string | null;
};
export type SpeakingHelpLevel = "direction" | "usage" | "example";
export type SpeakingHelpCard = {
  id: string; version: number; target_item_id: string | null;
  level: SpeakingHelpLevel; status: "loading" | "ready" | "unavailable";
  direction: string | null; expression: string | null; meaning: string | null;
  pattern: string | null; example: string | null; substitution: string | null;
  source: "automatic" | "requested"; source_message_id: string | null; error: string | null;
};
export type SpeakingWorkspace = {
  session: SpeakingSession; version: number;
  runtime: { id: string; generation: number; state: "connecting" | "connected" | "disconnected"; expires_at: string } | null;
  messages: SpeakingMessage[]; evidence: SpeakingEvidence[]; learning: SpeakingLearningItem[];
  policy: SpeakingTeachingPolicy | null; analysis_status: "idle" | "pending" | "ready" | "unavailable"; hint: string | null;
  help?: SpeakingHelpCard | null;
  opportunities?: SpeakingOpportunity[];
  support?: { level: SpeakingSupportLevel; version: number } | null;
  demonstrations?: SpeakingDemonstration[];
};
export type SpeakingDemonstration = { target_item_id: string; message_id: string; revision: number; start: number; end: number; quote: string };
export type SpeakingOpportunity = {
  session_item_id: string; role: SpeakingTargetRole; status: "planned" | "offered" | "used" | "skipped";
  skipped_reason: string | null; skipped_at: string | null;
  sent: boolean; bound: boolean; reflected: boolean; presented: boolean; last_response_id: string | null;
};
export type SpeakingRuntimeTicket = { runtime_id: string; ticket: string; expires_at: string; websocket_path: string };
export type SpeakingClientEvent =
  | { type: "authenticate"; ticket: string }
  | { type: "audio.append"; audio: string }
  | { type: "text.submit"; client_turn_id: string; text: string }
  | { type: "playback"; item_id: string; played_ms: number }
  | { type: "microphone"; enabled: boolean }
  | { type: "hint"; request_id: string; level: "usage" | "example"; target_item_id?: string }
  | { type: "hint.shown"; hint_id: string; version: number; level: SpeakingHelpLevel }
  | { type: "message.shown"; message_id: string; revision: number }
  | { type: "target.skip"; target_item_id: string; reason: string }
  | { type: "target.restore"; target_item_id: string }
  | { type: "target.shown"; target_item_id: string }
  | { type: "support.set"; level: SpeakingSupportLevel; expected_version: number; request_id: string }
  | { type: "interrupt" | "ping" };
export type SpeakingServerEvent =
  | { type: "ready" | "snapshot" | "ended"; workspace: SpeakingWorkspace }
  | { type: "state"; state: "listening" | "thinking" | "speaking" }
  | { type: "user.activity"; speaking: boolean }
  | { type: "transcript.delta"; role: "user" | "assistant"; item_id: string; delta: string }
  | { type: "audio.delta"; item_id: string; response_id: string; audio: string }
  | { type: "audio.clear"; item_id: string | null }
  | { type: "error"; code: string; message: string; retryable: boolean; request_id?: string }
  | { type: "pong" };

export type FeedbackStatus = "queued" | "processing" | "ready" | "partial" | "insufficient_data" | "failed";
export type FeedbackDimensionId = "task_fit" | "transfer" | "scenario_fit" | "naturalness";
export type FeedbackReference = { message_id: string; transcript_revision: number; quote: string; start: number; end: number };
export type FeedbackCriterion = { id: string; label: string; rating: number | null; reason: string; evidence: FeedbackReference[] };
export type FeedbackDimension = { id: FeedbackDimensionId; score: number | null; basis: "ai_assessment" | "coverage"; summary: string; criteria: FeedbackCriterion[] };
export type FeedbackItem = { session_item_id: string; kind: CorpusKind; text: string; status: "appropriate" | "inappropriate" | "uncertain" | "not_observed"; independent_uses: number; prompted_uses: number; reason: string; evidence: FeedbackReference[];
  role?: SpeakingTargetRole | null; opportunity_status?: SpeakingOpportunity["status"] | null; excluded_reason?: string | null; uncertain_assistance_uses?: number;
  qualifying_independent_evidence?: FeedbackReference[];
};
export type FeedbackMissedOpportunity = { id: string; session_item_id: string; opportunity_attempt_id: string; opportunity_response_id: string; original: FeedbackReference; suggested: string; reason: string; basis: "ai_suggestion" };
export type FeedbackRefactor = { id: string; original: FeedbackReference; suggested: string; reason: string; save_text: string | null; save_kind: CorpusKind; save_meaning: string | null };
export type FeedbackStatistics = { user_turns: number; assessed_turns: number; excluded_turns: number; word_count: number; average_words: number; selected_expressions: number; used_expressions: number; selected_structures: number; used_structures: number;
  primary_targets?: number; offered_primary_targets?: number; assessed_primary_targets?: number; used_primary_targets?: number; skipped_targets?: number; opportunity_targets?: number; used_opportunity_targets?: number;
};
export type FeedbackResult = { dimensions: FeedbackDimension[]; item_results: FeedbackItem[]; statistics: FeedbackStatistics; refactors: FeedbackRefactor[]; missed_opportunities?: FeedbackMissedOpportunity[]; missed_opportunities_status?: "not_requested" | "not_applicable" | "ready" | "unavailable"; logic_stages: { label: string; status: "observed" | "not_observed" | "uncertain"; reason: string; evidence: FeedbackReference[] }[]; notices: string[] };
export type SpeakingFeedback = { id: string; session_id: string; status: FeedbackStatus; input_hash: string; rubric_version: string; analysis_version: string; attempts: number; retryable: boolean; error_code: string | null; created_at: string; updated_at: string; session: SpeakingSession; effective_support_level?: SpeakingSupportLevel | null; messages: SpeakingMessage[]; result: FeedbackResult | null };

export type SupportRecommendationRequest = { targets: { corpus_item_id: string; role: SpeakingTargetRole }[]; current_level: SpeakingSupportLevel | null };
export type SupportRecommendation = {
  status: "suggest_reduce" | "insufficient_history" | "keep_current"; suggested_level: SpeakingSupportLevel | null;
  current_level: SpeakingSupportLevel | null; rule_version: "support-history-v1"; as_of: string; history_truncated: boolean; reason: string;
  targets: { corpus_item_id: string; role: SpeakingTargetRole; qualifying_missions: number; practice_days: number; scene_roots: number; eligible: boolean;
    evidence: { session_id: string; report_id: string; practiced_at: string }[] }[];
};
export type PracticeUseSummary = {
  status: FeedbackItem["status"]; opportunity_status: SpeakingOpportunity["status"] | null;
  independent_uses: number; prompted_uses: number; uncertain_assistance_uses: number; excluded_reason: string | null;
};
export type PracticeComparison = {
  status: "ready" | "pending" | "unavailable" | "incompatible"; reason: string; parent_session_id: string | null; child_session_id: string;
  parent_support_level: SpeakingSupportLevel | null; child_support_level: SpeakingSupportLevel | null;
  items: { session_item_id: string; parent_session_item_id: string; text: string; role: SpeakingTargetRole; before: PracticeUseSummary | null; after: PracticeUseSummary | null }[];
};
