"use client";

import { ButtonLink } from "@/components/ui/button";

import type { ReactNode } from "react";
import { missionHref } from "./return-location";
import { useCurrentLocation } from "./use-current-location";

/** Real href preserves the source for ordinary, modified and new-tab navigation. */
export function LoadoutLink({ className, children, size = "inherit", shape = "pill" }: { className?: string; children: ReactNode; size?: "sm" | "inherit"; shape?: "default" | "pill" }) {
  const location = useCurrentLocation();
  return <ButtonLink variant="secondary" size={size} shape={shape} href={missionHref("loadout", location)} className={className} style={{ textDecoration: "none" }}>{children}</ButtonLink>;
}
