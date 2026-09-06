import { selectCorpusItems } from "@libitu/core/stage-one";
import { readExtensionTranscript } from "./extension-handoff.ts";
import type {
  CorpusItem,
  CorpusSelectionAnalysis,
  CorpusKind,
  FunctionalTag,
  HighlightedTranscriptPart,
  LearnerLevel,
  LogicNode,
  StageOneBlueprint,
  TranscriptLine
} from "@libitu/types/stage-one";

const DEFAULT_API_BASE_URL = "http://localhost:8000";
const REQUEST_TIMEOUT_MS = 15_000;
const JOB_POLL_INTERVAL_MS = 1_500;
const JOB_WAIT_TIMEOUT_MS = 10 * 60_000;

const allowedTags = new Set<FunctionalTag>([
  "acknowledging",
  "clarifying",
  "conceding",
  "contrast",
  "discourse",
  "emphasising",
  "framing",
  "hedging",
  "idiom",
  "justifying",
  "proposing",
  "reframing",
  "redirecting",
  "softening",
  "summarising",
  "summarizing",
  "transitioning"
]);

export type StageOneSource = {
  kind: "youtube";
  sourceUrl: string;
  title: string;
  contentId?: string;
  jobId?: string;
  handoffId?: string;
  transcriptText?: string;
  language?: string;
  learnerLevel?: LearnerLevel;
};

type ApiContentResolveResponse = {
  content_id: string;
  kind: string;
  normalized_key: string;
  source_url: string | null;
  title: string | null;
};

type ApiProcessingJob = {
  id: string;
  content_id: string;
  status: "pending" | "processing" | "ready" | "failed";
  analysis_version: string;
  processing_stage?:
    | "queued"
    | "loading_content"
    | "fetching_transcript"
    | "formatting_transcript"
    | "analyzing"
    | "building_blueprint"
    | "persisting"
    | "completed"
    | "failed";
  blueprint_id: string | null;
  error_code?: string | null;
  error_message: string | null;
  analysis_preview?: ApiAnalysisPreview | null;
};

type ApiAnalysisPreview = {
  output_chars: number;
  summary: string | null;
  chapters: string[];
  logic_flow: Array<{ title: string; subtitle: string; timestamp: string | null }>;
  corpus_items: ApiPreviewCorpusItem[];
  transcript_lines: Array<{ time: string; text: string }>;
};

type ApiLogicNode = {
  id: string;
  title: string;
  subtitle: string;
  time: string | null;
};

type ApiHighlightedTranscriptPart = {
  text: string;
  tag: string;
  kind: string;
};

type ApiTranscriptLine = {
  id?: string | null;
  time: string;
  parts: Array<string | ApiHighlightedTranscriptPart>;
};

type ApiCorpusItem = {
  id: string;
  kind: string;
  text: string;
  tags: string[];
  meta: string;
  saved?: boolean;
  meaning?: string | null;
  usage_note?: string | null;
  source_text?: string | null;
  pattern_family?: string | null;
  level?: LearnerLevel | null;
  register?: "casual" | "neutral" | "professional" | "formal" | null;
  scenario_tags?: string[];
  phonology_note?: string | null;
  naturalness_score?: number | null;
  transferability_score?: number | null;
  learning_value_score?: number | null;
};

type ApiPreviewCorpusItem = Omit<ApiCorpusItem, "id" | "meta" | "saved"> & {
  timestamp?: string | null;
  meaning: string;
  source_text: string;
  level: LearnerLevel;
  naturalness_score: number;
  transferability_score: number;
  learning_value_score: number;
};

type ApiBlueprint = {
  id: string;
  content_id: string;
  title: string;
  source_url: string | null;
  summary: string;
  logic_flow: ApiLogicNode[];
  chapters: string[];
  transcript: ApiTranscriptLine[];
  corpus_items: ApiCorpusItem[];
};

