import type { CorpusItem, CorpusSelectionContext } from "@libitu/types/stage-one";
import { savedCorpusKey, type CorpusRemote, type SavedCorpusRecord } from "./corpus-storage.ts";
import {
  toApiCorpusSelectionAnalysis,
  toCorpusSelectionAnalysis,
  type ApiCorpusSelectionAnalysis
} from "../stage-one/api/stage-one-api.ts";

type ApiSelectionContext = {
  content_id?: string | null;
  selected_text: string;
  current_sentence: string;
  context_before?: string | null;
  context_after?: string | null;
  timestamp?: string | null;
};

type ApiAnalysisDetail = {
  context: ApiSelectionContext;
  analysis: ApiCorpusSelectionAnalysis;
};

type ApiRecord = {
  id: string;
  content_id: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  kind: CorpusItem["kind"];
  text: string;
  meaning: string | null;
  usage_context: string | null;
  tags: CorpusItem["tags"];
  slots: Record<string, string>;
  analysis_detail?: ApiAnalysisDetail | null;
  source_locator?: {
    client_key?: string;
    source_url?: string;
    source_title?: string;
    snapshot?: Record<string, unknown>;
  };
};

function toPayload(record: SavedCorpusRecord) {
  const item = record.item;
  const text = item.kind === "structure" ? item.text : item.text.match(/^["“'](.+?)["”']\s*[-–—]/)?.[1] ?? item.text;
  return {
    content_id: record.contentId ?? null, kind: item.kind, text, meaning: item.meaning ?? null,
    usage_context: item.usageNote ?? null, tags: item.tags, slots: item.slots ?? {},
    analysis_detail: item.analysisDetail ? {
      context: toApiContext(item.analysisDetail.context),
      analysis: toApiCorpusSelectionAnalysis(item.analysisDetail.analysis)
    } : null,
    source_locator: {
      client_key: record.key, source_url: record.sourceUrl, source_title: record.sourceTitle,
      snapshot: {
        id: item.id, kind: item.kind, text: item.text, tags: item.tags, meta: item.meta,
        meaning: item.meaning, usage_note: item.usageNote, source_text: item.sourceText,
        level: item.level, register: item.register, scenario_tags: item.scenarioTags,
        pattern_family: item.patternFamily, phonology_note: item.phonologyNote,
        naturalness_score: item.naturalnessScore, transferability_score: item.transferabilityScore,
        learning_value_score: item.learningValueScore
      }
    }
  };
}

function fromApi(row: ApiRecord): SavedCorpusRecord {
  const locator = row.source_locator ?? {};
  const snapshot = locator.snapshot ?? {};
  const item: CorpusItem = {
    id: typeof snapshot.id === "string" ? snapshot.id : row.id,
    kind: row.kind, text: row.kind === "structure" || !row.meaning ? row.text : `"${row.text}" - ${row.meaning}`,
    tags: row.tags, meta: typeof snapshot.meta === "string" ? snapshot.meta : "Saved to corpus",
    saved: true, meaning: row.meaning ?? undefined, usageNote: row.usage_context ?? undefined,
    sourceText: snapshot.source_text as string | undefined, level: snapshot.level as CorpusItem["level"],
    register: snapshot.register as CorpusItem["register"], scenarioTags: snapshot.scenario_tags as string[] | undefined,
    patternFamily: snapshot.pattern_family as string | undefined, phonologyNote: snapshot.phonology_note as string | undefined,
    naturalnessScore: snapshot.naturalness_score as number | undefined,
    transferabilityScore: snapshot.transferability_score as number | undefined,
    learningValueScore: snapshot.learning_value_score as number | undefined, slots: row.slots,
    analysisDetail: row.analysis_detail ? {
      context: fromApiContext(row.analysis_detail.context),
      analysis: toCorpusSelectionAnalysis(row.analysis_detail.analysis)
    } : undefined
  };
  return {
    key: locator.client_key ?? (typeof snapshot.text === "string"
      ? savedCorpusKey(row.content_id ?? locator.source_url ?? "", { ...item, text: snapshot.text })
      : `server:${row.id}`),
    contentId: row.content_id ?? undefined, sourceUrl: locator.source_url ?? "",
    sourceTitle: locator.source_title ?? "", item, serverId: row.id,
    createdAt: row.created_at ?? undefined, updatedAt: row.updated_at ?? undefined
  };
}

function toApiContext(context: CorpusSelectionContext): ApiSelectionContext {
  return {
    content_id: context.contentId,
    selected_text: context.selectedText,
    current_sentence: context.currentSentence,
    context_before: context.contextBefore,
    context_after: context.contextAfter,
    timestamp: context.timestamp
  };
}

function fromApiContext(context: ApiSelectionContext): CorpusSelectionContext {
  return {
    contentId: context.content_id ?? undefined,
    selectedText: context.selected_text,
    currentSentence: context.current_sentence,
    contextBefore: context.context_before ?? undefined,
    contextAfter: context.context_after ?? undefined,
    timestamp: context.timestamp ?? undefined
  };
}

export function createCorpusRemote(owner: string, getToken: () => Promise<string | null>): CorpusRemote {
  async function request<T>(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<T> {
    signal.throwIfAborted();
    const token = await getToken();
    signal.throwIfAborted();
    if (!token) throw new Error("Sign in again to sync your corpus.");
    // This is an account-switch guard, not JWT verification; FastAPI verifies the token.
    const encoded = token.split(".")[1];
    const claims = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
    if (claims.sub !== owner) throw new Error("Account changed. Please retry corpus sync.");
    const timeout = AbortSignal.timeout(20_000);
    const response = await fetch(`${(process.env.NEXT_PUBLIC_LIBITU_API_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "")}/api/corpus${path}`, {
      ...init, signal: AbortSignal.any([signal, timeout]),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      if (init.method === "DELETE" && response.status === 404) return undefined as T;
      throw new Error(response.status === 401 ? "Sign in again to sync your corpus."
        : init.method === "PATCH" ? "Changes could not be confirmed. Your edit is still here; retry saving or reload to check the saved version."
        : init.method === "DELETE" ? "Deletion could not be confirmed. Retry deleting or reload to check the saved version."
        : "Corpus sync failed. Your pending items are kept on this device; retry to sync.");
    }
    const result = response.status === 204 ? undefined : await response.json();
    signal.throwIfAborted();
    return result as T;
  }
  return {
    list: async (signal) => (await request<ApiRecord[]>("", signal)).map(fromApi),
    save: async (record, signal) => fromApi(await request<ApiRecord>("", signal, { method: "POST", body: JSON.stringify(toPayload(record)) })),
    hydrate: async (record, context, signal) => {
      if (!record.serverId) throw new Error("This corpus item is still waiting to sync.");
      return fromApi(await request<ApiRecord>(`/${encodeURIComponent(record.serverId)}/analysis-detail`, signal, {
        method: "POST",
        body: JSON.stringify(toApiContext(context))
      }));
    },
    update: async (record, edit, signal) => {
      if (!record.serverId) throw new Error("Sync this item before editing.");
      return fromApi(await request<ApiRecord>(`/${encodeURIComponent(record.serverId)}`, signal, {
        method: "PATCH", body: JSON.stringify({ text: edit.text, meaning: edit.meaning,
          usage_context: edit.usageNote, tags: edit.tags, slots: edit.slots })
      }));
    },
    remove: (id, signal) => request<void>(`/${encodeURIComponent(id)}`, signal, { method: "DELETE" })
  };
}
