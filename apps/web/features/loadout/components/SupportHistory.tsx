"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { SupportRecommendation, SupportRecommendationRequest, SpeakingSupportLevel } from "@libitu/types/speaking";
import type { SavedCorpusRecord } from "../../corpus/corpus-storage";
import { reducedSupport, SUPPORT_OPTIONS } from "../../speaking/support";
import { createSpeakingApi } from "../api/speaking-api";
import { expressionText, targetRole, type LoadoutDraft } from "../draft";
import styles from "./Loadout.module.css";

export function supportHistoryRequest(draft: LoadoutDraft, records: SavedCorpusRecord[]): SupportRecommendationRequest {
  return { current_level: draft.supportLevel ?? null, targets: draft.selectedKeys.map(key => ({ corpus_item_id: records.find(record => record.key === key)?.serverId ?? "", role: targetRole(draft, key) })) };
}
export function SupportHistory({ owner, getToken, draft, records, disabled, onApply }: {
  owner: string | null; getToken: () => Promise<string | null>; draft: LoadoutDraft; records: SavedCorpusRecord[]; disabled: boolean; onApply: (level: SpeakingSupportLevel) => void;
}) {
  const request = supportHistoryRequest(draft, records);
  const signature = JSON.stringify([owner, request]);
  const current = useRef(signature); current.current = signature;
  const flight = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ signature: string; busy: boolean; result: SupportRecommendation | null; error: string | null }>({ signature, busy: false, result: null, error: null });
  const value = state.signature === signature ? state : null;
  useEffect(() => () => { flight.current?.abort(); flight.current = null; }, [signature]);
  async function check() {
    if (!owner || disabled || flight.current || draft.submission) return;
    const abort = new AbortController(); flight.current = abort;
    setState({ signature, busy: true, result: null, error: null });
    try {
      const result = await createSpeakingApi(owner, getToken).supportRecommendation(request, abort.signal);
      if (!abort.signal.aborted && current.current === signature) setState({ signature, busy: false, result, error: null });
    } catch (error) {
      if (!abort.signal.aborted && current.current === signature) setState({ signature, busy: false, result: null, error: error instanceof Error ? error.message : "Practice history is unavailable. You can still start your mission." });
    } finally { if (flight.current === abort) flight.current = null; }
  }
  const result = value?.result;
  const suggestion = result?.suggested_level;
  const canApply = result?.status === "suggest_reduce" && suggestion && draft.supportLevel && reducedSupport(draft.supportLevel) === suggestion
    && !disabled && !draft.submission;
  return <section className={styles.historyPanel} aria-label="Practice history"><h3>Practice history</h3>
    <p className={styles.fieldHelp}>Check whether each primary target has reliable independent use in 3 Missions, on 2 UTC practice dates, across 2 scene families. This is a practice rule, not a mastery score.</p>
    <Button variant="secondary" size="inherit" type="button" disabled={disabled || !owner || !!draft.submission || !!value?.busy} loading={value?.busy} loadingLabel="Checking practice history…" onClick={() => void check()}>Check practice history</Button>
    {value?.error ? <p className={styles.fieldHelp} role="status">{value.error} Your selected support remains available and you can still start.</p> : null}
    {result ? <><p className={styles.fieldHelp} role="status">{result.reason}</p>
      <div className={styles.historyTargets}>{result.targets.map(target => {
        const record = records.find(record => record.serverId === target.corpus_item_id);
        return <article key={target.corpus_item_id}><strong>{record ? expressionText(record) : "Selected target"}</strong><p>{target.role === "primary" ? "Primary" : "Opportunity"} · {target.qualifying_missions} Missions · {target.practice_days} UTC dates · {target.scene_roots} scene families</p>
          {target.evidence.length ? <ul>{target.evidence.map(evidence => <li key={`${evidence.session_id}:${evidence.report_id}`}><Link href={`/speaking/${encodeURIComponent(evidence.session_id)}/analytics`}>Practice on {new Date(evidence.practiced_at).toISOString().slice(0, 10)} UTC</Link></li>)}</ul> : <p>No qualifying independent evidence found.</p>}
        </article>;
      })}</div>
      {result.history_truncated ? <p className={styles.fieldHelp}>Only the 100 most recent matching reports were checked. Older history may be missing.</p> : null}
      {result.status === "suggest_reduce" && suggestion ? <><p className={styles.fieldHelp}>Suggested support: {SUPPORT_OPTIONS.find(option => option.value === suggestion)?.label}. You decide whether to apply it.</p><Button variant="primary" size="inherit" type="button" disabled={!canApply} onClick={() => { if (canApply && current.current === signature) onApply(suggestion); }}>Apply suggested support</Button></> : null}
    </> : null}
  </section>;
}
