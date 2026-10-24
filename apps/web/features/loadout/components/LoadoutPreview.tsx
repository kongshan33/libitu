"use client";

import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select";

import { ArrowUpRight, X } from "lucide-react";
import type { SpeakingLogicTemplate, SpeakingTargetRole } from "@libitu/types/speaking";
import type { SavedCorpusRecord } from "../../corpus/corpus-storage";
import { currentCandidate, expressionText, resolveSelection, targetRole, type LoadoutDraft } from "../draft";
import { SUPPORT_OPTIONS } from "../../speaking/support";
import styles from "./Loadout.module.css";

export function LoadoutPreview({ draft, records, logic, onRemove, onRole, submitting, children }: {
  draft: LoadoutDraft; records: SavedCorpusRecord[]; logic?: SpeakingLogicTemplate;
  onRemove(key: string): void; onRole(key: string, role: SpeakingTargetRole): void; submitting: boolean; children: React.ReactNode;
}) {
  const selection = resolveSelection(draft, records);
  const candidate = currentCandidate(draft, records);
  return <aside className={styles.preview} aria-label="Loadout preview">
    <div className={styles.eyebrow}>Loadout preview</div>
    <h2>Your mission</h2>
    <p className={styles.goalPreview}>{candidate?.goal ?? "AI will prepare a matching scene when you start."}</p>
    <div className={styles.setupBadges}><span>{draft.scenarioType === "workplace" ? "Workplace" : "Everyday life"}</span><span>{draft.difficulty}</span><span>{draft.feedbackLevel} feedback</span>{draft.supportLevel ? <span>{SUPPORT_OPTIONS.find(option => option.value === draft.supportLevel)?.label}</span> : null}</div>
    <h3>Logic</h3>
    <div className={`${styles.logicPreview} ${logic ? styles.activeLogic : ""}`}>
      <strong>{logic?.title ?? "Free conversation"}</strong>
      <span>{logic?.steps.join(" → ") ?? "No logic template selected"}</span>
    </div>
    {(["primary", "opportunity"] as const).map(role => <section className={styles.slots} key={role} aria-label={`${role === "primary" ? "Primary" : "Opportunity"} targets`}>
      <h3>{role === "primary" ? "Primary targets" : "Opportunity targets"} · {draft.selectedKeys.filter(key => targetRole(draft, key) === role).length}</h3>
      {selection.selected.filter(slot => slot.record && targetRole(draft, slot.key) === role).map(slot => {
        const text = expressionText(slot.record!);
        return <div className={styles.targetSlot} key={slot.key}><div className={`${styles.slot} ${styles.filledSlot}`}><span className={styles.slotText}>{text}</span><Button variant="ghost" size="inherit" type="button" className={styles.remove} aria-label={`Remove ${text} from loadout`} disabled={submitting} onClick={() => onRemove(slot.key)}><X size={15} /></Button></div>
          <SelectField aria-label={`Target role for ${text}`} value={role} disabled={submitting} onValueChange={value => onRole(slot.key, value as SpeakingTargetRole)} options={[{ value: "primary", label: "Primary target" }, { value: "opportunity", label: "Opportunity target" }]} /></div>;
      })}
      <p className={styles.fieldHelp}>{role === "primary" ? "Your partner will plan chances to use these. Two is a useful starting point; one is enough." : "Optional extra practice. Leaving these unused is not a failure."}</p>
    </section>)}
    {selection.missing.length ? <div className={styles.missing} role="status"><strong>Unavailable selections</strong>
      <p>These items were removed or could not be loaded.</p>
      {selection.missing.map(({ key }, index) => <Button variant="secondary" size="inherit" type="button" key={key} disabled={submitting} onClick={() => onRemove(key)}>Remove unavailable item {index + 1}</Button>)}
    </div> : null}
    <div className={styles.startArea}>{children}<p className={styles.readiness} aria-live="polite">{selection.expressions.length} expressions + {selection.structures.length} structures</p>
      <p className={styles.preparationNote}>Your scene and targets are saved together. You can skip a target that does not fit during the conversation.</p></div>
  </aside>;
}

export function StartIcon() { return <ArrowUpRight size={17} aria-hidden="true" />; }
