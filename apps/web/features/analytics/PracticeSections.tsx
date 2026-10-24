"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select";
import type { FeedbackReference, PracticeComparison, PracticeUseSummary, PracticeVariation, SpeakingFeedback, SpeakingPlan, SpeakingSupportLevel } from "@libitu/types/speaking";
import { createCorpusRemote } from "../corpus/corpus-api";
import { createSpeakingApi } from "../loadout/api/speaking-api";
import { importMissionDraft } from "../loadout/draft";
import { missionHref } from "../navigation/return-location";
import { isSupportLevel, SUPPORT_OPTIONS } from "../speaking/support";
import { practiceDraft, secondRoundSupport, validMissedOpportunities } from "./model";
import styles from "./Analytics.module.css";

const supportLabel = (level: SpeakingSupportLevel | null) => SUPPORT_OPTIONS.find(option => option.value === level)?.label ?? "Not recorded";
const changeLabels = { setting: "Setting", goal: "Goal", user_role: "Your role", ai_role: "AI partner's role" };

export function MissedOpportunities({ report, onSelect }: { report: SpeakingFeedback; onSelect: (reference: FeedbackReference) => void }) {
  const suggestions = validMissedOpportunities(report);
  if (!report.result?.missed_opportunities_status || report.result.missed_opportunities_status === "not_requested") return null;
  return <section aria-label="Missed opportunities"><div className={styles.sectionHeading}><h2>Missed opportunities</h2><span className={styles.badge}>AI suggestions</span></div>
    <p className={styles.explainer}>Alternative wording for a reply after a presented opportunity. These suggestions are not language you actually used and do not count toward your results.</p>
    <div className={styles.refactors}>{suggestions.map(suggestion => <article className={styles.refactor} key={suggestion.id}>
      <div className={styles.refactorHeader}><strong>{report.session.items.find(item => item.id === suggestion.session_item_id)?.text}</strong><a href={`#source-${suggestion.original.message_id}`} onClick={event => { event.preventDefault(); onSelect(suggestion.original); }}>View source</a></div>
      <div className={styles.comparison}><div><h3>Your original reply</h3><p>{suggestion.original.quote}</p></div><div><h3>AI suggestion</h3><p>{suggestion.suggested}</p></div></div><p className={styles.refactorReason}>{suggestion.reason}</p>
    </article>)}</div>
    {!suggestions.length ? <p className={styles.empty}>{report.result.missed_opportunities_status === "unavailable" ? "Verified suggestions are unavailable for this report." : "No verified missed-opportunity suggestions for this conversation."}</p> : null}
  </section>;
}

