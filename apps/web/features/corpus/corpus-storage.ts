import type { CorpusItem, CorpusSelectionAnalysis, CorpusSelectionContext } from "@libitu/types/stage-one";

export type SavedCorpusRecord = {
  key: string;
  item: CorpusItem;
  contentId?: string;
  sourceUrl: string;
  sourceTitle: string;
  serverId?: string;
};
export type CorpusStorageState = {
  owner: string | null;
  ready: boolean;
  busy: boolean;
  records: SavedCorpusRecord[];
  error: string | null;
};
export type CorpusRemote = {
  list(signal: AbortSignal): Promise<SavedCorpusRecord[]>;
  save(record: SavedCorpusRecord, signal: AbortSignal): Promise<SavedCorpusRecord>;
  hydrate(record: SavedCorpusRecord, context: CorpusSelectionContext, signal: AbortSignal): Promise<SavedCorpusRecord>;
  remove(id: string, signal: AbortSignal): Promise<void>;
};
type Envelope = { version: 1; guest: SavedCorpusRecord[]; pending: Record<string, SavedCorpusRecord[]> };
export const CORPUS_STORAGE_KEY = "libitu:corpus:v1";

export function savedCorpusKey(source: string, item: CorpusItem): string {
  const phrase = item.kind === "structure" ? item.text : item.text.match(/^["“'](.+?)["”']\s*[-–—]/)?.[1] ?? item.text;
  return JSON.stringify([source, item.kind, phrase.toLowerCase().match(/[a-z0-9']+/g)?.join(" ") ?? phrase]);
}

function mergeRecords(records: SavedCorpusRecord[]): SavedCorpusRecord[] {
  return [...new Map(records.map((record) => [record.key, record])).values()];
}

function validRecords(value: unknown): value is SavedCorpusRecord[] {
  return Array.isArray(value) && value.every((record) => record && typeof record.key === "string"
    && typeof record.sourceUrl === "string" && typeof record.sourceTitle === "string"
    && record.item && typeof record.item.id === "string" && typeof record.item.text === "string"
    && ["chunk", "idiom", "structure"].includes(record.item.kind) && Array.isArray(record.item.tags)
    && typeof record.item.meta === "string");
}

export class CorpusStorage {
  state: CorpusStorageState = { owner: null, ready: false, busy: false, records: [], error: null };
  private controller = new AbortController();
  private remote: CorpusRemote | null = null;
  private listeners = new Set<(state: CorpusStorageState) => void>();

  constructor(private readonly storage: () => Storage) {}

  subscribe(listener: (state: CorpusStorageState) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close() { this.controller.abort(); }

  private publish(update: Partial<CorpusStorageState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener(this.state));
  }

  private read(): Envelope {
    const raw = this.storage().getItem(CORPUS_STORAGE_KEY);
    if (!raw) return { version: 1, guest: [], pending: {} };
    const value = JSON.parse(raw) as Envelope;
    if (value.version !== 1 || !validRecords(value.guest) || !value.pending
      || Array.isArray(value.pending) || typeof value.pending !== "object"
      || !Object.values(value.pending).every(validRecords)) {
      throw new Error("Local corpus data could not be read. It has not been overwritten.");
    }
    return value;
  }

  private async mutate(signal: AbortSignal, update: (value: Envelope) => void) {
    const write = () => {
      signal.throwIfAborted();
      const value = this.read();
      update(value);
      const serialized = JSON.stringify(value);
      if (this.storage().getItem(CORPUS_STORAGE_KEY) !== serialized) {
        this.storage().setItem(CORPUS_STORAGE_KEY, serialized);
      }
    };
    // Serialize guest claims and acknowledgements across tabs when Web Locks is available.
    if (typeof navigator !== "undefined" && navigator.locks) {
      await navigator.locks.request(CORPUS_STORAGE_KEY, { signal }, write);
    } else {
      write();
    }
  }

  private fail(error: unknown, signal: AbortSignal) {
    if (signal.aborted) return;
    this.publish({ busy: false, error: error instanceof Error ? error.message : "Corpus operation failed. Please retry." });
  }

  async open(owner: string | null, remote: CorpusRemote | null = null) {
    this.close();
    const signal = (this.controller = new AbortController()).signal;
    this.remote = remote;
    this.publish({ owner, ready: false, busy: true, records: [], error: null });
    try {
      if (!owner) {
        this.publish({ records: this.read().guest, ready: true, busy: false });
        return;
      }
      if (!remote) throw new Error("Sign in again to sync your corpus.");
      // One atomic local write binds guest records to this account before any upload.
      await this.mutate(signal, (value) => {
        value.pending[owner] = mergeRecords([...value.guest, ...(value.pending[owner] ?? [])]);
        value.guest = [];
      });
      signal.throwIfAborted();
      const pending = this.read().pending[owner] ?? [];
      this.publish({ records: pending });
      const cloud = await remote.list(signal);
      signal.throwIfAborted();
      this.publish({ records: mergeRecords([...pending, ...cloud]) });
      for (const record of pending) {
        signal.throwIfAborted();
        const saved = cloud.find((item) => item.key === record.key) ?? await remote.save(record, signal);
        signal.throwIfAborted();
        await this.acknowledge(owner, record.key, signal);
        signal.throwIfAborted();
        this.publish({ records: mergeRecords([...this.state.records, saved]) });
      }
      this.publish({ ready: true, busy: false });
    } catch (error) {
      this.fail(error, signal);
    }
  }

  private acknowledge(owner: string, key: string, signal: AbortSignal) {
    return this.mutate(signal, (value) => {
      value.pending[owner] = (value.pending[owner] ?? []).filter((record) => record.key !== key);
    });
  }

  async save(record: SavedCorpusRecord): Promise<boolean> {
    if (!this.state.ready || this.state.busy) return false;
    const { owner } = this.state;
    const signal = this.controller.signal;
    const remote = this.remote;
    this.publish({ busy: true, error: null });
    try {
      await this.mutate(signal, (value) => {
        if (owner) value.pending[owner] = mergeRecords([...(value.pending[owner] ?? []), record]);
        else value.guest = mergeRecords([...value.guest, record]);
      });
      signal.throwIfAborted();
      this.publish({ records: mergeRecords([...this.state.records, record]) });
      if (owner && remote) {
        const saved = await remote.save(record, signal);
        signal.throwIfAborted();
        await this.acknowledge(owner, record.key, signal);
        signal.throwIfAborted();
        this.publish({ records: mergeRecords([...this.state.records, saved]) });
      }
      this.publish({ busy: false });
      return true;
    } catch (error) {
      this.fail(error, signal);
      return false;
    }
  }

  async hydrate(
    record: SavedCorpusRecord,
    context: CorpusSelectionContext,
    analyze: () => Promise<CorpusSelectionAnalysis>,
  ): Promise<SavedCorpusRecord | null> {
    if (record.item.analysisDetail || !this.state.ready || this.state.busy) return record.item.analysisDetail ? record : null;
    const { owner } = this.state;
    const signal = this.controller.signal;
    const remote = this.remote;
    this.publish({ busy: true, error: null });
    try {
      const enriched = owner && remote && record.serverId
        ? await remote.hydrate(record, context, signal)
        : { ...record, item: { ...record.item, analysisDetail: { context, analysis: await analyze() } } };
      signal.throwIfAborted();
      if (!owner || !record.serverId) {
        await this.mutate(signal, (value) => {
          if (owner) {
            value.pending[owner] = mergeRecords((value.pending[owner] ?? []).map((item) => item.key === record.key ? enriched : item));
          } else {
            value.guest = mergeRecords(value.guest.map((item) => item.key === record.key ? enriched : item));
          }
        });
      }
      signal.throwIfAborted();
      this.publish({
        records: this.state.records.map((item) => item.key === record.key ? enriched : item),
        busy: false
      });
      return enriched;
    } catch (error) {
      this.fail(error, signal);
      return null;
    }
  }

  async remove(record: SavedCorpusRecord): Promise<boolean> {
    if (!this.state.ready || this.state.busy) return false;
    const { owner } = this.state;
    const signal = this.controller.signal;
    const remote = this.remote;
    this.publish({ busy: true, error: null });
    try {
      if (owner && remote) {
        // A timed-out save may have committed. Resolve it before clearing the outbox.
        const id = record.serverId ?? (await remote.list(signal)).find((item) => item.key === record.key)?.serverId;
        signal.throwIfAborted();
        if (id) await remote.remove(id, signal);
      }
      await this.mutate(signal, (value) => {
        if (owner) value.pending[owner] = (value.pending[owner] ?? []).filter((item) => item.key !== record.key);
        else value.guest = value.guest.filter((item) => item.key !== record.key);
      });
      signal.throwIfAborted();
      this.publish({ records: this.state.records.filter((item) => item.key !== record.key), busy: false });
      return true;
    } catch (error) {
      this.fail(error, signal);
      return false;
    }
  }
}
