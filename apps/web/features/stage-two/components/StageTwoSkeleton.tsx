import { BrandLogo } from "@/components/BrandLogo";
import styles from "./StageTwoSkeleton.module.css";

type View = "shadow" | "segments";

/** Show only the main regions; loading should not imitate every control or sentence. */
export function StageTwoSkeleton({ view = "shadow", label = "Loading practice…" }: { view?: View; label?: string }) {
  return <section className={styles.practice} role="status" aria-label={label} aria-busy="true" data-practice-skeleton={view}>
    <span className={styles.srOnly}>{label}</span>
    <div className={styles.frame} aria-hidden="true">
      <div className="stage-two-shadow-header"><span className={styles.heading} /></div>
      {view === "segments" ? <div className={styles.picker}>
        <div className={styles.timeline} />
        <div className={styles.cards}><div className={styles.card} /><div className={styles.card} /><div className={styles.card} /></div>
      </div> : <div className="stage-two-practice-layout">
        <aside className="stage-two-sentences" data-skeleton-region="sentences"><div className={styles.sidebar} /></aside>
        <div className="stage-two-practice-main">
          <span className={styles.caption} />
          <div className={styles.media} data-skeleton-region="media"><div className={styles.video} /></div>
          <div className={styles.analysis} data-skeleton-region="analysis" />
        </div>
      </div>}
    </div>
  </section>;
}

export function StageTwoLoadingShell({ view }: { view: "shadow" | "segments" }) {
  return <main className="stage-page practice-redesign"><section className="reader-shell" aria-label="Loading Libitu">
    <header className="topbar"><BrandLogo className="logo" /><div className={`topbar-title ${styles.title}`} aria-hidden="true"><span className={styles.caption} /></div></header>
    <StageTwoSkeleton view={view} label={view === "segments" ? "Loading segments…" : "Loading practice…"} />
  </section></main>;
}
