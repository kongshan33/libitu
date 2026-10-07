"use client";

import { ButtonLink } from "@/components/ui/button";

import { useRouter } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";

/** Capture the current sentence/source URL at the user's navigation gesture. */
export function LoadoutLink({ className, children, size = "inherit", shape = "pill" }: { className?: string; children: ReactNode; size?: "sm" | "inherit"; shape?: "default" | "pill" }) {
  const router = useRouter();
  function navigate(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const returnTo = window.location.pathname + window.location.search + window.location.hash;
    router.push(`/loadout?${new URLSearchParams({ returnTo })}`);
  }
  return <ButtonLink variant="secondary" size={size} shape={shape} href="/loadout" className={className} style={{ textDecoration: "none" }} onClick={navigate}>{children}</ButtonLink>;
}
