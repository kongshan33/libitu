import type { CorpusKind } from "./stage-one";

export type SpeakingScenario = "workplace" | "everyday";
export type SpeakingDifficulty = "guided" | "standard" | "challenging";
export type SpeakingFeedbackLevel = "light" | "balanced" | "detailed";
export type LogicTemplateId = "persuasive_pitch" | "technical_troubleshoot" | "stakeholder_alignment" | "status_update" | "disagreement" | "onboarding";
export type SpeakingLogicTemplate = { id: LogicTemplateId; title: string; description: string; steps: string[] };
export type SpeakingOptions = {
  logic_templates: SpeakingLogicTemplate[];
  max_structures: number;
  max_expressions: number;
  min_items: number;
};
export type SpeakingSessionCreate = {
  client_id: string;
  scenario_type: SpeakingScenario;
  goal: string;
  difficulty: SpeakingDifficulty;
  feedback_level: SpeakingFeedbackLevel;
  logic_template_id: LogicTemplateId | null;
  corpus_item_ids: string[];
};
export type SpeakingSessionItem = {
  id: string;
  corpus_item_id: string | null;
  ordinal: number;
  kind: CorpusKind;
  text: string;
  meaning: string | null;
  tags: string[];
  slots: Record<string, string>;
  source_title: string | null;
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
  target_item_id: string | null; action: "continue_naturally" | "implicit_elicitation" | "explicit_hint" | "move_on";
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
  | { type: "interrupt" | "ping" };
export type SpeakingServerEvent =
  | { type: "ready" | "snapshot" | "ended"; workspace: SpeakingWorkspace }
  | { type: "state"; state: "listening" | "thinking" | "speaking" }
  | { type: "user.activity"; speaking: boolean }
  | { type: "transcript.delta"; role: "user" | "assistant"; item_id: string; delta: string }
  | { type: "audio.delta"; item_id: string; response_id: string; audio: string }
  | { type: "audio.clear"; item_id: string | null }
  | { type: "error"; code: string; message: string; retryable: boolean }
  | { type: "pong" };

export type FeedbackStatus = "queued" | "processing" | "ready" | "partial" | "insufficient_data" | "failed";
export type FeedbackDimensionId = "task_fit" | "transfer" | "scenario_fit" | "naturalness";
export type FeedbackReference = { message_id: string; transcript_revision: number; quote: string; start: number; end: number };
export type FeedbackCriterion = { id: string; label: string; rating: number | null; reason: string; evidence: FeedbackReference[] };
export type FeedbackDimension = { id: FeedbackDimensionId; score: number | null; basis: "ai_assessment" | "coverage"; summary: string; criteria: FeedbackCriterion[] };
export type FeedbackItem = { session_item_id: string; kind: CorpusKind; text: string; status: "appropriate" | "inappropriate" | "uncertain" | "not_observed"; independent_uses: number; prompted_uses: number; reason: string; evidence: FeedbackReference[] };
export type FeedbackRefactor = { id: string; original: FeedbackReference; suggested: string; reason: string; save_text: string | null; save_kind: CorpusKind; save_meaning: string | null };
export type FeedbackStatistics = { user_turns: number; assessed_turns: number; excluded_turns: number; word_count: number; average_words: number; selected_expressions: number; used_expressions: number; selected_structures: number; used_structures: number };
export type FeedbackResult = { dimensions: FeedbackDimension[]; item_results: FeedbackItem[]; statistics: FeedbackStatistics; refactors: FeedbackRefactor[]; logic_stages: { label: string; status: "observed" | "not_observed" | "uncertain"; reason: string; evidence: FeedbackReference[] }[]; notices: string[] };
export type SpeakingFeedback = { id: string; session_id: string; status: FeedbackStatus; input_hash: string; rubric_version: string; analysis_version: string; attempts: number; retryable: boolean; error_code: string | null; created_at: string; updated_at: string; session: SpeakingSession; messages: SpeakingMessage[]; result: FeedbackResult | null };
