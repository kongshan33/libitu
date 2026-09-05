"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { Check, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import type { CorpusFilter, CorpusItem, CorpusKind, CorpusSelectionAnalysis, FunctionalTag, StageOneBlueprint } from "@libitu/types/stage-one";
import type { LearnerLevel } from "@libitu/types/stage-one";
import { AuthControls } from "@/features/auth/components/AuthControls";
import {
  analyzeCorpusSelection,
  defaultStageOneSource,
  loadStageOneBlueprint,
  StageOneApiError,
  type StageOneAnalysisPreview,
  type StageOneSource
} from "../api/stage-one-api";
import { YouTubePlayer, type YouTubePlayerHandle } from "./YouTubePlayer";
import { useSavedCorpus } from "./useSavedCorpus";
import { savedCorpusKey } from "../api/corpus-storage";

const tagClass: Record<CorpusItem["tags"][number], string> = {
  acknowledging: "tag-teal",
  clarifying: "tag-teal",
  conceding: "tag-purple",
  contrast: "tag-purple",
  discourse: "tag-purple",
  emphasising: "tag-amber",
  framing: "tag-amber",
  hedging: "tag-amber",
  idiom: "tag-teal",
  justifying: "tag-amber",
  proposing: "tag-teal",
  reframing: "tag-teal",
  redirecting: "tag-purple",
  softening: "tag-gray",
  summarising: "tag-teal",
  summarizing: "tag-teal",
  transitioning: "tag-purple"
};

const editableKinds: CorpusKind[] = ["chunk", "idiom", "structure"];
const editableTags: FunctionalTag[] = ["discourse", "softening", "hedging", "clarifying", "contrast", "justifying", "reframing", "proposing"];
const editableLevels: LearnerLevel[] = ["A1", "A2", "B1", "B2", "C1", "C2"];
const editableRegisters: NonNullable<CorpusItem["register"]>[] = ["casual", "neutral", "professional", "formal"];

type SelectionCardState = {
  id: string;
  pinned: boolean;
  analysis: CorpusSelectionAnalysis;
  fieldDraft: CorpusSelectionAnalysis["fields"];
  note: string;
  tab: "explain" | "syntax";
  status: "loading" | "ready";
  position: { x: number; y: number };
  context: AnalyzeSelectionContext;
};

type AnalyzeSelectionContext = {
  selectedText: string;
  currentSentence: string;
  contextBefore?: string;
  contextAfter?: string;
  timestamp?: string;
};

function LibraryIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M3.25 3.5h9.5v9h-9.5zM5.5 5.75h5M5.5 8h5M5.5 10.25h3" />
    </svg>
  );
}

