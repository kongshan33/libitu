"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { Check, Pin, PinOff, Plus, Trash2, Volume2, X } from "lucide-react";
import type {
  CorpusFilter,
  CorpusItem,
  CorpusItemAnalysisDetail,
  CorpusKind,
  CorpusSelectionAnalysis,
  CorpusSelectionContext,
  FunctionalTag,
  StageOneBlueprint
} from "@libitu/types/stage-one";
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
import { savedCorpusKey, type SavedCorpusRecord } from "../api/corpus-storage";
import { findCurrentTimedItem, parseTimestamp } from "../timeline";

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
const TRANSCRIPT_AUTO_ALIGN_PAUSE_MS = 6000;
const PROGRAMMATIC_SCROLL_SETTLE_MS = 450;

type SelectionCardState = {
  id: string;
  pinned: boolean;
  analysis: CorpusSelectionAnalysis;
  fieldDraft: CorpusSelectionAnalysis["fields"];
  note: string;
  tab: "explain" | "syntax";
  status: "loading" | "ready";
  position: { x: number; y: number };
  context: CorpusSelectionContext;
};

type CorpusDetailState = {
  id: string;
  key: string;
  item: CorpusItem;
  record?: SavedCorpusRecord;
  context: CorpusSelectionContext;
  detail?: CorpusItemAnalysisDetail;
  status: "loading" | "ready" | "error";
  tab: "explain" | "syntax";
  error?: string;
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
  const [corpusDetail, setCorpusDetail] = useState<CorpusDetailState | null>(null);
  const closeSelectionCard = useCallback(() => setSelectionCard(null), []);
  const [autoScroll, setAutoScroll] = useState(true);
  const [autoScrollPausedUntil, setAutoScrollPausedUntil] = useState<number | null>(null);
  const [isPlayerPlaying, setIsPlayerPlaying] = useState(false);
  const [highlightActive, setHighlightActive] = useState(true);
  const [sourceTitle, setSourceTitle] = useState("Loading Stage 1 content");
  const [source, setSource] = useState<StageOneSource | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const resolvedSourceRef = useRef<StageOneSource | null>(null);
  const playerRef = useRef<YouTubePlayerHandle>(null);
  const programmaticScrollTimeoutRef = useRef<number | null>(null);
  const resumeAutoScrollTimeoutRef = useRef<number | null>(null);
  const detailCacheRef = useRef(new Map<string, CorpusItemAnalysisDetail>());

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

    const activeSource = resolvedSourceRef.current ?? source;
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

      try {
        const nextBlueprint = await loadStageOneBlueprint(activeSource, (message) => {
          if (!controller.signal.aborted) setErrorMessage(message);
        }, {
          signal: controller.signal,
          resumeFailedJob: loadAttempt > 0,
          onResolved: (ids) => {
            if (controller.signal.aborted) return;
            resolvedSourceRef.current = { ...activeSource, ...ids, handoffId: undefined };
            const url = new URL(window.location.href);
            if (url.searchParams.get("contentId") === ids.contentId && url.searchParams.get("jobId") === ids.jobId
              && !url.searchParams.has("handoffId") && !url.searchParams.has("transcriptText")) return;
            url.searchParams.set("contentId", ids.contentId);
            url.searchParams.set("jobId", ids.jobId);
            url.searchParams.delete("handoffId");
            url.searchParams.delete("transcriptText");
            window.history.replaceState(window.history.state, "", url);
          },
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
    () => transcript.map((line) => ({ item: line, seconds: parseTimestamp(line.time) })),
    [transcript]
  );
  const logicTimeline = useMemo(
    () => logicNodes.map((node) => ({ item: node, seconds: parseTimestamp(node.time) })),
    [logicNodes]
  );

  const syncActiveMoment = useCallback((seconds: number) => {
    const currentLine = findCurrentTimedItem(transcriptTimeline, seconds);
    if (currentLine) setActiveTranscriptTime((current) => current === currentLine.time ? current : currentLine.time);
    const currentNode = findCurrentTimedItem(logicTimeline, seconds, true);
    if (currentNode) setActiveNode((current) => current === currentNode.id ? current : currentNode.id);
  }, [logicTimeline, transcriptTimeline]);

  const handlePlayerTimeChange = useCallback((seconds: number) => {
    syncActiveMoment(seconds);
  }, [syncActiveMoment]);

  const autoScrollPaused = autoScrollPausedUntil !== null && Date.now() < autoScrollPausedUntil;
  const manualAutoAlignPaused = isPlayerPlaying && autoScrollPaused;
  const shouldAutoAlignTranscript = autoScroll && !autoScrollPaused && isPlayerPlaying;

  const markProgrammaticScroll = useCallback(() => {
    if (programmaticScrollTimeoutRef.current !== null) window.clearTimeout(programmaticScrollTimeoutRef.current);
    programmaticScrollTimeoutRef.current = window.setTimeout(() => {
      programmaticScrollTimeoutRef.current = null;
    }, PROGRAMMATIC_SCROLL_SETTLE_MS);
  }, []);

  const pauseAutoAlignForManualScroll = useCallback(() => {
    if (!autoScroll) return;
    const pausedUntil = Date.now() + TRANSCRIPT_AUTO_ALIGN_PAUSE_MS;
    setAutoScrollPausedUntil(pausedUntil);
    if (resumeAutoScrollTimeoutRef.current !== null) window.clearTimeout(resumeAutoScrollTimeoutRef.current);
    resumeAutoScrollTimeoutRef.current = window.setTimeout(() => {
      setAutoScrollPausedUntil((current) => current === pausedUntil ? null : current);
      resumeAutoScrollTimeoutRef.current = null;
    }, TRANSCRIPT_AUTO_ALIGN_PAUSE_MS);
  }, [autoScroll]);

  const resumeAutoAlignNow = useCallback(() => {
    if (resumeAutoScrollTimeoutRef.current !== null) {
      window.clearTimeout(resumeAutoScrollTimeoutRef.current);
      resumeAutoScrollTimeoutRef.current = null;
    }
    setAutoScrollPausedUntil(null);
  }, []);

  useEffect(() => {
    return () => {
      if (programmaticScrollTimeoutRef.current !== null) window.clearTimeout(programmaticScrollTimeoutRef.current);
      if (resumeAutoScrollTimeoutRef.current !== null) window.clearTimeout(resumeAutoScrollTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!shouldAutoAlignTranscript || !activeTranscriptTime) return;
    const activeLine = document.getElementById(transcriptElementId(activeTranscriptTime));
    if (!activeLine) return;
    markProgrammaticScroll();
    activeLine.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeTranscriptTime, markProgrammaticScroll, shouldAutoAlignTranscript]);

  function handleTranscriptViewportScroll() {
    if (programmaticScrollTimeoutRef.current !== null) return;
    pauseAutoAlignForManualScroll();
  }

  function toggleAutoScroll() {
    resumeAutoAlignNow();
    setAutoScroll((value) => !value);
  }

  function selectNode(nodeId: string, time: string | null) {
    resumeAutoAlignNow();
    seekToMoment(time, transcript.find((line) => line.id === nodeId)?.time);
    setActiveNode(nodeId);
  }

  function selectTranscriptLine(time: string) {
    resumeAutoAlignNow();
    seekToMoment(time);
  }

  function seekToMoment(primaryTime: string | null, fallbackTime?: string) {
    const time = primaryTime ?? fallbackTime ?? null;
    const seconds = parseTimestamp(time);
    if (seconds === null) return;
    playerRef.current?.seekTo(seconds);
    syncActiveMoment(seconds);
  }

  function saveCorpusItem(item: CorpusItem) {
    const key = corpusKey(item);
    const analysisDetail = item.analysisDetail ?? detailCacheRef.current.get(key);
    return corpus.save({
      key,
      item: analysisDetail ? { ...item, analysisDetail } : item,
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

    const context: CorpusSelectionContext = {
      contentId: blueprint?.contentId ?? source?.contentId,
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

    const analysis = await analyzeCorpusSelection(context);
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
    const savedAnalysis = {
      ...selectionCard.analysis,
      fields: { ...selectionCard.fieldDraft, kind }
    };
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
      slots,
      analysisDetail: {
        context: selectionCard.context,
        analysis: savedAnalysis
      }
    };
    if (!await saveCorpusItem(item)) return;
    setSelectionCard((current) => current?.id === selectionCard.id ? null : current);
    setActiveTab("saved");
  }

  async function openCorpusDetail(key: string, item: CorpusItem, record?: SavedCorpusRecord) {
    const context = buildCorpusSelectionContext(
      item,
      transcript,
      blueprint?.contentId ?? source?.contentId
    );
    const cached = item.analysisDetail ?? detailCacheRef.current.get(key);
    const detailId = crypto.randomUUID();
    setCorpusDetail({
      id: detailId,
      key,
      item,
      record,
      context: cached?.context ?? context,
      detail: cached,
      status: cached ? "ready" : "loading",
      tab: "explain"
    });
    if (cached) return;

    const analyze = () => analyzeCorpusSelection(context);
    let enrichedItem: CorpusItem;
    let enrichedRecord = record;
    if (record) {
      const saved = await corpus.hydrate(record, context, analyze);
      if (!saved?.item.analysisDetail) {
        setCorpusDetail((current) => current?.id === detailId
          ? { ...current, status: "error", error: "The full analysis could not be loaded. Please retry." }
          : current
        );
        return;
      }
      enrichedRecord = saved;
      enrichedItem = saved.item;
    } else {
      enrichedItem = { ...item, analysisDetail: { context, analysis: await analyze() } };
    }
    const detail = enrichedItem.analysisDetail;
    if (!detail) {
      setCorpusDetail((current) => current?.id === detailId
        ? { ...current, status: "error", error: "The full analysis could not be loaded. Please retry." }
        : current
      );
      return;
    }
    detailCacheRef.current.set(key, detail);
    setCorpusDetail((current) => current?.id === detailId
      ? { ...current, item: enrichedItem, record: enrichedRecord, detail, context: detail.context, status: "ready" }
      : current
    );
  }

  function retryCorpusDetail() {
    if (!corpusDetail) return;
    detailCacheRef.current.delete(corpusDetail.key);
    void openCorpusDetail(corpusDetail.key, corpusDetail.item, corpusDetail.record);
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
            {logicNodes.map((node) => (
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
                {/* {index < logicNodes.length - 1 ? <span className="logic-connector" aria-hidden="true" /> : null} */}
              </div>
            ))}
          </section>

        </aside>

        <section
          className="center-panel"
          aria-label="Video and transcript"
          onScroll={handleTranscriptViewportScroll}
        >
          <div className="video-frame">
            {displaySourceUrl ? (
              <YouTubePlayer
                ref={playerRef}
                sourceUrl={displaySourceUrl}
                title={displayTitle}
                onPlaybackChange={setIsPlayerPlaying}
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
                  aria-label={manualAutoAlignPaused ? "Auto-scroll paused after manual scroll" : "Auto-scroll"}
                  title={!isPlayerPlaying
                    ? "Auto-scroll will apply when the video plays"
                    : manualAutoAlignPaused
                      ? "Auto-scroll paused after manual scroll"
                      : "Auto-scroll"}
                  onClick={toggleAutoScroll}
                >
                  <span className="toggle-track"><span /></span>
                  {manualAutoAlignPaused ? "Auto-scroll paused" : "Auto-scroll"}
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

              <article
                className="transcript-area"
                aria-label="Annotated transcript"
                aria-busy={!isReady}
                onMouseUp={handleTranscriptSelection}
                onWheel={pauseAutoAlignForManualScroll}
                onTouchMove={pauseAutoAlignForManualScroll}
              >
                {transcript.map((line, lineIndex) => (
                  <div
                    className={`transcript-line ${highlightActive && line.time === activeTranscriptTime ? "active-line" : ""}`}
                    data-index={lineIndex}
                    id={transcriptElementId(line.time)}
                    key={`${line.time}-${lineIndex}`}
                    onClick={() => selectTranscriptLine(line.time)}
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
              {selectionCard && !corpusDetail ? (
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
                      className="corpus-detail-trigger"
                      type="button"
                      aria-label={`Open full analysis for ${corpusSelectedText(item)}`}
                      onClick={() => void openCorpusDetail(key, item, record)}
                    >
                      <span className={item.kind === "structure" ? "structure-text" : "corpus-text"}>{item.text}</span>
                      {item.usageNote ? <span className="corpus-note">{item.usageNote}</span> : null}
                      <span className="corpus-tags">
                        {item.tags.map((tag) => (
                          <span className={`tag ${tagClass[tag]}`} key={tag}>
                            {tag}
                          </span>
                        ))}
                      </span>
                      <span className="corpus-meta">{item.meta.replace(/\s*-\s*(click \+ to save|saved locally|saved to corpus|analyzing)$/, "")}{saved ? ` - ${corpus.signedIn ? record?.serverId ? "Saved to account" : "Pending sync" : "Saved on this device"}` : ""}</span>
                    </button>
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
      {corpusDetail ? (
        <CorpusDetailDialog
          state={corpusDetail}
          onClose={() => setCorpusDetail(null)}
          onRetry={retryCorpusDetail}
          onSeek={seekToMoment}
          onTabChange={(tab) => setCorpusDetail((current) => current ? { ...current, tab } : current)}
        />
      ) : null}
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
  const handoffId = params.get("handoffId") ?? undefined;
  const learnerLevel = parseLearnerLevel(params.get("learnerLevel") ?? params.get("level"));

  return {
    kind: "youtube",
    sourceUrl,
    title,
    contentId,
    jobId,
    handoffId,
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

function transcriptElementId(time: string) {
  return `transcript-${time.replaceAll(":", "-")}`;
}


function nearestTranscriptLine(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>(".transcript-line") ?? null;
}

function transcriptLineText(line: StageOneBlueprint["transcript"][number]) {
  return line.parts.map((part) => typeof part === "string" ? part : part.text).join("").replace(/\s+/g, " ").trim();
}

function corpusSelectedText(item: CorpusItem) {
  if (item.sourceText) return item.sourceText;
  if (item.kind === "structure") return item.text;
  return item.text.match(/^["“'](.+?)["”']\s*[-–—]/)?.[1] ?? item.text;
}

function buildCorpusSelectionContext(
  item: CorpusItem,
  transcript: StageOneBlueprint["transcript"],
  contentId?: string,
): CorpusSelectionContext {
  const selectedText = corpusSelectedText(item);
  const selected = selectedText.toLocaleLowerCase();
  const timestamp = item.meta.match(/^\s*(\d{1,2}:\d{2}(?::\d{2})?)/)?.[1];
  let lineIndex = transcript.findIndex((line) => transcriptLineText(line).toLocaleLowerCase().includes(selected));
  if (lineIndex < 0 && timestamp) lineIndex = transcript.findIndex((line) => line.time === timestamp);
  const line = lineIndex >= 0 ? transcript[lineIndex] : undefined;
  return {
    contentId,
    selectedText,
    currentSentence: line ? transcriptLineText(line) : selectedText,
    contextBefore: lineIndex > 0 ? transcriptLineText(transcript[lineIndex - 1]) : undefined,
    contextAfter: lineIndex >= 0 && transcript[lineIndex + 1] ? transcriptLineText(transcript[lineIndex + 1]) : undefined,
    timestamp: line?.time ?? timestamp
  };
}

function buildLoadingSelectionAnalysis(context: CorpusSelectionContext): CorpusSelectionAnalysis {
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

type CorpusDetailDialogProps = {
  state: CorpusDetailState;
  onClose: () => void;
  onRetry: () => void;
  onSeek: (time: string | null) => void;
  onTabChange: (tab: "explain" | "syntax") => void;
};

function CorpusDetailDialog({ state, onClose, onRetry, onSeek, onTabChange }: CorpusDetailDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const analysis = state.detail?.analysis;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="corpus-detail-dialog"
      aria-labelledby="corpus-detail-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="corpus-detail-shell">
        <header className="corpus-detail-header">
          <div>
            <span className="section-label">Corpus detail</span>
            <h1 id="corpus-detail-title">{analysis?.recommendedText ?? corpusSelectedText(state.item)}</h1>
          </div>
          <button className="dialog-close" type="button" aria-label="Close corpus detail" title="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>

        <section className="source-context" aria-label="Original source context">
          <div className="source-context-heading">
            <div>
              <span>Original context</span>
              {state.record?.sourceTitle ? <strong>{state.record.sourceTitle}</strong> : null}
            </div>
            {state.context.timestamp ? (
              <button type="button" className="inline-command" onClick={() => onSeek(state.context.timestamp ?? null)}>
                {state.context.timestamp}
              </button>
            ) : null}
          </div>
          {state.context.contextBefore ? <p className="context-neighbor">{state.context.contextBefore}</p> : null}
          <p className="context-current">{highlightSelection(state.context.currentSentence, state.context.selectedText)}</p>
          {state.context.contextAfter ? <p className="context-neighbor">{state.context.contextAfter}</p> : null}
        </section>

        <div className="corpus-detail-tabs" role="tablist" aria-label="Full corpus analysis">
          <button
            type="button"
            role="tab"
            aria-selected={state.tab === "explain"}
            className={state.tab === "explain" ? "active" : ""}
            onClick={() => onTabChange("explain")}
          >
            Explain
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={state.tab === "syntax"}
            className={state.tab === "syntax" ? "active" : ""}
            onClick={() => onTabChange("syntax")}
          >
            Syntax
          </button>
        </div>

        <div className="corpus-detail-body" aria-live="polite">
          {state.status === "loading" ? (
            <div className="detail-status" role="status">
              <span className="status-indicator loading" aria-hidden="true" />
              <div>
                <h2>Preparing the full analysis</h2>
                <p>{state.item.meaning ?? "Reading the selected expression in its original context."}</p>
              </div>
            </div>
          ) : state.status === "error" || !analysis ? (
            <div className="detail-status" role="alert">
              <span className="status-indicator failed" aria-hidden="true">!</span>
              <div>
                <h2>Analysis could not be loaded</h2>
                <p>{state.error ?? "Please retry."}</p>
                <button className="inline-command" type="button" onClick={onRetry}>Retry</button>
              </div>
            </div>
          ) : state.tab === "explain" ? (
            <ExplainPanel analysis={analysis} isLoading={false} />
          ) : (
            <SyntaxPanel analysis={analysis} isLoading={false} saveDisabled />
          )}
        </div>
      </div>
    </dialog>
  );
}

function highlightSelection(sentence: string, selectedText: string) {
  const index = sentence.toLocaleLowerCase().indexOf(selectedText.toLocaleLowerCase());
  if (index < 0) return sentence;
  return (
    <>
      {sentence.slice(0, index)}
      <mark>{sentence.slice(index, index + selectedText.length)}</mark>
      {sentence.slice(index + selectedText.length)}
    </>
  );
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
          <Volume2 size={13} aria-hidden="true" />
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
  onSavePattern?: (kindOverride?: CorpusKind, textOverride?: string, slots?: Record<string, string>) => void;
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
            {onSavePattern ? (
              <button className="inline-command" type="button" disabled={isLoading || saveDisabled} onClick={() => onSavePattern("structure", pattern.template, pattern.slots)}>
                Save structure
              </button>
            ) : null}
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
