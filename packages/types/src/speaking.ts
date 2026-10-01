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