export function StageOneReader() {
  const [blueprint, setBlueprint] = useState<StageOneBlueprint | null>(null);
  const [analysisPreview, setAnalysisPreview] = useState<StageOneAnalysisPreview | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed" | "unsupported">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeNode, setActiveNode] = useState<string | null>(null);
  const [activeTranscriptTime, setActiveTranscriptTime] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<CorpusFilter>("chunks");
  const corpus = useSavedCorpus();
  const [selectionCard, setSelectionCard] = useState<SelectionCardState | null>(null);
  const closeSelectionCard = useCallback(() => setSelectionCard(null), []);
  const [autoScroll, setAutoScroll] = useState(true);
  const [highlightActive, setHighlightActive] = useState(true);
  const [sourceTitle, setSourceTitle] = useState("Loading Stage 1 content");
  const [source, setSource] = useState<StageOneSource | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const playerRef = useRef<YouTubePlayerHandle>(null);

  const sourceKey = blueprint?.contentId ?? source?.contentId ?? source?.sourceUrl ?? "";
  const sourceUrl = blueprint?.sourceUrl ?? source?.sourceUrl;
  const savedRecords = corpus.records.filter((record) => (record.contentId ?? record.sourceUrl) === sourceKey
    || Boolean(sourceUrl && record.sourceUrl === sourceUrl));
  const savedByKey = new Map(savedRecords.map((record) => [record.key, record]));
  const corpusKey = (item: CorpusItem) => savedRecords.find((record) =>
    record.key === savedCorpusKey(record.contentId ?? record.sourceUrl, item)
    || savedCorpusKey("", record.item) === savedCorpusKey("", item))?.key ?? savedCorpusKey(sourceKey, item);
  const candidates = blueprint?.corpusItems ?? analysisPreview?.corpusItems ?? [];
  const allCorpus = [...new Map([
    ...candidates.map((item) => [corpusKey(item), item] as const),
    ...savedRecords.map((record) => [record.key, record.item] as const)
  ]).entries()].map(([key, item]) => ({ key, item, record: savedByKey.get(key) }));
  const visibleCorpus = activeTab === "saved" ? savedRecords.map((record) => ({ key: record.key, item: record.item, record }))
    : allCorpus.filter(({ item }) => item.kind === ({ chunks: "chunk", idioms: "idiom", structures: "structure" } as const)[activeTab]);

  useEffect(() => {
    const nextSource = readStageOneSource();
    setSource((current) => current ?? nextSource);
    setSourceTitle(nextSource.title);
  }, []);

  useEffect(() => {
    if (!source) return;

    const activeSource = source;
    const controller = new AbortController();
    loadControllerRef.current = controller;

    loadBlueprint();

    return () => {
      controller.abort();
      if (loadControllerRef.current === controller) loadControllerRef.current = null;
    };

    async function loadBlueprint() {
      // Strict Mode can dispose the first setup before any network work starts.
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setStatus("loading");
      setErrorMessage(null);
      setAnalysisPreview(null);

      try {
        const nextBlueprint = await loadStageOneBlueprint(activeSource, (message) => {
          if (!controller.signal.aborted) setErrorMessage(message);
        }, {
          signal: controller.signal,
          resumeFailedJob: loadAttempt > 0,
          onPreview: (preview) => {
            if (!controller.signal.aborted) setAnalysisPreview(preview);
          }
        });
        if (controller.signal.aborted) return;
        setBlueprint(nextBlueprint);
        setActiveNode((current) => current ?? nextBlueprint.logicNodes[0]?.id ?? null);
        setAnalysisPreview(null);
        setStatus("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        const apiError = error instanceof StageOneApiError ? error : null;
        setStatus(apiError?.kind ?? "failed");
        setErrorMessage(error instanceof Error ? error.message : "Unable to load this content.");
      }
    }
  }, [source, loadAttempt]);

  const transcript = useMemo(
    () => blueprint?.transcript ?? analysisPreview?.transcriptLines ?? [],
    [analysisPreview?.transcriptLines, blueprint?.transcript]
  );
  const logicNodes = useMemo(
    () => blueprint?.logicNodes ?? analysisPreview?.logicNodes ?? [],
    [analysisPreview?.logicNodes, blueprint?.logicNodes]
  );
  const transcriptTimeline = useMemo(
    () => transcript.map((line) => ({ line, seconds: parseTimestamp(line.time) })).filter((entry) => entry.seconds !== null),
    [transcript]
  );

  const handlePlayerTimeChange = useCallback((seconds: number) => {
    const currentLine = findCurrentTranscriptLine(transcriptTimeline, seconds);
    if (currentLine) setActiveTranscriptTime((current) => current === currentLine.time ? current : currentLine.time);
  }, [transcriptTimeline]);

  useEffect(() => {
    if (!autoScroll || !activeTranscriptTime) return;
    document.getElementById(transcriptElementId(activeTranscriptTime))?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeTranscriptTime, autoScroll]);

  function selectNode(nodeId: string, time: string | null) {
    setActiveNode(nodeId);
    seekToMoment(time, transcript.find((line) => line.id === nodeId)?.time);
  }

  function selectTranscriptLine(time: string, nodeId?: string) {
    if (nodeId) setActiveNode(nodeId);
    setActiveTranscriptTime(time);
    seekToMoment(time);
  }

  function seekToMoment(primaryTime: string | null, fallbackTime?: string) {
    const time = primaryTime ?? fallbackTime ?? null;
    const seconds = parseTimestamp(time);
    if (seconds === null) return;
    playerRef.current?.seekTo(seconds);
    setActiveTranscriptTime(findCurrentTranscriptLine(transcriptTimeline, seconds)?.time ?? time);
  }

  function saveCorpusItem(item: CorpusItem) {
    return corpus.save({
      key: corpusKey(item), item,
      contentId: blueprint?.contentId ?? source?.contentId,
      sourceUrl: blueprint?.sourceUrl ?? source?.sourceUrl ?? "",
      sourceTitle: blueprint?.title ?? sourceTitle
    });
  }

  async function handleTranscriptSelection(event: MouseEvent<HTMLElement>) {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();
    if (!selection || !selectedText || selectedText.length < 2 || /^[\W_]+$/.test(selectedText)) return;

    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const target = event.currentTarget;
    if (!range || !target.contains(range.commonAncestorContainer)) return;

    const lineElement = nearestTranscriptLine(range.commonAncestorContainer) ?? nearestTranscriptLine(selection.anchorNode);
    if (!lineElement) return;

    const lineIndex = Number(lineElement.dataset.index ?? "0");
    const currentLine = transcript[lineIndex];
    if (!currentLine) return;

    const context: AnalyzeSelectionContext = {
      selectedText,
      currentSentence: transcriptLineText(currentLine),
      contextBefore: transcript[lineIndex - 1] ? transcriptLineText(transcript[lineIndex - 1]) : undefined,
      contextAfter: transcript[lineIndex + 1] ? transcriptLineText(transcript[lineIndex + 1]) : undefined,
      timestamp: currentLine.time
    };
    const rect = range.getBoundingClientRect();
    const cardWidth = Math.min(520, window.innerWidth - 28);
    const cardHeight = Math.min(620, window.innerHeight - 28);
    const position = {
      x: Math.min(Math.max(rect.left + rect.width / 2, cardWidth / 2 + 14), window.innerWidth - cardWidth / 2 - 14),
      y: Math.max(window.scrollY + 14, Math.min(rect.bottom + window.scrollY + 12, window.scrollY + window.innerHeight - cardHeight - 14))
    };

    const loadingAnalysis = buildLoadingSelectionAnalysis(context);
    const selectionId = crypto.randomUUID();
    setSelectionCard({
      id: selectionId,
      pinned: false,
      analysis: loadingAnalysis,
      fieldDraft: loadingAnalysis.fields,
      note: "",
      tab: "explain",
      status: "loading",
      position,
      context
    });

    const analysis = await analyzeCorpusSelection({
      contentId: blueprint?.contentId,
      ...context
    });
    setSelectionCard((current) => current?.id === selectionId
      ? {
        ...current,
        analysis,
        fieldDraft: analysis.fields,
        status: "ready"
      }
      : current
    );
  }

  function updateSelectionField<K extends keyof CorpusSelectionAnalysis["fields"]>(field: K, value: CorpusSelectionAnalysis["fields"][K]) {
    setSelectionCard((current) => current
      ? { ...current, fieldDraft: { ...current.fieldDraft, [field]: value } }
      : current
    );
  }

  async function saveSelectionItem(kindOverride?: CorpusKind, textOverride?: string, slots?: Record<string, string>) {
    if (!selectionCard || !corpus.ready || corpus.busy) return;
    const kind = kindOverride ?? selectionCard.fieldDraft.kind;
    const text = textOverride ?? selectionCard.analysis.recommendedText;
    const id = `manual-${Date.now()}-${Math.round(Math.random() * 1000)}`;
    const item: CorpusItem = {
      id,
      kind,
      text,
      tags: selectionCard.fieldDraft.tags,
      meta: `${selectionCard.context.timestamp ?? "--:--"} - ${selectionCard.fieldDraft.level}`,
      saved: true,
      meaning: selectionCard.analysis.explanation.meaning,
      usageNote: selectionCard.note || selectionCard.analysis.recommendationReason,
      sourceText: selectionCard.context.selectedText,
      level: selectionCard.fieldDraft.level,
      register: selectionCard.fieldDraft.register,
      scenarioTags: selectionCard.analysis.explanation.usageChips,
      patternFamily: slots ? Object.keys(slots).join(", ") : undefined,
      slots
    };
    if (!await saveCorpusItem(item)) return;
    setSelectionCard((current) => current?.id === selectionCard.id ? null : current);
    setActiveTab("saved");
  }

  function retryLoad() {
    if (!source) return;
    loadControllerRef.current?.abort();
    setStatus("loading");
    setLoadAttempt((attempt) => attempt + 1);
  }

  const isReady = status === "ready" && blueprint !== null;
  const displaySourceUrl = blueprint?.sourceUrl ?? source?.sourceUrl;
  const displayTitle = blueprint?.title ?? sourceTitle;
  const displaySummary = blueprint?.summary ?? analysisPreview?.summary;

  return (
    <main className="stage-page">
      <section className="reader-shell" aria-label="Libitu stage 1 ingest reader">
        <header className="topbar">
          <Link className="logo" href="/" aria-label="Libitu home">
            libitu
          </Link>
          <div className="topbar-title">{blueprint?.title ?? sourceTitle}</div>
          <div className="stage-pills" aria-label="Learning stages">
            <span className="stage-pill active">Stage 1 - Ingest</span>
            <button className="stage-pill" type="button">Stage 2 - Shadow</button>
            <button className="stage-pill" type="button">Stage 3 - Mission</button>
          </div>
          <AuthControls />
        </header>

        <aside className="left-panel" aria-label="Logic flow" aria-busy={!isReady}>
          <section className="logic-flow">
            <div className="section-label">Logic flow</div>
            {logicNodes.map((node, index) => (
              <div className="logic-step" key={node.id}>
                <button
                  className={`logic-node ${activeNode === node.id ? "active" : ""}`}
                  type="button"
                  onClick={() => selectNode(node.id, node.time)}
                >
                  <span className="logic-dot" aria-hidden="true" />
                  <span className="logic-copy">
                    <span className="logic-title">{node.title}</span>
                    <span className="logic-subtitle">{node.subtitle}</span>
                  </span>
                  <span className="logic-time">{node.time}</span>
                </button>
                {index < logicNodes.length - 1 ? <span className="logic-connector" aria-hidden="true" /> : null}
              </div>
            ))}
          </section>

        </aside>

        <section className="center-panel" aria-label="Video and transcript">
          <div className="video-frame">
            {displaySourceUrl ? (
              <YouTubePlayer
                ref={playerRef}
                sourceUrl={displaySourceUrl}
                title={displayTitle}
                onTimeChange={handlePlayerTimeChange}
              />
            ) : source ? (
              <p className="empty-state">The source video URL is unavailable.</p>
            ) : null}
          </div>
          <div className="video-summary" aria-live="polite">
            <h1>{displayTitle}</h1>
            <p className={displaySummary ? undefined : "summary-pending"}>
              {displaySummary ?? "Preparing the video summary..."}
            </p>
          </div>

          {!isReady ? (
            <StageOneStatusPanel
              status={status === "ready" ? "loading" : status}
              message={errorMessage}
              onRetry={retryLoad}
              preview={analysisPreview}
            />
          ) : null}

          {transcript.length > 0 ? (
            <>
              <div className="video-controls">
                <button
                  className={`toggle-control ${autoScroll ? "on" : ""}`}
                  type="button"
                  aria-pressed={autoScroll}
                  onClick={() => setAutoScroll((value) => !value)}
                >
                  <span className="toggle-track"><span /></span>
                  Auto-scroll
                </button>
                <button
                  className={`toggle-control ${highlightActive ? "on" : ""}`}
                  type="button"
                  aria-pressed={highlightActive}
                  onClick={() => setHighlightActive((value) => !value)}
                >
                  <span className="toggle-track"><span /></span>
                  Highlight active
                </button>
                <button className="control-button" type="button" disabled={!isReady}>
                  <LibraryIcon />
                  Add to corpus
                </button>
              </div>

              <article className="transcript-area" aria-label="Annotated transcript" aria-busy={!isReady} onMouseUp={handleTranscriptSelection}>
                {transcript.map((line, lineIndex) => (
                  <div
                    className={`transcript-line ${highlightActive && line.time === activeTranscriptTime ? "active-line" : ""}`}
                    data-index={lineIndex}
                    id={transcriptElementId(line.time)}
                    key={`${line.time}-${lineIndex}`}
                    onClick={() => selectTranscriptLine(line.time, line.id)}
                  >
                    <button className="transcript-time" type="button" aria-label={`Play from ${line.time}`}>{line.time}</button>
                    <span className="transcript-text">
                      {line.parts.map((part, index) =>
                        typeof part === "string" ? (
                          part
                        ) : (
                          <button
                            className={`highlight ${part.kind}`}
                            data-tag={part.tag}
                            key={`${part.text}-${index}`}
                            type="button"
                            aria-label={`${part.kind}: ${part.text}. ${part.tag}`}
                          >
                            {part.text}
                          </button>
                        )
                      )}
                    </span>
                  </div>
                ))}
              </article>
              {selectionCard ? (
                <SelectionAnalysisCard
                  key={selectionCard.id}
                  state={selectionCard}
                  saveDisabled={!corpus.ready || corpus.busy}
                  onClose={closeSelectionCard}
                  onTogglePin={() => setSelectionCard((current) => current ? { ...current, pinned: !current.pinned } : current)}
                  onFieldChange={updateSelectionField}
                  onNoteChange={(note) => setSelectionCard((current) => current ? { ...current, note } : current)}
                  onSave={saveSelectionItem}
                  onTabChange={(tab) => setSelectionCard((current) => current ? { ...current, tab } : current)}
                />
              ) : null}
            </>
          ) : null}
        </section>

        <aside className="right-panel" aria-label="Extracted corpus" aria-busy={!isReady}>
          <div className="corpus-tabs" role="tablist" aria-label="Corpus filters">
            <button
              className={`corpus-tab ${activeTab === "chunks" ? "active" : ""}`}
              type="button"
              onClick={() => setActiveTab("chunks")}
            >
              Chunks
            </button>
            <button
              className={`corpus-tab ${activeTab === "idioms" ? "active" : ""}`}
              type="button"
              onClick={() => setActiveTab("idioms")}
            >
              Idioms
            </button>
            <button
              className={`corpus-tab ${activeTab === "structures" ? "active" : ""}`}
              type="button"
              onClick={() => setActiveTab("structures")}
            >
              Structures
            </button>
            <button
              className={`corpus-tab ${activeTab === "saved" ? "active" : ""}`}
              type="button"
              onClick={() => setActiveTab("saved")}
            >
              Saved
            </button>
          </div>

          <section className="corpus-section">
            <div className="section-label">{activeTab === "saved" ? "Saved to corpus" : "Extracted this video"}</div>
            {corpus.error ? (
              <div className="corpus-sync-status" role="alert">
                <p>{corpus.error}</p>
                <button type="button" className="inline-command" onClick={corpus.retry} disabled={corpus.busy}>Retry sync</button>
              </div>
            ) : corpus.busy ? <p className="corpus-sync-status" role="status">Loading saved corpus...</p> : null}
            <div className="corpus-list">
              {visibleCorpus.length === 0 && activeTab === "saved" && corpus.ready ? (
                <p className="empty-state">No saved expressions for this video.</p>
              ) : visibleCorpus.length === 0 && !isReady ? (
                <p className="empty-state">
                  {status === "loading" ? "Expressions will appear here as they are validated." : "No corpus was produced."}
                </p>
              ) : null}
              {visibleCorpus.map(({ key, item, record }) => {
                const saved = Boolean(record);
                const saveLabel = saved ? "Remove from corpus" : "Save to corpus";
                return (
                  <article className={`corpus-card ${saved ? "saved" : ""}`} key={key}>
                    <button
                      className={`save-button ${saved ? "saved" : ""}`}
                      type="button"
                      disabled={(!isReady && !saved) || !corpus.ready || corpus.busy}
                      aria-label={saveLabel}
                      title={saveLabel}
                      aria-pressed={saved}
                      onClick={() => record ? void corpus.remove(record) : void saveCorpusItem(item)}
                    >
                      {saved ? activeTab === "saved" ? <Trash2 /> : <Check /> : <Plus />}
                    </button>
                    <p className={item.kind === "structure" ? "structure-text" : "corpus-text"}>{item.text}</p>
                    {item.usageNote ? <p className="corpus-note">{item.usageNote}</p> : null}
                    <div className="corpus-tags">
                      {item.tags.map((tag) => (
                        <span className={`tag ${tagClass[tag]}`} key={tag}>
                          {tag}
                        </span>
                      ))}
                    </div>
                    <div className="corpus-meta">{item.meta.replace(/\s*-\s*(click \+ to save|saved locally|saved to corpus|analyzing)$/, "")}{saved ? ` - ${corpus.signedIn ? record?.serverId ? "Saved to account" : "Pending sync" : "Saved on this device"}` : ""}</div>
                  </article>
                );
              })}
            </div>
          </section>

          <div className="mission-box">
            <div>
              <span>Ready for Stage 3</span>
              <strong>{savedRecords.length} items selected</strong>
            </div>
            <button className="mission-button" type="button">Open loadout</button>
          </div>
        </aside>
      </section>
    </main>
  );
}

function readStageOneSource(): StageOneSource {
  const params = new URLSearchParams(window.location.search);
  const sourceUrl = params.get("sourceUrl") ?? defaultStageOneSource.sourceUrl;
  const title = params.get("title") ?? defaultStageOneSource.title;
  const transcriptText = params.get("transcriptText") ?? undefined;
  const language = params.get("language") ?? undefined;
  const contentId = params.get("contentId") ?? undefined;
  const jobId = params.get("jobId") ?? undefined;
  const learnerLevel = parseLearnerLevel(params.get("learnerLevel") ?? params.get("level"));

  return {
    kind: "youtube",
    sourceUrl,
    title,
    contentId,
    jobId,
    transcriptText,
    language,
    learnerLevel: learnerLevel ?? defaultStageOneSource.learnerLevel
  };
}

function parseLearnerLevel(value: string | null): LearnerLevel | undefined {
  const normalized = value?.toUpperCase();
  return normalized && ["A1", "A2", "B1", "B2", "C1", "C2"].includes(normalized)
    ? normalized as LearnerLevel
    : undefined;
}

function parseTimestamp(timestamp: string | null): number | null {
  if (!timestamp) return null;
  const parts = timestamp.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function transcriptElementId(time: string) {
  return `transcript-${time.replaceAll(":", "-")}`;
}

function findCurrentTranscriptLine(
  timeline: Array<{ line: StageOneBlueprint["transcript"][number]; seconds: number | null }>,
  currentTime: number
) {
  let current: StageOneBlueprint["transcript"][number] | null = null;
  for (const entry of timeline) {
    if (entry.seconds === null || entry.seconds > currentTime) break;
    current = entry.line;
  }
  return current;
}


function nearestTranscriptLine(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>(".transcript-line") ?? null;
}

function transcriptLineText(line: StageOneBlueprint["transcript"][number]) {
  return line.parts.map((part) => typeof part === "string" ? part : part.text).join("").replace(/\s+/g, " ").trim();
}

function buildLoadingSelectionAnalysis(context: AnalyzeSelectionContext): CorpusSelectionAnalysis {
  return {
    analysisSource: "ai",
    selectionType: /[.!?]$/.test(context.selectedText) ? "sentence" : "phrase",
    completeness: "complete",
    selectedText: context.selectedText,
    recommendedText: context.selectedText,
    recommendationReason: "Checking whether this is the best corpus unit from context.",
    fields: {
      kind: "chunk",
      tags: ["discourse"],
      level: "B1",
      register: "neutral"
    },
    notePlaceholder: "Add your own cue, translation, or memory hook.",
    explanation: {
      pronunciation: {
        ipa: "/.../",
        connectedSpeech: "Analyzing connected speech from context.",
        audioText: context.selectedText
      },
      meaning: "Analyzing meaning in context.",
      pragmaticFunction: "Analyzing what this expression does in the conversation.",
      similarExpressions: [],
      examples: [],
      usageChips: ["context"]
    },
    syntaxAnalysis: {
      sentenceType: "Analyzing selection type and grammatical role.",
      mainClause: "Finding the main clause and the selection's role in it.",
      structureBreakdown: [],
      logicRelations: [],
      informationHierarchy: [],
      styleFeatures: [],
      usageScenarios: [],
      grammarPoints: [],
      wordingNotes: [],
      reusablePatterns: [],
      translations: [],
      translationNotes: [],
      evidence: [context.contextBefore, context.currentSentence, context.contextAfter].filter((value): value is string => Boolean(value))
    }
  };
}

type SelectionAnalysisCardProps = {
  state: SelectionCardState;
  saveDisabled: boolean;
  onClose: () => void;
  onTogglePin: () => void;
  onFieldChange: <K extends keyof CorpusSelectionAnalysis["fields"]>(field: K, value: CorpusSelectionAnalysis["fields"][K]) => void;
  onNoteChange: (note: string) => void;
  onSave: (kindOverride?: CorpusKind, textOverride?: string, slots?: Record<string, string>) => void;
  onTabChange: (tab: "explain" | "syntax") => void;
};

function SelectionAnalysisCard({ state, saveDisabled, onClose, onTogglePin, onFieldChange, onNoteChange, onSave, onTabChange }: SelectionAnalysisCardProps) {
  const { analysis, fieldDraft } = state;
  const isLoading = state.status === "loading";
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (state.pinned) return;
    function handleOutsidePointer(event: PointerEvent) {
      if (event.target instanceof Node && !cardRef.current?.contains(event.target)) onClose();
    }
    // Pointer events inside the embedded video do not bubble to this document.
    function handleFrameFocus() {
      if (document.activeElement instanceof HTMLIFrameElement) onClose();
    }
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    window.addEventListener("blur", handleFrameFocus);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
      window.removeEventListener("blur", handleFrameFocus);
    };
  }, [state.pinned, onClose]);

  return (
    <section
      ref={cardRef}
      className="selection-card"
      style={{ left: state.position.x, top: state.position.y }}
      aria-label="Corpus selection analysis"
    >
      <div className="selection-card-header">
        <div>
          <div className="section-label">Add to corpus</div>
          <p className="selection-original">{analysis.selectedText}</p>
        </div>
        <button
          className="selection-pin"
          type="button"
          aria-label={state.pinned ? "Unpin selection card" : "Pin selection card"}
          aria-pressed={state.pinned}
          title={state.pinned ? "Unpin selection card" : "Pin selection card"}
          onClick={onTogglePin}
        >
          {state.pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
        </button>
      </div>

      {analysis.completeness === "needs_expansion" ? (
        <div className="selection-recommendation expanded">
          <span>Suggested completion</span>
          <strong>{analysis.recommendedText}</strong>
          <p>{analysis.recommendationReason}</p>
        </div>
      ) : null}

      {analysis.providerNotice ? (
        <p className="selection-provider-notice" role="status">{analysis.providerNotice}</p>
      ) : null}

      <div className="field-chip-row" aria-label="Editable AI fields">
        <CycleChip label="kind" value={fieldDraft.kind} values={editableKinds} onChange={(value) => onFieldChange("kind", value)} />
        <CycleChip label="tag" value={fieldDraft.tags[0] ?? "discourse"} values={editableTags} onChange={(value) => onFieldChange("tags", [value])} />
        <CycleChip label="level" value={fieldDraft.level} values={editableLevels} onChange={(value) => onFieldChange("level", value)} />
        <CycleChip label="register" value={fieldDraft.register} values={editableRegisters} onChange={(value) => onFieldChange("register", value)} />
      </div>

      <textarea
        className="selection-note"
        value={state.note}
        placeholder={analysis.notePlaceholder}
        onChange={(event) => onNoteChange(event.target.value)}
      />

      <div className="selection-actions">
        <div className="selection-tabs" role="tablist" aria-label="Selection analysis views">
          <button className={state.tab === "explain" ? "active" : ""} type="button" onClick={() => onTabChange("explain")}>Explain</button>
          <button className={state.tab === "syntax" ? "active" : ""} type="button" onClick={() => onTabChange("syntax")}>Syntax</button>
        </div>
        <button className="selection-save" type="button" disabled={isLoading || saveDisabled} onClick={() => onSave()}>
          Save
        </button>
      </div>

      <div className="selection-panel" aria-busy={isLoading}>
        {state.tab === "explain" ? (
          <ExplainPanel analysis={analysis} isLoading={isLoading} />
        ) : (
          <SyntaxPanel analysis={analysis} isLoading={isLoading} saveDisabled={saveDisabled} onSavePattern={onSave} />
        )}
      </div>
    </section>
  );
}

