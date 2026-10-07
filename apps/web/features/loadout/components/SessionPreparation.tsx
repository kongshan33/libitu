"use client";

import { DirectionLink } from "@/components/ui/direction-button";

import { AppHeader } from "@/components/AppHeader";

import { Button } from "@/components/ui/button";

import { useAuth, useClerk } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { Check, ArrowLeft } from "lucide-react";
import type { SpeakingSession } from "@libitu/types/speaking";
import { createSpeakingApi, SpeakingApiError } from "../api/speaking-api";
import { safeReturnPath } from "../navigation";
import styles from "./Loadout.module.css";

export function SessionPreparation({ sessionId }: { sessionId: string }) {
  const { isLoaded, userId, getToken } = useAuth();
  const clerk = useClerk();
  const [attempt, setAttempt] = useState(0);
  const [returnTo, setReturnTo] = useState("/");
  const [result, setResult] = useState<{ owner: string; id: string; session: SpeakingSession | null; error: string | null; status: number } | null>(null);
  useEffect(() => { setReturnTo(safeReturnPath(new URL(window.location.href).searchParams.get("returnTo"))); }, []);
  useEffect(() => {
    if (!isLoaded || !userId) return;
    const controller = new AbortController();
    setResult(null);
    void createSpeakingApi(userId, getToken).read(sessionId, controller.signal).then((session) => {
      if (!controller.signal.aborted) setResult({ owner: userId, id: sessionId, session, error: null, status: 200 });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResult({ owner: userId, id: sessionId, session: null,
        error: error instanceof Error ? error.message : "This mission could not be loaded.", status: error instanceof SpeakingApiError ? error.status : 0 });
    });
    return () => controller.abort();
  }, [isLoaded, userId, getToken, sessionId, attempt]);
  const current = result && result.owner === userId && result.id === sessionId ? result : null;
  const session = current?.session;
  function signIn() { const returnUrl = window.location.href; clerk.openSignIn({ forceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl }); }
  return <><AppHeader active="mission" /><main className={styles.page}><section className={styles.shell} aria-label="Saved speaking mission">

    <div className={styles.sessionMain}>
      <DirectionLink className={styles.back} href={`/loadout?returnTo=${encodeURIComponent(returnTo)}`}><ArrowLeft size={14} aria-hidden="true" /> Back to loadout</DirectionLink>
      {!isLoaded ? <p role="status">Checking sign-in…</p> : !userId ? <div className={styles.emptyLibrary}><h1>Sign in to view your mission</h1><p>Your saved mission belongs to your account.</p><Button variant="primary" size="inherit" className={styles.startButton} type="button" onClick={signIn}>Sign in</Button></div>
        : current?.error ? <div className={styles.error} role="alert"><h1>Mission unavailable</h1><p>{current.error}</p>{current.status === 401 ? <Button variant="secondary" size="inherit" type="button" onClick={signIn}>Sign in again</Button> : current.status !== 404 ? <Button variant="secondary" size="inherit" type="button" onClick={() => setAttempt((value) => value + 1)}>Retry loading mission</Button> : null}</div>
          : !session ? <p role="status">Loading your saved mission…</p> : <>
            <div className={styles.savedBadge}><Check size={15} aria-hidden="true" /> Saved to your account</div>
            <h1>Your mission is prepared</h1><p className={styles.sessionGoal}>{session.goal}</p>
            <dl className={styles.sessionSettings}><div><dt>Scenario</dt><dd>{session.scenario_type === "workplace" ? "Workplace" : "Everyday life"}</dd></div><div><dt>Difficulty</dt><dd>{session.difficulty}</dd></div><div><dt>Feedback</dt><dd>{session.feedback_level}</dd></div></dl>
            <div className={styles.preparationBanner}><h2>AI role-play is not available yet</h2><p>Your goal and selected language are saved. You can return to this page after refreshing or signing in again.</p></div>
            <section className={styles.section}><h2>Conversation strategy</h2><p>{session.logic_template?.title ?? "Free conversation"}</p>{session.logic_template ? <p className={styles.logicFlow}>{session.logic_template.steps.join(" → ")}</p> : <p className={styles.fieldHelp}>No logic template selected.</p>}</section>
            <section className={styles.section}><h2>Selected language</h2><p className={styles.sectionIntro}>This saved selection stays the same if you later edit or remove corpus items.</p><div className={styles.savedItems}>
              {[...session.items].sort((a, b) => a.ordinal - b.ordinal).map((item) => <article className={styles.savedItem} key={item.id}><span className={styles.kindTag}>{item.kind}</span><h3 className={item.kind === "structure" ? styles.structureText : undefined}>{item.text}</h3>{item.meaning ? <p>{item.meaning}</p> : null}<div className={styles.tags}>{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>{Object.keys(item.slots).length ? <dl className={styles.patternSlots}>{Object.entries(item.slots).map(([name, description]) => <div key={name}><dt>{name}</dt><dd>{description}</dd></div>)}</dl> : null}{item.source_title ? <p className={styles.source}>{item.source_title}</p> : null}</article>)}
            </div></section>
          </>}
    </div>
  </section></main></>;
}