export type ApiCorpusSelectionAnalysis = {
  analysis_source: "ai" | "fallback";
  provider_notice?: string | null;
  selection_type: "phrase" | "sentence";
  completeness: "complete" | "needs_expansion" | "structure_candidate";
  selected_text: string;
  recommended_text: string;
  recommendation_reason: string;
  fields: {
    kind: string;
    tags: string[];
    level: LearnerLevel;
    register: "casual" | "neutral" | "professional" | "formal";
  };
  note_placeholder: string;
  explanation: {
    pronunciation: {
      ipa: string;
      connected_speech: string;
      audio_text: string;
    };
    meaning: string;
    pragmatic_function: string;
    similar_expressions: string[];
    examples: Array<{
      english: string;
      chinese: string;
      typical?: boolean;
    }>;
    usage_chips: string[];
  };
  syntax_analysis: {
    sentence_type: string;
    main_clause: string;
    structure_breakdown: string[];
    logic_relations: string[];
    information_hierarchy: string[];
    style_features: string[];
    usage_scenarios: string[];
    grammar_points: string[];
    wording_notes: string[];
    reusable_patterns: Array<{
      template: string;
      slots: Record<string, string>;
      rationale: string;
    }>;
    translations: Array<{
      label: string;
      text: string;
      recommended?: boolean;
    }>;
    translation_notes: string[];
    background_context?: string | null;
    evidence: string[];
  };
};

export type AnalyzeCorpusSelectionInput = {
  contentId?: string;
  selectedText: string;
  currentSentence: string;
  contextBefore?: string;
  contextAfter?: string;
  timestamp?: string;
};

export type StageOneAnalysisPreview = {
  summary?: string;
  logicNodes: LogicNode[];
  chapters: string[];
  corpusItems: CorpusItem[];
  transcriptLines: TranscriptLine[];
  outputCharacters: number;
};

export class StageOneApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly kind: "failed" | "unsupported" = "failed"
  ) {
    super(message);
    this.name = "StageOneApiError";
  }
}

export const defaultStageOneSource: StageOneSource = {
  kind: "youtube",
  sourceUrl: "https://www.youtube.com/watch?v=abc123",
  title: "Building Anthropic | A conversation with our co-founders",
  learnerLevel: "B1"
};

export async function analyzeCorpusSelection(input: AnalyzeCorpusSelectionInput): Promise<CorpusSelectionAnalysis> {
  try {
    const analysis = await request<ApiCorpusSelectionAnalysis>("/api/corpus/analyze-selection", {
      method: "POST",
      body: JSON.stringify({
        content_id: input.contentId,
        selected_text: input.selectedText,
        current_sentence: input.currentSentence,
        context_before: input.contextBefore,
        context_after: input.contextAfter,
        timestamp: input.timestamp
      })
    }, 60_000);
    return toCorpusSelectionAnalysis(analysis);
  } catch {
    return fallbackSelectionAnalysis(input);
  }
}