export function SecondRound({ report, owner, getToken, returnTo, disabled }: { report: SpeakingFeedback; owner: string; getToken: () => Promise<string | null>; returnTo: string; disabled: boolean }) {
  const router = useRouter();
  const [variation, setVariation] = useState<PracticeVariation>("details");
  const [support, setSupport] = useState<SpeakingSupportLevel>(() => secondRoundSupport(report));
  const [plan, setPlan] = useState<SpeakingPlan | null>(null);
  const [busy, setBusy] = useState<"prepare" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef<AbortController | null>(null);
  useEffect(() => () => flight.current?.abort(), []);
  async function run(importing: boolean) {
    if (flight.current || disabled) return;
    const abort = new AbortController(); flight.current = abort; setBusy(importing ? "import" : "prepare"); setError(null);
    try {
      if (!importing) {
        const value = await createSpeakingApi(owner, getToken).practicePlan(report.session_id, variation, abort.signal);
        abort.signal.throwIfAborted(); setPlan(value);
      } else if (plan) {
        const records = await createCorpusRemote(owner, getToken).list(abort.signal);
        abort.signal.throwIfAborted();
        const draft = practiceDraft(report, plan, support, records);
        const imported = await importMissionDraft(window.localStorage, owner, draft, { isCurrent: () => !abort.signal.aborted });
        abort.signal.throwIfAborted();
        if (imported) router.push(missionHref("loadout", returnTo, undefined, { reportImport: imported }));
      }
    } catch (value) { if (!abort.signal.aborted) setError(value instanceof Error ? value.message : "The second round could not be prepared. Your existing draft is kept."); }
    finally { if (flight.current === abort) { flight.current = null; setBusy(null); } }
  }
  if (!report.session.mission_plan || report.session.status !== "completed") return null;
  return <section className={styles.practicePanel} aria-label="Prepare a second round"><h2 className={styles.sideTitle}>Prepare a second round</h2>
    <p className={styles.small}>Keep the same language and target roles while changing the conversation. Your existing draft is kept.</p>
    <label>Variation<SelectField aria-label="Practice variation" value={variation} disabled={!!busy || disabled} onValueChange={value => { setVariation(value as PracticeVariation); setPlan(null); setError(null); }} options={[{ value: "details", label: "Change details" }, { value: "role_swap", label: "Swap roles", disabled: report.session.mission_plan.user_role === report.session.mission_plan.ai_role }]} /></label>
    <label>Support for this round<SelectField aria-label="Second-round support" value={support} disabled={!!busy || disabled} onValueChange={value => { if (isSupportLevel(value)) setSupport(value); }} options={SUPPORT_OPTIONS} /></label>
    <p className={styles.small}>This support choice is a practice preference, not a mastery assessment.</p>
    <Button variant="secondary" size="inherit" disabled={!!busy || disabled} loading={busy === "prepare"} loadingLabel="Preparing second round…" onClick={() => void run(false)}>Prepare second round</Button>
    {plan ? <div className={styles.practiceReview}><h3>Review the changes</h3>{plan.candidates.map(candidate => <article key={candidate.id}><strong>{candidate.title}</strong><p>{candidate.goal}</p><dl>{candidate.changes?.map(change => <div key={change.field}><dt>{changeLabels[change.field]}</dt><dd><span>Before: {change.before}</span><span>After: {change.after}</span></dd></div>)}</dl></article>)}
      <p className={styles.small}>Confirm to import these scenes into Loadout, where you can choose one before starting.</p>
      <Button variant="primary" size="inherit" disabled={!!busy || disabled} loading={busy === "import"} loadingLabel="Saving second round…" onClick={() => void run(true)}>Confirm and open Loadout</Button>
    </div> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </section>;
}

function UseSummary({ value }: { value: PracticeUseSummary | null }) {
  if (!value) return <p className={styles.small}>Not available</p>;
  return <><p>{value.independent_uses} independent · {value.prompted_uses} assisted · {value.uncertain_assistance_uses} unknown assistance</p>
    <p className={styles.small}>Use: {value.status.replaceAll("_", " ")} · Opportunity: {value.opportunity_status ?? "Not recorded"}</p>
    {value.excluded_reason ? <p className={styles.small}>Excluded: {value.excluded_reason}</p> : null}</>;
}
export function PracticeComparisonSection({ report, owner, getToken, returnTo }: { report: SpeakingFeedback; owner: string; getToken: () => Promise<string | null>; returnTo: string }) {
  const [value, setValue] = useState<PracticeComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!report.session.practice) return;
    const abort = new AbortController();
    setValue(null); setError(null);
    void createSpeakingApi(owner, getToken).comparison(report.session_id, abort.signal).then(result => { if (!abort.signal.aborted) setValue(result); })
      .catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "The comparison could not be read."); });
    return () => abort.abort();
  }, [owner, report.session_id, report.session.practice, report.status, getToken, attempt]);
  if (!report.session.practice) return null;
  return <section aria-label="Practice comparison"><div className={styles.sectionHeading}><h2>Practice comparison</h2><span className={styles.badge}>{value?.status === "ready" ? "Recorded facts" : "Existing reports"}</span></div>
    <p className={styles.explainer}>Compare recorded use and final support in these two conversations. This does not measure learning gain.</p>
    {error ? <p className={styles.error} role="alert">{error}</p> : !value ? <p role="status">Loading existing reports…</p> : <p>{value.reason}</p>}
    {value?.status === "ready" ? <>
      <p className={styles.small}>Before: {supportLabel(value.parent_support_level)} · After: {supportLabel(value.child_support_level)}</p>
      {value.items.map(item => <article className={styles.refactor} key={item.session_item_id}><h3>{item.text} <span className={styles.badge}>{item.role}</span></h3><div className={styles.comparison}><div><h3>Before</h3><UseSummary value={item.before} /></div><div><h3>After</h3><UseSummary value={item.after} /></div></div></article>)}
    </> : null}
    {value?.parent_session_id ? <Link className={styles.small} href={missionHref("analytics", returnTo, value.parent_session_id)}>View original report</Link> : null}
    {error || value?.status === "pending" ? <Button variant="secondary" size="inherit" onClick={() => setAttempt(current => current + 1)}>Check comparison</Button> : null}
  </section>;
}
