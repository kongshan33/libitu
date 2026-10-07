"use client";

import { DirectionButton } from "@/components/ui/direction-button";

import { Textarea } from "@/components/ui/field";

import { Button, ButtonLink } from "@/components/ui/button";

import { BrandLogo } from "@/components/BrandLogo";
import { AuthControls } from "@/features/auth/components/AuthControls";
import dynamic from "next/dynamic";
import { useAuth, useClerk } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { ArrowLeft, ArrowRight, Check, Clock3, Pin, PinOff, Plus, Star, Target, Trash2, X } from "lucide-react";
import type {
  CorpusFilter,
  CorpusItem,
  CorpusItemAnalysisDetail,
  CorpusKind,
  CorpusSelectionAnalysis,
  CorpusSelectionContext,
  FunctionalTag,
  StageOneBlueprint,
  StageOneSegment
} from "@libitu/types/stage-one";
import type { LearnerLevel } from "@libitu/types/stage-one";
import { LearningLocationTracker } from "@/features/profile/LearningLocationTracker";
import {
  analyzeCorpusSelection,
  defaultStageOneSource,
  loadStageOneBlueprint,
  StageOneApiError,
  type StageOneAnalysisPreview,
  type StageOneSource
} from "../api/stage-one-api";
import { YouTubePlayer, type YouTubePlayerHandle } from "./YouTubePlayer";
import { ExplainPanel, SyntaxPanel } from "../../corpus/AnalysisPanels";
import { useSavedCorpus } from "../../corpus/useSavedCorpus";
import { savedCorpusKey, type SavedCorpusRecord } from "../../corpus/corpus-storage";
import { findCurrentTimedItem, parseTimestamp, formatTranscriptTimestamp } from "../timeline";
import { CaptionTimedText } from "../../playback/CaptionTimedText";
import { CaptionWordClock } from "../../playback/caption-word-clock";
import { WordTimingNotice } from "../../playback/WordTimingNotice";
import { CaptionTimingRecoveryNotice } from "../../playback/CaptionTimingRecoveryNotice";
import { useCaptionTimingRecovery } from "./use-caption-timing-recovery";
import { buildSentenceUnits } from "../../stage-two/sentences";
import { readStageTwoLocation, replaceStageTwoLocation } from "../../stage-two/location";
import { BufferedReferenceProvider, useBufferedReference } from "../../stage-two/reference/use-buffered-reference";
import { BufferedReferencePanel } from "../../stage-two/components/BufferedReferencePanel";
import { useReferenceAnalysis } from "../../stage-two/analysis/use-reference-analysis";
import { useBufferedAnalysis } from "../../stage-two/analysis/use-buffered-analysis";
import { buildReferenceKey, type ReferenceAnalysisCache } from "../../stage-two/analysis/reference-analysis-cache";
import { LoadoutLink } from "../../navigation/LoadoutLink";

const StageTwoShadowing = dynamic(() => import("../../stage-two/components/StageTwoShadowing").then((module) => module.StageTwoShadowing),
  { loading: () => <p role="status">Opening practice…</p> });

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

type StageOneReaderProps = {
  onChooseSegment?: () => void;
  onStartStageTwo?: (segment: StageOneSegment) => void;
};

type StageOneView = "reader" | "picker" | "preparing" | "shadow";

function LibraryIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M3.25 3.5h9.5v9h-9.5zM5.5 5.75h5M5.5 8h5M5.5 10.25h3" />
    </svg>
  );
}

