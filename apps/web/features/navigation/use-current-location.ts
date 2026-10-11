"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useSyncExternalStore } from "react";
import { STAGE_TWO_LOCATION_CHANGED } from "../stage-two/location";

function subscribe(listener: () => void) {
  const events = ["popstate", "hashchange", STAGE_TWO_LOCATION_CHANGED];
  for (const event of events) window.addEventListener(event, listener);
  return () => { for (const event of events) window.removeEventListener(event, listener); };
}
const snapshot = () => window.location.pathname + window.location.search + window.location.hash;

/** Reader selection uses native history; expose its current href to real links. */
export function useCurrentLocation(): string {
  const pathname = usePathname();
  const params = useSearchParams();
  const browserHref = useSyncExternalStore(subscribe, snapshot, () => "");
  const hash = browserHref.includes("#") ? browserHref.slice(browserHref.indexOf("#")) : "";
  return pathname + (params.size ? `?${params}` : "") + hash;
}