export async function loadStageOneBlueprint(
  source = defaultStageOneSource,
  onProgress?: (message: string) => void,
  options: {
    signal?: AbortSignal;
    resumeFailedJob?: boolean;
    onPreview?: (preview: StageOneAnalysisPreview) => void;
    onResolved?: (ids: { contentId: string; jobId: string }) => void;
  } = {}
): Promise<StageOneBlueprint> {
  const { signal } = options;
  signal?.throwIfAborted();
  const loadRequest = <T>(path: string, init: RequestInit = {}) =>
    request<T>(path, { ...init, signal });
  let lastPreview = "";
  const onPreview = options.onPreview ? (preview: StageOneAnalysisPreview) => {
    if (signal?.aborted) return;
    const corpusItems = selectCorpusItems(preview.corpusItems, source.learnerLevel);
    const next = {
      ...preview,
      corpusItems,
      transcriptLines: preview.transcriptLines.map((line) => toTranscriptLine(line, corpusItems))
    };
    const signature = JSON.stringify(next);
    if (signature === lastPreview) return;
    lastPreview = signature;
    options.onPreview?.(next);
  } : undefined;
  if (source.contentId) {
    if (source.jobId) {
      onProgress?.("Checking the processing job.");
      let job: ApiProcessingJob;
      try {
        job = await loadRequest<ApiProcessingJob>(`/api/jobs/${source.jobId}`);
      } catch (error) {
        if (!(error instanceof StageOneApiError) || error.status !== 404) throw error;
        onProgress?.("Starting the current blueprint version.");
        job = await loadRequest<ApiProcessingJob>("/api/jobs", {
          method: "POST",
          body: JSON.stringify({ content_id: source.contentId })
        });
      }
      if (job.status === "failed" && options.resumeFailedJob) {
        onProgress?.("Restarting blueprint analysis.");
        job = await loadRequest<ApiProcessingJob>("/api/jobs", {
          method: "POST",
          body: JSON.stringify({ content_id: source.contentId })
        });
      }
      options.onResolved?.({ contentId: source.contentId, jobId: job.id });
      job = await waitForJob(job, onProgress, onPreview, signal);
      assertReadyJob(job);
    }
    onProgress?.("Loading the completed blueprint.");
    let blueprint: ApiBlueprint;
    try {
      blueprint = await loadRequest<ApiBlueprint>(blueprintPath(source.contentId, source.learnerLevel));
    } catch (error) {
      if (!(error instanceof StageOneApiError) || error.status !== 404) throw error;
      onProgress?.("Updating this content to the current blueprint version.");
      let currentJob = await loadRequest<ApiProcessingJob>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({ content_id: source.contentId })
      });
      options.onResolved?.({ contentId: source.contentId, jobId: currentJob.id });
      currentJob = await waitForJob(currentJob, onProgress, onPreview, signal);
      assertReadyJob(currentJob);
      blueprint = await loadRequest<ApiBlueprint>(blueprintPath(source.contentId, source.learnerLevel));
    }
    return toStageOneBlueprint(blueprint, {
      content_id: source.contentId,
      kind: source.kind,
      normalized_key: `youtube:${source.contentId}`,
      source_url: source.sourceUrl,
      title: source.title
    });
  }

  let transcriptText = source.transcriptText;
  if (source.handoffId && !transcriptText) {
    onProgress?.("Reading captions from YouTube.");
    transcriptText = await readExtensionTranscript(source.handoffId, signal);
    signal?.throwIfAborted();
  }
  onProgress?.(transcriptText ? "Saving the source transcript." : "Checking available captions.");
  const content = await loadRequest<ApiContentResolveResponse>("/api/content/resolve", {
    method: "POST",
    body: JSON.stringify({
      kind: source.kind,
      source_url: source.sourceUrl,
      transcript_text: transcriptText,
      language: source.language,
      title: source.title
    })
  });

  onProgress?.("Starting blueprint analysis.");
  let job = await loadRequest<ApiProcessingJob>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      content_id: content.content_id
    })
  });

  options.onResolved?.({ contentId: content.content_id, jobId: job.id });
  job = await waitForJob(job, onProgress, onPreview, signal);
  assertReadyJob(job);

  onProgress?.("Loading the completed blueprint.");
  const blueprint = await loadRequest<ApiBlueprint>(blueprintPath(content.content_id, source.learnerLevel));
  return toStageOneBlueprint(blueprint, content);
}

async function waitForJob(
  initialJob: ApiProcessingJob,
  onProgress?: (message: string) => void,
  onPreview?: (preview: StageOneAnalysisPreview) => void,
  signal?: AbortSignal
): Promise<ApiProcessingJob> {
  signal?.throwIfAborted();
  notifyJobUpdate(initialJob, onProgress, onPreview);
  if (!["pending", "processing"].includes(initialJob.status)) return initialJob;

  const deadline = Date.now() + JOB_WAIT_TIMEOUT_MS;
  try {
    return await waitForJobStream(initialJob, deadline, onProgress, onPreview, signal);
  } catch {
    signal?.throwIfAborted();
    return waitForJobPolling(initialJob, deadline, onProgress, onPreview, signal);
  }
}

