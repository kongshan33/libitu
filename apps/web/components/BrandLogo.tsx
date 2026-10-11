import Link from "@/components/ui/PrefetchLink";
import styles from "./BrandLogo.module.css";

/** The landing wordmark, scaled by its existing header without moving the tagline. */
export function BrandLogo({ className, tagline }: { className?: string; tagline?: string }) {
  return <Link href="/" className={className} aria-label="Libitu home" translate="no">
    <b className={styles.wordmark}>libitu<i aria-hidden="true">.</i></b>
    {tagline ? <span>{tagline}</span> : null}
  </Link>;
}
