import type { CorpusFilter, CorpusItem, LearnerLevel } from "@libitu/types/stage-one";

const levelOrder: LearnerLevel[] = ["A1", "A2", "B1", "B2", "C1", "C2"];

// Keep preview ranking aligned with blueprint_service._select_corpus_items.
export function selectCorpusItems(items: CorpusItem[], level?: LearnerLevel, limit = 12): CorpusItem[] {
  const rank = (item: CorpusItem) => {
    const quality = (item.learningValueScore ?? 3) * 2
      + (item.naturalnessScore ?? 3) + (item.transferabilityScore ?? 3);
    if (!level || !item.level) return quality;
    const delta = levelOrder.indexOf(item.level) - levelOrder.indexOf(level);
    const bonus: Record<number, number> = { 0: 8, 1: 6, [-1]: 5, 2: 2, [-2]: 2 };
    return quality + (bonus[delta] ?? 0);
  };
  const ranked = [...items].sort((a, b) => rank(b) - rank(a));
  if (ranked.length <= limit) return ranked;
  const idioms = Math.max(1, Math.floor(limit / 6));
  const structures = Math.max(2, Math.floor(limit / 3));
  const chunks = Math.max(1, limit - idioms - structures);
  const selected = new Set([
    ...ranked.filter((item) => item.kind === "chunk").slice(0, chunks),
    ...ranked.filter((item) => item.kind === "idiom").slice(0, idioms),
    ...ranked.filter((item) => item.kind === "structure").slice(0, structures)
  ].map((item) => item.id));
  for (const item of ranked) {
    if (selected.size >= limit) break;
    selected.add(item.id);
  }
  return ranked.filter((item) => selected.has(item.id)).slice(0, limit);
}

export function getInitialSavedCorpusIds(corpusItems: CorpusItem[]) {
  return new Set(corpusItems.filter((item) => item.saved).map((item) => item.id));
}

export function filterCorpusItems(corpusItems: CorpusItem[], filter: CorpusFilter, savedIds: Set<string>) {
  if (filter === "chunks") return corpusItems.filter((item) => item.kind === "chunk");
  if (filter === "idioms") return corpusItems.filter((item) => item.kind === "idiom");
  if (filter === "structures") return corpusItems.filter((item) => item.kind === "structure");
  return corpusItems.filter((item) => savedIds.has(item.id));
}
