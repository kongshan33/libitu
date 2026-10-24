"use client";

import { currentAuthReturnUrl, missionHref } from "@/features/navigation/return-location";
import { ContentSkeleton } from "@/components/ui/ContentSkeleton";
import { DirectionLink } from "@/components/ui/direction-button";
import { SelectField } from "@/components/ui/select";
import { AppHeader } from "@/components/AppHeader";
import { Textarea, Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import Link from "@/components/ui/PrefetchLink";
import { useRouter } from "next/navigation";
import { useAuth, useClerk } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check } from "lucide-react";
import type { SpeakingOptions, SpeakingTargetRole } from "@libitu/types/speaking";
import { useSavedCorpus } from "../../corpus/useSavedCorpus";
import { createSpeakingApi, getSpeakingOptions, SpeakingApiError } from "../api/speaking-api";
import { useLoadoutDraft } from "../hooks/useLoadoutDraft";
import { adjustSceneTarget, automaticCandidate, changeDraftSupport, currentCandidate, draftSignature, expressionText, missionInputSignature, missionPlanError, missionSelectionError, preparePlannedSubmission, sceneFitAdvice, targetRole, toggleMissionSelection, type LoadoutDraft, type SceneTargetAdjustment } from "../draft";
import { isSupportLevel, SUPPORT_OPTIONS } from "../../speaking/support";
import { prepareMissionNavigation, startMissionPhase } from "../../speaking/mission-timing";
import { missionFitProblem, missionProblem, type MissionProblem } from "../problems";
import { MissionRecovery } from "./MissionRecovery";
import { CorpusPicker } from "./CorpusPicker";
import { LoadoutPreview, StartIcon } from "./LoadoutPreview";
import { SupportHistory } from "./SupportHistory";
import styles from "./Loadout.module.css";

