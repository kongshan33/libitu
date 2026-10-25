import { BrandLogo } from "@/components/BrandLogo";

/** Decorative only: actual progress and errors belong to the reader status panel. */
export function ReaderSkeleton({ rows = 3 }: { rows?: number }) {
  return <div className="reader-skeleton" aria-hidden="true">
    {Array.from({ length: rows }, (_, index) => <div className="reader-skeleton-group" key={index}>
      <span className="reader-skeleton-line" />
      <span className="reader-skeleton-line" />
      <span className="reader-skeleton-line" />
    </div>)}
  </div>;
}

export function ReaderLoadingShell() {
  return <main className="stage-page practice-redesign">
    <section className="reader-shell" aria-label="Loading Libitu" aria-busy="true">
      <header className="topbar"><BrandLogo className="logo" /><span className="topbar-title" role="status">Opening your workspace…</span></header>
      <aside className="left-panel"><ReaderSkeleton /></aside>
      <section className="center-panel">
        <div className="video-summary"><ReaderSkeleton rows={1} /></div>
        <div className="video-frame reader-skeleton-video" aria-hidden="true" />
        <ReaderSkeleton rows={4} />
      </section>
      <aside className="right-panel"><ReaderSkeleton /></aside>
    </section>
  </main>;
}
