import type { AttemptPage, PracticeApi, PracticeAttempt } from "./practice-api.ts";

/** Refresh the loaded depth, extending it when necessary to keep a selected older take visible. */
export async function loadHistoryPages(api: Pick<PracticeApi, "list">, content: string, sentence: string,
  minimum: number, selected: string | null, signal: AbortSignal): Promise<AttemptPage> {
  const items = new Map<string, PracticeAttempt>();
  let offset = 0;
  for (;;) {
    signal.throwIfAborted();
    const page = await api.list(content, sentence, offset, signal);
    for (const item of page.items) items.set(item.id, item);
    if (page.next_offset === null || (items.size >= minimum && (!selected || items.has(selected)))) {
      return { items: [...items.values()], next_offset: page.next_offset };
    }
    if (page.next_offset <= offset) throw new Error("History pagination could not continue. Reload history.");
    offset = page.next_offset;
  }
}
