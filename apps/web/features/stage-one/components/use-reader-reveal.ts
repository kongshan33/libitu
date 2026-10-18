"use client";

import { useLayoutEffect, useRef } from "react";

/** Decorate newly committed content without changing its keys, height or availability. */
export function useReaderReveal(sourceKey: string, revision: unknown) {
  const root = useRef<HTMLElement>(null);
  const seen = useRef({ sourceKey, keys: new Set<string>() });

  useLayoutEffect(() => {
    if (seen.current.sourceKey !== sourceKey) seen.current = { sourceKey, keys: new Set() };
    const batches = new Map<string, number>();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    root.current?.querySelectorAll<HTMLElement>("[data-reader-reveal]").forEach(element => {
      const key = element.dataset.readerReveal!;
      if (seen.current.keys.has(key)) return;
      seen.current.keys.add(key);
      const group = key.split(":", 1)[0];
      const index = batches.get(group) ?? 0;
      batches.set(group, index + 1);
      // Long transcripts must not create hundreds of composited animations or a long queue.
      if (reducedMotion || index >= 12) return;
      element.style.setProperty("--reader-reveal-delay", `${Math.min(index, 6) * 40}ms`);
      element.dataset.readerEntering = "true";
    });
  }, [sourceKey, revision]);

  return root;
}
