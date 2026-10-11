"use client";

import { currentAuthReturnUrl } from "@/features/navigation/return-location";

import { ContentSkeleton } from "@/components/ui/ContentSkeleton";

import { DirectionButton, DirectionLink } from "@/components/ui/direction-button";

import { AppHeader } from "@/components/AppHeader";

import { ButtonLink } from "@/components/ui/button";

import Link from "@/components/ui/PrefetchLink";
import Image from "next/image";
import { useAuth, useClerk, useUser } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, CalendarDays, ChevronRight, Flame, History, Play, Target, UserRound } from "lucide-react";
import { readLearningLocation } from "./learning-location";
import { ActivityChart } from "./ActivityChart";
import { LearningDimensions } from "./LearningDimensions";
import { MissionFeedback } from "./MissionFeedback";
import { HistoryFeed, HistoryList, ProfileError } from "./PracticeHistory";
import { readProfileResource } from "./api";
import { profileSourceHref, recordedDuration } from "./format";
import type { HistoryKind, ProfileData, ProfileRange } from "./types";
import styles from "./Profile.module.css";

export function ProfilePage({ history = false, historyKind = "all" }: { history?: boolean; historyKind?: HistoryKind }) {
  const { isLoaded, userId } = useAuth();
  const clerk = useClerk();
  return <main className={styles.page}>
    <AppHeader active="learning" />
    <div className={styles.shell}>
      {!isLoaded ? <ContentSkeleton label="Loading your account…" /> : !userId ? <section className={styles.gate}>
        <span className={styles.gateIcon}><UserRound size={30} aria-hidden="true" /></span><div className={styles.eyebrow}>Your personal learning space</div><h1>Make your practice count.</h1><p>Sign in to see your saved practice, grow your corpus and pick up where you left off.</p>
        <DirectionButton variant="primary" className={styles.primary} type="button" onClick={() => { const url = currentAuthReturnUrl(); clerk.openSignIn({ forceRedirectUrl: url, signUpForceRedirectUrl: url }); }}>Sign in to view my learning <ArrowRight size={16} aria-hidden="true" /></DirectionButton>
        <Link className={styles.textLink} href="/">Back to practice</Link>
      </section> : <AccountLearning key={`${userId}:${history}:${historyKind}`} owner={userId} history={history} historyKind={historyKind} />}
    </div>
  </main>;
}

