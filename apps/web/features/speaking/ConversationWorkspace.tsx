"use client";

import { currentAuthReturnUrl } from "@/features/navigation/return-location";

import { DirectionLink } from "@/components/ui/direction-button";

import { AppHeader } from "@/components/AppHeader";

import { Textarea } from "@/components/ui/field";

import { Button, ButtonLink } from "@/components/ui/button";

import { useAuth, useClerk } from "@clerk/nextjs";
import { BrandLogo } from "@/components/BrandLogo";
import { useRouteIntent, useRoutePrefetch } from "../navigation/use-route-prefetch";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, Expand, MessageSquare, Mic, MicOff, Minimize, Pause, Radio, RefreshCw, Square, Trash2, X } from "lucide-react";
import type { SpeakingDemonstration, SpeakingEvidence, SpeakingHelpLevel, SpeakingMessage, SpeakingOpportunity, SpeakingSupportLevel, SpeakingWorkspace } from "@libitu/types/speaking";
import { missionHref } from "../navigation/return-location";
import { useConversation } from "./use-conversation";
import { validEvidence, observedItemIds, assistanceLabel } from "./evidence";
import { HintCard } from "./HintCard";
import { observeVisible } from "./visibility";
import { currentSupport, validDemonstrations } from "./support";
import { SupportControls } from "./SupportControls";
import { finishMissionNavigation } from "./mission-timing";
import styles from "./Speaking.module.css";

