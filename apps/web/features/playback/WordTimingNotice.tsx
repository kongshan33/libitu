"use client";

import { memo, useMemo } from "react";
import { Info } from "lucide-react";
import { captionTimingCoverage, wordTimingNotice, type CaptionTimingText } from "./caption-timing-availability";

type Props = {
  rows: readonly CaptionTimingText[];
  enabled?: boolean;
  concealed?: boolean;
  pending?: boolean;
};

/** Caption capability changes with source data/settings, never with playback ticks. */
export const WordTimingNotice = memo(function WordTimingNotice({ rows, enabled = true, concealed = false, pending = false }: Props) {
  const coverage = useMemo(() => captionTimingCoverage(rows), [rows]);
  const notice = wordTimingNotice(coverage, { enabled, concealed, pending });
  if (!notice) return null;
  return <div className="word-timing-notice" data-word-timing-status={notice.status}
    role="status" aria-label="Word timing status" aria-live="polite" aria-atomic="true">
    <Info size={16} aria-hidden="true" />
    <div><strong>{notice.title}</strong><span>{notice.detail}</span></div>
  </div>;
});