function AccountLearning({ owner, history, historyKind }: { owner: string; history: boolean; historyKind: HistoryKind }) {
  const [timezone, setTimezone] = useState<string | null>(null);
  useEffect(() => { setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"); }, []);
  if (history) return <>
    <DirectionLink href="/profile" className={styles.back}><ArrowLeft size={15} aria-hidden="true" /> My learning</DirectionLink>
    <div className={styles.heading}><div><div className={styles.eyebrow}>A record of showing up</div><h1>Practice history</h1><p>Revisit your conversations and the sources you’ve practiced with.</p></div><ButtonLink variant="primary" size="inherit" href="/loadout" className={styles.primary}><Play size={14} aria-hidden="true" /> New Mission</ButtonLink></div>
    {timezone ? <HistoryFeed owner={owner} timezone={timezone} initialKind={historyKind} /> : <ContentSkeleton label="Loading practice history…" />}
    <p className={styles.footnote}>Videos appear once per source and open Stage 1. One shadowing entry is one saved take. Mission entries include at least one speaking turn. Dates use {timezone ?? "your local timezone"}.</p>
  </>;
  return <Dashboard owner={owner} timezone={timezone} />;
}

function Dashboard({ owner, timezone }: { owner: string; timezone: string | null }) {
  const { getToken } = useAuth();
  const { user } = useUser();
  const [range, setRange] = useState<ProfileRange>("4w");
  const [result, setResult] = useState<{ range: ProfileRange; data: ProfileData } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);
  const [location, setLocation] = useState<ReturnType<typeof readLearningLocation>>(null);
  useEffect(() => { setLocation(readLearningLocation(owner)); }, [owner]);
  useEffect(() => {
    if (!timezone) return;
    const controller = new AbortController();
    setBusy(true); setError(null);
    void readProfileResource<ProfileData>(`?${new URLSearchParams({ timezone, range })}`, owner, getToken, controller.signal).then((data) => {
      setResult({ range, data }); setBusy(false);
    }).catch((reason: unknown) => { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason : new Error("Your learning could not be loaded.")); setBusy(false); } });
    return () => controller.abort();
  }, [owner, getToken, timezone, range, attempt]);

  const data = result?.data ?? null;
  const overview = data?.overview;
  const chartData = result?.range === range && !error ? data : null;
  const currentUser = user?.id === owner ? user : null;
  const name = currentUser?.fullName || currentUser?.firstName || currentUser?.username || "Your learning space";
  const source = data?.last_practiced_source;
  const sourceHref = source ? profileSourceHref(source.content_id, source.source_url) : null;
  const lastLocation = location ?? (source && sourceHref ? { href: sourceHref, title: source.title || "Your last practiced video" } : null);
  const resume = data?.resume_speaking;

  return <>
    <div className={styles.heading}><div><div className={styles.eyebrow}>A little practice. More possibilities.</div><h1>My learning</h1></div><ButtonLink variant="primary" size="inherit" href="/loadout" className={styles.primary}><Play size={14} aria-hidden="true" /> New Mission</ButtonLink></div>
    <section className={styles.identity} aria-label="Your learning overview">
      <div className={styles.userBlock}>{currentUser?.hasImage && currentUser.imageUrl ? <Image className={styles.avatar} src={currentUser.imageUrl} alt="" width={62} height={62} unoptimized /> : <span className={styles.avatar} aria-hidden="true">{name[0].toUpperCase()}</span>}
        <div><h2>{name}</h2><p>{currentUser?.createdAt ? `Learning with Libitu since ${currentUser.createdAt.toLocaleDateString("en", { year: "numeric", month: "short" })}` : "Turn real English into language you can use."}</p>
          {overview ? <span className={styles.streak}><Flame size={13} aria-hidden="true" />{overview.current_streak_days ? `${overview.current_streak_days} ${overview.current_streak_days === 1 ? "day" : "days"} of consistent practice` : "A fresh start is a practice away"}</span> : null}
        </div>
      </div>
      <dl className={styles.stats}>{[
        [overview?.shadowing_attempts.toLocaleString("en"), "Shadowing takes"],
        [overview?.speaking_sessions.toLocaleString("en"), "Missions practiced"],
        [overview?.corpus_total.toLocaleString("en"), "Corpus items"],
        [overview ? recordedDuration(overview.shadowing_duration_ms) : undefined, "Shadowing recorded"]
      ].map(([value, label]) => <div key={label}><dt>{label}</dt><dd>{value ?? "—"}</dd></div>)}</dl>
    </section>
    {error ? <ProfileError error={error} retry={() => setAttempt((value) => value + 1)} /> : null}
    {busy && !data ? <ContentSkeleton label="Loading your learning records…" /> : null}
    {data && error ? <p className={styles.footnote}>Showing the last loaded overview. Activity for the requested range could not be refreshed.</p> : null}
    <MissionFeedback data={data} loading={busy && !data} />
    <div className={styles.grid}>
      <LearningDimensions />
      <ActivityChart data={chartData} range={range} onRange={setRange} loading={busy} />
    </div>
    <aside className={styles.focus} aria-label="Your next step"><span className={styles.focusIcon}><Target size={21} aria-hidden="true" /></span><div><span className={styles.eyebrow}>Your next step</span><p>{resume ? "Pick up your Mission and put your saved language to work." : overview?.corpus_total ? "You’ve collected useful language. Give it a voice in your next Mission." : "Find an expression in a video, save it, then make it part of a conversation."}</p></div><DirectionLink href={resume ? `/speaking/${encodeURIComponent(resume.session_id)}?returnTo=%2Fprofile` : overview?.corpus_total ? "/loadout" : "/"}>{resume ? "Continue Mission" : overview?.corpus_total ? "Start a Mission" : "Explore practice"}<ArrowRight size={15} aria-hidden="true" /></DirectionLink></aside>
    <section className={styles.card} aria-labelledby="quick-title"><div className={styles.cardHeader}><h2 id="quick-title">Make your next move</h2></div><div className={styles.quickLinks}>
      <QuickLink href="/corpus" icon={BookOpen} title="My corpus" subtitle={overview ? `${overview.corpus_total} items · ${overview.corpus_structures} structures${overview.corpus_week_added !== null ? ` · +${overview.corpus_week_added} this week` : ""}` : "Browse saved language in your loadout"} tone="purple" />
      <QuickLink href="/profile/history" icon={History} title="Practice history" subtitle="Revisit your takes and conversations" tone="teal" />
      <QuickLink href="/loadout" icon={Target} title="Start a new Mission" subtitle="Choose language. Give it a purpose." tone="amber" />
      {lastLocation ? <QuickLink href={lastLocation.href} icon={Play} title={location ? "Continue learning" : "Last practiced source"} subtitle={`${lastLocation.title}${location ? " · On this device" : ""}`} tone="blue" />
        : <QuickLink href="/" icon={Play} title="Find your next source" subtitle="Start with a video you want to understand" tone="blue" />}
    </div></section>
    <section className={styles.card} aria-labelledby="videos-title"><div className={styles.cardHeader}><h2 id="videos-title">Original videos</h2><Link href="/profile/history?kind=video" className={styles.textLink}>View all videos <ArrowRight size={14} aria-hidden="true" /></Link></div>
      {!data ? busy ? <ContentSkeleton label="Loading video history…" /> : <p className={styles.videoEmpty}>Video history is unavailable.</p> : data.recent_videos?.items.length ? <HistoryList items={data.recent_videos.items} timezone={data.timezone} /> : <div className={styles.videoEmpty}><p>Your videos will appear here when you open them while signed in.</p><Link href="/" className={styles.textLink}>Explore videos <ArrowRight size={14} aria-hidden="true" /></Link></div>}
    </section>
    <section className={styles.card} aria-labelledby="recent-title"><div className={styles.cardHeader}><h2 id="recent-title">Recent practice</h2><DirectionLink href="/profile/history" className={styles.textLink}>View all <ArrowRight size={14} aria-hidden="true" /></DirectionLink></div>
      {data ? <HistoryList items={data.recent_history.items} timezone={data.timezone} /> : busy ? <ContentSkeleton label="Loading recent practice…" /> : <p className={styles.loading}>Recent practice is unavailable.</p>}
    </section>
    <p className={styles.footnote}><CalendarDays size={13} aria-hidden="true" />{overview ? `${overview.active_days} active ${overview.active_days === 1 ? "day" : "days"} · ` : ""}Saved practice only. Recorded time includes shadowing audio, not listening or Mission duration.</p>
  </>;
}

function QuickLink({ href, icon: Icon, title, subtitle, tone }: { href: string; icon: typeof BookOpen; title: string; subtitle: string; tone: string }) {
  return <Link className={styles.quickLink} href={href}><span className={`${styles.quickIcon} ${styles[tone]}`}><Icon size={19} aria-hidden="true" /></span><span><strong>{title}</strong><small>{subtitle}</small></span><ChevronRight size={17} aria-hidden="true" /></Link>;
}
