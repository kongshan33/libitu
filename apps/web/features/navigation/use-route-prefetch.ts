"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

/** Warm page code/RSC only; never mount the destination or run its client effects. */
export function useRoutePrefetch() {
  const router = useRouter();
  const warmed = useRef(new Map<string, number>());
  return useCallback((href: string | null | undefined) => {
    if (!href?.startsWith("/") || href.startsWith("//")) return;
    const target = href.split("#")[0];
    if (target === window.location.pathname + window.location.search) return;
    const now = Date.now();
    if (now - (warmed.current.get(target) ?? 0) < 30_000) return;
    const entries = warmed.current;
    if (entries.size >= 32) entries.delete(entries.keys().next().value!);
    entries.set(target, now);
    router.prefetch(target);
  }, [router]);
}

export function useRouteIntent(href: string | null | undefined) {
  const prefetch = useRoutePrefetch();
  const warm = useCallback(() => prefetch(href), [prefetch, href]);
  return { onMouseEnter: warm, onFocus: warm, onTouchStart: warm };
}