export function StageOneReader({ onChooseSegment, onStartStageTwo }: StageOneReaderProps = {}) {
  const { isLoaded: authLoaded, userId } = useAuth();
  const clerk = useClerk();
  const [blueprint, setBlueprint] = useState<StageOneBlueprint | null>(null);
  const [analysisPreview, setAnalysisPreview] = useState<StageOneAnalysisPreview | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed" | "unsupported">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeNode, setActiveNode] = useState<string | null>(null);
  const [activeTranscriptIdentity, setActiveTranscriptIdentity] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<CorpusFilter>("chunks");
  const corpus = useSavedCorpus();
  const [selectionCard, setSelectionCard] = useState<SelectionCardState | null>(null);
  const [corpusDetail, setCorpusDetail] = useState<CorpusDetailState | null>(null);
  const closeSelectionCard = useCallback(() => setSelectionCard(null), []);
  const [autoScroll, setAutoScroll] = useState(true);
  const [autoScrollPausedUntil, setAutoScrollPausedUntil] = useState<number | null>(null);
  const [isPlayerPlaying, setIsPlayerPlaying] = useState(false);
  const playingRef = useRef(false);
  const [highlightActive, setHighlightActive] = useState(true);
  const [sourceTitle, setSourceTitle] = useState("Loading Stage 1 content");
  const [source, setSource] = useState<StageOneSource | null>(null);
  const [stageOneView, setStageOneView] = useState<StageOneView>("reader");
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const resolvedSourceRef = useRef<StageOneSource | null>(null);
  const playerRef = useRef<YouTubePlayerHandle>(null);
  const [wordClock] = useState(() => new CaptionWordClock());
  const programmaticScrollTimeoutRef = useRef<number | null>(null);
  const resumeAutoScrollTimeoutRef = useRef<number | null>(null);
  const detailCacheRef = useRef(new Map<string, CorpusItemAnalysisDetail>());
  const handlePlaybackChange = useCallback((playing: boolean) => {
    playingRef.current = playing;
    setIsPlayerPlaying(playing);
  }, []);
  const applyRecoveredBlueprint = useCallback((next: StageOneBlueprint) => {
    if (playingRef.current) return false;
    setBlueprint(next);
    return true;
  }, []);
  const timingRecovery = useCaptionTimingRecovery(blueprint, {
    ready: status === "ready", applyWhenPaused: stageOneView === "reader" && !isPlayerPlaying,
    language: source?.language, learnerLevel: source?.learnerLevel, onApply: applyRecoveredBlueprint
  });

  const sourceKey = blueprint?.contentId ?? source?.contentId ?? source?.sourceUrl ?? "";
  const sourceUrl = blueprint?.sourceUrl ?? source?.sourceUrl;
  const bufferedReference = useBufferedReference(blueprint?.contentId ?? source?.contentId ?? null, sourceUrl ?? null);
  const sharedReferenceAnalysis = useReferenceAnalysis(null, null);
  const sharedReferenceCache = sharedReferenceAnalysis.cache;
  const captureGeneration = useRef(0);
  const suspendBuffered = bufferedReference.suspend;
  useEffect(() => { sharedReferenceCache.clear(); }, [sourceKey, sourceUrl, sharedReferenceCache]);
  const suspendReference = useCallback(() => {
    suspendBuffered();
    captureGeneration.current++;
  }, [suspendBuffered]);
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
    setSourceTitle(nextSource.title || "YouTube video");
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
    () => transcript.map((line, index) => ({
      item: { identity: transcriptIdentity(line, index) },
      seconds: transcriptStartSeconds(line)
    })),
    [transcript]
  );
  const logicTimeline = useMemo(
    () => logicNodes.map((node) => ({ item: node, seconds: parseTimestamp(node.time) })),
    [logicNodes]
  );

  const syncActiveMoment = useCallback((seconds: number) => {
    const currentLine = findCurrentTimedItem(transcriptTimeline, seconds);
    if (currentLine) setActiveTranscriptIdentity((current) => current === currentLine.identity ? current : currentLine.identity);
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
    if (!shouldAutoAlignTranscript || !activeTranscriptIdentity) return;
    const activeLine = document.getElementById(transcriptElementId(activeTranscriptIdentity));
    if (!activeLine) return;
    markProgrammaticScroll();
    activeLine.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeTranscriptIdentity, markProgrammaticScroll, shouldAutoAlignTranscript]);

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

  function selectTranscriptLine(line: StageOneBlueprint["transcript"][number], index: number) {
    resumeAutoAlignNow();
    const seconds = transcriptStartSeconds(line);
    if (seconds === null) return;
    playerRef.current?.seekTo(seconds, { autoplay: true });
    syncActiveMoment(seconds);
    setActiveTranscriptIdentity(transcriptIdentity(line, index));
  }

  function seekToMoment(primaryTime: string | null, fallbackTime?: string) {
    const time = primaryTime ?? fallbackTime ?? null;
    const seconds = parseTimestamp(time);
    if (seconds === null) return;
    playerRef.current?.seekTo(seconds, { autoplay: true });
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
  const playableSegments = useMemo(
    () => (blueprint?.segments ?? []).filter(isPlayableSegment),
    [blueprint?.segments]
  );
  const displaySourceUrl = blueprint?.sourceUrl ?? source?.sourceUrl;
  const displayTitle = blueprint?.title ?? sourceTitle;
  const displaySummary = blueprint?.summary ?? analysisPreview?.summary;
  const selectedSegment = playableSegments.find((segment) => segment.id === selectedSegmentId) ?? null;

  const openSegmentPicker = useCallback(() => {
    if (playableSegments.length === 0) return;
    suspendReference();
    playerRef.current?.pause();
    onChooseSegment?.();
    setStageOneView("picker");
  }, [onChooseSegment, playableSegments.length, suspendReference]);

  const closeSegmentPicker = useCallback(() => {
    suspendReference();
    replaceStageTwoLocation(null);
    if (stageOneView !== "reader") handlePlaybackChange(false);
    setStageOneView("reader");
  }, [handlePlaybackChange, stageOneView, suspendReference]);

  const beginStageTwoPreparation = useCallback((segment: StageOneSegment) => {
    suspendReference();
    setSelectedSegmentId(segment.id);
    setStageOneView("preparing");
  }, [suspendReference]);

  const launchStageTwo = useCallback((segment: StageOneSegment) => {
    suspendReference();
    const firstSentence = blueprint ? buildSentenceUnits(blueprint.contentId, segment, blueprint.transcript)[0] : null;
    replaceStageTwoLocation({ segmentId: segment.id, sentenceId: firstSentence?.id });
    setSelectedSegmentId(segment.id);
    setStageOneView("shadow");
    if (userId) onStartStageTwo?.(segment);
    else if (authLoaded) {
      const returnUrl = window.location.href;
      clerk.openSignIn({ forceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl });
    }
  }, [onStartStageTwo, suspendReference, blueprint, userId, authLoaded, clerk]);

  useEffect(() => {
    if (!blueprint) return;
    const location = readStageTwoLocation(new URL(window.location.href));
    if (!location) return;
    if (!playableSegments.some((segment) => segment.id === location.segmentId)) {
      replaceStageTwoLocation(null);
      return;
    }
    setSelectedSegmentId(location.segmentId);
    setStageOneView("shadow");
  }, [blueprint, playableSegments]);

  return (
    <BufferedReferenceProvider value={bufferedReference}>
    <LearningLocationTracker authLoaded={authLoaded} owner={userId} ready={isReady}
      contentId={blueprint?.contentId ?? null} sourceUrl={displaySourceUrl} title={displayTitle} />
    <main className="stage-page">
      <section className="reader-shell" aria-label="Libitu stage 1 ingest reader">
        <header className="topbar">
          <BrandLogo className="logo" />
          <div className="topbar-title">{blueprint?.title ?? sourceTitle}</div>
          <div className="stage-pills" aria-label="Learning stages">
            <button
              className={`stage-pill ${stageOneView === "reader" || stageOneView === "picker" ? "active" : ""}`}
              type="button"
              onClick={closeSegmentPicker}
            >
              Stage 1 - Ingest
            </button>
            <button
              className={`stage-pill ${stageOneView === "preparing" || stageOneView === "shadow" ? "active" : ""}`}
              type="button"
              disabled={!isReady}
            >
              Stage 2 - Shadow
            </button>
            <LoadoutLink className="stage-pill">Stage 3 - Mission</LoadoutLink>
          </div>
          <ButtonLink variant="secondary" size="inherit" shape="pill" className="stage-pill" href="/corpus">Corpus</ButtonLink>
          <AuthControls />
        </header>

        {stageOneView === "picker" ? (
          <StageOneSegmentPicker
            segments={playableSegments}
            logicNodes={logicNodes}
            selectedSegmentId={selectedSegmentId}
            title={displayTitle}
            onBack={closeSegmentPicker}
            onSelect={setSelectedSegmentId}
            onBegin={beginStageTwoPreparation}
          />
        ) : stageOneView === "preparing" && selectedSegment ? (
          <StageTwoPreparation
            contentId={blueprint!.contentId}
            segment={selectedSegment}
            logicNodes={logicNodes}
            transcript={transcript}
            sourceUrl={displaySourceUrl ?? ""}
            capture={bufferedReference}
            captureGeneration={captureGeneration.current}
            cache={sharedReferenceCache}
            onStart={launchStageTwo}
          />
        ) : stageOneView === "shadow" && selectedSegment && (!authLoaded || !userId) ? (
          <section className="shadow-sign-in" aria-label="Sign in to Shadow">
            <h1>Sign in to start Shadow</h1>
            <p>Save your practice history to your account. You choose whether to keep recordings for later playback.</p>
            <p>{selectedSegment.title} · Your selected sentence will be kept.</p>
            <Button variant="secondary" size="inherit" type="button" disabled={!authLoaded} onClick={() => {
              const returnUrl = window.location.href;
              clerk.openSignIn({ forceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl });
            }}>{authLoaded ? "Sign in or create account" : "Checking sign-in…"}</Button>
            <Button variant="secondary" size="inherit" type="button" onClick={closeSegmentPicker}>Back to Stage 1</Button>
          </section>
        ) : stageOneView === "shadow" && selectedSegment && authLoaded && userId ? (
          <StageTwoShadowing
            key={JSON.stringify([userId, blueprint!.contentId, selectedSegment.id, displaySourceUrl])}
            contentId={blueprint!.contentId}
            segment={selectedSegment}
            sourceUrl={displaySourceUrl}
            title={displayTitle}
            transcript={transcript}
            timingRecovery={<CaptionTimingRecoveryNotice state={timingRecovery.state} inPractice onRetry={timingRecovery.retry} />}
            sharedReferenceCache={sharedReferenceCache}
            captureGeneration={captureGeneration.current}
            onBack={() => {
              suspendReference();
              replaceStageTwoLocation(null);
              setStageOneView("picker");
            }}
          />
        ) : (
          <>
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
                wordClock={wordClock}
                ref={playerRef}
                sourceUrl={displaySourceUrl}
                title={displayTitle}
                onPlaybackChange={handlePlaybackChange}
                onTimeChange={handlePlayerTimeChange}
                onTelemetry={(sample) => bufferedReference.sample(
                  sample.blockedByPausedSeek ? { ...sample, state: 2 } : sample, captureGeneration.current)}
              />
            ) : source ? (
              <p className="empty-state">The source video URL is unavailable.</p>
            ) : null}
          </div>
          {displaySourceUrl && blueprint?.contentId ? <BufferedReferencePanel capture={bufferedReference} playable /> : null}
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
                {/* <Button variant="secondary" size="inherit" className="control-button" type="button" disabled={!isReady}>
                  <LibraryIcon />
                  Add to corpus
                </Button> */}
              </div>

              {/* <WordTimingNotice rows={transcript} enabled={highlightActive} pending={status === "loading"} /> */}
              <CaptionTimingRecoveryNotice state={timingRecovery.state} onRetry={timingRecovery.retry} />
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
                    className={`transcript-line ${highlightActive && transcriptIdentity(line, lineIndex) === activeTranscriptIdentity ? "active-line" : ""}`}
                    data-index={lineIndex}
                    id={transcriptElementId(transcriptIdentity(line, lineIndex))}
                    key={line.segmentationVersion && line.id ? line.id : `${line.time}-${lineIndex}`}
                    onClick={() => selectTranscriptLine(line, lineIndex)}
                  >
                    <button className="transcript-time" type="button" aria-label={`Play from ${formatTranscriptTimestamp(line.time)}`}>{formatTranscriptTimestamp(line.time)}</button>
                    <CaptionTimedText className="transcript-text" parts={line.parts} clock={wordClock}
                      enabled={highlightActive}
                      sourceTokenStart={line.sourceTokenStart} timingSource={line.timingSource} wordTimings={line.wordTimings} />
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
                <Button variant="secondary" size="inherit" type="button" className="inline-command" onClick={corpus.retry} disabled={corpus.busy} loading={corpus.busy} loadingLabel="Syncing…">Retry sync</Button>
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
              <span>Your saved language</span>
              <strong>{savedRecords.length} items saved from this source</strong>
            </div>
            <LoadoutLink className="mission-button" size="sm" shape="default">Open loadout</LoadoutLink>
          </div>
        </aside>

        {isReady ? (
          <StageOneStageCta
            segmentCount={playableSegments.length}
            onChooseSegment={openSegmentPicker}
          />
        ) : null}
          </>
        )}
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
    </BufferedReferenceProvider>
  );
}

