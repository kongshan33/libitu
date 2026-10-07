"use client";

import { DirectionLink } from "@/components/ui/direction-button";

import { AppHeader } from "@/components/AppHeader";

import { Button, ButtonLink } from "@/components/ui/button";

import { useAuth, useClerk } from "@clerk/nextjs";
import { BrandLogo } from "@/components/BrandLogo";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, BookPlus, Check, ChevronRight, RefreshCw } from "lucide-react";
import type { FeedbackDimension, FeedbackDimensionId, FeedbackReference, FeedbackRefactor, SpeakingFeedback } from "@libitu/types/speaking";
import { createCorpusRemote } from "../corpus/corpus-api";
import { createSpeakingApi } from "../loadout/api/speaking-api";
import { importMissionDraft } from "../loadout/draft";
import { createFeedbackApi } from "./api";
import { FeedbackController, feedbackPending } from "./controller";
import { DIMENSIONS, draftFromMission, retryMissionRequest, suggestionRecord, validReference } from "./model";
import styles from "./Analytics.module.css";

export function AnalyticsPage({ sessionId }: { sessionId: string }) {
  const { isLoaded, userId, getToken } = useAuth();
  const clerk = useClerk();
  if (!isLoaded) return <><AppHeader active="mission" /><main className={styles.page}><p role="status">Checking sign-in…</p></main></>;
  if (!userId) return <><AppHeader active="mission" /><main className={styles.page}><section className={styles.gate}><BrandLogo className={styles.logo} /><h1>Sign in to view your report</h1><p>Your conversation and feedback belong to your account.</p><Button variant="primary" size="inherit" className={styles.primary} onClick={() => { const url = window.location.href; clerk.openSignIn({ forceRedirectUrl: url, signUpForceRedirectUrl: url }); }}>Sign in</Button></section></main></>;
  return <OwnedReport key={`${userId}:${sessionId}`} owner={userId} sessionId={sessionId} getToken={getToken} />;
}
function EvidenceLinks({ references, report, onSelect }: { references: FeedbackReference[]; report: SpeakingFeedback; onSelect: (reference: FeedbackReference) => void }) {
  const valid = references.filter(reference => validReference(reference, report.messages));
  return valid.length ? <div className={styles.evidenceLinks}>{valid.map((reference, index) => <a key={`${reference.message_id}:${reference.start}:${index}`} href={`#source-${reference.message_id}`} onClick={event => { event.preventDefault(); onSelect(reference); }}>“{reference.quote}” <ArrowUpRight size={12} aria-hidden="true" /><span className={styles.srOnly}>View source</span></a>)}</div> : null;
}
function DimensionDetail({ dimension, report, onSelect }: { dimension: FeedbackDimension | undefined; report: SpeakingFeedback; onSelect: (reference: FeedbackReference) => void }) {
  if (!dimension) return <p className={styles.empty}>Assessment details are not available yet.</p>;
  if (dimension.id === "transfer") return <>
    <p className={styles.explainer}>Each selected item counts once toward coverage. Prompted use counts and is shown separately. These observations do not establish mastery.</p>
    {(["Expressions", "Structures"] as const).map(group => {
      const items = report.result?.item_results.filter(item => group === "Structures" ? item.kind === "structure" : item.kind !== "structure") ?? [];
      return items.length ? <section className={styles.itemGroup} key={group}><h3>{group}</h3>{items.map(item => <article className={styles.item} key={item.session_item_id}>
        <div className={styles.itemHeading}><strong>{item.text}</strong><span className={`${styles.badge} ${item.status === "appropriate" ? styles.good : item.status === "inappropriate" ? styles.attention : ""}`}>{({ appropriate: "Appropriate use", inappropriate: "Needs context", uncertain: "Not confirmed", not_observed: "Not observed" })[item.status]}</span></div>
        <p>{item.reason}</p>{item.independent_uses + item.prompted_uses > 0 ? <p className={styles.small}>{item.independent_uses} independent · {item.prompted_uses} prompted</p> : null}<EvidenceLinks references={item.evidence} report={report} onSelect={onSelect} />
      </article>)}</section> : null;
    })}
  </>;
  return <div className={styles.criteria}>{dimension.criteria.length ? dimension.criteria.map(criterion => <article className={styles.criterion} key={criterion.id}><div className={styles.itemHeading}><h3>{criterion.label}</h3><span className={styles.rating}>{criterion.rating === null ? "Not assessed" : `${criterion.rating} / 4`}</span></div><p>{criterion.reason}</p><EvidenceLinks references={criterion.evidence} report={report} onSelect={onSelect} /></article>) : <p className={styles.empty}>There is not enough verified evidence to assess this dimension.</p>}</div>;
}
function Overview({ report }: { report: SpeakingFeedback }) {
  const dimensions = DIMENSIONS.map(({ id }) => report.result?.dimensions.find(value => value.id === id));
  const complete = dimensions.every(value => value?.score !== null && value?.score !== undefined);
  const points = dimensions.map((value, index) => {
    const angle = (-90 + index * 90) * Math.PI / 180, radius = (value?.score ?? 0) * .7;
    return `${110 + Math.cos(angle) * radius},${100 + Math.sin(angle) * radius}`;
  }).join(" ");
  return <section><h2 className={styles.sideTitle}>Four-dimension overview</h2>{complete ? <svg viewBox="0 0 220 206" className={styles.radar} role="img" aria-label={dimensions.map((value, index) => `${DIMENSIONS[index].label}: ${value!.score} out of 100`).join(". ")}>
    {[.25, .5, .75, 1].map(scale => <polygon key={scale} points={`110,${100 - 70 * scale} ${110 + 70 * scale},100 110,${100 + 70 * scale} ${110 - 70 * scale},100`} fill="none" stroke="#dedbd5" />)}
    <path d="M110 30V170M40 100H180" stroke="#dedbd5" /><polygon points={points} fill="rgb(83 74 183 / 14%)" stroke="#534ab7" strokeWidth="2" />
    <text x="110" y="16" textAnchor="middle">Task fit</text><text x="187" y="96">Transfer</text><text x="110" y="190" textAnchor="middle">Scenario fit</text><text x="34" y="96" textAnchor="end">Naturalness</text>
  </svg> : <p className={styles.overviewNotice}>A complete chart appears when all four dimensions have enough evidence. Unavailable scores are left blank.</p>}<p className={styles.small}>AI assessments describe this conversation. Naturalness is based on text, not pronunciation or speech timing.</p></section>;
}
function OwnedReport({ owner, sessionId, getToken }: { owner: string; sessionId: string; getToken: () => Promise<string | null> }) {
  const router = useRouter();
  const [state, setState] = useState<FeedbackController["state"]>({ report: null, loading: true, error: null, errorStatus: null, pollingPaused: false });
  const controller = useRef<FeedbackController | null>(null);
  const action = useRef<AbortController | null>(null);
  const [activeDimension, setActiveDimension] = useState<FeedbackDimensionId>("task_fit");
  const [source, setSource] = useState<FeedbackReference | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const report = state.report;
  useEffect(() => {
    const current = new FeedbackController(createFeedbackApi(owner, sessionId, getToken), setState);
    controller.current = current;
    Promise.resolve().then(() => { void current.load(); });
    return () => { current.dispose(); if (controller.current === current) controller.current = null; action.current?.abort(); action.current = null; };
  }, [owner, sessionId, getToken]);
  function selectSource(reference: FeedbackReference) {
    if (!report || !validReference(reference, report.messages)) return;
    setSource(reference); setTranscriptOpen(true);
    requestAnimationFrame(() => { const element = document.getElementById(`source-${reference.message_id}`); element?.scrollIntoView({ block: "center", behavior: "instant" }); element?.focus({ preventScroll: true }); });
  }
  async function runAction(name: string, operation: (signal: AbortSignal) => Promise<void>) {
    if (action.current) return;
    const current = new AbortController(); action.current = current; setBusy(name); setActionError(null);
    try { await operation(current.signal); }
    catch (error) { if (!current.signal.aborted) setActionError(error instanceof Error ? error.message.startsWith("Corpus sync failed") ? "Your corpus could not be reached. Please try again." : error.message : "This action could not be completed. Please try again."); }
    finally { if (action.current === current) { action.current = null; setBusy(null); } }
  }
  async function saveSuggestion(refactor: FeedbackRefactor) {
    if (!report) return;
    await runAction(refactor.id, async signal => {
      const record = suggestionRecord(report, refactor, window.location.origin);
      await createCorpusRemote(owner, getToken).save(record, signal); signal.throwIfAborted();
      setSaved(previous => [...previous, refactor.id]);
    });
  }
  async function nextMission(adjust: boolean) {
    if (!report) return;
    await runAction(adjust ? "adjust" : "retry", async signal => {
      const records = await createCorpusRemote(owner, getToken).list(signal); signal.throwIfAborted();
      const imported = draftFromMission(report.session, records);
      if (adjust || imported.missing) {
        const result = await importMissionDraft(window.localStorage, owner, imported.draft, { isCurrent: () => !signal.aborted });
        signal.throwIfAborted(); if (!result) return;
        router.push(`/loadout?reportImport=${result}${imported.missing ? "&replaceMissing=1" : ""}`); return;
      }
      const storageKey = `libitu:mission-retry:${owner}:${sessionId}`;
      let clientId = window.sessionStorage.getItem(storageKey);
      if (!clientId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)) { clientId = crypto.randomUUID(); window.sessionStorage.setItem(storageKey, clientId); }
      const session = await createSpeakingApi(owner, getToken).create(retryMissionRequest(report.session, records, clientId), signal);
      signal.throwIfAborted(); window.sessionStorage.removeItem(storageKey);
      router.push(`/speaking/${encodeURIComponent(session.id)}`);
    });
  }
  const selected = report?.result?.dimensions.find(dimension => dimension.id === activeDimension);
  const pending = feedbackPending(report);
  const stats = report?.result?.statistics;
  const userNumbers = new Map(report?.messages.filter(message => message.role === "user").map((message, index) => [message.id, index + 1]));
  return <><AppHeader active="mission" /><main className={styles.page}><section className={styles.shell} aria-label="Speaking analytics">
    <div className={styles.topbar}><span className={styles.stagePill}>Stage 5 · Analytics</span></div>
    <div className={styles.heading}><DirectionLink className={styles.back} href={`/speaking/${encodeURIComponent(sessionId)}`}><ArrowLeft size={14} aria-hidden="true" /> Conversation review</DirectionLink><div className={styles.eyebrow}>Reflect, then try again</div><h1>{report ? "Your mission report" : "Speaking report"}</h1><p>{report?.session.goal ?? "Feedback grounded in your conversation."}</p>{report ? <div className={styles.context}><span>{report.session.scenario_type === "workplace" ? "Workplace" : "Everyday life"}</span><span>{report.session.difficulty}</span>{report.session.logic_template ? <span>{report.session.logic_template.title}</span> : null}<span>{report.session.turn_count} user {report.session.turn_count === 1 ? "turn" : "turns"}</span></div> : null}</div>
    {state.error ? <div className={styles.statusBox} role="alert"><h2>{state.errorStatus === 404 ? "Report unavailable" : "Report not ready to show"}</h2><p>{state.error}</p>{state.errorStatus !== 404 && state.errorStatus !== 409 ? <Button variant="secondary" size="inherit" onClick={() => void controller.current?.refresh()} disabled={state.loading} loading={state.loading} loadingLabel="Loading…">Reload report</Button> : null}</div> : null}
    {!report && state.loading ? <div className={styles.statusBox} role="status">Loading your saved report…</div> : null}
    {report ? <>
      {pending || report.status !== "ready" ? <div className={styles.statusBox} role="status"><strong>{({ queued: "Your report is queued", processing: "Reviewing your conversation", partial: "Some feedback is available", insufficient_data: "Not enough evidence for a full assessment", failed: "The assessment could not be completed", ready: "Report ready" })[report.status]}</strong><p>{pending ? "Your transcript is saved. You can leave this page and return to the same report." : report.status === "insufficient_data" ? "Missing or unconfirmed speech is not treated as a zero. Start another mission when you are ready." : "Verified observations are kept. Unavailable scores stay blank."}</p>{state.pollingPaused ? <p>Automatic checking has paused. Your assessment can continue in the background.</p> : null}{state.pollingPaused ? <Button variant="secondary" size="inherit" disabled={state.loading} loading={state.loading} loadingLabel="Checking…" onClick={() => void controller.current?.refresh()}>Check report status</Button> : null}{report.retryable && !pending ? <Button variant="secondary" size="inherit" disabled={state.loading} loading={state.loading} loadingLabel="Requesting…" onClick={() => void controller.current?.retry()}><RefreshCw size={13} aria-hidden="true" />Retry assessment</Button> : null}</div> : null}
      <div className={styles.body}><div className={styles.main}>
        <div className={styles.scoreRow} role="tablist" aria-label="Assessment dimensions">{DIMENSIONS.map(({ id, label, description }, index) => {
          const dimension = report.result?.dimensions.find(value => value.id === id), score = dimension?.score;
          return <button type="button" role="tab" id={`tab-${id}`} aria-controls="dimension-detail" aria-selected={activeDimension === id} tabIndex={activeDimension === id ? 0 : -1} className={`${styles.scoreCard} ${activeDimension === id ? styles.selected : ""}`} key={id} onClick={() => setActiveDimension(id)} onKeyDown={event => {
            const next = event.key === "ArrowRight" ? (index + 1) % 4 : event.key === "ArrowLeft" ? (index + 3) % 4 : event.key === "Home" ? 0 : event.key === "End" ? 3 : null;
            if (next !== null) { event.preventDefault(); setActiveDimension(DIMENSIONS[next].id); document.getElementById(`tab-${DIMENSIONS[next].id}`)?.focus(); }
          }}><span className={styles.scoreLabel}>{label}</span><span className={styles.score}>{score === null || score === undefined ? "—" : score}<small>{score !== null && score !== undefined ? "/100" : "Not assessed"}</small></span><span className={styles.scoreBar}>{score !== null && score !== undefined ? <span style={{ width: `${score}%` }} /> : null}</span><span className={styles.scoreDescription}>{description}</span></button>;
        })}</div>
        <section className={styles.detail} role="tabpanel" id="dimension-detail" aria-labelledby={`tab-${activeDimension}`} tabIndex={0}><div className={styles.sectionHeading}><h2>{DIMENSIONS.find(dimension => dimension.id === activeDimension)?.label}</h2><span className={styles.badge}>{activeDimension === "transfer" ? "Coverage" : "AI assessment"}</span></div>{selected?.summary ? <p className={styles.summary}>{selected.summary}</p> : null}<DimensionDetail dimension={selected} report={report} onSelect={selectSource} /></section>
        {report.result?.logic_stages.length ? <section><div className={styles.sectionHeading}><h2>Conversation structure</h2><span className={styles.badge}>Separate from task fit</span></div><div className={styles.logicStages}>{report.result.logic_stages.map((stage, index) => <article key={`${stage.label}:${index}`}><h3>{stage.label}<span className={styles.small}>{stage.status === "observed" ? "Observed" : stage.status === "uncertain" ? "Not confirmed" : "Not observed"}</span></h3><p>{stage.reason}</p><EvidenceLinks references={stage.evidence} report={report} onSelect={selectSource} /></article>)}</div></section> : null}
        {report.result ? <section><div className={styles.sectionHeading}><h2>Ways to refine your language</h2><span className={styles.badge}>{Math.min(3, report.result.refactors.length)} {report.result.refactors.length === 1 ? "suggestion" : "suggestions"}</span></div><p className={styles.explainer}>AI suggestions aim to preserve your meaning. Choose wording that still says what you intend.</p><div className={styles.refactors}>{report.result.refactors.slice(0, 3).filter(refactor => validReference(refactor.original, report.messages)).map(refactor => <article className={styles.refactor} key={refactor.id}><div className={styles.refactorHeader}><span className={styles.badge}>Your turn {userNumbers.get(refactor.original.message_id)}</span><a href={`#source-${refactor.original.message_id}`} onClick={event => { event.preventDefault(); selectSource(refactor.original); }}>View source <ArrowUpRight size={12} aria-hidden="true" /></a></div><div className={styles.comparison}><div><h3>Your version</h3><p>{refactor.original.quote}</p></div><div><h3>Suggested wording</h3><p>{refactor.suggested}</p></div></div><div className={styles.refactorReason}><p>{refactor.reason}</p>{refactor.save_text ? <Button variant="primary" size="inherit" type="button" disabled={!!busy || saved.includes(refactor.id)} loading={busy === refactor.id} loadingLabel="Saving…" onClick={() => void saveSuggestion(refactor)}>{saved.includes(refactor.id) ? <Check size={14} aria-hidden="true" /> : <BookPlus size={14} aria-hidden="true" />}{saved.includes(refactor.id) ? "Saved to corpus" : "Save AI suggestion"}</Button> : null}</div></article>)}</div>{!report.result.refactors.length ? <p className={styles.empty}>No verified rewrite suggestions for this conversation.</p> : null}</section> : null}
        <details className={styles.transcript} open={transcriptOpen} onToggle={event => setTranscriptOpen(event.currentTarget.open)}><summary>Source transcript <span>{report.messages.length} messages</span></summary><p className={styles.explainer}>This is the saved transcript used for this assessment. Unconfirmed turns do not contribute to scores.</p>{report.messages.length ? report.messages.map(message => {
          const match = source?.message_id === message.id && validReference(source, report.messages) ? source : null;
          return <article key={message.id} id={`source-${message.id}`} tabIndex={-1} className={`${styles.sourceMessage} ${message.role === "user" ? styles.userMessage : ""}`}><h3>{message.role === "user" ? `Your turn ${userNumbers.get(message.id)}` : "AI partner"}<span>{message.status === "final" ? message.input_source : message.status === "interrupted" ? "Interrupted · may include words not heard" : "Transcript not confirmed"}</span></h3><p>{match ? <>{message.text.slice(0, match.start)}<mark>{match.quote}</mark>{message.text.slice(match.end)}</> : message.text || "Transcript unavailable"}</p></article>;
        }) : <p className={styles.empty}>There are no saved messages.</p>}</details>
        {report.result?.notices.length ? <div className={styles.notices}>{report.result.notices.map((notice, index) => <p key={index}>{notice}</p>)}</div> : null}
        <p className={styles.version}>Assessment standard: {report.rubric_version} · {report.analysis_version}</p>
      </div><aside className={styles.sidebar} aria-label="Report summary and next steps">
        <Overview report={report} />
        <section><h2 className={styles.sideTitle}>Session at a glance</h2><dl className={styles.stats}><div><dt>User turns</dt><dd>{stats?.user_turns ?? report.session.turn_count}</dd></div><div><dt>Assessed turns</dt><dd>{stats?.assessed_turns ?? "—"}</dd></div><div><dt>Unconfirmed turns</dt><dd>{stats?.excluded_turns ?? "—"}</dd></div><div><dt>Average words / turn</dt><dd>{stats ? stats.average_words.toFixed(1) : "—"}</dd></div><div><dt>Expressions used</dt><dd>{stats ? `${stats.used_expressions} / ${stats.selected_expressions}` : "—"}</dd></div><div><dt>Structures used</dt><dd>{stats ? `${stats.used_structures} / ${stats.selected_structures}` : "—"}</dd></div></dl></section>
        <section><h2 className={styles.sideTitle}>Keep the practice going</h2><div className={styles.nextSteps}><Button variant="primary" size="inherit" type="button" className={styles.primary} disabled={!!busy} loading={busy === "retry"} loadingLabel="Preparing mission…" onClick={() => void nextMission(false)}><span>Retry this mission<small>Same goal, settings and selected language</small></span><ChevronRight size={16} aria-hidden="true" /></Button><Button variant="secondary" size="inherit" type="button" disabled={!!busy} loading={busy === "adjust"} loadingLabel="Preparing loadout…" onClick={() => void nextMission(true)}><span>Adjust loadout<small>Save this setup without replacing your draft</small></span><ChevronRight size={16} aria-hidden="true" /></Button><ButtonLink variant="secondary" size="inherit" href="/loadout"><span>New mission<small>Open mission setup</small></span><ChevronRight size={16} aria-hidden="true" /></ButtonLink></div>{actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}</section>
        <p className={styles.small}>This report stays linked to the original mission. Starting again creates a separate conversation.</p>
      </aside></div>
    </> : null}
  </section></main></>;
}
