"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { useRouteIntent } from "@/features/navigation/use-route-prefetch";

/** Keep Next's viewport prefetch; user intent additionally warms the full dynamic route. */
export default function PrefetchLink({ href, prefetch, onMouseEnter, onFocus, onTouchStart, ...props }: ComponentProps<typeof Link>) {
  const intent = useRouteIntent(prefetch !== false && typeof href === "string" ? href : null);
  return <Link {...props} href={href} prefetch={prefetch}
    onMouseEnter={event => { onMouseEnter?.(event); if (!event.defaultPrevented) intent.onMouseEnter(); }}
    onFocus={event => { onFocus?.(event); if (!event.defaultPrevented) intent.onFocus(); }}
    onTouchStart={event => { onTouchStart?.(event); if (!event.defaultPrevented) intent.onTouchStart(); }} />;
}