function isPlayableSegment(segment: StageOneBlueprint["segments"][number]) {
  return typeof segment.startMs === "number"
    && typeof segment.endMs === "number"
    && segment.endMs > segment.startMs;
}

type StageOneStageCtaProps = {
  segmentCount: number;
  onChooseSegment?: () => void;
};

function StageOneStageCta({ segmentCount, onChooseSegment }: StageOneStageCtaProps) {
  const canChooseSegment = segmentCount > 0;

  return (
    <footer className="stage-one-cta" aria-label="Stage 2 entry point">
      <div className="stage-one-cta-status" role="status" aria-live="polite">
        <span className={`stage-one-cta-dot ${canChooseSegment ? "ready" : "unavailable"}`} aria-hidden="true" />
        {canChooseSegment
          ? `Analysis complete · ${segmentCount} practice segment${segmentCount === 1 ? "" : "s"} ready`
          : "Analysis complete · Practice segments unavailable"}
      </div>
      <span className="stage-one-cta-spacer" aria-hidden="true" />
      <span className="stage-one-cta-hint">
        {canChooseSegment ? "All segments under 5 minutes" : "Playable segment timing is required"}
      </span>
      <DirectionButton variant="primary"
        className="stage-one-cta-button"
        type="button"
        disabled={!canChooseSegment}
        onClick={onChooseSegment}
      >
        {canChooseSegment ? "Choose a segment to shadow" : "Segments unavailable"}
        <ArrowRight aria-hidden="true" />
      </DirectionButton>
    </footer>
  );
}