type CycleChipProps<T extends string> = {
  label: string;
  value: T;
  values: readonly T[];
  onChange: (value: T) => void;
};

function CycleChip<T extends string>({ label, value, values, onChange }: CycleChipProps<T>) {
  function cycle() {
    const currentIndex = values.indexOf(value);
    onChange(values[(currentIndex + 1) % values.length]);
  }

  return (
    <button className="field-chip" type="button" onClick={cycle}>
      <span>{label}</span>
      {value}
    </button>
  );
}

function ExplainPanel({ analysis, isLoading }: { analysis: CorpusSelectionAnalysis; isLoading: boolean }) {
  return (
    <div className="analysis-stack">
      <section>
        <h2>Pronunciation</h2>
        <p><strong>{analysis.explanation.pronunciation.ipa}</strong></p>
        <p>{analysis.explanation.pronunciation.connectedSpeech}</p>
        <button className="inline-command" type="button" disabled={isLoading} onClick={() => speakText(analysis.explanation.pronunciation.audioText)}>
          Play
        </button>
      </section>
      <section>
        <h2>Meaning and function</h2>
        <p>{analysis.explanation.meaning}</p>
        <p>{analysis.explanation.pragmaticFunction}</p>
      </section>
      <section>
        <h2>Similar expressions</h2>
        <div className="mini-chip-row">
          {analysis.explanation.similarExpressions.map((expression) => <span key={expression}>{expression}</span>)}
          {analysis.explanation.similarExpressions.length === 0 ? <span>{isLoading ? "Analyzing..." : "No alternatives available"}</span> : null}
        </div>
      </section>
      <section>
        <h2>Examples</h2>
        {analysis.explanation.examples.map((example) => (
          <p className="example-line" key={example.english}>
            {example.typical ? <span>Typical</span> : null}
            {example.english}<br />
            <small>{example.chinese}</small>
          </p>
        ))}
      </section>
      <div className="mini-chip-row">
        {analysis.explanation.usageChips.map((chip) => <span key={chip}>{chip}</span>)}
      </div>
    </div>
  );
}

