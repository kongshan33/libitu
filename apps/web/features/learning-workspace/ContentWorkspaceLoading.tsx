"use client";

import { usePathname } from "next/navigation";
import { StageTwoLoadingShell } from "../stage-two/components/StageTwoSkeleton";
import { ReaderLoadingShell } from "../stage-one/components/ReaderSkeleton";

/** Read only the path: this fallback must not suspend on workspace data or search params. */
export function ContentWorkspaceLoading() {
  const pathname = usePathname();
  const isPractice = pathname.endsWith("/segments") || pathname.endsWith("/shadow");
  if (!isPractice) return <ReaderLoadingShell />;
  return <StageTwoLoadingShell view={pathname.endsWith("/segments") ? "segments" : "shadow"} />;
}
