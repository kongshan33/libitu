"use client";

import { useState } from "react";
import type { ActivityPoint, ProfileData, ProfileRange } from "./types";
import { activityDate } from "./format";
import styles from "./Profile.module.css";

const metrics = [
  { key: "shadowing_attempts", label: "Shadowing takes", color: "var(--purple-600)" },
  { key: "speaking_turns", label: "Speaking turns", color: "var(--teal-600)" },
  { key: "corpus_added", label: "Corpus added", color: "#986013" }
] as const;

export function ActivityChart({ data, range, onRange, loading }: {
  data: ProfileData | null; range: ProfileRange; onRange: (range: ProfileRange) => void; loading: boolean;
}) {
  const [metric, setMetric] = useState<keyof Omit<ActivityPoint, "date">>("shadowing_attempts");
  const selected = metrics.find((item) => item.key === metric)!;
  const items = data?.activity.items ?? [];
  const known = items.length > 0 && items.every((item) => item[metric] !== null);
  const values = items.map((item) => item[metric] ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const max = Math.max(1, ...values);
  const x = (index: number) => 35 + index * 405 / Math.max(1, items.length - 1);
  const y = (value: number) => 153 - value / max * 115;
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const month = data?.activity.bucket === "month";

  return <section className={styles.card} aria-labelledby="activity-title">
    <div className={styles.cardHeader}><h2 id="activity-title">Learning activity</h2><span className={styles.smallMuted}>Saved activity</span></div>
    <div className={styles.chartBody}>
      <div className={styles.rangeGroup} role="group" aria-label="Activity date range">
        {([["4w", "Last 4 weeks"], ["3m", "Last 3 months"], ["all", "All time"]] as const).map(([value, label]) =>
          <button type="button" key={value} aria-pressed={range === value} onClick={() => onRange(value)}>{label}</button>)}
      </div>
      <div className={styles.metricGroup} role="group" aria-label="Activity metric">
        {metrics.map((item) => <button type="button" key={item.key} aria-pressed={metric === item.key} onClick={() => setMetric(item.key)}>
          <span style={{ background: item.color }} aria-hidden="true" />{item.label}
        </button>)}
      </div>
      <div className={styles.chart} aria-busy={loading}>
        {loading ? <div className={styles.chartMessage} role="status">Loading activity…</div> : !data ? <div className={styles.chartMessage}>Activity is unavailable.</div>
          : !known ? <div className={styles.chartMessage}>Dates aren’t available for this activity yet.</div>
            : total === 0 ? <div className={styles.chartMessage}><strong>No {selected.label.toLowerCase()} in this period</strong><span>Your saved activity will appear here.</span></div>
              : <>
                <div className={styles.chartTotal}><strong>{total.toLocaleString("en")}</strong><span>{selected.label.toLowerCase()} in this period</span></div>
                <svg viewBox="0 0 460 190" role="img" aria-label={`${selected.label}: ${total} in the selected period. Daily or monthly values are in the activity table below.`}>
                  {[...new Set([0, Math.ceil(max / 2), max])].map((value) => <g key={value}><line x1="35" x2="440" y1={y(value)} y2={y(value)} stroke="var(--color-border-tertiary)" strokeDasharray="3 4" /><text x="23" y={y(value) + 4} textAnchor="end">{value}</text></g>)}
                  <polyline points={points} fill="none" stroke={selected.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
                  {items.map((item, index) => <circle key={item.date} cx={x(index)} cy={y(values[index])} r={items.length > 35 ? 2 : 3} fill={selected.color}><title>{activityDate(item.date, month)}: {values[index]}</title></circle>)}
                  <text x="35" y="178">{activityDate(items[0].date, month)}</text><text x="440" y="178" textAnchor="end">{activityDate(items.at(-1)!.date, month)}</text>
                </svg>
              </>}
      </div>
      {data ? <p className={styles.chartCaption}>{activityDate(data.activity.start_date)} – {activityDate(data.activity.end_date)} · {data.timezone.replaceAll("_", " ")}<br />{month ? "Monthly" : "Daily"} counts · {metric === "corpus_added" ? "Items still in your corpus, grouped by save date." : "Speaking turns are your finalized contributions."}</p> : null}
      {known && !loading ? <details className={styles.tableDetails}><summary>View activity data</summary><div className={styles.tableScroll}>
        <table><caption>{selected.label}</caption><thead><tr><th scope="col">{month ? "Month" : "Date"}</th><th scope="col">Count</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.date}><th scope="row">{activityDate(item.date, month)}</th><td>{item[metric]}</td></tr>)}</tbody>
        </table></div></details> : null}
    </div>
  </section>;
}