function waitForJobStream(
  initialJob: ApiProcessingJob,
  deadline: number,
  onProgress?: (message: string) => void,
  onPreview?: (preview: StageOneAnalysisPreview) => void,
  signal?: AbortSignal
): Promise<ApiProcessingJob> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let settled = false;
    const stream = new EventSource(`${apiBaseUrl()}/api/jobs/${initialJob.id}/events`);
    const timeout = window.setTimeout(() => finish(() => reject(new Error("Job stream timed out."))), Math.max(0, deadline - Date.now()));

    function finish(action: () => void) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      stream.close();
      action();
    }

    function abort() {
      finish(() => reject(signal?.reason ?? new DOMException("Loading cancelled", "AbortError")));
    }
    signal?.addEventListener("abort", abort, { once: true });

    stream.addEventListener("job", (event) => {
      if (settled) return;
      try {
        const job = JSON.parse(event.data) as ApiProcessingJob;
        notifyJobUpdate(job, onProgress, onPreview);
        if (!["pending", "processing"].includes(job.status)) {
          finish(() => resolve(job));
        }
      } catch (error) {
        finish(() => reject(error));
      }
    });
    stream.onerror = () => finish(() => reject(new Error("Job stream disconnected.")));
  });
}

async function waitForJobPolling(
  initialJob: ApiProcessingJob,
  deadline: number,
  onProgress?: (message: string) => void,
  onPreview?: (preview: StageOneAnalysisPreview) => void,
  signal?: AbortSignal
): Promise<ApiProcessingJob> {
  let job = initialJob;
  while (["pending", "processing"].includes(job.status) && Date.now() < deadline) {
    notifyJobUpdate(job, onProgress, onPreview);
    await delay(JOB_POLL_INTERVAL_MS, signal);
    job = await request<ApiProcessingJob>(`/api/jobs/${job.id}`, { signal });
  }
  notifyJobUpdate(job, onProgress, onPreview);
  return job;
}

function notifyJobUpdate(
  job: ApiProcessingJob,
  onProgress?: (message: string) => void,
  onPreview?: (preview: StageOneAnalysisPreview) => void
) {
  onProgress?.(jobProgressMessage(job));
  if (job.status === "processing" && job.analysis_preview) {
    onPreview?.(toStageOneAnalysisPreview(job.analysis_preview));
  }
}

function assertReadyJob(job: ApiProcessingJob) {
  if (job.status === "failed") {
    const kind = ["content_not_found", "transcript_unavailable"].includes(job.error_code ?? "")
      ? "unsupported"
      : "failed";
    throw new StageOneApiError(job.error_message ?? "Processing failed.", 200, kind);
  }
  if (job.status !== "ready") {
    throw new StageOneApiError("Processing is still running. Try again in a moment.");
  }
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  init.signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  init.signal?.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...init.headers
      }
    });
    if (!response.ok) {
      const message = await readErrorMessage(response);
      throw new StageOneApiError(message, response.status, response.status === 422 ? "unsupported" : "failed");
    }
    const result = await response.json() as T;
    init.signal?.throwIfAborted();
    return result;
  } catch (error) {
    init.signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new StageOneApiError("The API request timed out. Check the API and worker services.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abort);
  }
}

function jobProgressMessage(job: ApiProcessingJob) {
  switch (job.processing_stage) {
    case "loading_content":
      return "Loading the source content.";
    case "fetching_transcript":
      return "Fetching available captions.";
    case "formatting_transcript": {
      const lineCount = job.analysis_preview?.transcript_lines.length ?? 0;
      return lineCount
        ? `Formatting captions locally (${lineCount.toLocaleString()} sentences ready).`
        : "Formatting captions locally.";
    }
    case "analyzing":
      return job.analysis_preview?.output_chars
        ? `DeepSeek is streaming the analysis (${job.analysis_preview.output_chars.toLocaleString()} characters received).`
        : "DeepSeek is analyzing the transcript.";
    case "building_blueprint":
      return "Building the logic map and transcript annotations.";
    case "persisting":
      return "Saving the completed blueprint.";
    default:
      return job.status === "pending" ? "Waiting for the blueprint worker." : "Processing the blueprint.";
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: unknown };
    if (typeof payload.detail === "string") return payload.detail;
  } catch {
    return `API request failed with status ${response.status}.`;
  }

  return `API request failed with status ${response.status}.`;
}