export function LoadoutPage({ returnTo = "/", reportImport: reportOrigin = null, replaceMissing = false }: { returnTo?: string; reportImport?: string | null; replaceMissing?: boolean } = {}) {
  const { isLoaded, userId, getToken } = useAuth();
  const clerk = useClerk();
  const router = useRouter();
  const owner = userId ?? null;
  const corpus = useSavedCorpus();
  const local = useLoadoutDraft(owner, isLoaded);
  const [options, setOptions] = useState<SpeakingOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [submission, setSubmission] = useState<{ owner: string | null; busy: boolean; phase?: "preparing" | "saving"; error: MissionProblem | null; authError: boolean }>({ owner: null, busy: false, error: null, authError: false });
  const [generation, setGeneration] = useState<{ owner: string | null; busy: boolean; error: MissionProblem | null }>({ owner: null, busy: false, error: null });
  const [manualOpen, setManualOpen] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(false);
  const tipsRef = useRef<HTMLDetailsElement>(null);
  const comparisonRef = useRef<HTMLDetailsElement>(null);
  const preferencesRef = useRef<HTMLTextAreaElement>(null);
  const recoveryRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const planFlight = useRef<AbortController | null>(null);
  const draft = local.draft;
  const inputSignature = missionInputSignature(draft, corpus.records);
  const latest = useRef({ owner, inputSignature });
  latest.current = { owner, inputSignature };

  useEffect(() => {
    const controller = new AbortController();
    setOptionsError(null);
    void getSpeakingOptions(controller.signal).then(setOptions).catch((error: unknown) => {
      if (!controller.signal.aborted) setOptionsError(error instanceof Error ? error.message : "Mission options could not be loaded.");
    });
    return () => controller.abort();
  }, [optionsAttempt]);
  useEffect(() => {
    setSource(""); setQuery(""); setManualOpen(false); setTipsOpen(false);
    setSubmission({ owner, busy: false, error: null, authError: false });
    return () => { inFlight.current?.abort(); inFlight.current = null; };
  }, [owner]);
  useEffect(() => {
    // Also fence another tab's input changes and corpus sync/account transitions.
    inFlight.current?.abort(); inFlight.current = null;
    setSubmission({ owner, busy: false, error: null, authError: false });
    planFlight.current?.abort(); planFlight.current = null;
    setGeneration({ owner, busy: false, error: null });
    return () => { planFlight.current?.abort(); planFlight.current = null; };
  }, [owner, inputSignature]);

  const busy = submission.owner === owner && submission.busy;
  const generating = generation.owner === owner && generation.busy;
  const submitError = submission.owner === owner ? submission.error : null;
  const generationError = generation.owner === owner ? generation.error : null;
  const problem = submitError ?? generationError;
  const fitAdvice = problem?.kind === "fit" ? sceneFitAdvice(draft, corpus.records) : undefined;
  const primaryCount = draft.selectedKeys.filter(key => targetRole(draft, key) === "primary").length;
  const opportunityCount = draft.selectedKeys.length - primaryCount;
  useEffect(() => {
    if (problem) { recoveryRef.current?.focus({ preventScroll: true }); recoveryRef.current?.scrollIntoView({ block: "nearest" }); }
  }, [problem]);
  const authError = submission.owner === owner && submission.authError;
  const sourceChoices = [...new Map(corpus.records.map(record => [record.contentId ?? record.sourceUrl, record.sourceTitle || "Personal corpus"])).entries()];
  const search = query.trim().toLocaleLowerCase();
  const filtered = corpus.records.filter(record => (!source || (record.contentId ?? record.sourceUrl) === source)
    && (!search || `${expressionText(record)} ${record.item.meaning ?? ""} ${record.item.tags.join(" ")} ${record.sourceTitle}`.toLocaleLowerCase().includes(search)));
  const groups = new Map<string, typeof filtered>();
  for (const record of filtered) {
    const tag = record.item.tags.find(value => value !== "idiom") ?? "Function not yet labelled";
    const title = tag === "Function not yet labelled" ? tag : tag.charAt(0).toUpperCase() + tag.slice(1);
    groups.set(title, [...(groups.get(title) ?? []), record]);
  }
  const validation = missionPlanError(draft, corpus.records);
  const targetError = missionSelectionError(draft, corpus.records, Boolean(owner));
  const candidate = currentCandidate(draft, corpus.records);
  const plan = draft.plan?.signature === inputSignature ? draft.plan.value : null;
  const canRetrySnapshot = Boolean(owner && draft.submission?.signature === draftSignature(draft));
  const linked = Boolean(draft.plan?.value.practice_source);
  const setupLocked = linked || canRetrySnapshot;
  const blocked = !local.ready || Boolean(local.error) || !isLoaded || !options || busy || generating
    || (!canRetrySnapshot && (!corpus.ready || corpus.busy || Boolean(corpus.error) || Boolean(targetError)));
  const generationBlocked = !local.ready || Boolean(local.error) || !isLoaded || busy || generating || setupLocked
    || !corpus.ready || corpus.busy || Boolean(corpus.error) || Boolean(targetError);

  function change(patch: Partial<LoadoutDraft>, preservePlan = false) {
    if (busy || canRetrySnapshot || linked && !preservePlan) return;
    planFlight.current?.abort(); planFlight.current = null;
    setGeneration({ owner, busy: false, error: null });
    void local.update({ ...draft, ...patch, ...(!preservePlan ? { plan: undefined, selectedCandidateId: undefined } : {}), submission: undefined });
    setSubmission({ owner, busy: false, error: null, authError: false });
  }
  function changeRole(key: string, role: SpeakingTargetRole) {
    change({ targetRoles: { ...Object.fromEntries(draft.selectedKeys.map(value => [value, targetRole(draft, value)])), [key]: role } });
  }
  function showTips() {
    setTipsOpen(true);
    tipsRef.current?.querySelector("summary")?.focus();
    tipsRef.current?.scrollIntoView({ block: "center" });
  }
  function showPreferences() {
    preferencesRef.current?.focus();
    preferencesRef.current?.scrollIntoView({ block: "center" });
  }
  function showScenes() {
    setManualOpen(true);
    comparisonRef.current?.querySelector("summary")?.focus();
    comparisonRef.current?.scrollIntoView({ block: "center" });
  }
  function adjustTarget(key: string, action: SceneTargetAdjustment) {
    const adjusted = adjustSceneTarget(draft, key, action);
    if (adjusted !== draft) change(adjusted);
  }
  async function signIn() {
    if (!await local.update(draft)) return;
    const returnUrl = currentAuthReturnUrl();
    clerk.openSignIn({ forceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl });
  }
  async function generate() {
    if (inFlight.current || planFlight.current || generationBlocked) return;
    if (!owner) { await signIn(); return; }
    const controller = new AbortController();
    planFlight.current = controller;
    const signature = inputSignature;
    const current = () => !controller.signal.aborted && latest.current.owner === owner && latest.current.inputSignature === signature
      && (clerk.user?.id ?? null) === owner;
    setSubmission({ owner, busy: false, error: null, authError: false });
    setGeneration({ owner, busy: true, error: null });
    try {
      const value = await createSpeakingApi(owner, getToken).plan({ scenario_type: draft.scenarioType, brief: draft.goal.trim(), candidate_count: 2,
        targets: draft.selectedKeys.map(key => ({ corpus_item_id: corpus.records.find(record => record.key === key)!.serverId!, role: targetRole(draft, key) })) }, controller.signal);
      if (!current()) return;
      if (!await local.update({ ...draft, plan: { signature, value }, selectedCandidateId: undefined, submission: undefined }, draft)) throw new Error("Your draft changed or could not be saved while planning. Review it and generate scenes again.");
      if (current()) setGeneration({ owner, busy: false, error: null });
    } catch (error) {
      if (current()) {
        setGeneration({ owner, busy: false, error: missionProblem(error, "preparing") });
        if (error instanceof SpeakingApiError && error.status === 401) setSubmission({ owner, busy: false, error: null, authError: true });
      }
    } finally { if (planFlight.current === controller) planFlight.current = null; }
  }
  async function start() {
    if (inFlight.current || planFlight.current || blocked) return;
    if (!owner || authError) { await signIn(); return; }
    const started = performance.now();
    startMissionPhase("scene_cache", started)(canRetrySnapshot ? "retry" : plan ? "cache_hit" : "cache_miss");
    const controller = new AbortController();
    inFlight.current = controller;
    let working = draft;
    let savedDraft = draft;
    let phase: MissionProblem["phase"] = canRetrySnapshot ? "saving" : "preparing";
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (latest.current.owner !== owner || latest.current.inputSignature !== inputSignature || (clerk.user?.id ?? null) !== owner) throw new DOMException("The setup changed.", "AbortError");
      if (!local.isCurrentDraft(working)) throw new Error("Your draft changed in another tab. Review it before starting.");
    };
    setGeneration({ owner, busy: false, error: null });
    setSubmission({ owner, busy: true, phase: canRetrySnapshot || plan ? "saving" : "preparing", error: null, authError: false });
    try {
      assertCurrent();
      const api = createSpeakingApi(owner, getToken);
      // An uncertain create always replays its immutable request before planning.
      if (!canRetrySnapshot) {
        if (!plan) {
          if (linked) throw new Error("This linked setup no longer matches its saved scenes. Unlink it before preparing a new mission.");
          const value = await api.plan({ scenario_type: working.scenarioType, brief: working.goal.trim(), candidate_count: 1,
            targets: working.selectedKeys.map(key => ({ corpus_item_id: corpus.records.find(record => record.key === key)!.serverId!, role: targetRole(working, key) })) }, controller.signal);
          assertCurrent();
          const generated = { ...working, plan: { signature: inputSignature, value }, selectedCandidateId: undefined, submission: undefined };
          if (!await local.update(generated, working)) throw new Error("Your draft changed or could not be saved while preparing the scene. Review it before starting.");
          working = generated; savedDraft = generated;
          assertCurrent();
        }
        const selected = automaticCandidate(working, corpus.records);
        if (!selected) {
          if (!sceneFitAdvice(working, corpus.records)) throw new SpeakingApiError("The prepared scenes could not be verified against your targets. Please retry preparation.", 502, "invalid_output_schema");
          setManualOpen(true);
          setSubmission({ owner, busy: false, error: missionFitProblem(), authError: false });
          return;
        }
        working = { ...working, selectedCandidateId: selected.id };
      }
      const prepared = preparePlannedSubmission(working, corpus.records, () => crypto.randomUUID());
      // The comparison uses the exact last saved draft, including any retry ID.
      if (!await local.update(prepared, savedDraft)) throw new Error("Your draft changed or could not be saved. Review it before starting.");
      working = prepared;
      assertCurrent();
      phase = "saving";
      setSubmission({ owner, busy: true, phase: "saving", error: null, authError: false });
      const session = await api.create(prepared.submission!.request, controller.signal);
      assertCurrent();
      const confirmed = await local.confirmSubmission(prepared, session.client_id);
      if (!confirmed) throw new Error("Your mission was saved, but its confirmation could not be saved on this device. Retry to recover the same mission before starting another.");
      working = confirmed;
      assertCurrent();
      prepareMissionNavigation(owner, session.id, started);
      router.push(missionHref("session", returnTo, session.id));
    } catch (error) {
      if (!controller.signal.aborted && (clerk.user?.id ?? null) === owner) setSubmission({ owner, busy: false,
        error: missionProblem(error, phase),
        authError: error instanceof SpeakingApiError && error.status === 401 });
    } finally { if (inFlight.current === controller) inFlight.current = null; }
  }

  return <><AppHeader active="mission" /><main className={styles.page}><section className={styles.shell} aria-label="Speaking loadout"><div className={styles.body}>
    <div className={styles.main}>
      <DirectionLink href={returnTo} className={styles.back}><ArrowLeft size={14} aria-hidden="true" /> Back to learning</DirectionLink>
      <div className={styles.pageHeading}><div className={styles.eyebrow}>Stage 3 · Prepare to use your English</div><h1>Mission loadout</h1><p>Choose a few expressions. Build a scene where you have a reason to use them.</p></div>
      {reportOrigin ? <p className={styles.notice} role="status">{reportOrigin === "saved" ? "Your previous mission is saved as an additional draft." : "Your previous mission is ready to adjust."} Choose your targets, then start to prepare a matching scene.{replaceMissing ? " Remove unavailable selections and choose replacements." : ""}</p> : null}
      {!local.ready && !local.error ? <ContentSkeleton label="Loading your saved loadout…" /> : null}
      <p className={`${styles.fieldHelp} ${styles.draftStatus}`} data-pending={local.pending} role="status" aria-hidden={!local.pending}>Saving your draft on this device… Keep this page open until saving finishes.</p>
      {local.error ? <div className={styles.error} role="alert"><p>{local.error}</p><p>This is a device storage issue, not evidence that you chose the wrong targets.{local.ready ? " Your current selection is still on this page." : ""}</p><Button variant="secondary" size="inherit" type="button" onClick={local.retry}>Retry saving draft</Button></div> : null}
      {local.deviceDrafts.map((deviceDraft, index) => <div className={styles.notice} key={index}><strong>You also have a saved draft.</strong><p>{deviceDraft.goal || "An untitled mission"} · {deviceDraft.selectedKeys.length} selected items. {deviceDraft.plan?.value.practice_source ? "Your current setup will be kept as another draft." : "Using it replaces the setup below."}</p><Button variant="secondary" size="inherit" type="button" disabled={busy || canRetrySnapshot} onClick={() => local.adopt(index)}>Use device draft{local.deviceDrafts.length > 1 ? ` ${index + 1}` : ""}</Button></div>)}
      {canRetrySnapshot ? <p className={styles.notice} role="status">A mission start is awaiting confirmation. Retry start mission to recover the original request before changing this setup.</p> : null}
      {linked ? <section className={styles.notice} aria-label="Linked second round"><strong>Linked second round · {draft.plan!.value.practice_source!.variation === "role_swap" ? "Swapped roles" : "Changed details"}</strong><p>Your language, target roles and scene setup stay linked to the original mission. You can choose another prepared scene or change support. Unlink to edit the targets or prepare different scenes.</p><Button variant="secondary" size="inherit" type="button" disabled={busy || canRetrySnapshot} onClick={() => { void local.update({ ...draft, plan: undefined, selectedCandidateId: undefined, submission: undefined }, draft); }}>Unlink second round</Button></section> : null}

      <section id="corpus" className={styles.section} aria-label="Your saved corpus">
        <h2><span className={styles.stepNumber}>1</span> Choose your target language</h2>
        <div className={styles.selectionGuide}>
          <p>Start with <strong>2 primary targets and 0–1 opportunity target</strong>. One primary target is enough for a shorter mission.</p>
          <p className={styles.selectionCount} aria-live="polite">Selected: {primaryCount} primary · {opportunityCount} opportunity</p>
          <details ref={tipsRef} open={tipsOpen} onToggle={event => setTipsOpen(event.currentTarget.open)}>
            <summary>How to choose targets</summary>
            <p>Choose primary expressions that serve the same communication task and a similar tone, such as giving an opinion and explaining a reason in a workplace discussion. They can come from different sources or topics.</p>
            <p>Use opportunity targets for language that might fit but is not essential. Save expressions that need a different setting or tone for another mission. Opportunity targets do not have to be used. More targets is not the goal.</p>
            <p>You can select 1–3 primary targets and up to 2 opportunity targets, with at most 3 structures. Nothing is removed or reassigned automatically.</p>
          </details>
        </div>
        {draft.selectedKeys.length > 5 ? <p className={styles.notice}>Your previous {draft.selectedKeys.length} selections are preserved. Choose up to 5 for this mission using the preview.</p> : null}
        {!corpus.ready && !corpus.error ? <ContentSkeleton label="Loading your corpus…" variant="cards" /> : null}
        {corpus.error ? <div className={styles.error} role="alert"><p>{corpus.error}</p><Button variant="secondary" size="inherit" type="button" onClick={corpus.retry}>Retry corpus sync</Button></div> : null}
        {corpus.ready && !corpus.records.length ? <div className={styles.emptyLibrary}><h3>Your corpus is empty</h3><p>Save an expression or structure while learning, then come back to equip it.</p><Link href={returnTo}>Find language to save <StartIcon /></Link></div> : null}
        {corpus.records.length ? <>
          <div className={styles.filters}><label>Search corpus<Input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Expression, meaning or function" /></label><label>Source<SelectField aria-label="Source" value={source} onValueChange={setSource} options={[{ value: "", label: "All sources" }, ...sourceChoices.map(([value, label]) => ({ value, label }))]} /></label></div>
          {[...groups].map(([title, records]) => <CorpusPicker key={title} title={title} records={records} selectedKeys={draft.selectedKeys} count={draft.selectedKeys.length} limit={5} disabled={!local.ready || busy || setupLocked} onToggle={record => change(toggleMissionSelection(draft, record))} />)}
          {!groups.size ? <p className={styles.empty}>No language matches these filters.</p> : null}
        </> : null}
      </section>

      {problem ? <div ref={recoveryRef} tabIndex={-1}><MissionRecovery problem={problem} advice={fitAdvice} draft={draft} disabled={busy || generating}
        onRetry={() => void (submitError ? start() : generate())} onTips={showTips} onPreferences={showPreferences} onCompare={showScenes} onAdjust={adjustTarget} /></div> : null}

      <fieldset className={styles.section} disabled={!local.ready || busy || canRetrySnapshot}>
        <legend><span className={styles.stepNumber}>2</span> Mission preferences <span className={styles.optional}>Optional</span></legend>
        <p className={styles.sectionIntro}>Start mission prepares a scene around your targets. Add preferences here, or let AI choose a suitable setting.</p>
        <div className={styles.fieldGrid}>
          <label>Scenario type<SelectField disabled={linked || canRetrySnapshot} aria-label="Scenario type" value={draft.scenarioType} onValueChange={value => change({ scenarioType: value as LoadoutDraft["scenarioType"] })} options={[{ value: "workplace", label: "Workplace" }, { value: "everyday", label: "Everyday life" }]} /></label>
          <label>Difficulty<SelectField disabled={linked || canRetrySnapshot} aria-label="Difficulty" value={draft.difficulty} onValueChange={value => change({ difficulty: value as LoadoutDraft["difficulty"] }, true)} options={[{ value: "guided", label: "Guided" }, { value: "standard", label: "Standard" }, { value: "challenging", label: "Challenging" }]} /></label>
          <label className={styles.goalField}>Scene preferences <span className={styles.optional}>Optional</span><Textarea disabled={linked} ref={preferencesRef} aria-label="Scene preferences" value={draft.goal} maxLength={500} rows={3} placeholder="For example: discussing a launch with a colleague" onChange={event => change({ goal: event.target.value })} /><span className={styles.fieldHelp}>Add a setting, role or outcome, or leave this blank. {draft.goal.length} / 500</span></label>
          <label className={styles.feedbackField}>Feedback level<SelectField disabled={linked || canRetrySnapshot} aria-label="Feedback level" value={draft.feedbackLevel} onValueChange={value => change({ feedbackLevel: value as LoadoutDraft["feedbackLevel"] }, true)} options={[{ value: "light", label: "Light" }, { value: "balanced", label: "Balanced" }, { value: "detailed", label: "Detailed" }]} /></label>
          <label className={styles.supportField}>Support<SelectField disabled={canRetrySnapshot} aria-label="Mission support" value={draft.supportLevel ?? "legacy"} onValueChange={value => { if (isSupportLevel(value)) change(changeDraftSupport(draft, value), true); }}
            options={[...(draft.supportLevel == null ? [{ value: "legacy", label: "Existing support" }] : []), ...SUPPORT_OPTIONS.map(({ value, label }) => ({ value, label }))]} />
            <span className={styles.fieldHelp}>{SUPPORT_OPTIONS.find(option => option.value === draft.supportLevel)?.description ?? "This saved setup keeps its existing support. Choose a level to try a different amount of help."} You can reduce support during the mission; this is a practice choice, not a mastery rating.</span></label>
        </div>
        <SupportHistory owner={owner} getToken={getToken} draft={draft} records={corpus.records} disabled={busy || generating || !local.ready || !!local.error || !corpus.ready || corpus.busy || !!corpus.error || !!targetError || canRetrySnapshot} onApply={level => change(changeDraftSupport(draft, level), true)} />
        {optionsError ? <div className={styles.error} role="alert"><p>{optionsError}</p><Button variant="secondary" size="inherit" type="button" onClick={() => setOptionsAttempt(value => value + 1)}>Retry mission options</Button></div> : !options ? <p className={styles.fieldHelp} role="status">Loading mission settings…</p> : null}
        <fieldset disabled={linked} className={styles.strategyFieldset}><details className={styles.strategyOptions}>
        <summary>Conversation strategy · optional</summary>
        <p className={styles.sectionIntro}>Choose a conversation structure before starting, or keep a free conversation.</p>
        <div className={styles.logicGrid} role="group" aria-label="Logic template">{options?.logic_templates.map(logic => <button type="button" key={logic.id} aria-pressed={draft.logicTemplateId === logic.id} className={`${styles.logicCard} ${draft.logicTemplateId === logic.id ? styles.selectedCard : ""}`} onClick={() => change({ logicTemplateId: draft.logicTemplateId === logic.id ? null : logic.id }, true)}><span className={styles.logicTitle}>{logic.title}{draft.logicTemplateId === logic.id ? <Check size={15} aria-hidden="true" /> : null}</span><span className={styles.logicDescription}>{logic.description}</span><span className={styles.logicFlow}>{logic.steps.join(" → ")}</span></button>)}</div>
        {draft.logicTemplateId ? <Button variant="ghost" size="inherit" className={styles.textButton} type="button" onClick={() => change({ logicTemplateId: null }, true)}>Clear logic template</Button> : null}
        </details>
        </fieldset>
        <details ref={comparisonRef} className={styles.strategyOptions} open={manualOpen} onToggle={event => setManualOpen(event.currentTarget.open)}>
        <summary>Choose a scene myself</summary>
        <p className={styles.sectionIntro}>Compare two scenes and select one before starting. Start mission prepares just one when you have no saved scene.</p>
        {targetError ? <p className={styles.validation}>{targetError}</p> : null}
        <Button variant="secondary" size="inherit" type="button" className={styles.generateButton} disabled={generationBlocked} loading={generating} loadingLabel="Creating matching scenes…" onClick={() => void (authError ? signIn() : generate())}>{!owner || authError ? "Sign in to generate scenes" : plan ? "Generate new scenes" : "Generate matching scenes"}</Button>
        {!owner ? <p className={styles.fieldHelp}>Your selection stays on this device. Sign in to generate scenes and save your mission.</p> : null}
        {generating ? <p className={styles.fieldHelp} role="status">Planning roles, goals and natural opportunities for your targets… This may take up to 2 minutes. Your selection is kept.</p> : null}
        {plan ? <div className={styles.sceneList} role="group" aria-label="Matching scenes">{plan.candidates.map(scene => <article key={scene.id} className={`${styles.sceneCard} ${candidate?.id === scene.id ? styles.selectedCard : ""}`}>
          <h3>{scene.title}</h3><p>{scene.setting}</p><dl><div><dt>You</dt><dd>{scene.user_role}</dd></div><div><dt>AI partner</dt><dd>{scene.ai_role}</dd></div><div><dt>Goal</dt><dd>{scene.goal}</dd></div><div><dt>Tone</dt><dd>{scene.register}</dd></div></dl>
          {scene.changes?.length ? <div className={styles.sceneChanges}><strong>Changes from the original mission</strong>{scene.changes.map(change => <p key={change.field}><span>{change.field.replaceAll("_", " ")} · Before: {change.before}</span><span>After: {change.after}</span></p>)}</div> : null}
          <ul className={styles.targetFitList}>{scene.targets.map(target => {
            const record = corpus.records.find(value => value.serverId === target.corpus_item_id);
            return <li key={target.corpus_item_id}><strong>{record ? expressionText(record) : "Unavailable target"} <span className={styles.fitBadge}>{target.fit === "unknown" ? "Fit not established" : `${target.fit} fit`}</span></strong><span>{target.role === "primary" ? "Primary" : "Opportunity"} · {target.communicative_function}</span><p>{target.fit_reason}</p>{target.metadata_status !== "available" ? <span className={styles.fieldHelp}>Source usage information is {target.metadata_status === "partial" ? "incomplete" : "unavailable"}; review this fit.</span> : null}</li>;
          })}</ul>
          <Button variant={candidate?.id === scene.id ? "primary" : "secondary"} size="inherit" type="button" disabled={generating || busy || canRetrySnapshot} aria-pressed={candidate?.id === scene.id} onClick={() => {
            setSubmission({ owner, busy: false, error: null, authError: false });
            setGeneration({ owner, busy: false, error: null });
            void local.update({ ...draft, selectedCandidateId: scene.id, submission: undefined });
          }}>{candidate?.id === scene.id ? "Scene selected" : `Choose ${scene.title}`}{candidate?.id === scene.id ? <Check size={14} aria-hidden="true" /> : null}</Button>
        </article>)}</div> : null}
        {plan && validation && !targetError ? <p className={styles.validation}>{validation}</p> : null}
        </details>
      </fieldset>


    </div>
    <LoadoutPreview draft={draft} records={corpus.records} logic={options?.logic_templates.find(logic => logic.id === draft.logicTemplateId)} submitting={busy || setupLocked} onRole={changeRole}
      onRemove={key => change({ selectedKeys: draft.selectedKeys.filter(item => item !== key) })}>
      {problem ? <Button variant="ghost" size="inherit" type="button" className={styles.recoveryLink} onClick={() => { recoveryRef.current?.focus(); recoveryRef.current?.scrollIntoView({ block: "center" }); }}>Review mission guidance</Button> : null}
      {targetError && !canRetrySnapshot ? <p className={styles.validation} id="loadout-validation">{targetError}</p> : null}
      {busy && submission.phase === "preparing" ? <p className={styles.fieldHelp} role="status">Preparing a matching scene… This may take up to 2 minutes. Your selection is kept.</p> : null}
      <Button variant="primary" size="inherit" type="button" className={styles.startButton} disabled={blocked} loading={busy} loadingLabel={submission.phase === "preparing" ? "Preparing scene…" : "Saving mission…"} onClick={() => void start()} aria-describedby={targetError && !canRetrySnapshot ? "loadout-validation" : undefined}>{!owner || authError ? "Sign in to start mission" : canRetrySnapshot ? "Retry start mission" : "Start mission"}<StartIcon /></Button>
    </LoadoutPreview>
  </div></section></main></>;
}
