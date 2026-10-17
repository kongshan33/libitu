"use client";
import { ProgressiveComparison } from "./ProgressiveComparison";

import { DirectionButton } from "@/components/ui/direction-button";

import { Button } from "@/components/ui/button";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Info, Pause, Play } from "lucide-react";
import type { StageOneSegment, TranscriptLine } from "@libitu/types/stage-one";
import type { SentenceUnit } from "@libitu/types/stage-two";
import { WorkspacePlayer } from "../../learning-workspace/MediaHost";
import { type YouTubePlayerHandle, type YouTubeTelemetry } from "../../stage-one/components/YouTubePlayer";
import { buildSentenceUnits } from "../sentences";
import { readStageTwoLocation, replaceStageTwoLocation } from "../location";
import { useCurrentLocation } from "../../navigation/use-current-location";
import { useSentenceRecording } from "../recording/use-sentence-recording";
import { SentenceRecordingPanel } from "./SentenceRecordingPanel";
import { PracticeSettings } from "./PracticeSettings";
import { referencePhase as resolveReferencePhase } from "../practice/reference-phase";
import { recordingReference } from '../practice/recording-reference';
import { referenceStatus } from '../practice/reference-status';
import { type AudioAnalysisView } from "./AcousticComparisonPanel";
import { useReferenceAnalysis } from "../analysis/use-reference-analysis";
import { buildReferenceKey } from "../analysis/reference-analysis-cache";

import { useSoundGuide } from "../sound/use-sound-guide";
import { PracticeLayers, type PracticeLayer } from "./PracticeLayers";
import { PracticePrompt } from './PracticePrompt';
import { PracticeOutcome } from './PracticeOutcome';
import { PracticeLayerState } from './PracticeLayerState';
import { practiceTokens, visiblePositions, supportSnapshot, nextPracticeIndex } from '../practice/flow';
import { layerPresentation } from '../practice/layer-presentation';
import type { PracticeApi, TextSupport } from '../persistence/practice-api';
import styles from './StageTwoPractice.module.css';
import { CaptionWordClock } from "../../playback/caption-word-clock";
import { useBufferedReferenceContext } from "../reference/use-buffered-reference";
import type { ReferenceAnalysisCache } from "../analysis/reference-analysis-cache";
import { useBufferedAnalysis } from "../analysis/use-buffered-analysis";
import { BufferedReferencePanel } from "./BufferedReferencePanel";
import { usePracticePersistence } from "../persistence/PracticePersistence";
import { PracticeHistory } from "../persistence/PracticeHistory";
import { usePracticeProgress } from "../persistence/use-practice-progress";
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
  sharedReferenceCache: ReferenceAnalysisCache;
  captureGeneration?: number;
  onBack(): void;
};

const noLocalRecording: AudioAnalysisView = { features: null, pending: false, error: null, retry() {} };
type TakeSelections = Record<string, { id: string | null; take?: string }>;

