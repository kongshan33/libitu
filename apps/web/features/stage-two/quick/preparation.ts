export const QUICK_PREPARATION_MS = 2_000;

/** The preparation interval never owns a microphone and can be cancelled at any point. */
export function startQuickPreparation(onTick: (seconds: number) => void, onReady: () => void) {
  let cancelled = false;
  onTick(2);
  const tick = setTimeout(() => { if (!cancelled) onTick(1); }, 1_000);
  const ready = setTimeout(() => { if (!cancelled) onReady(); }, QUICK_PREPARATION_MS);
  return () => {
    cancelled = true;
    clearTimeout(tick);
    clearTimeout(ready);
  };
}
