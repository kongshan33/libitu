export type LogicNode = {
  id: string;
  title: string;
  subtitle: string;
  time: string | null;
};

export type CorpusKind = "chunk" | "idiom" | "structure";

export type LearnerLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";

export type FunctionalTag =
  | "acknowledging"
  | "clarifying"
  | "conceding"
  | "contrast"
  | "discourse"
  | "emphasising"
  | "framing"
  | "hedging"
  | "idiom"
  | "justifying"
  | "proposing"
  | "reframing"
  | "redirecting"
  | "softening"
  | "summarising"
  | "summarizing"
  | "transitioning";

export type CorpusItem = {
  id: string;
  kind: CorpusKind;
  text: string;
  tags: FunctionalTag[];
  meta: string;
  saved?: boolean;
  meaning?: string;
  usageNote?: string;
  sourceText?: string;
  patternFamily?: string;
  level?: LearnerLevel;
  register?: "casual" | "neutral" | "professional" | "formal";
  scenarioTags?: string[];
  phonologyNote?: string;
  naturalnessScore?: number;
  transferabilityScore?: number;
  learningValueScore?: number;
  slots?: Record<string, string>;
};

export type HighlightedTranscriptPart = {
  text: string;
  tag: string;
  kind: CorpusKind;
};

export type TranscriptPart = string | HighlightedTranscriptPart;

export type TranscriptLine = {
  id?: string;
  time: string;
  parts: TranscriptPart[];
};

export type CorpusFilter = "chunks" | "idioms" | "structures" | "saved";

export type StageOneBlueprint = {
  id: string;
  contentId: string;
  sourceUrl?: string;
  title: string;
  summary: string;
  logicNodes: LogicNode[];
  chapters: string[];
  transcript: TranscriptLine[];
  corpusItems: CorpusItem[];
};

export type SelectionCompleteness = "complete" | "needs_expansion" | "structure_candidate";

export type CorpusSelectionAnalysis = {
  analysisSource: "ai" | "fallback";
  providerNotice?: string;
  selectionType: "phrase" | "sentence";
  completeness: SelectionCompleteness;
  selectedText: string;
  recommendedText: string;
  recommendationReason: string;
  fields: {
    kind: CorpusKind;
    tags: FunctionalTag[];
    level: LearnerLevel;
    register: "casual" | "neutral" | "professional" | "formal";
  };
  notePlaceholder: string;
  explanation: {
    pronunciation: {
      ipa: string;
      connectedSpeech: string;
      audioText: string;
    };
    meaning: string;
    pragmaticFunction: string;
    similarExpressions: string[];
    examples: Array<{
      english: string;
      chinese: string;
      typical: boolean;
    }>;
    usageChips: string[];
  };
  syntaxAnalysis: {
    sentenceType: string;
    mainClause: string;
    structureBreakdown: string[];
    logicRelations: string[];
    informationHierarchy: string[];
    styleFeatures: string[];
    usageScenarios: string[];
    grammarPoints: string[];
    wordingNotes: string[];
    reusablePatterns: Array<{
      template: string;
      slots: Record<string, string>;
      rationale: string;
    }>;
    translations: Array<{
      label: string;
      text: string;
      recommended: boolean;
    }>;
    translationNotes: string[];
    backgroundContext?: string;
    evidence: string[];
  };
};