const segmentLogicColors = ["#1d9e75", "#ef9f27", "#534ab7", "#3b82f6"];

function StageOneSegmentPicker({
  segments,
  logicNodes,
  selectedSegmentId,
  title,
  onBack,
  onSelect,
  onBegin
}: {
  segments: StageOneSegment[];
  logicNodes: StageOneBlueprint["logicNodes"];
  selectedSegmentId: string | null;
  title: string;
  onBack: () => void;
  onSelect: (segmentId: string) => void;
  onBegin?: (segment: StageOneSegment) => void;
}) {
  const totalDurationMs = Math.max(...segments.map((segment) => segment.endMs ?? 0), 0);
  const allUnderFiveMinutes = segments.every((segment) => segmentDurationMs(segment) <= 5 * 60_000);
  const selectedSegment = segments.find((segment) => segment.id === selectedSegmentId) ?? null;

  return (
    <section className="stage-one-picker" aria-label="Choose a segment to shadow">
      <header className="stage-one-picker-header">
        <DirectionButton variant="secondary" className="stage-one-picker-back" type="button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          Back
        </DirectionButton>
        <div className="stage-one-picker-heading">
          <h1>Choose a segment to shadow</h1>
          <p>AI divided {title} into {segments.length} segments aligned to the logic flow.</p>
        </div>
        <span className="stage-one-picker-rule">
          <Clock3 aria-hidden="true" />
          {allUnderFiveMinutes ? "All under 5 min" : "Some segments over 5 min"}
        </span>
      </header>

      <div className="stage-one-picker-timeline">
        <div className="stage-one-picker-timeline-label">
          <span>Video timeline · {formatSegmentClock(totalDurationMs)} total</span>
          <span>Click a segment to select</span>
        </div>
        <div className="stage-one-picker-timeline-scroll">
          <div
            className="stage-one-picker-timeline-track"
            style={{ minWidth: `${Math.max(segments.length * 112, 560)}px` }}
          >
            <div className="stage-one-picker-timeline-bar" role="group" aria-label="Video segments">
              {segments.map((segment, index) => {
                const logic = segmentLogicFor(segment, logicNodes, index);
                const selected = segment.id === selectedSegmentId;
                return (
                  <button
                    className={`stage-one-picker-timeline-segment ${selected ? "selected" : ""}`}
                    key={segment.id}
                    type="button"
                    aria-label={`${segment.title}, ${formatSegmentClock(segment.startMs ?? 0)} to ${formatSegmentClock(segment.endMs ?? 0)}`}
                    aria-pressed={selected}
                    style={{
                      flex: Math.max(segmentDurationMs(segment), 1),
                      background: logic.color
                    }}
                    onClick={() => onSelect(segment.id)}
                  >
                    <span className="stage-one-picker-timeline-number">S{segment.sequence ?? index + 1}</span>
                    <span className="stage-one-picker-timeline-title">{segment.title}</span>
                  </button>
                );
              })}
            </div>
            <div className="stage-one-picker-timeline-boundaries" aria-label="Segment boundary times">
              {segments.map((segment, index) => (
                <time
                  className={index === 0 ? "first" : ""}
                  dateTime={`PT${Math.round((segment.startMs ?? 0) / 1000)}S`}
                  key={`${segment.id}-start`}
                  style={{ left: `${totalDurationMs > 0 ? (segment.startMs ?? 0) / totalDurationMs * 100 : 0}%` }}
                >
                  {formatSegmentClock(segment.startMs ?? 0)}
                </time>
              ))}
              <time className="last" dateTime={`PT${Math.round(totalDurationMs / 1000)}S`}>
                {formatSegmentClock(totalDurationMs)}
              </time>
            </div>
          </div>
        </div>
      </div>

      <div className="stage-one-picker-scroll">
        <div className="stage-one-picker-grid">
          {segments.map((segment, index) => (
            <StageOneSegmentCard
              key={segment.id}
              segment={segment}
              logic={segmentLogicFor(segment, logicNodes, index)}
              selected={segment.id === selectedSegmentId}
              onSelect={() => onSelect(segment.id)}
            />
          ))}
        </div>
      </div>

      <footer className="stage-one-picker-footer">
        <div className="stage-one-picker-selection">
          <span>{selectedSegment ? "Selected segment" : "Select a segment above to begin"}</span>
          {selectedSegment ? (
            <strong>{selectedSegment.title} · {formatSegmentDuration(selectedSegment)} · {segmentLogicFor(selectedSegment, logicNodes, 0).node?.title ?? "Logic flow"}</strong>
          ) : null}
        </div>
        <DirectionButton variant="primary"
          className="stage-one-picker-begin"
          type="button"
          disabled={!selectedSegment}
          onClick={() => selectedSegment && onBegin?.(selectedSegment)}
        >
          Begin Stage 2{selectedSegment ? ` · ${selectedSegment.title}` : ""}
          <ArrowRight aria-hidden="true" />
        </DirectionButton>
      </footer>
    </section>
  );
}

