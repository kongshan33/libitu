"use client";

import { DirectionLink } from "@/components/ui/direction-button";

import { AppHeader } from "@/components/AppHeader";

import { Textarea } from "@/components/ui/field";

import { Button, ButtonLink } from "@/components/ui/button";

import { useAuth, useClerk } from "@clerk/nextjs";
import { BrandLogo } from "@/components/BrandLogo";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, Expand, MessageSquare, Mic, MicOff, Minimize, Pause, Radio, RefreshCw, Square, Trash2, X } from "lucide-react";
import type { SpeakingEvidence, SpeakingMessage, SpeakingWorkspace } from "@libitu/types/speaking";
import { safeReturnPath } from "../loadout/navigation";
import { useConversation } from "./use-conversation";
import { validEvidence, observedItemIds } from "./evidence";
import styles from "./Speaking.module.css";

export function ConversationWorkspace({ sessionId }: { sessionId: string }) {
  const { isLoaded, userId, getToken } = useAuth();
  const clerk = useClerk();
  if (!isLoaded) return <><AppHeader active="mission" /><main className={styles.page}><p role="status">Checking sign-in…</p></main></>;
  if (!userId) return <><AppHeader active="mission" /><main className={styles.page}><section className={styles.gate}><BrandLogo className={styles.logo} /><h1>Sign in to view your mission</h1><p>Your saved mission and conversation belong to your account.</p><Button variant="primary" size="inherit" className={styles.primary} onClick={() => { const url = window.location.href; clerk.openSignIn({ forceRedirectUrl: url, signUpForceRedirectUrl: url }); }}>Sign in</Button></section></main></>;
  return <OwnedConversation key={`${userId}:${sessionId}`} owner={userId} sessionId={sessionId} getToken={getToken} />;
}
function HighlightedMessage({ message, evidence, onSelect }: { message: SpeakingMessage; evidence: SpeakingEvidence[]; onSelect: (value: SpeakingEvidence) => void }) {
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
function TrainingSidebar({ workspace, onSelect, hint, onHint, canHint }: { workspace: SpeakingWorkspace; onSelect: (value: SpeakingEvidence) => void; hint: string | null; onHint: () => void; canHint: boolean }) {
  const items = [...workspace.session.items].sort((a, b) => a.ordinal - b.ordinal);
  const valid = workspace.messages.flatMap(message => validEvidence(message, workspace.evidence));
  const observed = observedItemIds(workspace);
  return <>
    <div className={styles.sidebarHeading}><span>Your loadout</span><span>{items.length} items</span></div>
    {(["expression", "structure"] as const).map(group => <section className={group === "structure" ? styles.structures : undefined} key={group}>
      <h2 className={styles.groupTitle}>{group === "structure" ? "Structures" : "Expressions"}</h2>
      {items.filter(item => group === "structure" ? item.kind === "structure" : item.kind !== "structure").map(item => {
        const evidence = valid.filter(value => value.session_item_id === item.id);
        const learning = workspace.learning.find(value => value.session_item_id === item.id);
        return <article className={styles.languageCard} key={item.id}><h3>{item.text}</h3>{item.meaning ? <p>{item.meaning}</p> : null}
          {Object.keys(item.slots).length ? <details><summary>Pattern slots</summary><dl>{Object.entries(item.slots).map(([slot, description]) => <div key={slot}><dt>{slot}</dt><dd>{description}</dd></div>)}</dl></details> : null}
          {evidence.length ? <><button type="button" className={styles.evidenceLink} onClick={() => onSelect(evidence[evidence.length - 1])}><Check size={12} aria-hidden="true" /> {evidence.length} observed {evidence.length === 1 ? "use" : "uses"}<ChevronRight size={12} aria-hidden="true" /></button>{learning ? <p className={styles.usageDetail}>{learning.independent_uses} independent · {learning.prompted_uses} prompted</p> : null}</> : <span className={styles.notObserved}>Not observed yet</span>}
        </article>;
      })}
    </section>)}
    <section className={styles.observations}><h2>Practice so far</h2><div><span>User turns</span><strong>{workspace.session.turn_count}</strong></div><div><span>Language observed</span><strong>{observed.size}/{items.length}</strong></div><p>Observations in this conversation, not a mastery score.</p>
      <p role="status">{workspace.analysis_status === "pending" ? "Checking your latest turn…" : workspace.analysis_status === "unavailable" ? "Language analysis is unavailable for the latest turn." : workspace.analysis_status === "ready" ? "Evidence is up to date." : "Evidence appears after a finalized turn."}</p>
    </section>
    <section className={styles.hintPanel}><h2>Need a hand?</h2>{hint ? <p>{hint}</p> : <p>Get one suggestion from your selected language.</p>}<Button variant="secondary" size="inherit" type="button" onClick={onHint} disabled={!canHint}>Get a hint</Button></section>
  </>;
}
function OwnedConversation({ owner, sessionId, getToken }: { owner: string; sessionId: string; getToken: () => Promise<string | null> }) {
  const router = useRouter();
  const { state, controller } = useConversation(owner, sessionId, getToken);
  const [view, setView] = useState<"voice" | "chat">("voice");
  const [focused, setFocused] = useState(false);
  const [trainingOpen, setTrainingOpen] = useState(false);
  const [text, setText] = useState("");
  const [selectedEvidence, setSelectedEvidence] = useState<SpeakingEvidence | null>(null);
  const [confirmAction, setConfirmAction] = useState<"end" | "delete" | null>(null);
  const [returnTo, setReturnTo] = useState("/");
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { setReturnTo(safeReturnPath(new URL(window.location.href).searchParams.get("returnTo"))); }, []);
  const workspace = state.workspace;
  const ended = state.connection === "ended";
  const connected = state.connection === "connected";
  const connecting = state.connection === "connecting";
  const canStart = !!workspace && !ended && !connecting && !state.busy;
  const evidence = selectedEvidence && workspace?.messages.some(message => validEvidence(message, workspace.evidence).some(item => item.id === selectedEvidence.id)) ? selectedEvidence : null;
  useEffect(() => { if (view === "chat") bottom.current?.scrollIntoView({ block: "nearest", behavior: "instant" }); }, [workspace?.messages.length, state.pending?.id, view]);
  function chooseEvidence(value: SpeakingEvidence) { setSelectedEvidence(value); setView("chat"); requestAnimationFrame(() => document.getElementById(`turn-${value.message_id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })); }
  async function submit() { const value = text.trim(); if (!value || !controller || state.pending || ended) return; setView("chat"); setText(""); await controller.submit(value); }
  async function confirm() {
    if (!controller) return;
    if (confirmAction === "delete") { if (await controller.delete()) router.replace(`/loadout?returnTo=${encodeURIComponent(returnTo)}`); }
    else { if (await controller.end()) { setConfirmAction(null); router.push(`/speaking/${encodeURIComponent(sessionId)}/analytics`); } }
  }
  const voiceTitle = ended ? "Conversation ended" : connecting ? "Connecting…" : state.connection === "paused" ? "Conversation paused" : state.connection === "disconnected" ? "Ready to reconnect" : !connected ? "Ready when you are" : state.phase === "thinking" ? "Thinking…" : state.phase === "speaking" ? "Your partner is speaking" : state.microphone ? "Listening…" : "Microphone off";
  const voiceHelp = ended ? "Review your transcript and language evidence." : connecting ? "Preparing your conversation." : state.connection === "paused" ? "Paused while you were away. Resume when ready." : state.connection === "disconnected" ? "Your finalized transcript is saved. Reconnect when ready." : !connected ? "Start, then speak naturally. You can also type below." : state.phase === "speaking" ? "Speak to interrupt, or use Stop speaking." : state.microphone ? "Turns are detected automatically." : "Keep typing, or enable your microphone.";
  return <><AppHeader active="mission" /><main className={styles.page}><section className={`${styles.shell} ${focused ? styles.focused : ""}`} aria-label="Speaking mission">
    <div className={styles.topbar} aria-label="Mission controls"><DirectionLink className={styles.back} href={`/loadout?returnTo=${encodeURIComponent(returnTo)}`}><ArrowLeft size={14} aria-hidden="true" /><span>Loadout</span></DirectionLink><span className={styles.topspacer} />{workspace && !ended ? <Button variant="secondary" size="inherit" type="button" className={styles.endButton} onClick={() => setConfirmAction("end")} disabled={state.busy}>End mission</Button> : null}</div>
    {!workspace ? <div className={styles.empty}>{state.error ? <><h1>Mission unavailable</h1><p role="alert">{state.error}</p><Button variant="primary" size="inherit" type="button" className={styles.primary} onClick={() => void controller?.load()}>Retry loading mission</Button></> : <p role="status">Loading your saved mission…</p>}</div> : <>
      <div className={styles.mission}><div className={styles.eyebrow}>{workspace.session.scenario_type === "workplace" ? "Workplace" : "Everyday life"} · {workspace.session.difficulty} · {workspace.session.feedback_level} feedback</div><h1>{workspace.session.goal}</h1><p>{ended ? "Saved conversation · read-only review" : "Use your selected language in a natural conversation."}</p></div>
      {workspace.session.logic_template ? <section className={styles.logic} aria-label="Conversation strategy"><div><strong>{workspace.session.logic_template.title}</strong><span>Practice guide</span></div><ol>{workspace.session.logic_template.steps.map((step, index) => <li key={`${index}:${step}`}>{index > 0 ? <ChevronRight size={12} aria-hidden="true" /> : null}<span>{step}</span></li>)}</ol></section> : null}
      {state.error ? <div className={styles.notice} role="alert"><span>{state.error}</span>{state.conflict ? <Button variant="secondary" size="inherit" type="button" onClick={() => void controller?.start(view === "voice", true)} disabled={connecting}>Take over here</Button> : null}</div> : null}
      {confirmAction ? <section className={styles.confirm} aria-label={confirmAction === "delete" ? "Delete conversation confirmation" : "End mission confirmation"}><h2>{confirmAction === "delete" ? "Delete this mission?" : "End this mission?"}</h2><p>{confirmAction === "delete" ? "Your saved transcript, language evidence and mission will be permanently deleted." : state.pending ? "One message is still unconfirmed. Ending closes the connection and saves the finalized conversation for review." : "This stops the microphone and closes the conversation. Your finalized transcript and evidence stay available."}</p><div><Button variant={confirmAction === "delete" ? "danger-solid" : "primary"} size="inherit" type="button" className={styles.primary} disabled={state.busy} loading={state.busy} loadingLabel="Saving…" onClick={() => void confirm()}>{confirmAction === "delete" ? "Delete permanently" : "End and review"}</Button><Button variant="secondary" size="inherit" type="button" disabled={state.busy} onClick={() => setConfirmAction(null)}>Cancel</Button></div></section> : null}
      <div className={styles.workspace}>
        <section className={styles.conversation} aria-label="Conversation">
          <div className={styles.toolbar}><div className={styles.views} aria-label="Conversation view"><button type="button" aria-pressed={view === "voice"} onClick={() => setView("voice")}><Radio size={14} aria-hidden="true" />Voice</button><button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")}><MessageSquare size={14} aria-hidden="true" />Chat</button></div><span className={styles.connection} role="status"><span className={connected ? styles.connectedDot : styles.dot} />{ended ? "Completed" : connected ? "Connected" : connecting ? "Connecting" : state.connection === "paused" ? "Paused" : "Offline"}</span><Button variant="secondary" size="inherit" type="button" className={styles.trainingToggle} aria-expanded={trainingOpen} onClick={() => { setTrainingOpen(!trainingOpen); setFocused(false); }}>Loadout<ChevronDown size={14} aria-hidden="true" /></Button><Button variant="ghost" size="inherit" shape="circle" type="button" className={styles.iconButton} aria-label={focused ? "Restore training sidebar" : "Expand conversation"} aria-pressed={focused} onClick={() => setFocused(!focused)}>{focused ? <Minimize size={16} /> : <Expand size={16} />}</Button></div>
          {view === "voice" ? <div className={styles.voice} data-phase={connected ? state.phase : "idle"}><div className={styles.orb} aria-hidden="true" /><h2>{voiceTitle}</h2><p>{voiceHelp}</p>{!connected && !ended ? <Button variant="record" size="inherit" shape="pill" type="button" className={styles.primary} disabled={!canStart || state.conflict} loading={connecting} loadingLabel="Connecting…" onClick={() => void controller?.start(true)}>{state.connection === "paused" ? "Resume conversation" : state.connection === "disconnected" ? "Reconnect" : "Start conversation"}</Button> : null}{connected && state.phase === "speaking" ? <Button variant="secondary" size="inherit" type="button" onClick={() => controller?.interrupt()}><Square size={12} aria-hidden="true" />Stop speaking</Button> : null}{connected ? <Button variant="ghost" size="inherit" type="button" className={styles.quiet} onClick={() => controller?.pause()}><Pause size={12} aria-hidden="true" />Pause conversation</Button> : null}<span className={styles.voicePrivacy}>{state.microphone ? "Microphone on · audio sent for this conversation" : "Microphone off"}</span>{Object.values(state.partials).length ? <p className={styles.liveCaption}>{Object.values(state.partials).at(-1)?.text}<span>Live transcript · not finalized</span></p> : null}</div>
            : <div className={styles.chat} aria-label="Conversation transcript">{!workspace.messages.length ? <div className={styles.chatEmpty}><MessageSquare size={24} aria-hidden="true" /><h2>Start with your idea</h2><p>Type a message below or switch to Voice. Your partner will respond within your mission.</p></div> : workspace.messages.map(message => <article id={`turn-${message.id}`} className={`${styles.message} ${message.role === "user" ? styles.userMessage : styles.aiMessage}`} key={message.id}><div className={styles.speaker}>{message.role === "user" ? "You" : "AI partner"}<span>{message.input_source === "voice" ? "Voice" : "Text"}</span></div><div className={styles.bubble}><HighlightedMessage message={message} evidence={workspace.evidence} onSelect={chooseEvidence} /></div>{message.status !== "final" ? <p className={styles.messageStatus}>{message.status === "interrupted" ? "Interrupted · generated text may include words not played" : message.text ? "Transcript not confirmed" : "Transcript unavailable"}</p> : null}</article>)}
              {Object.entries(state.partials).map(([id, partial]) => <article className={`${styles.message} ${partial.role === "user" ? styles.userMessage : styles.aiMessage}`} key={id}><div className={styles.speaker}>{partial.role === "user" ? "You" : "AI partner"}<span>Live · not finalized</span></div><div className={styles.bubble}>{partial.text}</div></article>)}
              {state.pending ? <article className={`${styles.message} ${styles.userMessage}`}><div className={styles.speaker}>You<span>{state.pending.status === "sending" ? "Awaiting confirmation…" : "Not yet confirmed"}</span></div><div className={styles.bubble}>{state.pending.text}</div>{state.pending.status === "unconfirmed" ? <Button variant="secondary" size="inherit" type="button" onClick={() => void controller?.retryText()} disabled={connecting || state.conflict}>Retry same message</Button> : null}</article> : null}<div ref={bottom} />
            </div>}
          {evidence ? <section className={styles.evidenceDetail} aria-label="Language evidence"><Button variant="ghost" size="inherit" shape="circle" type="button" className={styles.iconButton} aria-label="Close evidence" onClick={() => setSelectedEvidence(null)}><X size={14} /></Button><strong>“{evidence.quote}”</strong><p>{evidence.reason}</p><span>{evidence.match_type} match · {evidence.appropriateness === "appropriate" ? "Appropriate in this context" : evidence.appropriateness === "uncertain" ? "Context not confirmed" : "Context needs attention"} · {evidence.prompted ? "Prompted" : "Independent"}</span></section> : null}
          {!ended ? <div className={styles.composerArea}><form className={styles.composer} onSubmit={event => { event.preventDefault(); void submit(); }}><Textarea shape="pill" aria-label="Message your AI partner" placeholder="Or send a message…" value={text} rows={1} maxLength={4000} disabled={state.busy} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} /><Button variant="primary" size="inherit" shape="circle" type="submit" className={styles.sendButton} aria-label="Send message" disabled={!text.trim() || !!state.pending || connecting || state.busy || state.conflict}><ArrowUp size={18} /></Button><Button variant="record" size="inherit" shape="circle" recording={state.microphone} type="button" className={`${styles.micButton} ${state.microphone ? styles.micActive : ""}`} aria-label={state.microphone ? "Mute microphone" : "Enable microphone"} aria-pressed={state.microphone} disabled={state.microphoneBusy || connecting || state.busy || state.conflict} onClick={() => { if (!connected) void controller?.start(true); else void controller?.setMicrophone(!state.microphone); }}>{state.microphone ? <Mic size={20} /> : <MicOff size={20} />}</Button></form><div className={styles.composerHelp}><span>{text.length ? `${text.length}/4000 · Shift+Enter for a new line` : "Text is saved · audio is not retained by Libitu"}</span><Button variant="ghost" size="inherit" type="button" disabled={!connected} onClick={() => { setTrainingOpen(true); setFocused(false); controller?.hint(); }}>Need a hint?</Button></div>{!connected && view === "chat" ? <Button variant="ghost" size="inherit" type="button" className={styles.quiet} loading={connecting} loadingLabel="Connecting…" onClick={() => void controller?.start(false)} disabled={!canStart || state.conflict}><RefreshCw size={12} aria-hidden="true" />Connect for text</Button> : null}</div>
            : <div className={styles.review}><Check size={16} aria-hidden="true" /><p>Mission complete. Review the actual transcript and evidence above.</p><ButtonLink variant="primary" size="inherit" className={styles.primary} href={`/speaking/${encodeURIComponent(sessionId)}/analytics`}>View mission report</ButtonLink><Button variant="danger" size="inherit" type="button" className={styles.deleteButton} onClick={() => setConfirmAction("delete")}><Trash2 size={13} aria-hidden="true" />Delete mission</Button></div>}
        </section>
        <aside className={`${styles.sidebar} ${trainingOpen ? styles.sidebarOpen : ""}`} aria-label="Training sidebar"><TrainingSidebar workspace={workspace} onSelect={chooseEvidence} hint={workspace.hint} onHint={() => controller?.hint()} canHint={connected} /></aside>
      </div>
    </>}
  </section></main></>;
}