function SyntaxPanel({
  analysis,
  isLoading,
  onSavePattern,
  saveDisabled
}: {
  analysis: CorpusSelectionAnalysis;
  isLoading: boolean;
  onSavePattern: (kindOverride?: CorpusKind, textOverride?: string, slots?: Record<string, string>) => void;
  saveDisabled: boolean;
}) {
  return (
    <div className="analysis-stack">
      <section>
        <h2>Sentence structure</h2>
        <p><strong>{analysis.syntaxAnalysis.sentenceType}</strong></p>
        <p>{analysis.syntaxAnalysis.mainClause}</p>
        <AnalysisItems items={analysis.syntaxAnalysis.structureBreakdown} emptyLabel={isLoading ? "Analyzing..." : "No additional breakdown."} />
      </section>
      <AnalysisList title="Logic relations" items={analysis.syntaxAnalysis.logicRelations} isLoading={isLoading} />
      <AnalysisList title="Information hierarchy" items={analysis.syntaxAnalysis.informationHierarchy} isLoading={isLoading} />
      <AnalysisList title="Style" items={analysis.syntaxAnalysis.styleFeatures} isLoading={isLoading} />
      <AnalysisList title="Usage scenarios" items={analysis.syntaxAnalysis.usageScenarios} isLoading={isLoading} />
      <AnalysisList title="Grammar focus" items={analysis.syntaxAnalysis.grammarPoints} isLoading={isLoading} />
      <AnalysisList title="Wording" items={analysis.syntaxAnalysis.wordingNotes} isLoading={isLoading} />
      <section>
        <h2>Reusable structures</h2>
        {analysis.syntaxAnalysis.reusablePatterns.map((pattern) => (
          <article className="pattern-row" key={pattern.template}>
            <code>{pattern.template}</code>
            <p>{pattern.rationale}</p>
            <button className="inline-command" type="button" disabled={isLoading || saveDisabled} onClick={() => onSavePattern("structure", pattern.template, pattern.slots)}>
              Save structure
            </button>
          </article>
        ))}
        {analysis.syntaxAnalysis.reusablePatterns.length === 0 ? <p>Preparing reusable patterns.</p> : null}
      </section>
      <section>
        <h2>Translations</h2>
        {analysis.syntaxAnalysis.translations.map((translation) => (
          <div className="translation-version" key={`${translation.label}-${translation.text}`}>
            <strong>{translation.label}{translation.recommended ? " · Recommended" : ""}</strong>
            <p>{translation.text}</p>
          </div>
        ))}
        {analysis.syntaxAnalysis.translations.length === 0 ? <p>Preparing translations.</p> : null}
      </section>
      <AnalysisList title="Translation notes" items={analysis.syntaxAnalysis.translationNotes} isLoading={isLoading} />
      {analysis.syntaxAnalysis.backgroundContext ? (
        <section>
          <h2>Background</h2>
          <p>{analysis.syntaxAnalysis.backgroundContext}</p>
        </section>
      ) : null}
      <AnalysisList title="Evidence" items={analysis.syntaxAnalysis.evidence} isLoading={isLoading} />
    </div>
  );
}

