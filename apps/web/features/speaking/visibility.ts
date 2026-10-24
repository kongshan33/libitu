/** Confirm a painted, mostly visible surface, rather than equating mount with exposure. */
export function observeVisible(element: HTMLElement, onVisible: () => void): () => void {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  if (!view) return () => {};
  let stopped = false;
  let visible = false;
  let firstFrame = 0;
  let paintedFrame = 0;
  const observer = new view.IntersectionObserver(entries => {
    const entry = entries.find(value => value.target === element);
    visible = !!entry?.isIntersecting && entry.intersectionRatio >= 0.95;
    schedule();
  }, { threshold: [0, 0.95, 1] });

  function cancelFrames() {
    view!.cancelAnimationFrame(firstFrame); view!.cancelAnimationFrame(paintedFrame);
    firstFrame = 0; paintedFrame = 0;
  }
  function check() {
    if (stopped || !visible || doc.visibilityState !== "visible" || !element.isConnected) return;
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      const style = view!.getComputedStyle(current);
      if (current.hidden || current.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return;
    }
    // IntersectionObserver does not account for a modal covering the card.
    const hit = doc.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    if (!hit || !element.contains(hit)) return;
    cleanup();
    onVisible();
  }
  function schedule() {
    cancelFrames();
    if (stopped || !visible || doc.visibilityState !== "visible") return;
    firstFrame = view!.requestAnimationFrame(() => {
      firstFrame = 0;
      paintedFrame = view!.requestAnimationFrame(() => { paintedFrame = 0; check(); });
    });
  }
  function cleanup() {
    stopped = true; cancelFrames(); observer.disconnect();
    doc.removeEventListener("visibilitychange", schedule);
    view!.removeEventListener("focus", schedule);
    view!.removeEventListener("pointerup", schedule);
    view!.removeEventListener("scroll", schedule, true);
    view!.removeEventListener("resize", schedule);
    view!.removeEventListener("animationend", schedule, true);
    view!.removeEventListener("transitionend", schedule, true);
  }
  observer.observe(element);
  doc.addEventListener("visibilitychange", schedule);
  view.addEventListener("focus", schedule);
  view.addEventListener("pointerup", schedule);
  view.addEventListener("scroll", schedule, true);
  view.addEventListener("resize", schedule);
  // A menu may cover a newly mounted label until its exit animation ends,
  // without changing the label's intersection or scroll position.
  view.addEventListener("animationend", schedule, true);
  view.addEventListener("transitionend", schedule, true);
  return cleanup;
}