function StageTwoPreparation({
  contentId,
  segment,
  logicNodes,
  transcript,
  sourceUrl,
  capture,
  captureGeneration,
  cache,
  onStart
}: {
  contentId: string;
  segment: StageOneSegment;
  logicNodes: StageOneBlueprint["logicNodes"];
  transcript: StageOneBlueprint["transcript"];
  sourceUrl: string;
  capture: ReturnType<typeof useBufferedReference>;
  captureGeneration: number;
  cache: ReferenceAnalysisCache;
  onStart?: (segment: StageOneSegment) => void;
}) {
  const logic = segmentLogicFor(segment, logicNodes, Math.max((segment.sequence ?? 1) - 1, 0));
  const sentences = useMemo(() => buildSentenceUnits(contentId, segment, transcript), [contentId, segment, transcript]);
  const player = useRef<YouTubePlayerHandle>(null);
  const [playing, setPlaying] = useState(false);
  const suspend = capture.suspend;
  const observed = useReferenceAnalysis(null, null, undefined, cache);
  const preparation = useBufferedAnalysis(contentId, sourceUrl, sentences, capture, cache);
  const keyOf = (sentence: typeof sentences[number]) => buildReferenceKey(contentId, sourceUrl, sentence.id, sentence.startMs, sentence.endMs);
  const covered = sentences.filter((sentence) => capture.covers({ start: sentence.startMs / 1000, end: sentence.endMs / 1000 }));
  const analyzed = sentences.filter((sentence) => observed.isReady(keyOf(sentence)));
  const missing = sentences.find((sentence) => !capture.covers({ start: sentence.startMs / 1000, end: sentence.endMs / 1000 })
    && !observed.isReady(keyOf(sentence)));
  useEffect(() => {
    const handle = player.current;
    return () => { handle?.pause(); suspend(); };
  }, [suspend]);
  function prepareMissing() {
    if (playing) { player.current?.pause(); capture.suspend(); return; }
    const start = Math.max(0, (missing?.startMs ?? segment.startMs ?? 0) / 1000 - 0.5);
    const end = (segment.endMs ?? 0) / 1000 + 0.3;
    player.current?.setPlaybackRate(1);
    player.current?.playRange(start, end, { loop: false });
  }
  const steps = ["Practice segment selected", sentences.length
    ? `${sentences.length} sentences ready for practice`
    : "Sentence text unavailable · segment playback available"];

  return (
    <section className="stage-two-preparation" aria-label="Preparing Stage 2" aria-live="polite">
      <div className="stage-two-preparation-heading">
        <h1>Ready to practice</h1>
        <p>Listen one sentence at a time, then repeat aloud.</p>
      </div>
      <div className="stage-two-preparation-segment">
        <span className="stage-two-preparation-icon" aria-hidden="true"><Target /></span>
        <span>
          <strong>{segment.title}</strong>
          <small>
            {formatSegmentClock(segment.startMs ?? 0)} – {formatSegmentClock(segment.endMs ?? 0)} · {formatSegmentDuration(segment)} · {logic.node?.title ?? "Logic flow"}
          </small>
        </span>
      </div>
      <div className="stage-two-preparation-steps" role="list" aria-label="Stage 2 preparation steps">
        {steps.map((step) => {
          return (
            <div className="stage-two-preparation-step done" key={step} role="listitem">
              <span className="stage-two-preparation-step-icon" aria-hidden="true" />
              {step}
            </div>
          );
        })}
      </div>
      <div className="stage-two-buffer-preparation">
        {sourceUrl ? <YouTubePlayer ref={player} sourceUrl={sourceUrl} title="Prepare selected practice audio"
          onPlaybackChange={setPlaying} onTimeChange={() => {}}
          onTelemetry={(sample) => capture.sample(sample.blockedByPausedSeek ? { ...sample, state: 2 } : sample, captureGeneration)} /> : null}
        <BufferedReferencePanel capture={capture} playable={Boolean(sourceUrl)}>
          <p role="status">{covered.length} of {sentences.length} sentence audio ranges available on this device. {analyzed.length} references analyzed.</p>
          <p className="stage-two-recording-note">Already heard sentences can be prepared from the buffer. Listen at 1× to fill missing ranges. The first three available references are analyzed here; the next ones are prepared as you practice.</p>
          {capture.state.phase === "enabled" && (missing || playing) ? <Button variant="secondary" size="inherit" type="button" onClick={prepareMissing}>
            {playing ? "Pause preparation" : "Listen to prepare missing audio"}
          </Button> : null}
          {preparation.error ? <p role="alert">{preparation.error} <Button variant="secondary" size="inherit" type="button" onClick={preparation.retry}>Retry preparation</Button></p> : null}
        </BufferedReferencePanel>
      </div>
      <DirectionButton variant="primary"
        className="stage-two-preparation-start visible"
        type="button"
        onClick={() => { player.current?.pause(); capture.suspend(); onStart?.(segment); }}
      >
        <ArrowRight aria-hidden="true" />
        Start shadowing
      </DirectionButton>
      <p>Listening and recording remain available while reference analysis is preparing. Sound detection is not evaluated.</p>
    </section>
  );
}


