"use client";

import { DirectionButton } from "@/components/ui/direction-button";

import { Button } from "@/components/ui/button";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Info, Pause, Play, Repeat2 } from "lucide-react";
import { LoadoutLink } from "../../navigation/LoadoutLink";
import type { StageOneSegment, TranscriptLine } from "@libitu/types/stage-one";
import type { SentenceUnit } from "@libitu/types/stage-two";
import { YouTubePlayer, type YouTubePlayerHandle, type YouTubeTelemetry } from "../../stage-one/components/YouTubePlayer";
import { buildSentenceUnits, sentenceAtTime } from "../sentences";
import { readStageTwoLocation, replaceStageTwoLocation } from "../location";
import { useSentenceRecording } from "../recording/use-sentence-recording";
import { SentenceRecordingPanel } from "./SentenceRecordingPanel";
import { useReferenceCapture } from "../reference/use-reference-capture";
import { ReferenceAudioPanel } from "./ReferenceAudioPanel";
import { StageTwoSelect } from "./StageTwoSelect";
import { type AudioAnalysisView } from "./AcousticComparisonPanel";
import { useReferenceAnalysis } from "../analysis/use-reference-analysis";
import { buildReferenceKey } from "../analysis/reference-analysis-cache";
import type { ReferenceClip } from "../reference/reference-capture";
import { useAudioFeatures } from "../analysis/use-audio-features";
import { useSoundGuide } from "../sound/use-sound-guide";
import { PracticeLayers, PracticeLayerShortcuts, type PracticeLayer } from "./PracticeLayers";
import { CaptionTimedText } from "../../playback/CaptionTimedText";
import { CaptionWordClock } from "../../playback/caption-word-clock";
import { WordTimingNotice } from "../../playback/WordTimingNotice";
import { useBufferedReferenceContext, type BufferedReferenceSession } from "../reference/use-buffered-reference";
import type { ReferenceAnalysisCache } from "../analysis/reference-analysis-cache";
import { useBufferedAnalysis } from "../analysis/use-buffered-analysis";
import { BufferedReferencePanel } from "./BufferedReferencePanel";
import { usePracticePersistence } from "../persistence/PracticePersistence";
import { PracticeHistory } from "../persistence/PracticeHistory";
import { usePracticeAnalysis } from "../persistence/use-practice-analysis";
import { PracticeAnalysisPanel } from "./PracticeAnalysisPanel";
import { LayerComparison } from "./LayerComparison";
import { useServerReference } from "../server-reference/use-server-reference";
import { ServerReferencePanel } from "../server-reference/ServerReferencePanel";
import type { RecordingState } from "../recording/local-recorder";

import { useCapturedReference } from '../server-reference/use-captured-reference';
import { comparisonView } from '../comparison/view';
import { useAudioWordClock } from '../../playback/use-audio-word-clock';

type Props = {
  contentId: string;
  segment: StageOneSegment;
  sourceUrl?: string;
  title: string;
  transcript: TranscriptLine[];
  timingRecovery?: ReactNode;
  bufferedReference?: BufferedReferenceSession;
  sharedReferenceCache?: ReferenceAnalysisCache;
  captureGeneration?: number;
  onBack(): void;
};

const noLocalRecording: AudioAnalysisView = { features: null, pending: false, error: null, retry() {} };