export function StageTwoShadowing({ contentId, segment, sourceUrl, title, transcript, onBack, timingRecovery,
  sharedReferenceCache, captureGeneration = 1 }: Props) {
  const sentences = useMemo(() => buildSentenceUnits(contentId, segment, transcript), [contentId, segment, transcript]);
  const [skipShort,setSkipShort]=useState(true);
  const [directoryCollapsed, setDirectoryCollapsed] = useState(false);
  const directoryId = useId();
  const activeBufferedReference = useBufferedReferenceContext();
  const href = useCurrentLocation();
  const location = readStageTwoLocation(new URL(href, "https://libitu.invalid"));
  const selectedId = location?.segmentId === segment.id ? location.sentenceId : null;
  const selected = sentences.find((sentence) => sentence.id === selectedId) ?? sentences.find(sentence=>!skipShort||practiceTokens(sentence.text).length>=4) ?? null;
  const selectedIndex = selected ? sentences.indexOf(selected) : -1;
  const previousIndex=nextPracticeIndex(sentences,selectedIndex,-1,skipShort);
  const nextIndex=nextPracticeIndex(sentences,selectedIndex,1,skipShort);
  const playerRef = useRef<YouTubePlayerHandle>(null);
  const [bufferPreparing, setBufferPreparing] = useState(false);
  const [wordClock] = useState(() => new CaptionWordClock());
  const [learnerClock] = useState(() => new CaptionWordClock());
  const [savedClip,setSavedClip] = useState<{url:string;id:string|null;analyze:boolean}|null>(null);
  const [practice,setPractice] = useState<{sentence:string|null;mode:TextSupport['mode'];revealed:number[];reviewing:boolean}>({sentence:selected?.id??null,mode:'hidden',revealed:[],reviewing:false});
  const supportMode=practice.mode;
  const revealed=practice.sentence===selected?.id?practice.revealed:[];
  const reviewing=practice.sentence===selected?.id&&practice.reviewing;
  const [videoPreference,setVideoPreference]=useState<boolean|null>(null);
  const progressState = usePracticeProgress(contentId);
  const markPracticeSaved = progressState.markSaved;
  const cancelReferenceRef = useRef<(() => void) | null>(null);
  const persistence = usePracticePersistence();
  const outbox = persistence?.outbox;
  const [retainRecording, setRetainRecording] = useState(false);
  const takeContext = useRef<{ rate: number; textVisible: boolean; textSupport:TextSupport; retain: boolean; analyze: boolean; referenceId: string | null; resolveReference?:()=>Promise<string|null> } | null>(null);
  const api = persistence?.api;
  const [selectionState, setSelectionState] = useState<{ api: PracticeApi | undefined; content: string; items: TakeSelections } | null>(null);
  const analysisSelections = useMemo(() => selectionState?.api === api && selectionState?.content === contentId
    ? selectionState.items : {}, [selectionState, api, contentId]);
  const setAnalysisSelections = useCallback((update: (current: TakeSelections) => TakeSelections) => {
    setSelectionState(current => ({ api, content: contentId,
      items: update(current && current.api === api && current.content === contentId ? current.items : {}) }));
  }, [api, contentId]);
  const analysisSelection = selected ? analysisSelections[selected.id] : undefined;
  const analysisAttempt = analysisSelection?.id ?? null;
  const [referenceRevision,setReferenceRevision] = useState(0);
  const savedAnalysis = usePracticeAnalysis(persistence?.api, analysisAttempt, (persistence?.state.savedVersion??0)+referenceRevision);
  const reloadProgress = progressState.reload;
  const checkedWords = savedAnalysis.data?.word_check;
  useEffect(() => { reloadProgress(); }, [reloadProgress, savedAnalysis.data?.id, savedAnalysis.data?.state,
    checkedWords?.status, checkedWords?.matched_count, checkedWords?.source_count]);
  const saveCompleted = useCallback((clip: NonNullable<RecordingState["clip"]>) => {
    const context = takeContext.current;
    if (!context || !outbox) return;
    const take = clip.url;
    setSavedClip({url:take,id:null,analyze:context.analyze});
    setPractice(current=>current.sentence===clip.sentenceId?{...current,reviewing:true,revealed:[]}:current);
    setAnalysisSelections(current => ({ ...current, [clip.sentenceId]: { id: null, take } }));
    outbox.enqueue({ content_id: contentId, sentence_id: clip.sentenceId,
      duration_ms: Math.max(1, Math.min(61000, Math.round(clip.durationMs))), playback_rate: context.rate,
      text_visible: context.textVisible, text_support:context.textSupport }, clip.blob, context.retain, context.analyze ? { referenceId: context.referenceId, resolveReference:context.resolveReference } : undefined,
    id => { setSavedClip(current=>current?.url===take?{...current,id}:current);
      markPracticeSaved(clip.sentenceId);
      setAnalysisSelections(current => current[clip.sentenceId]?.take === take
        ? { ...current, [clip.sentenceId]: { ...current[clip.sentenceId], id } } : current); });
  }, [contentId, outbox, markPracticeSaved, setAnalysisSelections]);
  const pauseReference = useCallback(() => {
    window.dispatchEvent(new Event("libitu:practice-playback"));
    cancelReferenceRef.current?.();
    playerRef.current?.pause();
  }, []);
  const recording = useSentenceRecording(selected?.id ?? null, pauseReference, saveCompleted);
  const { recorder, pauseReplay } = recording;
  const selectAnalysis = useCallback((id: string | null) => {
    pauseReplay();
    if (selected) setAnalysisSelections(current => ({ ...current, [selected.id]: { id } }));
    setPractice(current=>({...current,sentence:selected?.id??null,reviewing:Boolean(id),revealed:[]}));
    setLayer('sound');
  }, [selected,pauseReplay,setAnalysisSelections]);
  const restoreAnalysis = useCallback((latest: string | null, availableIds: string[]) => {
    if (!selected) return;
    const previous = analysisSelections[selected.id];
    const pending = Boolean(previous?.take && !previous.id);
    const id = previous?.id && availableIds.includes(previous.id) ? previous.id : latest;
    if (!pending) setAnalysisSelections(current => ({ ...current, [selected.id]:
      current[selected.id]?.take && !current[selected.id].id ? current[selected.id] :
      current[selected.id]?.id && availableIds.includes(current[selected.id].id!) ? current[selected.id] : { id } }));
    if (!recording.isBusy()) setPractice(current => ({ ...current, sentence: selected.id,
      revealed: current.sentence === selected.id ? current.revealed : [], reviewing: pending || Boolean(id) }));
  }, [selected,analysisSelections,recording,setAnalysisSelections]);

  const recordingUrl = recording.state.clip?.sentenceId === selected?.id ? recording.state.clip?.url ?? null : null;
  // A manually selected historical take must never inherit the current clip's measurements.
  const currentTakeSelected = !analysisAttempt || analysisSelection?.take === recordingUrl || (savedClip?.id===analysisAttempt && savedClip.url===recordingUrl);
  const workspaceUserAnalysis = noLocalRecording;
  useAudioWordClock(recording.audioRef,recordingUrl,learnerClock,currentTakeSelected);
  const beforeCapture = useCallback(() => {
    window.dispatchEvent(new Event("libitu:practice-playback"));
    recorder.cancel(); pauseReplay();
  }, [recorder, pauseReplay]);
  const referenceKey = selected ? buildReferenceKey(contentId, sourceUrl ?? "",
    selected.id, selected.startMs, selected.endMs) : null;
  const referenceAnalysis = useReferenceAnalysis(referenceKey, sharedReferenceCache);
  const demanded = useMemo(() => sentences.slice(Math.max(0, selectedIndex), Math.max(0, selectedIndex) + 3), [sentences, selectedIndex]);
  const bufferedAnalysis = useBufferedAnalysis(contentId, sourceUrl ?? "", demanded,
    bufferPreparing ? undefined : activeBufferedReference ?? undefined, referenceAnalysis.cache);
  const { features, error: analysisError, pending: analysisPending, retry, canRetry } = referenceAnalysis;
  const referenceView = useMemo(() => ({ features, error: analysisError, pending: analysisPending, retry, canRetry }),
    [features, analysisError, analysisPending, retry, canRetry]);
  const referenceBusy = bufferPreparing;
  const listRef = useRef<HTMLOListElement>(null);
  const [scope, setScope] = useState<"sentence" | "segment">("sentence");
  const [loop, setLoop] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState((selected?.startMs ?? segment.startMs ?? 0) / 1000);
  const [rates, setRates] = useState<number[]>([1]);
  const [rate, setRate] = useState(1);
  const cloud = useServerReference(persistence?.referenceApi, contentId, segment.id,
    selected, sentences[selectedIndex + 1] ?? null, scope, rate, loop, Boolean(persistence?.analyze));
  useEffect(()=>{if(cloud.reference?.state==='deleted')setReferenceRevision(v=>v+1);},[cloud.reference?.state]);
  const captured = useCapturedReference(contentId,segment.id,selected,referenceAnalysis.cache,activeBufferedReference,
    !cloud.available && !cloud.checking && Boolean(persistence?.analyze));
  const recordingReferenceRow = cloud.available ? cloud.reference : captured.row;
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
  const reviewKey = `${selected?.id}:${analysisAttempt}`;
  const [soundVisibility, setSoundVisibility] = useState<{key:string;hidden:boolean}|null>(null);
  const soundConcealed = soundVisibility?.key === reviewKey && soundVisibility.hidden;
  const practiceBusy=recording.isBusy();
  const analysisPresentation=layerPresentation(savedAnalysis.data,reviewing,practiceBusy);
  const locks=analysisPresentation.locked;
  const activeLayer=locks[layer]?'sound':layer;
  const collapseDirectory = directoryCollapsed || practiceBusy;
  const sourceTokens=useMemo(()=>practiceTokens(selected?.text??''),[selected?.text]);
  const visible=visiblePositions(sourceTokens,supportMode,revealed);
  const videoVisible=referenceBusy||(!cloud.available&&referencePlaying)||(videoPreference??(!reviewing&&!features));
  const activeScope = referenceBusy ? "sentence" : scope;
  const activeLoop = !referenceBusy && loop;
  const start = activeScope === "sentence" && selected ? selected.startMs : segment.startMs ?? 0;
  const end = activeScope === "sentence" && selected ? selected.endMs : segment.endMs ?? 0;
  const playable = Boolean(sourceUrl && end > start);
  const initialStart = useRef(start);
  const progress = Math.min(100, Math.max(0, (time * 1000 - start) / Math.max(1, end - start) * 100));
  const suspendBuffered = activeBufferedReference?.suspend;
  useEffect(() => {
    if (!cloud.available) return;
    playerRef.current?.pause();
    suspendBuffered?.();
    setBufferPreparing(false);
  }, [cloud.available, suspendBuffered]);


  function startRecording() {
    if (!outbox?.canRecord()) return;
    if (!selected||recording.isBusy()||referenceBusy)return;
    // Freeze an eligible optional Reference; learner analysis can run independently.
    const reference = recordingReference(recordingReferenceRow, contentId, segment.id, selected);
    const snapshot=supportSnapshot(supportMode,visible,revealed);
    takeContext.current = { rate, textVisible: Boolean(visible.length), textSupport:snapshot, retain: retainRecording,
      analyze: persistence?.analyze ?? false, referenceId: reference?.id ?? null };
    setPractice(current=>({...current,sentence:selected.id,reviewing:false}));
    setLayer('sound');
    recording.start();
  }

  function revealWord(index:number) {
    if(!selected||recording.state.phase==='stopping')return;
    setPractice(current=>({...current,sentence:selected.id,revealed:[...new Set([...revealed,index])]}));
    if(recording.isBusy()&&takeContext.current) {
      takeContext.current.textSupport.revealed_source_indices=[...new Set([...takeContext.current.textSupport.revealed_source_indices,index])];
    }
  }
  function setSupport(mode:TextSupport['mode']) {
    if(recording.isBusy())return;
    setPractice(current=>({...current,sentence:selected?.id??null,mode,revealed:[]}));
  }


  useEffect(() => {
    cancelReferenceRef.current = () => {
      suspendBuffered?.();
      setBufferPreparing(false);
    };
    return () => { cancelReferenceRef.current = null; };
  }, [suspendBuffered]);

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

  function selectSentence(sentence: SentenceUnit) {
    cloud.pause();
    activeBufferedReference?.suspend();
    setBufferPreparing(false);
    setPractice(current=>({...current,sentence:sentence.id,revealed:[],reviewing:Boolean(analysisSelections[sentence.id]?.id)}));
    setLayer('sound');setVideoPreference(null);
    recording.changeSentence(sentence.id);
    // Cancel the old range immediately, before React commits the new selection.
    const player = playerRef.current;
    player?.pause();
    player?.setRange({ start: sentence.startMs / 1000, end: sentence.endMs / 1000, loop });
    player?.seekTo(sentence.startMs / 1000);
    setScope("sentence");
    setTime(sentence.startMs / 1000);
    replaceStageTwoLocation({ segmentId: segment.id, sentenceId: sentence.id });
  }

  function changeScope(next: "sentence" | "segment") {
    cloud.pause();
    activeBufferedReference?.suspend();
    setBufferPreparing(false);
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
    const next=nextPracticeIndex(sentences,selectedIndex,offset,skipShort);
    const sentence=next===null?null:sentences[next];
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
    if (next) {
      window.dispatchEvent(new Event("libitu:practice-playback"));
      recording.pauseReplay();
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

  }

  const shortcuts=useRef<{listen():void;record():void;stop():void}|null>(null);
  useEffect(()=>{shortcuts.current={listen:()=>{if(!recording.isBusy()&&playable)togglePlayback();},record:startRecording,
    stop:()=>{if(recording.recorder.getSnapshot().phase==='recording')recording.recorder.stop();}};});
  useEffect(()=>{
    function key(event:globalThis.KeyboardEvent) {
      if(event.ctrlKey||event.altKey||event.metaKey||event.isComposing||(event.target instanceof Element&&event.target.closest('input,textarea,select,button,summary,[contenteditable="true"],[role="combobox"]')))return;
      if(event.code==='Space'){event.preventDefault();shortcuts.current?.listen();}
      if(event.key.toLowerCase()==='r'){event.preventDefault();if(recorder.getSnapshot().phase==='recording')shortcuts.current?.stop();else shortcuts.current?.record();}
    }
    document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);
  },[recorder]);

  function togglePlayback() {
    recording.pauseReplay();
    if (cloud.available) {
      playerRef.current?.pause();
      if (cloud.playing) cloud.pause(); else void cloud.play();
      return;
    }
    if (playing) { pauseReference(); return; }
    playerRef.current?.play();
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

  // Restore persisted Reference silently; practice progress describes Takes, not Reference availability.
  const restoringReference = Boolean(persistence && (!captured.entry || captured.entry.restoring));
  const uploadingReference = Boolean(captured.entry?.pending && !restoringReference);
  const referencePhase = resolveReferencePhase({ preparing: bufferPreparing, uploading: uploadingReference,
    serverState: captured.row?.state, serverError: Boolean(captured.entry?.error), localPending: analysisPending,
    localError: Boolean(analysisError || bufferedAnalysis.error), localUsable: !persistence?.analyze && features?.quality.status === 'usable' });
  const serverReferenceStatus = referenceStatus(recordingReferenceRow, selected?.id);
  const referencePresentation = {
    phase: bufferPreparing ? 'preparing' as const : restoringReference ? 'idle' as const : uploadingReference ? 'analyzing' as const : captured.entry?.error ? 'review' as const : serverReferenceStatus?.phase ?? referencePhase,
    title: bufferPreparing ? 'Preparing this sentence…' : restoringReference ? 'Reference audio' : uploadingReference ? 'Uploading reference audio…'
      : captured.entry?.error ? 'Reference update interrupted' : serverReferenceStatus?.title
        ?? (referencePhase==='ready' ? 'Reference audio ready' : referencePhase==='analyzing' ? 'Analyzing local reference audio…'
          : referencePhase==='review' ? 'Local reference analysis incomplete' : 'This sentence has not been prepared'),
    description: bufferPreparing ? 'Playing this sentence at 1× to prepare its reference. Keep this tab open.'
      : restoringReference ? 'Original audio enables comparison with your recording.'
      : uploadingReference ? 'Uploading the original audio for analysis.' : captured.entry?.error ? captured.entry.error
        : serverReferenceStatus?.description ?? (referencePhase==='ready' ? 'Reference ready for this sentence.'
          : bufferedCovered ? 'This sentence is available in the local audio buffer.' : 'Prepare the original audio before recording for comparison.'),
  };

  return (
    <section className={`stage-two-shadow ${styles.workspace}`} aria-label="Stage 2 shadowing">
      <header className="stage-two-shadow-header">
        <div>
          <div className="section-label">Stage 2 · Shadow</div>
          <h1>{segment.title}</h1>
          <p>{title} · {clock(segment.startMs ?? 0)} – {clock(segment.endMs ?? 0)}</p>
        </div>
        <DirectionButton variant="secondary" className="stage-two-shadow-back" type="button" onClick={leave}>
          <ArrowLeft aria-hidden="true" /> Back to segments
        </DirectionButton>
      </header>
      <div className="stage-two-practice-layout" data-directory-collapsed={collapseDirectory}>
        <nav className="stage-two-sentences" aria-label="Sentences in this segment">

          <div className="stage-two-sentences-heading">
            <div className="shadow-directory-title"><h2>Sentences</h2>
              <button className="shadow-directory-toggle" type="button" disabled={practiceBusy} aria-label={collapseDirectory ? "Expand sentence list" : "Collapse sentence list"}
                aria-expanded={!collapseDirectory} aria-controls={directoryId} onClick={() => setDirectoryCollapsed(value => !value)}>
                {collapseDirectory ? <ChevronsRight size={14} aria-hidden="true" /> : <ChevronsLeft size={14} aria-hidden="true" />}
              </button>
            </div>
            <span className="shadow-directory-total">{sentences.length} in this segment</span>
            <div className="shadow-directory-position" aria-hidden="true">{selected ? selectedIndex + 1 : '—'}<span>of {sentences.length}</span></div>
            <label className="shadow-skip-short"><input type="checkbox" checked={skipShort} onChange={event=>setSkipShort(event.target.checked)}/>Skip sentences under 4 words</label>
          </div>
          {progressState.loading ? <p role="status">Restoring practice progress…</p> : null}
          {progressState.error ? <p role="alert">Practice progress could not load. <Button size="sm" variant="secondary" onClick={progressState.reload}>Retry progress</Button></p> : null}
          {sentences.length ? (
            <ol ref={listRef} id={directoryId}>
              {sentences.map((sentence, index) => {
                const best = progressState.best[sentence.id];
                const practiced = progressState.ids.has(sentence.id);
                const passed = best ? best.matched_count * 100 >= best.source_count * 85 : false;
                const percent = best ? Math.floor(best.matched_count * 1000 / best.source_count) / 10 : null;
                const status = `${practiced ? 'Practiced' : 'Not practiced'}${best ? ` · ${passed ? 'Passed' : 'Not passed'} · Best ${percent}% words` : practiced ? ' · Not checked' : ''}`;
                return (
                <li key={sentence.id}>
                  <button type="button" aria-current={sentence.id === selected?.id ? "true" : undefined}
                    onClick={() => selectSentence(sentence)} onKeyDown={(event) => handleListKey(event, index)}
                    aria-label={`Sentence ${index+1}`} title={`Sentence ${index+1} · ${status}`}
                    data-practiced={practiced} data-passed={passed} data-short={skipShort && practiceTokens(sentence.text).length < 4}>
                    <span className="stage-two-sentence-number">{index+1}</span>
                    <span className="stage-two-sentence-copy">
                      <small className="shadow-directory-status" data-passed={passed}>{status}</small>
                      <span className="shadow-directory-text">{sentence.text}</span>
                      <small>~{clock(sentence.startMs)} – {clock(sentence.endMs)}</small>
                    </span>
                  </button>
                </li>
              );})}
            </ol>
          ) : <p className="empty-state">Sentence text is unavailable for this segment. You can still play the segment.</p>}
        </nav>
        <div className="stage-two-practice-main">
          <div className="stage-two-sentence-navigation">
            <DirectionButton variant="secondary" type="button" aria-label="Previous sentence" disabled={previousIndex===null} onClick={() => navigate(-1)}>
              <ChevronLeft aria-hidden="true" /> Previous
            </DirectionButton>
            <span role="status">{selected ? `Sentence ${selectedIndex + 1} of ${sentences.length}` : "Segment playback"}</span>
            <DirectionButton variant="secondary" type="button" aria-label="Next sentence" disabled={selectedIndex<0||nextIndex===null} onClick={() => navigate(1)}>
              Next <ChevronRight aria-hidden="true" />
            </DirectionButton>
          </div>
          <section className="stage-two-practice-media" aria-label="Listen and record">
            <div className="shadow-video-disclosure"><span>Video · ~{clock(selected?.startMs??start)} – {clock(selected?.endMs??end)}</span>
              <Button variant="ghost" size="sm" disabled={referenceBusy||(!cloud.available&&referencePlaying)} onClick={()=>setVideoPreference(!videoVisible)}>{videoVisible?'Hide video':'Show video'}</Button></div>
            <div className="stage-two-practice-video" hidden={!videoVisible}>
              <div className="stage-two-shadow-player">
                <WorkspacePlayer ref={playerRef} sourceUrl={sourceUrl ?? ""} title={title}
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
              <div className="stage-two-practice-audio">
                {cloud.available ? <ServerReferencePanel session={cloud} sentenceId={selected?.id} analysisEnabled={Boolean(persistence?.analyze)} /> : activeBufferedReference ? <BufferedReferencePanel compact presentation={referencePresentation} capture={activeBufferedReference} playable={playable && Boolean(selected)}>
                  {activeBufferedReference.state.phase === "enabled" && selected && selected.endMs - selected.startMs <= 60_000
                    && !bufferPreparing && !analysisPending && (!features || features.quality.status !== "usable" || analysisError
                      || (["error", "unreliable"].includes(referenceAnalysis.alignment.phase) && !referenceAnalysis.alignment.canRetry))
                    ? <Button variant="primary" size="sm" type="button" onClick={prepareBufferedSentence}>Prepare this sentence at 1×</Button> : null}
                  {bufferPreparing ? <Button variant="secondary" size="inherit" type="button" onClick={pauseReference}>Cancel preparation</Button> : null}
                  {analysisError || bufferedAnalysis.error ? <p role="alert">{analysisError ?? bufferedAnalysis.error}
                    <Button variant="secondary" size="inherit" type="button" onClick={() => { bufferedAnalysis.retry(); retry(); }}>Retry reference analysis</Button></p> : null}
                {!cloud.available ? <div className="capture-analysis-status" aria-label="Browser reference analysis">
                  {captured.entry?.error?<p role="alert">{captured.entry.error}</p>:null}
                  {persistence?.analyze&&(captured.entry?.error||captured.row&&['failed','cancelled','partially_completed','awaiting_upload'].includes(captured.row.state))?<Button variant="secondary" size="inherit" onClick={captured.retry}>{serverReferenceStatus?.action ?? "Retry reference analysis"}</Button>:null}
                  {captured.row?.state==='deleted'?<Button variant="secondary" size="inherit" onClick={captured.retry}>Prepare a new reference</Button>:null}
                  {captured.row&&captured.row.state!=='deleted'?<Button variant="danger-outline" size="sm" onClick={()=>void captured.remove()?.then(()=>setReferenceRevision(v=>v+1))}>Delete captured reference</Button>:null}
                </div>:null}
                </BufferedReferencePanel> : null}

              </div>
              <div className="stage-two-operation-footer">
                <details className="stage-two-audio-settings">
                  <summary><Info aria-hidden="true" size={16} />Audio settings</summary>
                  <div className="stage-two-audio-settings-content">
                    <div className="stage-two-audio-preference">
                      <label className="practice-retention">
                        <input type="checkbox" checked={persistence?.analyze ?? false} disabled={recording.isBusy()}
                          onChange={(event) => persistence?.setAnalyze(event.target.checked)} />
                        Server analysis
                      </label>
                      <p>Uploads new recordings privately for analysis. Preparing Reference audio is optional and enables comparison. Reference audio is kept for up to 30 days; recording analysis audio is removed after processing or within 24 hours. Turning this off stops new analysis; submitted tasks and saved results remain. This choice is remembered for your account on this browser.</p>
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
                <details className="stage-two-operation-help">
                  <summary>How It Works</summary>
                  <p>{cloud.available ? "This permitted file reference is prepared on the server and reused across sentences. Microphone access still starts with Record." : "Reference audio is prepared locally during continuous 1× listening. Seeking, buffering, or changing speed may leave a gap."}</p>
                  {!cloud.available ? <p>Browser reference audio can be uploaded for server word timing and pitch analysis. Reference audio is kept privately for up to 30 days for repeat practice, or until you delete it. Local timing and pitch previews remain available while server analysis runs.</p> : null}
                  <p>Unsaved audio stays on this page. Keep the page open while saving, and retry any failed saves before leaving. Saved takes are available below after a refresh.</p>
                </details>
              </div>
            </div>
          </section>
          <section className="shadow-practice-flow" aria-label="Sentence practice">
            {selected?reviewing&&!practiceBusy?<PracticeOutcome key={analysisAttempt??analysisSelection?.take??'pending'} data={savedAnalysis.data} loading={savedAnalysis.loading}
              pendingSave={Boolean(analysisSelection?.take&&!analysisAttempt&&!persistence?.state.errors.some(error=>error.sentenceId===selected.id))} requested={savedClip?.analyze??Boolean(persistence?.analyze)} text={selected.text}
              api={persistence?.api} takeId={analysisAttempt} onMarked={savedAnalysis.reload}/>:
              <PracticePrompt sentence={selected} mode={supportMode} revealed={revealed} onReveal={revealWord} clock={wordClock} disabled={recording.state.phase==='stopping'}/>:<p>Select a sentence to practice.</p>}
            {persistence?.state.errors.some(error=>error.sentenceId===selected?.id)?<p role="alert">Take save failed. You can replay locally. <Button size="sm" onClick={()=>outbox?.retry()}>Retry save</Button></p>:null}
            <div className="shadow-practice-actions">
              <Button variant="soft" size="lg" shape="pill" aria-label={referencePlaying?'Pause':'Listen'} disabled={practiceBusy||(cloud.available?!cloud.audioUrl:!playable)||(referenceBusy&&!referencePlaying)} onClick={togglePlayback}>
                {referencePlaying?<Pause aria-hidden="true"/>:<Play aria-hidden="true"/>}{referencePlaying?'Pause':'Listen'}
              </Button>
              <SentenceRecordingPanel compact recording={{...recording,start:startRecording}}
                startDisabled={referenceBusy}
                disabled={!outbox?.canRecord()||Boolean(captured.entry?.pending&&!captured.row)} sentenceNumber={selected?selectedIndex+1:null} historical={!currentTakeSelected}
                onCancel={()=>{recording.recorder.cancel();if(recording.state.clip||analysisAttempt)setPractice(current=>({...current,reviewing:true}));}}/>
            </div>
            {!practiceBusy&&!reviewing?<p className="shadow-practice-hint">Listen, then say it back. Click a covered word to peek.</p>:null}
            {reviewing&&!practiceBusy?<div className="shadow-result-actions">
              {savedAnalysis.data?.word_check?.tier==='below_60'?<><Button variant="secondary" onClick={()=>{const slower=effectiveRates.filter(v=>v<1).at(-1);if(slower===undefined)return;if(cloud.available)setRate(slower);else playerRef.current?.setPlaybackRate(slower);togglePlayback();}}>Listen slowly</Button>
                <Button variant="secondary" onClick={()=>{setSupport('keywords');setPractice(current=>({...current,reviewing:false}));}}>Try with key words</Button></>:null}
              <Button aria-label={nextIndex===null?"Finish segment":"Continue to next sentence"} variant={savedAnalysis.data?.word_check?.tier==='full_85_plus'?'primary':'secondary'} onClick={()=>nextIndex===null?leave():navigate(1)}>{nextIndex===null?'Back to segments':'Next sentence →'}</Button>
            </div>:null}
            <PracticeSettings rate={rate} rates={effectiveRates} mode={supportMode} loop={activeLoop} scope={activeScope}
              reviewing={reviewing} disabled={referenceBusy||practiceBusy} hasSentence={Boolean(selected)}
              onMode={setSupport} onLoop={toggleLoop} onScope={changeScope}
              onRate={value => cloud.available ? setRate(value) : playerRef.current?.setPlaybackRate(value)} />
            {timingRecovery}
          </section>
          {reviewing&&!practiceBusy?<div ref={layerWorkspaceRef}>
            <PracticeAnalysisPanel key={analysisAttempt??'none'} api={persistence?.api} attemptId={analysisAttempt} {...savedAnalysis}/>
            {analysisPresentation.visible&&soundGuide.error?<p role="alert">{soundGuide.error} <Button size="sm" onClick={soundGuide.retry}>Retry sound guide</Button></p>:null}
            {analysisPresentation.visible?<PracticeLayers active={activeLayer} onChange={setLayer} locked={locks} badges={analysisPresentation.badges}
              gate={<><strong>Word matching comes first</strong><p>Sound opens at 60%. Rhythm and Melody open at 85%. Recognition feedback does not change these thresholds.</p></>}
              sound={<PracticeLayerState label="Sound" status={analysisPresentation.statuses.sound} waitingReference={savedAnalysis.data?.phase==='waiting_reference'}><LayerComparison key={`${selected?.id}:${analysisAttempt}:sound`} layer="sound" view={comparison} concealed={soundConcealed} onConcealedChange={hidden=>setSoundVisibility({key:reviewKey,hidden})}/></PracticeLayerState>}
              rhythm={<PracticeLayerState label="Rhythm" status={analysisPresentation.statuses.rhythm} waitingReference={savedAnalysis.data?.phase==='waiting_reference'}><LayerComparison key={`${selected?.id}:${analysisAttempt}:rhythm`} layer="rhythm" view={comparison}/>{savedAnalysis.data?.result?.learner.rhythm_signal?<ProgressiveComparison layer="rhythm" fine pair={{learner:savedAnalysis.data.result.learner.rhythm_signal,reference:savedAnalysis.data.result.reference?.rhythm_signal??null}}/>:null}</PracticeLayerState>}
              melody={<PracticeLayerState label="Melody" status={analysisPresentation.statuses.melody} waitingReference={savedAnalysis.data?.phase==='waiting_reference'}><LayerComparison key={`${selected?.id}:${analysisAttempt}:melody`} layer="melody" view={comparison} playback={{reference:wordClock,yours:learnerClock,referenceOffsetMs:selected?.startMs??0}}/></PracticeLayerState>}/>:null}
          </div>:null}
          <PracticeHistory key={selected?.id ?? "none"} contentId={contentId} sentenceId={selected?.id ?? null}
            onAnalysisSelect={selectAnalysis} onAnalysisRestore={restoreAnalysis} selectedAnalysisId={analysisAttempt} playbackClock={learnerClock}
            blocked={recording.isBusy() || referenceBusy}
            onRecordDeleted={id => {
              if (savedClip?.id === id) { recording.clear(); setSavedClip(null); }
              setAnalysisSelections(current => {
                if (!selected || current[selected.id]?.id !== id) return current;
                const next = { ...current }; delete next[selected.id]; return next;
              });
              progressState.reload();
            }}
            onPlay={() => {
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
