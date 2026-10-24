"use client";

import { Button } from "@/components/ui/button";
import { sceneAdjustmentError, type LoadoutDraft, type SceneTargetAdjustment, type sceneFitAdvice } from "../draft";
import type { MissionProblem } from "../problems";
import styles from "./Loadout.module.css";

export function MissionRecovery({ problem, advice, draft, disabled, onRetry, onTips, onPreferences, onCompare, onAdjust }: {
  problem: MissionProblem;
  advice: ReturnType<typeof sceneFitAdvice>;
  draft: LoadoutDraft;
  disabled: boolean;
  onRetry(): void;
  onTips(): void;
  onPreferences(): void;
  onCompare(): void;
  onAdjust(key: string, action: SceneTargetAdjustment): void;
}) {
  return <section className={styles.recovery} aria-label="Mission recovery">
    <div role="alert"><h2>{problem.title}</h2><p>{problem.message}</p>{problem.detail ? <p className={styles.recoveryDetail}>{problem.detail}</p> : null}</div>
    {problem.kind === "fit" && advice ? <>
      <p className={styles.recoveryBasis}>For <strong>{advice.candidate.title}</strong> · {advice.candidate.register} tone</p>
      <p>These AI fit estimates apply to this scene, not to every situation where you could use the expression.</p>
      <ul className={styles.recoveryTargets}>{advice.targets.map(target => {
        const opportunityError = sceneAdjustmentError(draft, target.key, "opportunity");
        const removeError = sceneAdjustmentError(draft, target.key, "remove");
        return <li key={target.key}>
          <h3>{target.text}<span>{target.fit === "unknown" ? "Fit not established" : "Low fit in this scene"}</span></h3>
          <p>{target.reason}</p>
          {target.fit === "unknown" ? <p>There is not enough evidence of a natural opportunity in this scene.</p> : null}
          <div className={styles.recoveryActions}>
            <Button variant="secondary" size="inherit" type="button" disabled={disabled || !!opportunityError}
              aria-label={`Make ${target.text} an opportunity`} onClick={() => onAdjust(target.key, "opportunity")}>Make opportunity</Button>
            <Button variant="ghost" size="inherit" type="button" disabled={disabled || !!removeError}
              aria-label={`Remove ${target.text} from this mission`} onClick={() => onAdjust(target.key, "remove")}>Remove target</Button>
          </div>
          {opportunityError ? <p className={styles.fieldHelp}>{opportunityError}</p> : null}
        </li>;
      })}</ul>
      <p>After changing a target, press Start mission to prepare a new scene.</p>
      <div className={styles.recoveryActions}>
        <Button variant="secondary" size="inherit" type="button" disabled={disabled} onClick={onCompare}>Compare scenes</Button>
        <Button variant="ghost" size="inherit" type="button" disabled={disabled} onClick={onPreferences}>Change scene preferences</Button>
      </div>
    </> : <>
      {problem.kind === "system" ? <>
        <p>{problem.phase === "saving" ? "Retry saving to recover the same mission with its original scene and targets." : "You can retry with the same targets. The suggestions below are optional."}</p>
        <div className={styles.recoveryActions}>
          <Button variant="secondary" size="inherit" type="button" disabled={disabled} onClick={onRetry}>{problem.phase === "saving" ? "Retry saving mission" : "Retry preparation"}</Button>
          {problem.phase === "preparing" ? <>
            <Button variant="ghost" size="inherit" type="button" disabled={disabled} onClick={onTips}>Selection tips</Button>
            <Button variant="ghost" size="inherit" type="button" disabled={disabled} onClick={onPreferences}>Add scene preferences</Button>
          </> : null}
        </div>
      </> : null}
    </>}
  </section>;
}
