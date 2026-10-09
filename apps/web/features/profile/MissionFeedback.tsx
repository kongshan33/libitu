"use client";

import { ContentSkeleton } from "@/components/ui/ContentSkeleton";

import { DirectionLink } from "@/components/ui/direction-button";

import { useState } from "react";
import { ArrowRight, ClipboardCheck } from "lucide-react";
import type { FeedbackDimensionId } from "@libitu/types/speaking";
import type { ProfileData, ProfileFeedback } from "./types";
import styles from "./Profile.module.css";

const dimensions: { id: FeedbackDimensionId; label: string; explanation: string }[] = [
  { id: "task_fit", label: "Task fit", explanation: "How your language helped move toward this Mission’s goal." },
  { id: "transfer", label: "Language transfer", explanation: "Coverage of selected language used appropriately. Each item counts once; prompted use also counts." },
  { id: "scenario_fit", label: "Scenario fit", explanation: "How your tone and choices fit this conversation’s context." },
  { id: "naturalness", label: "Naturalness", explanation: "Clarity, grammar and word choices in your transcript. This does not assess pronunciation or speech timing." }
];

export function MissionFeedback({ data, loading }: { data: ProfileData | null; loading: boolean }) {
  const report = data?.latest_feedback;
  const unavailable = data?.latest_feedback_unavailable_reason;
  return <section className={styles.card} aria-labelledby="feedback-title">
    <div className={styles.cardHeader}><h2 id="feedback-title"><ClipboardCheck size={16} aria-hidden="true" />Latest Mission feedback</h2>
      <span className={styles.smallMuted}>{report?.status === "partial" ? "Partial report" : "Stage 5"}</span></div>
    {report ? <FeedbackDetails key={`${report.id}:${report.updated_at}`} report={report} timezone={data!.timezone} />
      : loading ? <ContentSkeleton label="Loading Mission feedback…" rows={1} />
        : !data ? <p className={styles.loading}>Mission feedback is unavailable. Retry loading your learning records above.</p>
          : <div className={styles.feedbackEmpty}><div><strong>{unavailable === "legacy_report" ? "Your earlier conversation is in your history" : unavailable === "version_mismatch" ? "Your earlier report is in your history" : unavailable === "invalid_result" ? "This report needs a closer look" : "Your next Mission can bring new insight"}</strong>
            <p>{unavailable === "legacy_report" ? "This older record has no compatible report. You can review the conversation from practice history."
              : unavailable === "version_mismatch" ? "This overview uses the current scoring rubric. You can still open the earlier report from practice history."
              : unavailable === "invalid_result" ? "A saved report could not be summarized. Open it from practice history to check its status."
                : "End a Mission to receive feedback on your goal, language use, scenario fit and naturalness. Saved results will appear here."}</p></div>
            <DirectionLink href="/profile/history" className={styles.textLink}>View practice history <ArrowRight size={14} aria-hidden="true" /></DirectionLink>
          </div>}
  </section>;
}

function FeedbackDetails({ report, timezone }: { report: ProfileFeedback; timezone: string }) {
  const [active, setActive] = useState<FeedbackDimensionId>("task_fit");
  const selected = report.dimensions.find((dimension) => dimension.id === active);
  const label = dimensions.find((dimension) => dimension.id === active)!;
  return <div className={styles.feedbackBody}>
    <div className={styles.feedbackHeading}><div><h3>{report.goal}</h3><p><time dateTime={report.practiced_at}>{new Date(report.practiced_at).toLocaleDateString("en", { timeZone: timezone, month: "short", day: "numeric", year: "numeric" })}</time>
      <span aria-hidden="true"> · </span>{report.scenario_type === "workplace" ? "Workplace" : "Everyday life"}<span aria-hidden="true"> · </span>{report.difficulty[0].toUpperCase() + report.difficulty.slice(1)}</p></div>
      <DirectionLink href={`/speaking/${encodeURIComponent(report.session_id)}/analytics`} className={styles.textLink}>View full report <ArrowRight size={14} aria-hidden="true" /></DirectionLink>
    </div>
    <div className={styles.feedbackScores} role="group" aria-label="Mission feedback dimensions">
      {dimensions.map((dimension) => {
        const value = report.dimensions.find((item) => item.id === dimension.id);
        const score = value?.score;
        const available = typeof score === "number";
        return <button type="button" key={dimension.id} aria-pressed={active === dimension.id} aria-controls="mission-feedback-detail" onClick={() => setActive(dimension.id)}>
          <span className={styles.feedbackLabel}>{dimension.label}</span><span className={styles.feedbackScore}>{available ? <>{score}<small> / 100</small></> : <span className={styles.unassessedScore}>Not assessed</span>}</span>
          <span className={styles.feedbackBar} aria-hidden="true">{available ? <span style={{ width: `${score}%` }} /> : null}</span>
          <span className={styles.feedbackBasis}>{dimension.id === "transfer" ? "Coverage" : "AI assessment"}</span>
        </button>;
      })}
    </div>
    <div className={styles.feedbackDetail} id="mission-feedback-detail" aria-live="polite"><strong>{label.label}</strong><p>{selected?.summary || "There is not enough evidence to assess this dimension."}</p><span>{label.explanation}</span></div>
    <p className={styles.feedbackNote}>{report.status === "partial" ? "Some dimensions lack enough evidence. Missing scores stay unassessed. " : ""}Scores describe this conversation, not your overall English level.</p>
  </div>;
}
