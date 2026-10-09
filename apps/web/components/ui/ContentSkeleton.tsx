import styles from "./ContentSkeleton.module.css";

/** Loading-only placeholder. Errors, empty results and operation progress stay explicit. */
export function ContentSkeleton({ label = "Loading content", variant = "rows", rows = 3 }: {
  label?: string; variant?: "rows" | "cards" | "practice"; rows?: number;
}) {
  return <div className={`${styles.root} ${styles[variant]}`} role="status" aria-busy="true" aria-label={label}>
    <span className={styles.srOnly}>{label}</span>
    <div aria-hidden="true" className={styles.content}>
      {variant === "practice" ? <><div className={styles.heading} /><div className={styles.video} /><div className={styles.controls} /></> : null}
      <div className={styles.groups}>{Array.from({ length: rows }, (_, index) => <div className={styles.group} key={index}>
        <span /><span /><span />
      </div>)}</div>
    </div>
  </div>;
}
