import type { HistoryItem } from "./types";

/** Group the server's ordered pages by actual local dates, including DST changes. */
export function groupHistory(items: HistoryItem[], timezone: string) {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone: timezone, weekday: "long", month: "short", day: "numeric", year: "numeric"
  });
  const groups = new Map<string, HistoryItem[]>();
  for (const item of items) {
    const label = formatter.format(new Date(item.occurred_at));
    const group = groups.get(label) ?? [];
    group.push(item);
    groups.set(label, group);
  }
  return Array.from(groups, ([label, rows]) => ({ label, items: rows }));
}

export function practiceStatus(item: HistoryItem): string {
  if (item.kind === "shadowing") return "Saved take";
  return { active: "In progress", completed: "Completed", abandoned: "Ended early", draft: "Prepared", recorded: "Recorded" }[item.status];
}
