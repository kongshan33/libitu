export type TimedEntry<T> = {
  item: T;
  seconds: number | null;
};

export function parseTimestamp(timestamp: string | null): number | null {
  if (!timestamp) return null;
  const parts = timestamp.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function findCurrentTimedItem<T>(
  timeline: readonly TimedEntry<T>[],
  currentTime: number,
  fallbackToFirst = false
): T | null {
  let current: T | null = null;
  let firstTimedItem: T | null = null;
  let currentSeconds = Number.NEGATIVE_INFINITY;
  let firstSeconds = Number.POSITIVE_INFINITY;

  for (const entry of timeline) {
    if (entry.seconds === null) continue;
    if (entry.seconds < firstSeconds) {
      firstSeconds = entry.seconds;
      firstTimedItem = entry.item;
    }
    if (entry.seconds <= currentTime && entry.seconds >= currentSeconds) {
      currentSeconds = entry.seconds;
      current = entry.item;
    }
  }

  return current ?? (fallbackToFirst ? firstTimedItem : null);
}