function StageOneSegmentCard({
  segment,
  logic,
  selected,
  onSelect
}: {
  segment: StageOneSegment;
  logic: SegmentLogic;
  selected: boolean;
  onSelect: () => void;
}) {
  const difficulty = segment.difficulty ?? "medium";
  const difficultyDots = difficulty === "easy" ? 1 : difficulty === "dense" ? 3 : 2;
  const duration = segmentDurationMs(segment);
  const quote = segment.quote ?? segment.sourceText ?? segment.summary;

  return (
    <button
      className={`stage-one-segment-card ${selected ? "selected" : ""}`}
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="stage-one-segment-accent" style={{ background: logic.color }} aria-hidden="true" />
      <span className="stage-one-segment-body">
        <span className="stage-one-segment-heading">
          <strong className="stage-one-segment-title">{segment.title}</strong>
          {segment.recommended ? (
            <span className="stage-one-segment-recommended">
              <Star aria-hidden="true" />
              Recommended
            </span>
          ) : null}
        </span>
        <span className="stage-one-segment-time">
          {formatSegmentClock(segment.startMs ?? 0)}–{formatSegmentClock(segment.endMs ?? 0)} · {formatSegmentDuration(segment)} · {segment.wordCount ?? "--"} words
        </span>
        <span className="stage-one-segment-duration-bar" aria-hidden="true">
          <span style={{ width: `${Math.min(duration / (5 * 60_000) * 100, 100)}%` }} />
        </span>
        <span className="stage-one-segment-quote">“{quote}”</span>
        <span className="stage-one-segment-footer">
          <span className="stage-one-segment-phonology">
            {segment.phonologyTags.map((tag) => <span key={tag}>{tag.toUpperCase()}</span>)}
          </span>
          <span className="stage-one-segment-difficulty">
            {[1, 2, 3].map((dot) => <i className={dot <= difficultyDots ? "filled" : ""} key={dot} style={{ background: dot <= difficultyDots ? difficultyColor(difficulty) : undefined }} aria-hidden="true" />)}
            {difficulty}
          </span>
        </span>
      </span>
      <span className="stage-one-segment-check" aria-hidden="true"><Check /></span>
    </button>
  );
}