function apiBaseUrl() {
  return (process.env.NEXT_PUBLIC_LIBITU_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
}

function blueprintPath(contentId: string, learnerLevel?: LearnerLevel) {
  const query = new URLSearchParams({ corpus_limit: "12" });
  if (learnerLevel) query.set("learner_level", learnerLevel);
  return `/api/blueprints/${contentId}?${query.toString()}`;
}

function toStageOneBlueprint(blueprint: ApiBlueprint, content: ApiContentResolveResponse): StageOneBlueprint {
  const corpusItems = blueprint.corpus_items.map(toCorpusItem);
  return {
    id: blueprint.id,
    contentId: blueprint.content_id,
    sourceUrl: blueprint.source_url ?? content.source_url ?? undefined,
    title: blueprint.title || content.title || "Untitled content",
    summary: blueprint.summary,
    logicNodes: blueprint.logic_flow.map(toLogicNode),
    chapters: blueprint.chapters,
    transcript: blueprint.transcript.map((line) => toTranscriptLine(line, corpusItems)),
    corpusItems
  };
}

function toLogicNode(node: ApiLogicNode): LogicNode {
  return {
    id: node.id,
    title: node.title,
    subtitle: node.subtitle,
    time: node.time
  };
}

function toStageOneAnalysisPreview(preview: ApiAnalysisPreview): StageOneAnalysisPreview {
  const logicNodes = preview.logic_flow.map((node, index) => ({
    id: `logic-${index + 1}`,
    title: node.title,
    subtitle: node.subtitle,
    time: node.timestamp
  }));
  const corpusItems = preview.corpus_items.map((item, index) =>
    toCorpusItem({
      ...item,
      id: `${item.kind}-${index + 1}`,
      text: item.kind === "structure" ? item.text : `"${item.text}" - ${item.meaning}`,
      meta: `${item.timestamp ?? "--:--"} - ${item.level} - analyzing`
    })
  );

  return {
    summary: preview.summary ?? undefined,
    chapters: preview.chapters,
    logicNodes,
    corpusItems,
    transcriptLines: (preview.transcript_lines ?? []).map((line) =>
      toTranscriptLine(
        {
          id: logicNodes.find((node) => node.time === line.time)?.id,
          time: line.time,
          parts: [line.text]
        },
        corpusItems
      )
    ),
    outputCharacters: preview.output_chars
  };
}

function toTranscriptLine(line: ApiTranscriptLine, corpusItems: CorpusItem[]): TranscriptLine {
  return {
    id: line.id ?? undefined,
    time: line.time,
    parts: annotateTranscriptText(
      line.parts.map((part) => typeof part === "string" ? part : part.text).join(""),
      corpusItems
    )
  };
}

function annotateTranscriptText(text: string, corpusItems: CorpusItem[]): Array<string | HighlightedTranscriptPart> {
  const lowered = text.toLocaleLowerCase();
  const matches = corpusItems.flatMap((item) => {
    const phrase = item.sourceText ?? extractCandidatePhrase(item.text);
    const match = findCandidateMatch(lowered, phrase);
    if (!match) return [];
    return [{ ...match, item }];
  }).sort((left, right) => left.start - right.start || right.end - left.end);

  if (matches.length === 0) return [text];

  const parts: Array<string | HighlightedTranscriptPart> = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    if (match.start > cursor) parts.push(text.slice(cursor, match.start));
    parts.push({
      text: text.slice(match.start, match.end),
      tag: match.item.tags[0] ?? (match.item.kind === "structure" ? "framing" : "discourse"),
      kind: match.item.kind
    });
    cursor = match.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function extractCandidatePhrase(value: string) {
  const quoted = value.match(/^["“'](.+?)["”']\s*(?:[-–—]|$)/)?.[1];
  if (quoted) return quoted.trim();
  return value.split(/\s+[-–—]\s+/)[0]?.replace(/^["“']|["”']$/g, "").trim() ?? value;
}

function findCandidateMatch(loweredText: string, phrase: string): { start: number; end: number } | null {
  if (phrase.length < 3) return null;
  const exactStart = loweredText.indexOf(phrase.toLocaleLowerCase());
  if (exactStart >= 0) return { start: exactStart, end: exactStart + phrase.length };

  const words = phrase.toLocaleLowerCase().match(/[a-z0-9']+/g) ?? [];
  for (let length = words.length - 1; length >= 3; length -= 1) {
    for (let startWord = 0; startWord + length <= words.length; startWord += 1) {
      const fragment = words.slice(startWord, startWord + length).join(" ");
      const start = loweredText.indexOf(fragment);
      if (start >= 0) return { start, end: start + fragment.length };
    }
  }
  return null;
}

function toCorpusItem(item: ApiCorpusItem): CorpusItem {
  const phrase = item.kind === "structure" ? item.text : extractCandidatePhrase(item.text);
  const identity = phrase.toLowerCase().match(/[a-z0-9']+/g)?.join(" ") ?? phrase;
  return {
    id: `corpus:${item.kind}:${identity}`,
    kind: toCorpusKind(item.kind),
    text: item.text,
    tags: item.tags.filter((tag): tag is FunctionalTag => allowedTags.has(tag as FunctionalTag)),
    meta: item.meta,
    saved: item.saved ?? false,
    meaning: item.meaning ?? undefined,
    usageNote: item.usage_note ?? undefined,
    sourceText: item.source_text ?? undefined,
    patternFamily: item.pattern_family ?? undefined,
    level: item.level ?? undefined,
    register: item.register ?? undefined,
    scenarioTags: item.scenario_tags ?? [],
    phonologyNote: item.phonology_note ?? undefined,
    naturalnessScore: item.naturalness_score ?? undefined,
    transferabilityScore: item.transferability_score ?? undefined,
    learningValueScore: item.learning_value_score ?? undefined
  };
}

export function toCorpusSelectionAnalysis(analysis: ApiCorpusSelectionAnalysis): CorpusSelectionAnalysis {
  return {
    analysisSource: analysis.analysis_source,
    providerNotice: analysis.provider_notice ?? undefined,
    selectionType: analysis.selection_type,
    completeness: analysis.completeness,
    selectedText: analysis.selected_text,
    recommendedText: analysis.recommended_text,
    recommendationReason: analysis.recommendation_reason,
    fields: {
      kind: toCorpusKind(analysis.fields.kind),
      tags: analysis.fields.tags.filter((tag): tag is FunctionalTag => allowedTags.has(tag as FunctionalTag)),
      level: analysis.fields.level,
      register: analysis.fields.register
    },
    notePlaceholder: analysis.note_placeholder,
    explanation: {
      pronunciation: {
        ipa: analysis.explanation.pronunciation.ipa,
        connectedSpeech: analysis.explanation.pronunciation.connected_speech,
        audioText: analysis.explanation.pronunciation.audio_text
      },
      meaning: analysis.explanation.meaning,
      pragmaticFunction: analysis.explanation.pragmatic_function,
      similarExpressions: analysis.explanation.similar_expressions,
      examples: analysis.explanation.examples.map((example) => ({
        english: example.english,
        chinese: example.chinese,
        typical: example.typical ?? false
      })),
      usageChips: analysis.explanation.usage_chips
    },
    syntaxAnalysis: {
      sentenceType: analysis.syntax_analysis.sentence_type,
      mainClause: analysis.syntax_analysis.main_clause,
      structureBreakdown: analysis.syntax_analysis.structure_breakdown,
      logicRelations: analysis.syntax_analysis.logic_relations,
      informationHierarchy: analysis.syntax_analysis.information_hierarchy,
      styleFeatures: analysis.syntax_analysis.style_features,
      usageScenarios: analysis.syntax_analysis.usage_scenarios,
      grammarPoints: analysis.syntax_analysis.grammar_points,
      wordingNotes: analysis.syntax_analysis.wording_notes,
      reusablePatterns: analysis.syntax_analysis.reusable_patterns,
      translations: analysis.syntax_analysis.translations.map((translation) => ({
        ...translation,
        recommended: translation.recommended ?? false
      })),
      translationNotes: analysis.syntax_analysis.translation_notes,
      backgroundContext: analysis.syntax_analysis.background_context ?? undefined,
      evidence: analysis.syntax_analysis.evidence
    }
  };
}

export function toApiCorpusSelectionAnalysis(analysis: CorpusSelectionAnalysis): ApiCorpusSelectionAnalysis {
  return {
    analysis_source: analysis.analysisSource,
    provider_notice: analysis.providerNotice,
    selection_type: analysis.selectionType,
    completeness: analysis.completeness,
    selected_text: analysis.selectedText,
    recommended_text: analysis.recommendedText,
    recommendation_reason: analysis.recommendationReason,
    fields: analysis.fields,
    note_placeholder: analysis.notePlaceholder,
    explanation: {
      pronunciation: {
        ipa: analysis.explanation.pronunciation.ipa,
        connected_speech: analysis.explanation.pronunciation.connectedSpeech,
        audio_text: analysis.explanation.pronunciation.audioText
      },
      meaning: analysis.explanation.meaning,
      pragmatic_function: analysis.explanation.pragmaticFunction,
      similar_expressions: analysis.explanation.similarExpressions,
      examples: analysis.explanation.examples,
      usage_chips: analysis.explanation.usageChips
    },
    syntax_analysis: {
      sentence_type: analysis.syntaxAnalysis.sentenceType,
      main_clause: analysis.syntaxAnalysis.mainClause,
      structure_breakdown: analysis.syntaxAnalysis.structureBreakdown,
      logic_relations: analysis.syntaxAnalysis.logicRelations,
      information_hierarchy: analysis.syntaxAnalysis.informationHierarchy,
      style_features: analysis.syntaxAnalysis.styleFeatures,
      usage_scenarios: analysis.syntaxAnalysis.usageScenarios,
      grammar_points: analysis.syntaxAnalysis.grammarPoints,
      wording_notes: analysis.syntaxAnalysis.wordingNotes,
      reusable_patterns: analysis.syntaxAnalysis.reusablePatterns,
      translations: analysis.syntaxAnalysis.translations,
      translation_notes: analysis.syntaxAnalysis.translationNotes,
      background_context: analysis.syntaxAnalysis.backgroundContext,
      evidence: analysis.syntaxAnalysis.evidence
    }
  };
}

function fallbackSelectionAnalysis(input: AnalyzeCorpusSelectionInput): CorpusSelectionAnalysis {
  const selectedText = input.selectedText.trim();
  const isSentence = /[.!?]$/.test(selectedText);

  return {
    analysisSource: "fallback",
    providerNotice: "AI 分析暂时不可用；当前仅保留你的原始选择，不会猜测含义或擅自补全边界。",
    selectionType: isSentence ? "sentence" : "phrase",
    completeness: "complete",
    selectedText,
    recommendedText: selectedText,
    recommendationReason: "AI 未完成边界判断，因此默认按你实际选中的内容保存。",
    fields: {
      kind: "chunk",
      tags: ["discourse"],
      level: "B1",
      register: "neutral"
    },
    notePlaceholder: "可选：写下你的理解、联想或使用场景",
    explanation: {
      pronunciation: {
        ipa: "待 AI 分析",
        connectedSpeech: "AI 可用后会结合上下文分析重音、弱读和连读。",
        audioText: selectedText
      },
      meaning: "AI 暂时不可用，无法可靠解释这段选择在当前上下文中的具体含义。",
      pragmaticFunction: "AI 暂时不可用，无法可靠判断它在这段对话中的语用作用。",
      similarExpressions: [],
      examples: [],
      usageChips: ["等待 AI 分析"]
    },
    syntaxAnalysis: {
      sentenceType: "待 AI 判断",
      mainClause: "待 AI 分析",
      structureBreakdown: [],
      logicRelations: [],
      informationHierarchy: [],
      styleFeatures: [],
      usageScenarios: [],
      grammarPoints: [],
      wordingNotes: [],
      reusablePatterns: [],
      translations: [{ label: "待分析", text: "AI 暂时不可用，未生成翻译。", recommended: true }],
      translationNotes: [],
      evidence: [input.contextBefore, input.currentSentence, input.contextAfter].filter((value): value is string => Boolean(value))
    }
  };
}

function toCorpusKind(kind: string): CorpusKind {
  if (kind === "idiom" || kind === "structure") return kind;
  return "chunk";
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    function abort() {
      window.clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Loading cancelled", "AbortError"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