export function StageTwoShadowing({ contentId, segment, sourceUrl, title, transcript, onBack, timingRecovery,
  bufferedReference, sharedReferenceCache, captureGeneration = 1 }: Props) {
  const sentences = useMemo(() => buildSentenceUnits(contentId, segment, transcript), [contentId, segment, transcript]);
  // StageOneReader provides the session through context. The optional prop is
  // retained for standalone callers; the context covers dynamic/remounted
  // Stage 2 views without creating a second Chrome authorization session or
  // showing the legacy panel.
  const contextBufferedReference = useBufferedReferenceContext();
  const activeBufferedReference = bufferedReference ?? contextBufferedReference;
  // The component is keyed by content/segment/source; a stale URL ID falls back safely.
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const location = typeof window === "undefined" ? null : readStageTwoLocation(new URL(window.location.href));
    return location?.segmentId === segment.id ? location.sentenceId : null;
  });
  const selected = sentences.find((sentence) => sentence.id === selectedId) ?? sentences[0] ?? null;
  const timingRows = useMemo(() => selected ? [selected] : [], [selected]);
  const selectedIndex = selected ? sentences.indexOf(selected) : -1;
  const playerRef = useRef<YouTubePlayerHandle>(null);
  const [bufferPreparing, setBufferPreparing] = useState(false);
  const [wordClock] = useState(() => new CaptionWordClock());
  const [learnerClock] = useState(() => new CaptionWordClock());
  const [savedClip,setSavedClip] = useState<{url:string;id:string|null}|null>(null);
  const cancelReferenceRef = useRef<(() => void) | null>(null);
  const listeningIntent = useRef(false);
  const previouslyPlaying = useRef(false);
  const completedReferences = useRef(new WeakSet<ReferenceClip>());
  const persistence = usePracticePersistence();
  const outbox = persistence?.outbox;
  const [retainRecording, setRetainRecording] = useState(false);
  const takeContext = useRef<{ rate: number; textVisible: boolean; retain: boolean; analyze: boolean; referenceId: string | null; resolveReference?:()=>Promise<string|null> } | null>(null);
  const [analysisSelection, setAnalysisSelection] = useState<{ sentence: string | null; id: string | null; take?: string } | null>(null);
  const selectAnalysis = useCallback((id: string | null) => setAnalysisSelection({ sentence: selected?.id ?? null, id }), [selected?.id]);
  // Viewing saved evidence is independent of consent to upload new recordings.
  // A history refresh must not replace a take the learner selected or just recorded.
  const restoreAnalysis = useCallback((id: string | null) => setAnalysisSelection(current =>
    current?.sentence === selected?.id ? current : { sentence: selected?.id ?? null, id }), [selected?.id]);
  const analysisAttempt = analysisSelection?.sentence === selected?.id ? analysisSelection?.id ?? null : null;
  const [referenceRevision,setReferenceRevision] = useState(0);
  const savedAnalysis = usePracticeAnalysis(persistence?.api, analysisAttempt, (persistence?.state.savedVersion??0)+referenceRevision);
  const saveCompleted = useCallback((clip: NonNullable<RecordingState["clip"]>) => {
    const context = takeContext.current;
    if (!context || !outbox) return;
    const take = clip.url;
    setSavedClip({url:take,id:null});
    setAnalysisSelection({ sentence: clip.sentenceId, id: null, take });
    outbox.enqueue({ content_id: contentId, sentence_id: clip.sentenceId,
      duration_ms: Math.max(1, Math.min(61000, Math.round(clip.durationMs))), playback_rate: context.rate,
      text_visible: context.textVisible }, clip.blob, context.retain, context.analyze ? { referenceId: context.referenceId, resolveReference:context.resolveReference } : undefined,
    id => { setSavedClip(current=>current?.url===take?{url:take,id}:current);
      setAnalysisSelection(current => current?.take === take ? { ...current, id } : current); });
  }, [contentId, outbox]);
  const pauseReference = useCallback(() => {
    window.dispatchEvent(new Event("libitu:practice-playback"));
    listeningIntent.current = false;
    cancelReferenceRef.current?.();
    playerRef.current?.pause();
  }, []);
  const recording = useSentenceRecording(selected?.id ?? null, pauseReference, saveCompleted);
  const { recorder, pauseReplay } = recording;
  const recordingUrl = recording.state.clip?.sentenceId === selected?.id ? recording.state.clip?.url ?? null : null;
  const userAnalysis = useAudioFeatures(recordingUrl);
  // A manually selected historical take must never inherit the current clip's measurements.
  const currentTakeSelected = !analysisAttempt || analysisSelection?.take === recordingUrl || (savedClip?.id===analysisAttempt && savedClip.url===recordingUrl);
  const workspaceUserAnalysis = currentTakeSelected ? userAnalysis : noLocalRecording;
  useAudioWordClock(recording.audioRef,recordingUrl,learnerClock,currentTakeSelected);
  const beforeCapture = useCallback(() => {
    window.dispatchEvent(new Event("libitu:practice-playback"));
    recorder.cancel(); pauseReplay();
  }, [recorder, pauseReplay]);
  const referenceRange = useMemo(() => selected ? { start: selected.startMs / 1000, end: selected.endMs / 1000 } : null,
    [selected]);
  const reference = useReferenceCapture(selected?.id ?? null, referenceRange, playerRef, beforeCapture);
  const referenceKey = selected ? buildReferenceKey(contentId, sourceUrl ?? "",
    selected.id, selected.startMs, selected.endMs) : null;
  const { releaseClip } = reference;
  const acceptReference = useCallback((clip: ReferenceClip) => releaseClip(clip), [releaseClip]);
  const referenceAnalysis = useReferenceAnalysis(referenceKey, reference.state.clip, acceptReference, sharedReferenceCache,
    selected ? { contentId, sentenceId: selected.id, text: selected.text, startMs: selected.startMs, endMs: selected.endMs } : undefined);
  const demanded = useMemo(() => sentences.slice(Math.max(0, selectedIndex), Math.max(0, selectedIndex) + 3), [sentences, selectedIndex]);
  const bufferedAnalysis = useBufferedAnalysis(contentId, sourceUrl ?? "", demanded,
    bufferPreparing ? undefined : activeBufferedReference ?? undefined, referenceAnalysis.cache);
  const { features, error: analysisError, pending: analysisPending, retry, canRetry } = referenceAnalysis;
  const referenceView = useMemo(() => ({ features, error: analysisError, pending: analysisPending, retry, canRetry }),
    [features, analysisError, analysisPending, retry, canRetry]);
  const referenceBusy = reference.isBusy() || bufferPreparing;
  const listRef = useRef<HTMLOListElement>(null);
  const [scope, setScope] = useState<"sentence" | "segment">("sentence");
  const [loop, setLoop] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState((selected?.startMs ?? segment.startMs ?? 0) / 1000);
  const [rates, setRates] = useState<number[]>([1]);
  const [rate, setRate] = useState(1);
  const cloud = useServerReference(persistence?.referenceApi, contentId, segment.id,
    selected, sentences[selectedIndex + 1] ?? null, scope, rate, loop);
  useEffect(()=>{if(cloud.reference?.state==='deleted')setReferenceRevision(v=>v+1);},[cloud.reference?.state]);
  const captured = useCapturedReference(contentId,segment.id,selected,referenceAnalysis.cache,activeBufferedReference,
    !cloud.available && Boolean(persistence?.analyzeReference));
  const soundGuide = useSoundGuide(contentId, selected?.id ?? null, selected?.text ?? null);
  const comparisonServer = cloud.available ? cloud.result : captured.row?.results.find(r=>r.sentence_id===selected?.id)??null;
  const comparison = useMemo(()=>comparisonView({sentence:selected,guide:soundGuide.data,data:savedAnalysis.data,
    server:comparisonServer,reference:referenceView.features,yours:workspaceUserAnalysis.features}),
    [selected,soundGuide.data,savedAnalysis.data,comparisonServer,referenceView.features,workspaceUserAnalysis.features]);
  useAudioWordClock(cloud.audioRef,cloud.audioUrl,wordClock,cloud.available,
    (scope==='sentence'?selected?.startMs??0:segment.startMs??0)/1000);
  const referencePlaying = cloud.available ? cloud.playing : playing;
  const effectiveRates = cloud.available ? [0.5, 0.75, 1, 1.25, 1.5, 2] : rates;
  const [layer, setLayer] = useState<PracticeLayer>("sound");
  const layerWorkspaceRef = useRef<HTMLDivElement>(null);
  const [textHidden, setTextHidden] = useState(false);
  const concealPrompt = layer === "sound" && textHidden;
  const activeScope = referenceBusy ? "sentence" : scope;
  const activeLoop = !referenceBusy && loop;
  const start = activeScope === "sentence" && selected ? selected.startMs : segment.startMs ?? 0;
  const end = activeScope === "sentence" && selected ? selected.endMs : segment.endMs ?? 0;
  const playable = Boolean(sourceUrl && end > start);
  const referenceEligible = Boolean(!cloud.available && !activeBufferedReference && selected && selected.endMs - selected.startMs <= 60_000 && scope === "sentence" && rate === 1);
  const initialStart = useRef(start);
  const playingSentence = referencePlaying ? sentenceAtTime(sentences, time * 1000) : null;
  const progress = Math.min(100, Math.max(0, (time * 1000 - start) / Math.max(1, end - start) * 100));
  const suspendBuffered = activeBufferedReference?.suspend;
  const cancelLegacyReference = reference.cancel;
  useEffect(() => {
    if (!cloud.available) return;
    playerRef.current?.pause();
    cancelLegacyReference();
    suspendBuffered?.();
    setBufferPreparing(false);
  }, [cloud.available, cancelLegacyReference, suspendBuffered]);


  function startRecording() {
    if (!outbox?.canRecord()) return;
    takeContext.current = { rate, textVisible: !concealPrompt, retain: retainRecording,
      analyze: persistence?.analyze ?? false, referenceId: cloud.available && cloud.reference?.state !== "deleted" ? cloud.reference?.id ?? null : null,
      resolveReference: cloud.available ? undefined : captured.freeze() };
    recording.start();
  }

  useEffect(() => {
    cancelReferenceRef.current = () => {
      cancelLegacyReference();
      suspendBuffered?.();
      setBufferPreparing(false);
    };
    return () => { cancelReferenceRef.current = null; };
  }, [cancelLegacyReference, suspendBuffered]);

  const bufferedCovered = Boolean(selected && activeBufferedReference?.covers({ start: selected.startMs / 1000, end: selected.endMs / 1000 }));
  useEffect(() => {
    if (!bufferPreparing) return;
    if (activeBufferedReference?.state.phase !== "enabled") {
      playerRef.current?.pause();
      suspendBuffered?.();
      setBufferPreparing(false);
      return;
    }
    const timer = setTimeout(() => {
      playerRef.current?.pause();
      suspendBuffered?.();
      setBufferPreparing(false);
    }, (selected ? selected.endMs - selected.startMs : 60_000) + 15_000);
    return () => clearTimeout(timer);
  }, [bufferPreparing, activeBufferedReference?.state.phase, suspendBuffered, selected]);

  useEffect(() => {
    function hide() { if (document.visibilityState === "hidden") listeningIntent.current = false; }
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);

  useEffect(() => {
    // One controller owns both scopes. Toggling repeat never starts playback.
    const player = playerRef.current;
    if (referenceBusy) return;
    player?.setRange(end > start ? { start: start / 1000, end: end / 1000, loop } : null);
  }, [start, end, loop, referenceBusy]);

  useEffect(() => {
    const player = playerRef.current;
    player?.seekTo(initialStart.current / 1000);
  }, []);

  useEffect(() => {
    replaceStageTwoLocation({ segmentId: segment.id, sentenceId: selected?.id });
  }, [segment.id, selected?.id]);

  useEffect(() => {
    const cached = Boolean(referenceKey && referenceAnalysis.has(referenceKey));
    reference.setReferenceReady(cached);
    const clip = reference.state.clip;
    if (!clip || !cached || completedReferences.current.has(clip)) return;
    completedReferences.current.add(clip);
    // Finalizing the first reference pauses the player. Continue the user's loop
    // once the analysis queue owns the bytes, with capture disabled by the cache.
    if (listeningIntent.current && loop && scope === "sentence" && selected
      && clip.sentenceId === selected.id && clip.rangeStart === selected.startMs / 1000
      && clip.rangeEnd === selected.endMs / 1000 && reference.state.sessionPhase === "enabled"
      && !recording.isBusy() && !recording.replaying && document.visibilityState !== "hidden") {
      playerRef.current?.setRange({ start: clip.rangeStart, end: clip.rangeEnd, loop: true });
      playerRef.current?.play();
    }
  }, [reference, referenceKey, referenceAnalysis, recording, loop, scope, selected]);

  function selectSentence(sentence: SentenceUnit) {
    cloud.pause();
    activeBufferedReference?.suspend();
    setBufferPreparing(false);
    setTextHidden(false);
    listeningIntent.current = false;
    reference.setEligible(false);
    reference.changeSentence(sentence.id, { start: sentence.startMs / 1000, end: sentence.endMs / 1000 });
    recording.changeSentence(sentence.id);
    // Cancel the old range immediately, before React commits the new selection.
    const player = playerRef.current;
    player?.pause();
    player?.setRange({ start: sentence.startMs / 1000, end: sentence.endMs / 1000, loop });
    player?.seekTo(sentence.startMs / 1000);
    setScope("sentence");
    setSelectedId(sentence.id);
    setTime(sentence.startMs / 1000);
    replaceStageTwoLocation({ segmentId: segment.id, sentenceId: sentence.id });
  }

  function focusLayer(next: PracticeLayer) {
    setLayer(next);
    requestAnimationFrame(() => layerWorkspaceRef.current?.scrollIntoView({ block: "start", behavior: "auto" }));
  }

  function changeScope(next: "sentence" | "segment") {
    cloud.pause();
    activeBufferedReference?.suspend();
    setBufferPreparing(false);
    listeningIntent.current = false;
    reference.setEligible(false);
    reference.cancel();
    recording.recorder.cancel();
    recording.pauseReplay();
    const nextStart = next === "sentence" && selected ? selected.startMs : segment.startMs ?? 0;
    const nextEnd = next === "sentence" && selected ? selected.endMs : segment.endMs ?? 0;
    const player = playerRef.current;
    player?.pause();
    player?.setRange({ start: nextStart / 1000, end: nextEnd / 1000, loop });
    player?.seekTo(nextStart / 1000);
    setScope(next);
    setTime(nextStart / 1000);
  }

  function navigate(offset: number) {
    const sentence = sentences[selectedIndex + offset];
    if (sentence) selectSentence(sentence);
  }

  function toggleLoop() {
    const next = !loop;
    playerRef.current?.setRange(end > start ? { start: start / 1000, end: end / 1000, loop: next } : null);
    setLoop(next);
  }

  function handleListKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1
      : event.key === "Home" ? 0 : event.key === "End" ? sentences.length - 1 : null;
    if (next === null || event.altKey || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    if (!sentences[next]) return;
    selectSentence(sentences[next]);
    listRef.current?.querySelectorAll("button")[next]?.focus();
  }

  function leave() {
    cloud.pause();
    listeningIntent.current = false;
    reference.clear();
    if (!sharedReferenceCache) referenceAnalysis.cache.clear();
    activeBufferedReference?.suspend();
    recording.clear();
    playerRef.current?.pause();
    playerRef.current?.setRange(null);
    onBack();
  }

  function handleReferencePlayback(next: boolean) {
    // Native iframe controls can bypass our Play button. Use the live recorder state.
    if (next && recording.isBusy()) {
      playerRef.current?.pause();
      return;
    }
    if (!next && previouslyPlaying.current && !reference.isBusy()) listeningIntent.current = false;
    previouslyPlaying.current = next;
    if (next) {
      window.dispatchEvent(new Event("libitu:practice-playback"));
      listeningIntent.current = true; recording.pauseReplay();
    }
    setPlaying(next);
  }

  function handleTelemetry(sample: YouTubeTelemetry) {
    if (cloud.available) return;
    if (activeBufferedReference) {
      const interrupted = recording.isBusy() || recording.replaying || sample.blockedByPausedSeek
        || document.visibilityState === "hidden";
      activeBufferedReference.sample(interrupted ? { ...sample, state: 2 } : sample, captureGeneration);
      if (bufferPreparing && selected && !interrupted && sample.rate === 1
        && sample.time >= selected.endMs / 1000 + 0.2) {
        playerRef.current?.pause();
        activeBufferedReference.suspend();
        referenceAnalysis.invalidate();
        setBufferPreparing(false);
      }
      return;
    }
    reference.setEligible(referenceEligible && !recording.isBusy() && !recording.replaying
      && document.visibilityState !== "hidden" && sample.rate === 1 && !sample.blockedByPausedSeek);
    reference.setReferenceReady(Boolean(referenceKey && referenceAnalysis.has(referenceKey)));
    reference.sample(sample);
  }

  function togglePlayback() {
    recording.pauseReplay();
    if (cloud.available) {
      playerRef.current?.pause();
      if (cloud.playing) cloud.pause(); else void cloud.play();
      return;
    }
    if (playing) { pauseReference(); return; }
    listeningIntent.current = true;
    const eligible = referenceEligible && !recording.isBusy() && document.visibilityState !== "hidden";
    reference.setEligible(eligible);
    // Listening again is also the retry path for an unusable or failed reference.
    if (eligible && reference.state.sessionPhase === "enabled"
      && (analysisError || features?.quality.status === "insufficient")) referenceAnalysis.invalidate();
    reference.setReferenceReady(Boolean(referenceKey && referenceAnalysis.has(referenceKey)));
    if (!reference.play()) playerRef.current?.play();
  }

  function prepareBufferedSentence() {
    if (!selected || !activeBufferedReference || activeBufferedReference.state.phase !== "enabled") return;
    beforeCapture();
    activeBufferedReference.suspend();
    bufferedAnalysis.retry();
    setBufferPreparing(true);
    playerRef.current?.setPlaybackRate(1);
    playerRef.current?.playRange(Math.max(0, selected.startMs / 1000 - 0.5), selected.endMs / 1000 + 0.3, { loop: false });
  }

  return (
    <section className="stage-two-shadow" aria-label="Stage 2 shadowing">
      <header className="stage-two-shadow-header">
        <div>
          <div className="section-label">Stage 2 · Shadow</div>
          <h1>{segment.title}</h1>
          <p>{title} · {clock(segment.startMs ?? 0)} – {clock(segment.endMs ?? 0)}</p>
        </div>
        {/* <LoadoutLink className="stage-two-shadow-back">Open loadout</LoadoutLink> */}
        <DirectionButton variant="secondary" className="stage-two-shadow-back" type="button" onClick={leave}>
          <ArrowLeft aria-hidden="true" /> Back to segments
        </DirectionButton>
      </header>
      <div className="stage-two-practice-layout">
        <nav className="stage-two-sentences" aria-label="Sentences in this segment">
          <PracticeLayerShortcuts active={layer} onChange={focusLayer} />
          <div className="stage-two-sentences-heading">
            <h2>Sentences</h2><span>{sentences.length} in this segment</span>
          </div>
          {sentences.length ? (
            <ol ref={listRef}>
              {sentences.map((sentence, index) => (
                <li key={sentence.id}>
                  <button type="button" aria-current={sentence.id === selected?.id ? "true" : undefined}
                    onClick={() => selectSentence(sentence)} onKeyDown={(event) => handleListKey(event, index)}
                    aria-label={`Sentence ${index + 1}: ${concealPrompt && sentence.id === selected?.id ? "Text hidden for practice" : sentence.text}`}>
                    <span className="stage-two-sentence-number">{index + 1}</span>
                    <span className="stage-two-sentence-copy">
                      <span>{concealPrompt && sentence.id === selected?.id ? "Text hidden for practice" : (
                        <CaptionTimedText text={sentence.text} sourceTokenStart={sentence.sourceTokenStart}
                          timingSource={sentence.timingSource} wordTimings={sentence.wordTimings} clock={wordClock} />
                      )}</span>
                      <small>~{clock(sentence.startMs)}
                        {sentence.id === playingSentence?.id ? <span className="stage-two-playing"><Play aria-hidden="true" /> Playing</span> : null}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ) : <p className="empty-state">Sentence text is unavailable for this segment. You can still play the segment.</p>}
        </nav>
        <div className="stage-two-practice-main">
          <div className="stage-two-sentence-navigation">
            <DirectionButton variant="secondary" type="button" aria-label="Previous sentence" disabled={selectedIndex <= 0} onClick={() => navigate(-1)}>
              <ChevronLeft aria-hidden="true" /> Previous
            </DirectionButton>
            <span role="status">{selected ? `Sentence ${selectedIndex + 1} of ${sentences.length}` : "Segment playback"}</span>
            <DirectionButton variant="secondary" type="button" aria-label="Next sentence" disabled={selectedIndex < 0 || selectedIndex >= sentences.length - 1} onClick={() => navigate(1)}>
              Next <ChevronRight aria-hidden="true" />
            </DirectionButton>
          </div>
          <div className="stage-two-sentence-focus">
            <span className="section-label">{selected ? `~${clock(selected.startMs)} – ${clock(selected.endMs)}` : "Listen to this segment"}</span>
            <p>{concealPrompt ? "Listen, then say this sentence aloud." : selected ? (
              <CaptionTimedText text={selected.text} sourceTokenStart={selected.sourceTokenStart}
                timingSource={selected.timingSource} wordTimings={selected.wordTimings} clock={wordClock} />
            ) : segment.sourceText ?? segment.summary}</p>
            <small>Sentence timings are approximate. Listen for the full phrase around each boundary.</small>
            {/* <WordTimingNotice rows={timingRows} concealed={concealPrompt} /> */}
            {timingRecovery}
          </div>
          <section className="stage-two-practice-media" aria-label="Listen and record">
            <div className="stage-two-practice-video">
              <div className="stage-two-shadow-player">
                <YouTubePlayer ref={playerRef} sourceUrl={sourceUrl ?? ""} title={title}
                  wordClock={cloud.available ? undefined : wordClock}
                  onTimeChange={(value) => {
                    if (!cloud.available || playing) setTime(value);
                    if (cloud.available && playing) wordClock.publish(value, true);
                  }} onPlaybackChange={handleReferencePlayback} onReady={setRates}
                  onPlaybackRateChange={(value) => { if (!cloud.available) setRate(value); }}
                  onTelemetry={handleTelemetry} />
              </div>
              <div className="stage-two-shadow-player-meta">
                <span>{clock(time * 1000)} / ~{clock(end)}</span>
                <span className="stage-two-shadow-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></span>
                <span>{activeLoop ? "Repeating" : "Play once"} · {activeScope === "sentence" && selected ? "sentence" : "segment"}</span>
              </div>
            </div>
            {cloud.available ? <audio ref={cloud.audioRef} src={cloud.audioUrl ?? undefined} preload="auto"
              onPause={() => cloud.setPlaying(false)}
              onEnded={() => cloud.setPlaying(false)}
              onTimeUpdate={event => {
                const absolute = (scope === "sentence" ? selected?.startMs ?? 0 : segment.startMs ?? 0) / 1000 + event.currentTarget.currentTime;
                setTime(absolute);
              }} /> : null}
            <div className="stage-two-operation-panel">
              <div className="stage-two-playback-controls stage-two-operation-bar" aria-label="Practice playback and recording controls">
                <div className="stage-two-operation-reference">
                  <span className="stage-two-operation-label">Reference</span>
                  <Button variant="soft" size="inherit" shape="pill" className="stage-two-play" type="button"
                    aria-label={referencePlaying ? "Pause" : scope === "segment" || !selected ? "Play segment" : "Play sentence"}
                    disabled={(cloud.available ? !cloud.audioUrl : !playable) || recording.isBusy() || (referenceBusy && !referencePlaying)} onClick={togglePlayback}>
                    {referencePlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                    {referencePlaying ? "Pause" : "Play reference"}
                  </Button>
                </div>
                <SentenceRecordingPanel compact recording={{ ...recording, start: startRecording }}
                  disabled={!outbox?.canRecord() || Boolean(captured.entry?.pending && !captured.row)} sentenceNumber={selected ? selectedIndex + 1 : null} />
                <div className="stage-two-operation-settings" aria-label="Playback settings">
                  <StageTwoSelect label="Range" ariaLabel="Playback range" value={selected ? activeScope : "segment"}
                    disabled={referenceBusy}
                    options={[{ value: "sentence", label: "Sentence", disabled: !selected }, { value: "segment", label: "Segment" }]}
                    onValueChange={(value) => changeScope(value as "sentence" | "segment")} />
                  <button type="button" className="stage-two-repeat" aria-pressed={activeLoop} disabled={referenceBusy} onClick={toggleLoop}>
                    <Repeat2 aria-hidden="true" /> Loop {activeLoop ? "on" : "off"}
                  </button>
                  <StageTwoSelect label="Speed" ariaLabel="Playback speed" value={String(rate)}
                    disabled={effectiveRates.length <= 1 || referenceBusy}
                    options={Array.from(new Set([...effectiveRates, rate])).sort((a, b) => a - b)
                      .map((value) => ({ value: String(value), label: `${value}×` }))}
                    onValueChange={(value) => cloud.available ? setRate(Number(value)) : playerRef.current?.setPlaybackRate(Number(value))} />
                </div>
              </div>
              <div className="stage-two-practice-audio">
                {cloud.available ? <ServerReferencePanel session={cloud} /> : activeBufferedReference ? <BufferedReferencePanel compact capture={activeBufferedReference} playable={playable && Boolean(selected)}>
                  <p role="status">{analysisPending ? "Analyzing this reference on your device…"
                    : features?.quality.status === "usable" ? "Reference ready for this sentence."
                      : features ? "This reference has insufficient usable speech. Listen again to prepare a new reference."
                        : bufferPreparing ? "Listening at 1× to prepare this sentence…"
                          : bufferedCovered ? "This sentence is available in the local audio buffer."
                            : "This sentence has not been fully captured. You can listen and record now, or prepare its reference."}</p>
                  {activeBufferedReference.state.phase === "enabled" && selected && selected.endMs - selected.startMs <= 60_000
                    && !bufferPreparing && !analysisPending && (!features || features.quality.status !== "usable" || analysisError
                      || (["error", "unreliable"].includes(referenceAnalysis.alignment.phase) && !referenceAnalysis.alignment.canRetry))
                    ? <Button variant="secondary" size="inherit" type="button" onClick={prepareBufferedSentence}>Prepare this sentence at 1×</Button> : null}
                  {bufferPreparing ? <Button variant="secondary" size="inherit" type="button" onClick={pauseReference}>Cancel preparation</Button> : null}
                  {analysisError || bufferedAnalysis.error ? <p role="alert">{analysisError ?? bufferedAnalysis.error}
                    <Button variant="secondary" size="inherit" type="button" onClick={() => { bufferedAnalysis.retry(); retry(); }}>Retry reference analysis</Button></p> : null}
                </BufferedReferencePanel> : <ReferenceAudioPanel compact capture={reference} playable={playable && Boolean(selected)} eligible={referenceEligible}
                  pending={analysisPending} features={features} analysisError={analysisError} />}
                {!cloud.available ? <div className="capture-analysis-status" aria-label="Browser reference analysis">
                  <p role="status">{captured.entry?.pending?'Preparing reference upload…':captured.row?.state==='completed'?'Reference analysis ready.':captured.row?.state==='queued'||captured.row?.state==='processing'?'Analyzing reference words and pitch…':captured.row?.state==='deleted'?'Reference deleted.':captured.row?.state==='partially_completed'?'Reference needs review; available measurements are shown.':captured.row?.state==='awaiting_upload'?'Reference upload incomplete. Keep this page open and retry.':captured.row?.state==='failed'||captured.row?.state==='cancelled'?'Reference analysis stopped. Retry analysis.':'Play the sentence to capture its reference audio.'}</p>
                  {captured.entry?.error?<p role="alert">{captured.entry.error}</p>:null}
                  {captured.entry?.error||captured.row&&['failed','cancelled','partially_completed','awaiting_upload'].includes(captured.row.state)?<Button variant="secondary" size="inherit" onClick={captured.retry}>Retry reference analysis</Button>:null}
                  {captured.row?.state==='deleted'?<Button variant="secondary" size="inherit" onClick={captured.retry}>Prepare a new reference</Button>:null}
                  {captured.row&&captured.row.state!=='deleted'?<Button variant="danger-outline" size="sm" onClick={()=>void captured.remove()?.then(()=>setReferenceRevision(v=>v+1))}>Delete captured reference</Button>:null}
                </div>:null}
              </div>
              <div className="stage-two-operation-footer">
                <details className="stage-two-audio-settings">
                  <summary><Info aria-hidden="true" size={16} />Audio settings</summary>
                  <div className="stage-two-audio-settings-content">
                    {!cloud.available ? <div className="stage-two-audio-preference">
                      <label className="practice-retention"><input type="checkbox" checked={persistence?.analyzeReference??false}
                        onChange={event=>persistence?.setAnalyzeReference(event.target.checked)}/>Analyze captured reference audio on the server</label>
                      <p>Uploads the captured sentence for word and pitch analysis. Private reference audio is kept for up to 30 days or until deleted.</p>
                    </div> : null}
                    <div className="stage-two-audio-preference">
                      <label className="practice-retention">
                        <input type="checkbox" checked={persistence?.analyze ?? false} disabled={recording.isBusy()}
                          onChange={(event) => persistence?.setAnalyze(event.target.checked)} />
                        Analyze new recordings on the server
                      </label>
                      <p>Uploads your voice for content checking and word timing/pitch comparison. Results stay with your practice record; analysis audio is removed after processing, or expires after 24 hours. This choice is remembered for your account on this browser.</p>
                    </div>
                    <div className="stage-two-audio-preference">
                      <label className="practice-retention">
                        <input type="checkbox" checked={retainRecording} disabled={recording.isBusy()}
                          onChange={(event) => setRetainRecording(event.target.checked)} />
                        Keep new recordings in my account for later playback
                      </label>
                      <p>Completed takes save a practice record automatically. Checked recordings are uploaded privately and kept until you delete them. No model training or human review.</p>
                    </div>
                  </div>
                </details>
                <p className="stage-two-practice-hint">Listen to the reference, then record and replay your take.</p>
                <details className="stage-two-operation-help">
                  <summary>How It Works</summary>
                  <p>{cloud.available ? "This permitted file reference is prepared on the server and reused across sentences. Microphone access still starts with Record." : "Reference audio is prepared locally during continuous 1× listening. Seeking, buffering, or changing speed may leave a gap."}</p>
                  {!cloud.available ? <p>Browser reference audio can be uploaded for server word timing and pitch analysis. Reference audio is kept privately for up to 30 days for repeat practice, or until you delete it. Local timing and pitch previews remain available while server analysis runs.</p> : null}
                  <p>Unsaved audio stays on this page. Keep the page open while saving, and retry any failed saves before leaving. Saved takes are available below after a refresh.</p>
                </details>
              </div>
            </div>
          </section>
          <div ref={layerWorkspaceRef}>
            <PracticeAnalysisPanel key={analysisAttempt ?? "none"} api={persistence?.api} attemptId={analysisAttempt} {...savedAnalysis} />
            {soundGuide.error ? <p role="alert">{soundGuide.error} <Button variant="secondary" size="inherit" onClick={soundGuide.retry}>Retry sound guide</Button></p> : null}
            {workspaceUserAnalysis.error ? <p role="alert">{workspaceUserAnalysis.error} <Button variant="secondary" size="inherit" onClick={workspaceUserAnalysis.retry}>Retry analysis</Button></p> : null}
            <PracticeLayers active={layer} onChange={setLayer}
              sound={<LayerComparison key={`${selected?.id}:${analysisAttempt}:sound`} layer="sound" view={comparison} concealed={concealPrompt} onConcealedChange={setTextHidden}/>}
              rhythm={<LayerComparison key={`${selected?.id}:${analysisAttempt}:rhythm`} layer="rhythm" view={comparison}/>}
              melody={<LayerComparison key={`${selected?.id}:${analysisAttempt}:melody`} layer="melody" view={comparison}
                playback={{reference:wordClock,yours:learnerClock,referenceOffsetMs:selected?.startMs??0}}/>}/>

          </div>
          <PracticeHistory key={selected?.id ?? "none"} contentId={contentId} sentenceId={selected?.id ?? null}
            onAnalysisSelect={selectAnalysis} onAnalysisRestore={restoreAnalysis} selectedAnalysisId={analysisAttempt} playbackClock={learnerClock}
            blocked={recording.isBusy() || referenceBusy}
            onPlay={() => {
              listeningIntent.current = false;
              cancelReferenceRef.current?.();
              playerRef.current?.pause();
              recording.pauseReplay();
              cloud.pause();
            }} />
        </div>
      </div>
    </section>
  );
}

function clock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:` : ""}${hours ? String(minutes).padStart(2, "0") : minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