function AnalysisList({ title, items, isLoading }: { title: string; items: string[]; isLoading: boolean }) {
  return (
    <section>
      <h2>{title}</h2>
      <AnalysisItems items={items} emptyLabel={isLoading ? "Analyzing..." : "No additional analysis."} />
    </section>
  );
}

function AnalysisItems({ items, emptyLabel }: { items: string[]; emptyLabel: string }) {
  if (items.length === 0) return <p>{emptyLabel}</p>;
  return (
    <ol className="analysis-list">
      {items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
    </ol>
  );
}

function speakText(text: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

type StageOneStatusPanelProps = {
  status: "loading" | "failed" | "unsupported";
  message: string | null;
  onRetry: () => void;
  preview: StageOneAnalysisPreview | null;
};

function StageOneStatusPanel({ status, message, onRetry, preview }: StageOneStatusPanelProps) {
  const isLoading = status === "loading";
  const title = isLoading
    ? "Loading the blueprint"
    : status === "unsupported"
      ? "This source is not supported yet"
      : "Blueprint generation failed";

  return (
    <div className="stage-status" role={isLoading ? "status" : "alert"}>
      <div className="status-heading">
        <span className={`status-indicator ${isLoading ? "loading" : "failed"}`} aria-hidden="true">
          {isLoading ? null : "!"}
        </span>
        <div>
          <h2>{title}</h2>
          <p>
            {message ??
              (isLoading
                ? "Resolving content, starting analysis, and fetching the Stage 1 blueprint."
                : "The API could not return a usable blueprint.")}
          </p>
        </div>
      </div>
      {isLoading && preview ? (
        <div className="stream-metrics" aria-label="Streaming analysis progress">
          <span><strong>{preview.logicNodes.length}</strong> logic steps</span>
          <span><strong>{preview.corpusItems.length}</strong> expressions</span>
          <span><strong>{preview.transcriptLines.length}</strong> subtitles</span>
        </div>
      ) : null}
      {!isLoading ? (
        <button className="mission-button" type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