type SegmentLogic = {
  node?: StageOneBlueprint["logicNodes"][number];
  color: string;
};

function segmentLogicFor(segment: StageOneSegment, logicNodes: StageOneBlueprint["logicNodes"], index: number): SegmentLogic {
  const node = segment.logicNodeId ? logicNodes.find((candidate) => candidate.id === segment.logicNodeId) : undefined;
  const fallbackNode = node ?? logicNodes[Math.min(segment.sequence ? segment.sequence - 1 : index, logicNodes.length - 1)];
  const colorIndex = Math.max(logicNodes.indexOf(fallbackNode), 0) % segmentLogicColors.length;
  return {
    node: fallbackNode,
    color: segmentLogicColors[colorIndex]
  };
}

function segmentDurationMs(segment: StageOneSegment) {
  return Math.max((segment.durationMs ?? ((segment.endMs ?? 0) - (segment.startMs ?? 0))), 0);
}

function formatSegmentClock(milliseconds: number) {
  const totalSeconds = Math.max(Math.round(milliseconds / 1000), 0);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatSegmentDuration(segment: StageOneSegment) {
  const totalSeconds = Math.round(segmentDurationMs(segment) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function difficultyColor(difficulty: NonNullable<StageOneSegment["difficulty"]>) {
  return difficulty === "easy" ? "#1d9e75" : difficulty === "dense" ? "#e24b4a" : "#ef9f27";
}

function readStageOneSource(): StageOneSource {
  const params = new URLSearchParams(window.location.search);
  const sourceUrl = params.get("sourceUrl") ?? defaultStageOneSource.sourceUrl;
  const title = params.get("title") ?? (params.has("sourceUrl") || params.has("contentId") ? "" : defaultStageOneSource.title);
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

function transcriptIdentity(line: StageOneBlueprint["transcript"][number], index: number) {
  return line.segmentationVersion ? line.id ?? `${line.time}-${index}` : line.time;
}

function transcriptStartSeconds(line: StageOneBlueprint["transcript"][number]): number | null {
  return Number.isFinite(line.startMs) && line.startMs! >= 0 ? line.startMs! / 1000 : parseTimestamp(line.time);
}

function transcriptElementId(identity: string) {
  return `transcript-${identity.replaceAll(":", "-")}`;
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
          <Button variant="ghost" size="inherit" shape="circle" className="dialog-close" type="button" aria-label="Close corpus detail" title="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </header>

        <section className="source-context" aria-label="Original source context">
          <div className="source-context-heading">
            <div>
              <span>Original context</span>
              {state.record?.sourceTitle ? <strong>{state.record.sourceTitle}</strong> : null}
            </div>
            {state.context.timestamp ? (
              <Button variant="secondary" size="inherit" type="button" className="inline-command" onClick={() => onSeek(state.context.timestamp ?? null)}>
                {state.context.timestamp}
              </Button>
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
                <Button variant="secondary" size="inherit" className="inline-command" type="button" onClick={onRetry}>Retry</Button>
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

      <Textarea
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
        <Button variant="primary" size="inherit" className="selection-save" type="button" disabled={isLoading || saveDisabled} onClick={() => onSave()}>
          Save
        </Button>
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
        <Button variant="secondary" size="inherit" className="mission-button" type="button" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
