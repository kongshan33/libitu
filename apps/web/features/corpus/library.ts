import { CONTENT_ID, learningHref } from "../navigation/learning-location.ts";
import type { SavedCorpusRecord } from "./corpus-storage.ts";
import { expressionText } from "../loadout/draft.ts";

export type LibraryFilters = { query: string; kind: string[]; tags: string[]; level: string[]; register: string[]; scenario: string[]; source: string[]; highValue: boolean };
export type LibrarySort = "recent" | "value" | "transfer" | "alphabetical";
export const emptyFilters: LibraryFilters = { query: "", kind: [], tags: [], level: [], register: [], scenario: [], source: [], highValue: false };
export const functionalTags = ["acknowledging", "clarifying", "conceding", "contrast", "discourse", "emphasising", "framing", "hedging", "idiom", "justifying", "proposing", "reframing", "redirecting", "softening", "summarising", "summarizing", "transitioning"] as const;
export function sourceKey(record: SavedCorpusRecord) { return record.contentId || record.sourceUrl || "personal"; }
export function libraryItems(records: SavedCorpusRecord[], filters: LibraryFilters, sort: LibrarySort): SavedCorpusRecord[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const matches = (selected: string[], values: string[]) => !selected.length || selected.some((value) => values.includes(value));
  const filtered = records.filter((record) => {
    const item = record.item;
    return (!query || [expressionText(record), item.meaning, item.usageNote, ...item.tags, record.sourceTitle].join(" ").toLocaleLowerCase().includes(query))
      && matches(filters.kind, [item.kind]) && matches(filters.tags, item.tags)
      && matches(filters.level, [item.level ?? "unknown"]) && matches(filters.register, [item.register ?? "unknown"])
      && matches(filters.scenario, item.scenarioTags?.length ? item.scenarioTags : ["unknown"])
      && matches(filters.source, [sourceKey(record)]) && (!filters.highValue || (item.learningValueScore ?? 0) >= 4);
  });
  return filtered.sort((a, b) => {
    const difference = sort === "alphabetical" ? expressionText(a).localeCompare(expressionText(b))
      : sort === "value" ? (b.item.learningValueScore ?? -1) - (a.item.learningValueScore ?? -1)
      : sort === "transfer" ? (b.item.transferabilityScore ?? -1) - (a.item.transferabilityScore ?? -1)
      : (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0);
    // Retain repository order for legacy items with unknown dates; never fabricate dates.
    return difference;
  });
}
export function sourceHref(record: SavedCorpusRecord): string | null {
  if (record.contentId && CONTENT_ID.test(record.contentId)) return learningHref({ contentId: record.contentId });
  try { const url = new URL(record.sourceUrl); return ["https:", "http:"].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}
