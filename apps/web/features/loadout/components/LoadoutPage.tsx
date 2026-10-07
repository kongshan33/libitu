"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth, useClerk } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check } from "lucide-react";
import type { SpeakingOptions } from "@libitu/types/speaking";
import { AuthControls } from "../../auth/components/AuthControls";
import { useSavedCorpus } from "../../corpus/useSavedCorpus";
import { createSpeakingApi, getSpeakingOptions, SpeakingApiError } from "../api/speaking-api";
import { useLoadoutDraft } from "../hooks/useLoadoutDraft";
import { expressionText, prepareSubmission, resolveSelection, selectionError, toggleSelection, type LoadoutDraft } from "../draft";
import { safeReturnPath } from "../navigation";
import { CorpusPicker } from "./CorpusPicker";
import { LoadoutPreview, StartIcon } from "./LoadoutPreview";
import styles from "./Loadout.module.css";

export function LoadoutPage() {
  const { isLoaded, userId, getToken } = useAuth();
  const clerk = useClerk();
  const router = useRouter();
  const owner = userId ?? null;
  const corpus = useSavedCorpus();
  const local = useLoadoutDraft(owner, isLoaded);
  const [options, setOptions] = useState<SpeakingOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [returnTo, setReturnTo] = useState("/");
  const [query, setQuery] = useState("");
  const [reportImport, setReportImport] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [submission, setSubmission] = useState<{ owner: string | null; busy: boolean; error: string | null; authError: boolean }>({ owner: null, busy: false, error: null, authError: false });
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => { const params = new URL(window.location.href).searchParams; setReturnTo(safeReturnPath(params.get("returnTo"))); if (params.has("reportImport")) setReportImport(`${params.get("reportImport") === "saved" ? "The mission was saved as an additional draft below. Your current setup is unchanged." : "Your previous mission is ready to adjust."}${params.has("replaceMissing") ? " Some original items were deleted. Remove unavailable selections and choose replacements before starting." : ""}`); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setOptionsError(null);
    void getSpeakingOptions(controller.signal).then(setOptions).catch((error: unknown) => {
      if (!controller.signal.aborted) setOptionsError(error instanceof Error ? error.message : "Mission options could not be loaded.");
    });
    return () => controller.abort();
  }, [optionsAttempt]);
  useEffect(() => {
    setSource(""); setQuery("");
    setSubmission({ owner, busy: false, error: null, authError: false });
    return () => { inFlight.current?.abort(); inFlight.current = null; };
  }, [owner]);

  const draft = local.draft;
  const selected = resolveSelection(draft, corpus.records);
  const busy = submission.owner === owner && submission.busy;
  const submitError = submission.owner === owner ? submission.error : null;
  const authError = submission.owner === owner && submission.authError;
  const sourceChoices = [...new Map(corpus.records.map((record) => [record.contentId ?? record.sourceUrl, record.sourceTitle || "Personal corpus"])).entries()];
  const search = query.trim().toLocaleLowerCase();
  const filtered = corpus.records.filter((record) => (!source || (record.contentId ?? record.sourceUrl) === source)
    && (!search || `${expressionText(record)} ${record.item.meaning ?? ""} ${record.item.tags.join(" ")} ${record.sourceTitle}`.toLocaleLowerCase().includes(search)));
  const validation = selectionError(draft, corpus.records, Boolean(owner));
  const canRetrySnapshot = Boolean(owner && draft.submission);
  const blocked = !local.ready || Boolean(local.error) || !isLoaded || !options || busy
    || (!canRetrySnapshot && (!corpus.ready || corpus.busy || Boolean(corpus.error) || Boolean(validation)));

  function change(patch: Partial<LoadoutDraft>) {
    if (busy) return;
    void local.update({ ...draft, ...patch, submission: undefined });
    setSubmission({ owner, busy: false, error: null, authError: false });
  }
  async function signIn() {
    if (!await local.update(draft)) return;
    const returnUrl = window.location.href;
    clerk.openSignIn({ forceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl });
  }
  async function start() {
    if (inFlight.current || blocked) return;
    if (!owner || authError) { await signIn(); return; }
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmission({ owner, busy: true, error: null, authError: false });
    try {
      const prepared = prepareSubmission(draft, corpus.records, () => crypto.randomUUID());
      if (!await local.update(prepared)) throw new Error("Save your draft on this device before starting. Retry saving above.");
      controller.signal.throwIfAborted();
      const session = await createSpeakingApi(owner, getToken).create(prepared.submission!.request, controller.signal);
      controller.signal.throwIfAborted();
      router.push(`/speaking/${encodeURIComponent(session.id)}?returnTo=${encodeURIComponent(returnTo)}`);
    } catch (error) {
      if (!controller.signal.aborted) setSubmission({ owner, busy: false,
        error: error instanceof Error ? error.message : "Your mission could not be saved. Please retry.",
        authError: error instanceof SpeakingApiError && error.status === 401 });
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }

  return <main className={styles.page}><section className={styles.shell} aria-label="Speaking loadout">
    <header className={styles.topbar}>
      <Link className={styles.logo} href="/">libitu</Link><span className={styles.topbarTitle}>Mission loadout</span>
      <span className={styles.stagePill} aria-current="page">Stage 3 · Mission</span><AuthControls />
    </header>
    <div className={styles.body}>
      <div className={styles.main}>
        <Link href={returnTo} className={styles.back}><ArrowLeft size={14} aria-hidden="true" /> Back to learning</Link>
        <div className={styles.pageHeading}><div className={styles.eyebrow}>Prepare to use your English</div><h1>Mission loadout</h1><p>Choose a goal and a small set of saved language for your next conversation.</p></div>
        {reportImport ? <p className={styles.notice} role="status">{reportImport}</p> : null}
        {!local.ready && !local.error ? <p className={styles.notice} role="status">Loading your saved loadout…</p> : null}
        {local.pending ? <p className={styles.fieldHelp} role="status">Saving your draft on this device… Keep this page open until saving finishes.</p> : null}
        {local.error ? <div className={styles.error} role="alert"><p>{local.error}</p><button type="button" onClick={local.retry}>Retry saving draft</button></div> : null}
        {local.deviceDrafts.map((deviceDraft, index) => <div className={styles.notice} key={index}><strong>You also have a saved draft.</strong><p>{deviceDraft.goal || "An untitled mission"} · {deviceDraft.selectedKeys.length} selected items. Using it replaces the setup below.</p><button type="button" disabled={busy} onClick={() => local.adopt(index)}>Use device draft{local.deviceDrafts.length > 1 ? ` ${index + 1}` : ""}</button></div>)}

        <fieldset className={styles.section} disabled={!local.ready || busy}>
          <legend><span className={styles.stepNumber}>1</span> Define your mission</legend>
          <div className={styles.fieldGrid}>
            <label>Scenario type<select aria-label="Scenario type" value={draft.scenarioType} onChange={(event) => change({ scenarioType: event.target.value as LoadoutDraft["scenarioType"] })}><option value="workplace">Workplace</option><option value="everyday">Everyday life</option></select></label>
            <label>Difficulty<select aria-label="Difficulty" value={draft.difficulty} onChange={(event) => change({ difficulty: event.target.value as LoadoutDraft["difficulty"] })}><option value="guided">Guided</option><option value="standard">Standard</option><option value="challenging">Challenging</option></select></label>
            <label className={styles.goalField}>Mission goal<textarea aria-label="Mission goal" value={draft.goal} maxLength={500} rows={3} placeholder="For example: agree on a revised project deadline" onChange={(event) => change({ goal: event.target.value })} aria-describedby="mission-goal-help" /><span id="mission-goal-help" className={styles.fieldHelp}>Describe the outcome you want. {draft.goal.length} / 500</span></label>
            <label>Feedback level<select aria-label="Feedback level" value={draft.feedbackLevel} onChange={(event) => change({ feedbackLevel: event.target.value as LoadoutDraft["feedbackLevel"] })}><option value="light">Light</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option></select></label>
          </div>
        </fieldset>

        <fieldset className={styles.section} disabled={!local.ready || busy}>
          <legend><span className={styles.stepNumber}>2</span> Choose your logic <span className={styles.optional}>Optional</span></legend>
          <p className={styles.sectionIntro}>A conversational strategy gives your mission a shape. You can also start without one.</p>
          {optionsError ? <div className={styles.error} role="alert"><p>{optionsError}</p><button type="button" onClick={() => setOptionsAttempt((value) => value + 1)}>Retry mission options</button></div> : !options ? <p role="status">Loading conversation strategies…</p> : null}
          <div className={styles.logicGrid} role="group" aria-label="Logic template">
            {options?.logic_templates.map((logic) => <button type="button" key={logic.id} aria-pressed={draft.logicTemplateId === logic.id}
              className={`${styles.logicCard} ${draft.logicTemplateId === logic.id ? styles.selectedCard : ""}`}
              onClick={() => change({ logicTemplateId: draft.logicTemplateId === logic.id ? null : logic.id })}>
              <span className={styles.logicTitle}>{logic.title}{draft.logicTemplateId === logic.id ? <Check size={15} aria-hidden="true" /> : null}</span>
              <span className={styles.logicDescription}>{logic.description}</span><span className={styles.logicFlow}>{logic.steps.join(" → ")}</span>
            </button>)}
          </div>
          {draft.logicTemplateId ? <button className={styles.textButton} type="button" onClick={() => change({ logicTemplateId: null })}>Clear logic template</button> : null}
        </fieldset>

        <section className={styles.section} aria-label="Your saved corpus">
          <h2><span className={styles.stepNumber}>3</span> Equip your language</h2>
          <p className={styles.sectionIntro}>Select at least one item. Use up to 3 structures and 5 expressions from any source.</p>
          {!corpus.ready && !corpus.error ? <p className={styles.notice} role="status">{corpus.busy && owner ? "Loading and syncing your corpus…" : "Loading your corpus…"}</p> : null}
          {corpus.error ? <div className={styles.error} role="alert"><p>{corpus.error}</p><button type="button" onClick={corpus.retry}>Retry corpus sync</button></div> : null}
          {corpus.ready && !corpus.records.length ? <div className={styles.emptyLibrary}><h3>Your corpus is empty</h3><p>Save an expression or structure while learning, then come back to equip it.</p><Link href={returnTo}>Find language to save <StartIcon /></Link></div> : null}
          {corpus.records.length ? <>
            <div className={styles.filters}><label>Search corpus<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Expression, meaning or tag" /></label>
              <label>Source<select aria-label="Source" value={source} onChange={(event) => setSource(event.target.value)}><option value="">All sources</option>{sourceChoices.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label></div>
            <CorpusPicker title="Structures" records={filtered.filter((record) => record.item.kind === "structure")} structures selectedKeys={draft.selectedKeys}
              count={selected.structures.length} limit={3} disabled={!local.ready || busy} onToggle={(record) => change(toggleSelection(draft, record, corpus.records))} />
            <CorpusPicker title="Expressions" records={filtered.filter((record) => record.item.kind !== "structure")} selectedKeys={draft.selectedKeys}
              count={selected.expressions.length} limit={5} disabled={!local.ready || busy} onToggle={(record) => change(toggleSelection(draft, record, corpus.records))} />
          </> : null}
        </section>
      </div>
      <LoadoutPreview draft={draft} records={corpus.records} logic={options?.logic_templates.find((logic) => logic.id === draft.logicTemplateId)} submitting={busy}
        onRemove={(key) => change({ selectedKeys: draft.selectedKeys.filter((item) => item !== key) })}>
        {submitError ? <p className={styles.submitError} role="alert">{submitError}</p> : null}
        {validation && !canRetrySnapshot ? <p className={styles.validation} id="loadout-validation">{validation}</p> : null}
        <button type="button" className={styles.startButton} disabled={blocked} onClick={() => void start()} aria-describedby={validation && !canRetrySnapshot ? "loadout-validation" : undefined}>
          {busy ? "Saving mission…" : !owner || authError ? "Sign in to start mission" : canRetrySnapshot ? "Retry start mission" : "Start mission"}<StartIcon />
        </button>
        {!owner ? <p className={styles.fieldHelp}>You can prepare here. Sign in when you are ready to save your mission.</p> : null}
      </LoadoutPreview>
    </div>
  </section></main>;
}