export function ConversationWorkspace({ sessionId, returnTo = "/" }: { sessionId: string; returnTo?: string }) {
  const { isLoaded, userId, getToken } = useAuth();
  const clerk = useClerk();
  if (!isLoaded) return <MissionLoading returnTo={returnTo} />;
  if (!userId) return <><AppHeader active="mission" /><main className={styles.page}><section className={styles.gate}><BrandLogo className={styles.logo} /><h1>Sign in to view your mission</h1><p>Your saved mission and conversation belong to your account.</p><Button variant="primary" size="inherit" className={styles.primary} onClick={() => { const url = currentAuthReturnUrl(); clerk.openSignIn({ forceRedirectUrl: url, signUpForceRedirectUrl: url }); }}>Sign in</Button></section></main></>;
  return <OwnedConversation key={`${userId}:${sessionId}`} owner={userId} sessionId={sessionId} returnTo={returnTo} getToken={getToken} />;
}
/** Keep auth and workspace loading visually identical; route transitions retain Loadout. */
function MissionLoading({ returnTo }: { returnTo: string }) {
  return <><AppHeader active="mission" /><main className={styles.page}><section className={styles.shell} aria-label="Speaking mission" aria-busy="true">
    <div className={styles.topbar} aria-label="Mission controls"><DirectionLink className={styles.back} href={missionHref("loadout", returnTo)}><ArrowLeft size={14} aria-hidden="true" /><span>Loadout</span></DirectionLink></div>
    <div role="status" aria-label="Loading your saved mission…">
      <span className={styles.loadingLabel}>Loading your saved mission…</span>
      <div className={styles.loadingContent} aria-hidden="true">
        <div className={`${styles.mission} ${styles.loadingMission}`}><span className={styles.loadingEyebrow} /><span className={styles.loadingTitle} /><span className={styles.loadingDescription} /></div>
        <div className={styles.workspace}>
          <div className={styles.conversation}>
            <div className={styles.toolbar}><span className={styles.loadingTabs} /><span className={styles.topspacer} /><span className={styles.loadingStatus} /></div>
            <div className={styles.voice}><span className={styles.loadingOrb} /><span className={styles.loadingVoiceTitle} /><span className={styles.loadingVoiceHelp} /><span className={styles.loadingAction} /></div>
            <div className={styles.composerArea}><span className={styles.loadingComposer} /></div>
          </div>
          <div className={styles.sidebar}><span className={styles.loadingSidebarTitle} /><span className={styles.loadingEntry} /><span className={styles.loadingEntry} /><span className={styles.loadingEntry} /></div>
        </div>
      </div>
    </div>
  </section></main></>;
}
function HighlightedMessage({ message, evidence, demonstrations, onSelect }: { message: SpeakingMessage; evidence: SpeakingEvidence[]; demonstrations?: SpeakingDemonstration[]; onSelect: (value: SpeakingEvidence) => void }) {
  if (message.role === "assistant") {
    const pieces: React.ReactNode[] = []; let end = 0;
    for (const match of validDemonstrations(message, demonstrations)) {
      if (match.start < end) continue;
      pieces.push(message.text.slice(end, match.start));
      pieces.push(<mark className={styles.modelMark} key={`${match.target_item_id}:${match.start}`}>{match.quote}</mark>);
      end = match.end;
    }
    pieces.push(message.text.slice(end));
    return <>{pieces}</>;
  }
  const matches = validEvidence(message, evidence);
  const pieces: React.ReactNode[] = []; let end = 0;
  for (const match of matches) {
    if (match.start < end) continue;
    pieces.push(message.text.slice(end, match.start));
    pieces.push(<button type="button" className={styles.evidenceMark} key={match.id} onClick={() => onSelect(match)} aria-label={`View evidence for ${match.quote}`}>{match.quote}</button>);
    end = match.end;
  }
  pieces.push(message.text.slice(end));
  return <>{pieces}</>;
}
function VisibleMessage({ message, active, onShown, children }: { message: SpeakingMessage; active: boolean; onShown: (id: string, revision: number) => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || message.role !== "assistant" || message.status === "unavailable" || !ref.current) return;
    return observeVisible(ref.current, () => onShown(message.id, message.revision));
  }, [active, message.id, message.revision, message.role, message.status, onShown]);
  return <div ref={ref} className={styles.bubble}>{children}</div>;
}
function OpportunityStatus({ value, version, canChange, hideReason, onSkip, onRestore }: {
  value: SpeakingOpportunity; version: number; canChange: boolean;
  hideReason?: boolean;
  onSkip: (id: string) => boolean | undefined; onRestore: (id: string) => boolean | undefined;
}) {
  const [pending, setPending] = useState<number | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const waiting = pending !== null && version <= pending;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => { setPending(null); setUnconfirmed(true); }, 10_000);
    return () => clearTimeout(timer);
  }, [waiting]);
  function change() {
    const sent = value.status === "skipped" ? onRestore(value.session_item_id) : onSkip(value.session_item_id);
    if (sent) { setPending(version); setUnconfirmed(false); }
  }
  const label = value.status === "skipped" ? "Skipped · excluded from assessment"
    : value.status === "used" ? "Used in this mission"
      : value.status === "offered" ? "Opportunity confirmed" : "Opportunity not yet confirmed";
  return <div className={styles.opportunity}>
    <span className={styles.opportunityStatus} data-status={value.status} role="status">{label}</span>
    {value.status === "skipped" ? <p>{hideReason ? null : value.skipped_reason} Skipping this target does not count as a failed attempt.</p>
      : value.role === "opportunity" ? <p>Optional: use this only when it fits.</p> : value.status === "planned" ? <p>Your partner has a planned opportunity. It has not yet been confirmed in the conversation.</p> : null}
    <button type="button" className={styles.itemHelp} disabled={!canChange || waiting} onClick={change}>{waiting ? "Saving change…" : value.status === "skipped" ? "Undo skip" : "Doesn't fit this scene"}</button>
    {unconfirmed ? <p role="status">The change was not confirmed. Check your connection and retry.</p> : null}
  </div>;
}
function VisibleTarget({ id, text, active, onShown }: { id: string; text: string; active: boolean; onShown: (id: string) => void }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!active || !ref.current) return;
    return observeVisible(ref.current, () => onShown(id));
  }, [active, id, text, onShown]);
  return <h3 ref={ref}>{text}</h3>;
}
function VisibleFrame({ id, text, active, onShown }: { id: string; text: string; active: boolean; onShown: (id: string) => void }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!active || !ref.current) return;
    return observeVisible(ref.current, () => onShown(id));
  }, [active, id, text, onShown]);
  return <p ref={ref} className={styles.sentenceFrame}><span>Sentence frame</span>{text}</p>;
}
function TrainingSidebar({ workspace, onSelect, onHint, onSkip, onRestore, onTargetShown, canHint }: {
  workspace: SpeakingWorkspace; onSelect: (value: SpeakingEvidence) => void;
  onHint: (level: "usage" | "example", targetItemId?: string) => void;
  onSkip: (id: string) => boolean | undefined; onRestore: (id: string) => boolean | undefined; canHint: boolean;
  onTargetShown: (id: string) => void;
}) {
  const items = [...workspace.session.items].sort((a, b) => a.ordinal - b.ordinal);
  const valid = workspace.messages.flatMap(message => validEvidence(message, workspace.evidence));
  const observed = observedItemIds(workspace);
  const planned = Boolean(workspace.session.mission_plan);
  const support = currentSupport(workspace);
  const hideWording = support?.level === "no_hint";
  const legacy = support === null;
  const active = !["completed", "abandoned"].includes(workspace.session.status);
  const groups = planned ? ["primary", "opportunity"] : ["expression", "structure"];
  const skipped = new Set(workspace.opportunities?.filter(value => value.status === "skipped").map(value => value.session_item_id));
  return <>
    <div className={styles.sidebarHeading}><span>Your loadout</span><span>{items.length} items</span></div>
    {groups.map(group => <section className={group === "structure" ? styles.structures : undefined} key={group}>
      <h2 className={styles.groupTitle}>{group === "primary" ? "Primary targets" : group === "opportunity" ? "Opportunity targets" : group === "structure" ? "Structures" : "Expressions"}</h2>
      {items.filter(item => planned ? workspace.session.mission_plan?.targets.find(target => target.session_item_id === item.id)?.role === group : group === "structure" ? item.kind === "structure" : item.kind !== "structure").map(item => {
        const evidence = valid.filter(value => value.session_item_id === item.id);
        const learning = workspace.learning.find(value => value.session_item_id === item.id);
        const opportunity = workspace.opportunities?.find(value => value.session_item_id === item.id);
        const target = workspace.session.mission_plan?.targets.find(value => value.session_item_id === item.id);
        return <article className={styles.languageCard} key={item.id}>
          {hideWording ? <h3>{target?.role === "opportunity" ? "Opportunity target" : "Primary target"} {item.ordinal + 1}</h3>
            : <VisibleTarget id={item.id} text={item.text} active={(planned || support !== null) && active} onShown={onTargetShown} />}
          {legacy && item.meaning ? <p>{item.meaning}</p> : null}
          {legacy && target ? <p className={styles.usageDetail}>{target.communicative_function}</p> : null}
          {support?.level === "model_frame" ? target?.sentence_frame
            ? <VisibleFrame id={item.id} text={target.sentence_frame} active={(planned || support !== null) && active} onShown={onTargetShown} />
            : <p>A sentence frame is not available for this target. You can ask for help.</p> : null}
          {opportunity ? <OpportunityStatus value={opportunity} version={workspace.version} canChange={canHint} hideReason={hideWording} onSkip={onSkip} onRestore={onRestore} /> : null}
          {legacy && Object.keys(item.slots).length ? <details><summary>Pattern slots</summary><dl>{Object.entries(item.slots).map(([slot, description]) => <div key={slot}><dt>{slot}</dt><dd>{description}</dd></div>)}</dl></details> : null}
          {evidence.length ? <><button type="button" className={styles.evidenceLink} onClick={() => onSelect(evidence[evidence.length - 1])}><Check size={12} aria-hidden="true" /> {evidence.length} observed {evidence.length === 1 ? "use" : "uses"}<ChevronRight size={12} aria-hidden="true" /></button>{learning ? <p className={styles.usageDetail}>{learning.independent_uses} independent · {learning.prompted_uses} prompted</p> : null}</> : <span className={styles.notObserved}>Not observed yet</span>}
          <button type="button" className={styles.itemHelp} disabled={!canHint || opportunity?.status === "skipped"} onClick={() => onHint("usage", item.id)}>Help me use this</button>
        </article>;
      })}
    </section>)}
    <section className={styles.observations}><h2>Practice so far</h2><div><span>User turns</span><strong>{workspace.session.turn_count}</strong></div>{planned ? <><div><span>Primary used</span><strong>{workspace.opportunities?.filter(value => value.role === "primary" && value.status === "used").length ?? 0}</strong></div><div><span>Opportunity used</span><strong>{workspace.opportunities?.filter(value => value.role === "opportunity" && value.status === "used").length ?? 0}</strong></div><div><span>Skipped</span><strong>{skipped.size}</strong></div></> : <div><span>Language observed</span><strong>{observed.size}/{items.length}</strong></div>}<p>Observations in this conversation, not a mastery score.</p>
      <p role="status">{workspace.analysis_status === "pending" ? "Checking your latest turn…" : workspace.analysis_status === "unavailable" ? "Language analysis is unavailable for the latest turn." : workspace.analysis_status === "ready" ? "Evidence is up to date." : "Evidence appears after a finalized turn."}</p>
    </section>
  </>;
}
function OwnedConversation({ owner, sessionId, returnTo, getToken }: { owner: string; sessionId: string; returnTo: string; getToken: () => Promise<string | null> }) {
  const router = useRouter();
  const reportIntent = useRouteIntent(missionHref("analytics", returnTo, sessionId));
  const prefetch = useRoutePrefetch();
  const { state, controller } = useConversation(owner, sessionId, getToken);
  const [view, setView] = useState<"voice" | "chat">("voice");
  const [focused, setFocused] = useState(false);
  const [trainingOpen, setTrainingOpen] = useState(false);
  const [text, setText] = useState("");
  const [selectedEvidence, setSelectedEvidence] = useState<SpeakingEvidence | null>(null);
  const [confirmAction, setConfirmAction] = useState<"end" | "delete" | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const workspace = state.workspace;
  useEffect(() => {
    if (workspace && ["idle", "ended"].includes(state.connection)) finishMissionNavigation(owner, sessionId);
  }, [owner, sessionId, workspace, state.connection]);
  const support = workspace ? currentSupport(workspace) : null;
  const visibleMessages = workspace?.messages.filter(message => message.text.trim().length > 0) ?? [];
  const visiblePartials = Object.entries(state.partials).filter(([, partial]) => partial.text.trim().length > 0);
  const ended = state.connection === "ended";
  const connected = state.connection === "connected";
  const connecting = state.connection === "connecting";
  const allTargetsSkipped = !!workspace?.session.mission_plan && !!workspace.opportunities?.length && workspace.opportunities.every(value => value.status === "skipped");
  const requestHint = useCallback((level: "usage" | "example" = "usage", targetItemId?: string) => controller?.hint(level, targetItemId), [controller]);
  const skipTarget = useCallback((id: string) => controller?.skipTarget(id), [controller]);
  const restoreTarget = useCallback((id: string) => controller?.restoreTarget(id), [controller]);
  const targetShown = useCallback((id: string) => controller?.targetShown(id), [controller]);
  const changeSupport = useCallback((level: SpeakingSupportLevel) => { controller?.setSupport(level); }, [controller]);
  const hintShown = useCallback((id: string, version: number, level: SpeakingHelpLevel) => controller?.hintShown(id, version, level), [controller]);
  const messageShown = useCallback((id: string, revision: number) => controller?.messageShown(id, revision), [controller]);
  const canStart = !!workspace && !ended && !connecting && !state.busy;
  const evidence = selectedEvidence && workspace?.messages.some(message => validEvidence(message, workspace.evidence).some(item => item.id === selectedEvidence.id)) ? selectedEvidence : null;
  useEffect(() => { if (view === "chat") bottom.current?.scrollIntoView({ block: "nearest", behavior: "instant" }); }, [visibleMessages.length, visiblePartials.length, state.pending?.id, view]);
  function chooseEvidence(value: SpeakingEvidence) { setSelectedEvidence(value); setView("chat"); requestAnimationFrame(() => document.getElementById(`turn-${value.message_id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })); }
  async function submit() { const value = text.trim(); if (!value || !controller || state.pending || ended) return; setView("chat"); setText(""); await controller.submit(value); }
  async function confirm() {
    if (!controller) return;
    prefetch(confirmAction === "delete" ? missionHref("loadout", returnTo) : missionHref("analytics", returnTo, sessionId));
    if (confirmAction === "delete") { if (await controller.delete()) router.replace(missionHref("loadout", returnTo)); }
    else { if (await controller.end()) { setConfirmAction(null); router.push(missionHref("analytics", returnTo, sessionId)); } }
  }
  if (!workspace && !state.error) return <MissionLoading returnTo={returnTo} />;
  const voiceTitle = ended ? "Conversation ended" : connecting ? "Connecting…" : state.connection === "paused" ? "Conversation paused" : state.connection === "disconnected" ? "Ready to reconnect" : !connected ? "Ready when you are" : state.phase === "thinking" ? "Thinking…" : state.phase === "speaking" ? "Your partner is speaking" : state.microphone ? "Listening…" : "Microphone off";
  const voiceHelp = ended ? "Review your transcript and language evidence." : connecting ? "Preparing your conversation." : state.connection === "paused" ? "Paused while you were away. Resume when ready." : state.connection === "disconnected" ? "Your finalized transcript is saved. Reconnect when ready." : !connected ? "Start, then speak naturally. You can also type below." : state.phase === "speaking" ? "Speak to interrupt, or use Stop speaking." : state.microphone ? "Turns are detected automatically." : "Keep typing, or enable your microphone.";
  return <><AppHeader active="mission" /><main className={styles.page}><section className={`${styles.shell} ${focused ? styles.focused : ""}`} aria-label="Speaking mission">
    <div className={styles.topbar} aria-label="Mission controls"><DirectionLink className={styles.back} href={missionHref("loadout", returnTo)}><ArrowLeft size={14} aria-hidden="true" /><span>Loadout</span></DirectionLink><span className={styles.topspacer} />{workspace && !ended ? <Button {...reportIntent} variant="secondary" size="inherit" type="button" className={styles.endButton} onClick={() => setConfirmAction("end")} disabled={state.busy}>End mission</Button> : null}</div>
    {!workspace ? <div className={styles.empty}>{state.error ? <><h1>Mission unavailable</h1><p role="alert">{state.error}</p><Button variant="primary" size="inherit" type="button" className={styles.primary} onClick={() => void controller?.load()}>Retry loading mission</Button></> : null}</div> : <>
      <div className={styles.mission}><div className={styles.eyebrow}>{workspace.session.scenario_type === "workplace" ? "Workplace" : "Everyday life"} · {workspace.session.difficulty} · {workspace.session.feedback_level} feedback</div><h1>{workspace.session.goal}</h1><p>{ended ? "Saved conversation · read-only review" : "Use your selected language in a natural conversation."}</p>{workspace.session.mission_plan ? <p>{workspace.session.mission_plan.setting} You: {workspace.session.mission_plan.user_role}. AI partner: {workspace.session.mission_plan.ai_role}.</p> : null}</div>
      {workspace.session.logic_template ? <section className={styles.logic} aria-label="Conversation strategy"><div><strong>{workspace.session.logic_template.title}</strong><span>Practice guide</span></div><ol>{workspace.session.logic_template.steps.map((step, index) => <li key={`${index}:${step}`}>{index > 0 ? <ChevronRight size={12} aria-hidden="true" /> : null}<span>{step}</span></li>)}</ol></section> : null}
      {!ended ? <SupportControls workspace={workspace} disabled={!connected || state.busy || state.phase !== "listening" || state.userSpeaking} pending={!!state.supportPending} error={state.supportError} onChange={changeSupport} /> : null}
      {state.error ? <div className={styles.notice} role="alert"><span>{state.error}</span>{state.conflict ? <Button variant="secondary" size="inherit" type="button" onClick={() => void controller?.start(view === "voice", true)} disabled={connecting}>Take over here</Button> : null}</div> : null}
      {confirmAction ? <section className={styles.confirm} aria-label={confirmAction === "delete" ? "Delete conversation confirmation" : "End mission confirmation"}><h2>{confirmAction === "delete" ? "Delete this mission?" : "End this mission?"}</h2><p>{confirmAction === "delete" ? "Your saved transcript, language evidence and mission will be permanently deleted." : state.pending ? "One message is still unconfirmed. Ending closes the connection and saves the finalized conversation for review." : "This stops the microphone and closes the conversation. Your finalized transcript and evidence stay available."}</p><div><Button variant={confirmAction === "delete" ? "danger-solid" : "primary"} size="inherit" type="button" className={styles.primary} disabled={state.busy} loading={state.busy} loadingLabel="Saving…" onClick={() => void confirm()}>{confirmAction === "delete" ? "Delete permanently" : "End and review"}</Button><Button variant="secondary" size="inherit" type="button" disabled={state.busy} onClick={() => setConfirmAction(null)}>Cancel</Button></div></section> : null}
      <div className={styles.workspace}>
        <section className={styles.conversation} aria-label="Conversation">
          <div className={styles.toolbar}><div className={styles.views} aria-label="Conversation view"><button type="button" aria-pressed={view === "voice"} onClick={() => setView("voice")}><Radio size={14} aria-hidden="true" />Voice</button><button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")}><MessageSquare size={14} aria-hidden="true" />Chat</button></div><span className={styles.connection} role="status"><span className={connected ? styles.connectedDot : styles.dot} />{ended ? "Completed" : connected ? "Connected" : connecting ? "Connecting" : state.connection === "paused" ? "Paused" : "Offline"}</span><Button variant="secondary" size="inherit" type="button" className={styles.trainingToggle} aria-expanded={trainingOpen} onClick={() => { setTrainingOpen(!trainingOpen); setFocused(false); }}>Loadout<ChevronDown size={14} aria-hidden="true" /></Button><Button variant="ghost" size="inherit" shape="circle" type="button" className={styles.iconButton} aria-label={focused ? "Restore training sidebar" : "Expand conversation"} aria-pressed={focused} onClick={() => setFocused(!focused)}>{focused ? <Minimize size={16} /> : <Expand size={16} />}</Button></div>
          {view === "voice" ? <div className={styles.voice} data-phase={connected ? state.phase : "idle"}><div className={styles.orb} aria-hidden="true" /><h2>{voiceTitle}</h2><p>{voiceHelp}</p>{!connected && !ended ? <Button variant="record" size="inherit" shape="pill" type="button" className={styles.primary} disabled={!canStart || state.conflict} loading={connecting} loadingLabel="Connecting…" onClick={() => void controller?.start(true)}>{state.connection === "paused" ? "Resume conversation" : state.connection === "disconnected" ? "Reconnect" : "Start conversation"}</Button> : null}{connected && state.phase === "speaking" ? <Button variant="secondary" size="inherit" type="button" onClick={() => controller?.interrupt()}><Square size={12} aria-hidden="true" />Stop speaking</Button> : null}{connected ? <Button variant="ghost" size="inherit" type="button" className={styles.quiet} onClick={() => controller?.pause()}><Pause size={12} aria-hidden="true" />Pause conversation</Button> : null}<span className={styles.voicePrivacy}>{state.microphone ? "Microphone on · audio sent for this conversation" : "Microphone off"}</span>{Object.values(state.partials).length ? <p className={styles.liveCaption}>{Object.values(state.partials).at(-1)?.text}<span>Live transcript · not finalized</span></p> : null}</div>
            : <div className={styles.chat} aria-label="Conversation transcript">{!visibleMessages.length && !visiblePartials.length && !state.pending ? <div className={styles.chatEmpty}><MessageSquare size={24} aria-hidden="true" /><h2>Start with your idea</h2><p>Type a message below or switch to Voice. Your partner will respond within your mission.</p></div> : visibleMessages.map(message => <article id={`turn-${message.id}`} className={`${styles.message} ${message.role === "user" ? styles.userMessage : styles.aiMessage}`} key={message.id}><div className={styles.speaker}>{message.role === "user" ? "You" : "AI partner"}<span>{message.input_source === "voice" ? "Voice" : "Text"}</span></div><VisibleMessage message={message} active={connected} onShown={messageShown}><HighlightedMessage message={message} evidence={workspace.evidence} demonstrations={support?.level === "no_hint" ? [] : workspace.demonstrations} onSelect={chooseEvidence} /></VisibleMessage>{message.status !== "final" ? <p className={styles.messageStatus}>{message.status === "interrupted" ? "Interrupted · generated text may include words not played" : message.text ? "Transcript not confirmed" : "Transcript unavailable"}</p> : null}</article>)}
              {visiblePartials.map(([id, partial]) => <article className={`${styles.message} ${partial.role === "user" ? styles.userMessage : styles.aiMessage}`} key={id}><div className={styles.speaker}>{partial.role === "user" ? "You" : "AI partner"}<span>Live · not finalized</span></div><div className={styles.bubble}>{partial.text}</div></article>)}
              {state.pending ? <article className={`${styles.message} ${styles.userMessage}`}><div className={styles.speaker}>You<span>{state.pending.status === "sending" ? "Awaiting confirmation…" : "Not yet confirmed"}</span></div><div className={styles.bubble}>{state.pending.text}</div>{state.pending.status === "unconfirmed" ? <Button variant="secondary" size="inherit" type="button" onClick={() => void controller?.retryText()} disabled={connecting || state.conflict}>Retry same message</Button> : null}</article> : null}<div ref={bottom} />
            </div>}
          {evidence ? <section className={styles.evidenceDetail} aria-label="Language evidence"><Button variant="ghost" size="inherit" shape="circle" type="button" className={styles.iconButton} aria-label="Close evidence" onClick={() => setSelectedEvidence(null)}><X size={14} /></Button><strong>“{evidence.quote}”</strong><p>{evidence.reason}</p><span>{evidence.match_type} match · {evidence.appropriateness === "appropriate" ? "Appropriate in this context" : evidence.appropriateness === "uncertain" ? "Context not confirmed" : "Context needs attention"} · {assistanceLabel(evidence)}</span></section> : null}
          {!ended ? <HintCard card={support && workspace.help?.source === "automatic" ? null : workspace.help ?? null} connected={connected} userSpeaking={state.userSpeaking || !!text.trim() || !!state.pending} onHint={requestHint} onShown={hintShown} /> : null}
          {!ended ? <div className={styles.composerArea}><form className={styles.composer} onSubmit={event => { event.preventDefault(); void submit(); }}><Textarea shape="pill" aria-label="Message your AI partner" placeholder="Or send a message…" value={text} rows={1} maxLength={4000} disabled={state.busy} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} /><Button variant="primary" size="inherit" shape="circle" type="submit" className={styles.sendButton} aria-label="Send message" disabled={!text.trim() || !!state.pending || connecting || state.busy || state.conflict}><ArrowUp size={18} /></Button><Button variant="record" size="inherit" shape="circle" recording={state.microphone} type="button" className={`${styles.micButton} ${state.microphone ? styles.micActive : ""}`} aria-label={state.microphone ? "Mute microphone" : "Enable microphone"} aria-pressed={state.microphone} disabled={state.microphoneBusy || connecting || state.busy || state.conflict} onClick={() => { if (!connected) void controller?.start(true); else void controller?.setMicrophone(!state.microphone); }}>{state.microphone ? <Mic size={20} /> : <MicOff size={20} />}</Button></form><div className={styles.composerHelp}><span>{text.length ? `${text.length}/4000 · Shift+Enter for a new line` : "Text is saved · audio is not retained by Libitu"}</span><Button variant="ghost" size="inherit" type="button" disabled={!connected || allTargetsSkipped} onClick={() => requestHint()}>Need a hint?</Button></div>{!connected && view === "chat" ? <Button variant="ghost" size="inherit" type="button" className={styles.quiet} loading={connecting} loadingLabel="Connecting…" onClick={() => void controller?.start(false)} disabled={!canStart || state.conflict}><RefreshCw size={12} aria-hidden="true" />Connect for text</Button> : null}</div>
            : <div className={styles.review}><Check size={16} aria-hidden="true" /><p>Mission complete. Review the actual transcript and evidence above.</p><ButtonLink variant="primary" size="inherit" className={styles.primary} href={missionHref("analytics", returnTo, sessionId)}>View mission report</ButtonLink><Button variant="danger" size="inherit" type="button" className={styles.deleteButton} onClick={() => setConfirmAction("delete")}><Trash2 size={13} aria-hidden="true" />Delete mission</Button></div>}
        </section>
        <aside className={`${styles.sidebar} ${workspace.session.mission_plan ? styles.plannedSidebar : ""} ${trainingOpen ? styles.sidebarOpen : ""}`} aria-label="Training sidebar"><TrainingSidebar workspace={workspace} onSelect={chooseEvidence} onHint={requestHint} onSkip={skipTarget} onRestore={restoreTarget} onTargetShown={targetShown} canHint={connected} /></aside>
      </div>
    </>}
  </section></main></>;
}
