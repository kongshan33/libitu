export type LogicNode = {
  id: string;
  title: string;
  subtitle: string;
  time: string | null;
};

export type SegmentDifficulty = "easy" | "medium" | "dense";

/**
 * A contiguous, playable practice unit derived from a Stage 1 blueprint.
 * Time and transcript ranges remain optional for backward-compatible legacy blueprints.
 */
export type StageOneSegment = {
  id: string;
  sequence?: number;
  title: string;
  summary: string;
  logicNodeId?: string;
  timestampMs?: number;
  startMs?: number;
  endMs?: number;
  durationMs?: number;
  transcriptStartIndex?: number;
  transcriptEndIndex?: number;
  sourceText?: string;
  quote?: string;
  wordCount?: number;
  phonologyTags: string[];
  difficulty?: SegmentDifficulty;
  recommended?: boolean;
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
  analysisDetail?: CorpusItemAnalysisDetail;
};

export type HighlightedTranscriptPart = {
  corpusItemId?: string;
  text: string;
  tag: string;
  kind: CorpusKind;
};

export type TranscriptPart = string | HighlightedTranscriptPart;

export type SentenceBoundarySource =
  | "source_punctuation"
  | "punctuation_model"
  | "syntax_merge"
  | "caption_pause"
  | "unresolved";

export type SentenceBoundaryConfidence = "high" | "medium" | "low";

/** Provider captions only: offsets are not acoustic word alignment. */
export type CaptionTrack = {
  version: "youtube-json3-v1" | "youtube-snippets-v1";
  video_id: string;
  language: string | null;
  kind: "asr" | "manual" | "unknown";
  events: Array<{
    tStartMs: number;
    dDurationMs?: number;
    segs: Array<{ utf8: string; tOffsetMs?: number }>;
    aAppend?: number;
    wWinId?: number;
  }>;
};

export type CaptionTimingSource = "caption_word_offsets" | "caption_event_estimate" | "caption_estimate";

export type CaptionWordTiming = {
  sourceTokenIndex: number;
  text: string;
  startMs: number;
  endMs: number | null;
  startSource: "caption_offset";
  endSource: "next_word_estimate" | "event_end_estimate" | null;
  sourceEventIndex: number;
  sourceSegIndex: number;
};

export type TranscriptLine = {
  id?: string;
  time: string;
  parts: TranscriptPart[];
  /** Present when the server has finalized this row as one shared sentence. */
  segmentationVersion?: string;
  /** Half-open whitespace-token range in the normalized source captions. */
  sourceTokenStart?: number;
  sourceTokenEnd?: number;
  /** Caption estimates, not word-level acoustic alignment. */
  startMs?: number;
  endMs?: number;
  boundarySource?: SentenceBoundarySource;
  boundaryConfidence?: SentenceBoundaryConfidence;
  timingSource?: CaptionTimingSource;
  wordTimings?: CaptionWordTiming[];
};

export type CorpusFilter = "chunks" | "idioms" | "structures" | "saved";

export type StageOneBlueprint = {
  id: string;
  contentId: string;
  segmentationVersion?: string;
  sourceUrl?: string;
  title: string;
  summary: string;
  logicNodes: LogicNode[];
  chapters: string[];
  transcript: TranscriptLine[];
  corpusItems: CorpusItem[];
  segments: StageOneSegment[];
};

export type SelectionCompleteness = "complete" | "needs_expansion" | "structure_candidate";

export type CorpusSelectionContext = {
  contentId?: string;
  selectedText: string;
  currentSentence: string;
  contextBefore?: string;
  contextAfter?: string;
  timestamp?: string;
};

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

export type CorpusItemAnalysisDetail = {
  context: CorpusSelectionContext;
  analysis: CorpusSelectionAnalysis;
};
