"use client";

import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select";
import type { SpeakingSupportLevel, SpeakingWorkspace } from "@libitu/types/speaking";
import { currentSupport, isSupportLevel, reducedSupport, SUPPORT_OPTIONS } from "./support";
import styles from "./Speaking.module.css";

export function SupportControls({ workspace, disabled, pending, error, onChange }: {
  workspace: SpeakingWorkspace; disabled: boolean; pending: boolean; error: string | null;
  onChange(level: SpeakingSupportLevel): void;
}) {
  const support = currentSupport(workspace);
  const next = support ? reducedSupport(support.level) : null;
  return <section className={styles.supportControls} aria-label="Practice support">
    <div className={styles.supportActions}>
      <label>Support<SelectField aria-label="Mission support" value={support?.level ?? "legacy"} disabled={disabled || pending}
        options={[...(!support ? [{ value: "legacy", label: "Existing support" }] : []), ...SUPPORT_OPTIONS.map(({ value, label }) => ({ value, label }))]}
        onValueChange={value => { if (isSupportLevel(value)) onChange(value); }} /></label>
      {next ? <Button variant="secondary" size="inherit" type="button" disabled={disabled || pending} onClick={() => onChange(next)}>Reduce support</Button> : null}
    </div>
    <p>{SUPPORT_OPTIONS.find(option => option.value === support?.level)?.description ?? "This mission keeps its existing support. Choose a level when connected to change how much help you receive."}</p>
    <p>Help already shown in this mission remains recorded. Changing support does not mark a target as mastered.</p>
    {pending ? <p role="status">Waiting for the support change to be confirmed…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
