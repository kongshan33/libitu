"use client";

import { currentAuthReturnUrl } from "@/features/navigation/return-location";

import { ContentSkeleton } from "@/components/ui/ContentSkeleton";

import { Button, ButtonLink } from "@/components/ui/button";

import Link from "@/components/ui/PrefetchLink";
import { useAuth, useClerk } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { ArrowUpRight, MessageCircle, Mic, Video } from "lucide-react";
import { ProfileApiError, readProfileResource } from "./api";
import type { HistoryItem, HistoryKind, HistoryPage } from "./types";
import { historyAction, historyHref, recordedDuration } from "./format";
import { groupHistory, practiceStatus } from "./history-groups";
import styles from "./Profile.module.css";

export function ProfileError({ error, retry }: { error: Error; retry: () => void }) {
  const clerk = useClerk();
  const auth = error instanceof ProfileApiError && error.status === 401;
  return <div className={styles.error} role="alert"><p>{error.message}</p><Button variant="secondary" size="inherit" type="button" onClick={() => {
    if (auth) { const url = currentAuthReturnUrl(); clerk.openSignIn({ forceRedirectUrl: url, signUpForceRedirectUrl: url }); }
    else retry();
  }}>{auth ? "Sign in again" : "Retry"}</Button></div>;
}

export function HistoryList({ items, timezone, detailed = false }: { items: HistoryItem[]; timezone: string; detailed?: boolean }) {
  if (!items.length) return <div className={styles.empty}><Mic size={24} aria-hidden="true" /><h3>Your next practice starts here</h3><p>Open a video, save a shadowing take or contribute to a Mission to start your history.</p><ButtonLink variant="primary" size="inherit" href="/loadout" className={styles.primary}>Start a Mission <ArrowUpRight size={15} aria-hidden="true" /></ButtonLink></div>;
  return <ul className={styles.historyList}>{items.map((item) => {
    const Icon = item.kind === "video" ? Video : item.kind === "shadowing" ? Mic : MessageCircle;
    const href = historyHref(item);
    const content = <><span className={`${styles.historyIcon} ${item.kind === "speaking" ? styles.teal : ""}`}><Icon size={18} aria-hidden="true" /></span>
      <span className={styles.historyText}><strong>{item.title}</strong><span>{item.kind === "video" ? "Original video" : item.kind === "shadowing" ? "Shadowing" : "Mission"}<span aria-hidden="true"> · </span><time dateTime={item.occurred_at}>{new Intl.DateTimeFormat("en", { timeZone: timezone, ...(detailed ? { hour: "numeric", minute: "2-digit" } as const : { month: "short", day: "numeric", year: "numeric" } as const) }).format(new Date(item.occurred_at))}</time>
        {item.duration_ms !== null ? ` · ${recordedDuration(item.duration_ms)} recorded` : item.turn_count !== null ? ` · ${item.turn_count} speaking ${item.turn_count === 1 ? "turn" : "turns"}` : ""}</span></span>
      {detailed ? <span className={styles.practiceStatus} data-status={item.status}>{practiceStatus(item)}</span> : null}
      <span className={styles.historyStatus}>{historyAction(item)}{href ? <ArrowUpRight size={14} aria-hidden="true" /> : null}</span></>;
    return <li key={`${item.kind}:${item.id}`}>{href ? <Link href={href}>{content}</Link> : <div className={styles.historyRow}>{content}</div>}</li>;
  })}</ul>;
}

export function HistoryFeed({ owner, timezone, initialKind = "all" }: { owner: string; timezone: string; initialKind?: HistoryKind }) {
  const [kind, setKind] = useState<HistoryKind>(initialKind);
  return <section className={styles.card} aria-label="Saved practice history">
    <div className={styles.historyToolbar}>
      <div className={styles.historyFilters} role="group" aria-label="Practice type">
        {([ ["all", "All practice"], ["video", "Videos"], ["shadowing", "Shadowing"], ["speaking", "Missions"] ] as const).map(([value, label]) =>
          <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}
      </div>
      <span className={styles.smallMuted}>Most recent first</span>
    </div>
    <FilteredHistory key={`${owner}:${kind}`} owner={owner} timezone={timezone} kind={kind} />
  </section>;
}

function FilteredHistory({ owner, timezone, kind }: { owner: string; timezone: string; kind: HistoryKind }) {
  const { getToken } = useAuth();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(null);
    void readProfileResource<HistoryPage>(`/history?offset=${offset}&limit=20&kind=${kind}`, owner, getToken, controller.signal).then((page) => {
      setItems((previous) => {
        const rows = offset === 0 ? [] : previous;
        const keys = new Set(rows.map((row) => `${row.kind}:${row.id}`));
        return [...rows, ...page.items.filter((row) => !keys.has(`${row.kind}:${row.id}`))];
      });
      setNext(page.next_offset); setBusy(false);
    }).catch((reason: unknown) => { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason : new Error("History could not be loaded.")); setBusy(false); } });
    return () => controller.abort();
  }, [owner, getToken, offset, attempt, kind]);

  return <div aria-busy={busy}>
    {groupHistory(items, timezone).map((group) => <section className={styles.historyGroup} key={group.label} aria-label={group.label}>
      <h2>{group.label}</h2><HistoryList items={group.items} timezone={timezone} detailed />
    </section>)}
    {!items.length && !busy && !error ? kind === "all" ? <HistoryList items={items} timezone={timezone} /> :
      <div className={styles.empty}>{kind === "video" ? <Video size={24} aria-hidden="true" /> : kind === "shadowing" ? <Mic size={24} aria-hidden="true" /> : <MessageCircle size={24} aria-hidden="true" />}
        <h3>{kind === "video" ? "No videos yet" : kind === "shadowing" ? "No saved shadowing takes yet" : "No Missions practiced yet"}</h3>
        <p>{kind === "video" ? "Open a video while signed in to find it here." : kind === "shadowing" ? "Practice a sentence and save your take to find it here." : "Contribute a speaking turn to a Mission to find it here."}</p>
        <ButtonLink variant="primary" size="inherit" href={kind !== "speaking" ? "/" : "/loadout"} className={styles.primary}>{kind !== "speaking" ? "Explore practice" : "Start a Mission"}<ArrowUpRight size={15} aria-hidden="true" /></ButtonLink>
      </div> : null}
    {error ? <ProfileError error={error} retry={() => setAttempt((value) => value + 1)} /> : null}
    {busy ? <ContentSkeleton label="Loading practice history…" /> : null}
    {next !== null && !error ? <div className={styles.feedFooter}><Button variant="secondary" size="inherit" type="button" loading={busy} loadingLabel="Loading practice…" onClick={() => setOffset(next)}>Load more practice</Button></div> : null}
  </div>;
}
