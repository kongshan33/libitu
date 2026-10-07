"use client";

import { Button } from "@/components/ui/button";

import { ArrowUpRight, X } from "lucide-react";
import type { SpeakingLogicTemplate } from "@libitu/types/speaking";
import type { SavedCorpusRecord } from "../../corpus/corpus-storage";
import { expressionText, resolveSelection, type LoadoutDraft } from "../draft";
import styles from "./Loadout.module.css";

export function LoadoutPreview({ draft, records, logic, onRemove, submitting, children }: {
  draft: LoadoutDraft; records: SavedCorpusRecord[]; logic?: SpeakingLogicTemplate;
  onRemove(key: string): void; submitting: boolean; children: React.ReactNode;
}) {
  const selection = resolveSelection(draft, records);
  return <aside className={styles.preview} aria-label="Loadout preview">
    <div className={styles.eyebrow}>Loadout preview</div>
    <h2>Your mission</h2>
    <p className={styles.goalPreview}>{draft.goal.trim() || "Set an outcome you want to achieve."}</p>
    <div className={styles.setupBadges}><span>{draft.scenarioType === "workplace" ? "Workplace" : "Everyday life"}</span><span>{draft.difficulty}</span><span>{draft.feedbackLevel} feedback</span></div>
    <h3>Logic</h3>
    <div className={`${styles.logicPreview} ${logic ? styles.activeLogic : ""}`}>
      <strong>{logic?.title ?? "Free conversation"}</strong>
      <span>{logic?.steps.join(" → ") ?? "No logic template selected"}</span>
    </div>
    <PreviewSlots title="Structures" selected={selection.structures} count={3} onRemove={onRemove} disabled={submitting} />
    <PreviewSlots title="Expression slots" selected={selection.expressions} count={5} onRemove={onRemove} disabled={submitting} />
    {selection.missing.length ? <div className={styles.missing} role="status"><strong>Unavailable selections</strong>
      <p>These items were removed or could not be loaded.</p>
      {selection.missing.map(({ key }, index) => <Button variant="secondary" size="inherit" type="button" key={key} disabled={submitting} onClick={() => onRemove(key)}>Remove unavailable item {index + 1}</Button>)}
    </div> : null}
    <div className={styles.startArea}>{children}<p className={styles.readiness} aria-live="polite">{selection.expressions.length} expressions + {selection.structures.length} structures</p>
      <p className={styles.preparationNote}>Your setup will be saved to your account. AI role-play is coming later.</p></div>
  </aside>;
}

function PreviewSlots({ title, selected, count, onRemove, disabled }: {
  title: string; selected: ReturnType<typeof resolveSelection>["selected"]; count: number;
  onRemove(key: string): void; disabled: boolean;
}) {
  return <section className={`${styles.slots} ${title === "Structures" ? styles.structureSlots : ""}`} aria-label={title}>
    <h3>{title}</h3>
    {Array.from({ length: Math.max(count, selected.length) }, (_, index) => {
      const slot = selected[index];
      const text = slot?.record ? expressionText(slot.record) : null;
      return <div className={`${styles.slot} ${slot ? styles.filledSlot : ""}`} key={slot?.key ?? `empty-${index}`}>
        <span className={styles.slotNumber}>{index + 1}</span><span className={styles.slotText}>{text ?? "Empty slot"}</span>
        {slot ? <Button variant="ghost" size="inherit" type="button" className={styles.remove} aria-label={`Remove ${text} from loadout`} disabled={disabled} onClick={() => onRemove(slot.key)}><X size={15} /></Button> : null}
      </div>;
    })}
  </section>;
}

export function StartIcon() { return <ArrowUpRight size={17} aria-hidden="true" />; }
