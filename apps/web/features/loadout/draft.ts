import type { LogicTemplateId, SpeakingDifficulty, SpeakingFeedbackLevel, SpeakingScenario, SpeakingSessionCreate } from "@libitu/types/speaking";
import type { SavedCorpusRecord } from "../corpus/corpus-storage.ts";

export const LOADOUT_STORAGE_KEY = "libitu:loadout:v1";
export const MAX_STRUCTURES = 3;
export const MAX_EXPRESSIONS = 5;
export const LOGIC_IDS: LogicTemplateId[] = ["persuasive_pitch", "technical_troubleshoot", "stakeholder_alignment", "status_update", "disagreement", "onboarding"];

export type LoadoutDraft = {
  scenarioType: SpeakingScenario;
  goal: string;
  difficulty: SpeakingDifficulty;
  feedbackLevel: SpeakingFeedbackLevel;
  logicTemplateId: LogicTemplateId | null;
  selectedKeys: string[];
  submission?: { signature: string; request: SpeakingSessionCreate };
};
type AccountDraft = { draft: LoadoutDraft; deviceDrafts: LoadoutDraft[] };
export type DraftEnvelope = { version: 1; guest: LoadoutDraft | null; accounts: Record<string, AccountDraft> };
export type DraftStorage = Pick<Storage, "getItem" | "setItem">;
export type DraftLock = <T>(operation: () => T) => Promise<T>;
type MutationContext = { lock?: DraftLock; isCurrent?: () => boolean };

const browserDraftLock: DraftLock = async (operation) => typeof navigator !== "undefined" && navigator.locks
  ? navigator.locks.request(LOADOUT_STORAGE_KEY, operation) : operation();

function mutateDraft<T>(operation: () => T, context: MutationContext): Promise<T | null> {
  return (context.lock ?? browserDraftLock)(() => context.isCurrent && !context.isCurrent() ? null : operation());
}

export function emptyDraft(): LoadoutDraft {
  return { scenarioType: "workplace", goal: "", difficulty: "standard", feedbackLevel: "balanced", logicTemplateId: null, selectedKeys: [] };
}

export function draftSignature(draft: LoadoutDraft): string {
  return JSON.stringify([draft.scenarioType, draft.goal.trim(), draft.difficulty, draft.feedbackLevel, draft.logicTemplateId, draft.selectedKeys]);
}

function validDraft(value: unknown): value is LoadoutDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as LoadoutDraft;
  if (!["workplace", "everyday"].includes(draft.scenarioType) || typeof draft.goal !== "string" || draft.goal.length > 500
    || !["guided", "standard", "challenging"].includes(draft.difficulty)
    || !["light", "balanced", "detailed"].includes(draft.feedbackLevel)
    || !(draft.logicTemplateId === null || LOGIC_IDS.includes(draft.logicTemplateId))
    || !Array.isArray(draft.selectedKeys) || draft.selectedKeys.length > 8
    || !draft.selectedKeys.every((key) => typeof key === "string") || new Set(draft.selectedKeys).size !== draft.selectedKeys.length) return false;
  if (!draft.submission) return true;
  const { signature, request } = draft.submission;
  return typeof signature === "string" && Boolean(request) && typeof request.client_id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.client_id)
    && request.scenario_type === draft.scenarioType && request.goal === draft.goal.trim()
    && request.difficulty === draft.difficulty && request.feedback_level === draft.feedbackLevel
    && request.logic_template_id === draft.logicTemplateId && signature === draftSignature(draft)
    && Array.isArray(request.corpus_item_ids) && request.corpus_item_ids.length === draft.selectedKeys.length
    && request.corpus_item_ids.every((id) => typeof id === "string" && id.length > 0)
    && new Set(request.corpus_item_ids).size === request.corpus_item_ids.length;
}

export function readDraftEnvelope(storage: DraftStorage): DraftEnvelope {
  const raw = storage.getItem(LOADOUT_STORAGE_KEY);
  if (!raw) return { version: 1, guest: null, accounts: {} };
  let envelope: DraftEnvelope;
  try { envelope = JSON.parse(raw) as DraftEnvelope; }
  catch { throw new Error("Your saved loadout could not be read. It has not been overwritten."); }
  if (!envelope || envelope.version !== 1 || !(envelope.guest === null || validDraft(envelope.guest))
    || !envelope.accounts || typeof envelope.accounts !== "object" || Array.isArray(envelope.accounts)
    || !Object.values(envelope.accounts).every((account) => account && validDraft(account.draft)
      && Array.isArray(account.deviceDrafts) && account.deviceDrafts.every(validDraft))) {
    throw new Error("Your saved loadout could not be read. It has not been overwritten.");
  }
  return envelope;
}

function accountOf(envelope: DraftEnvelope, owner: string): AccountDraft | undefined {
  return Object.hasOwn(envelope.accounts, owner) ? envelope.accounts[owner] : undefined;
}

/** Every envelope read/modify/write shares this lock, including ordinary field edits. */
export function openDraft(storage: DraftStorage, owner: string | null, claimGuest = true, context: MutationContext = {}): Promise<AccountDraft | null> {
  return mutateDraft(() => {
    const envelope = readDraftEnvelope(storage);
    if (!owner) return { draft: envelope.guest ?? emptyDraft(), deviceDrafts: [] };
    let account = accountOf(envelope, owner);
    if (!claimGuest) return account ?? { draft: emptyDraft(), deviceDrafts: [] };
    if (!account) account = { draft: envelope.guest ? { ...envelope.guest, submission: undefined } : emptyDraft(), deviceDrafts: [] };
    else if (envelope.guest) account = { ...account, deviceDrafts: [...account.deviceDrafts, { ...envelope.guest, submission: undefined }] };
    envelope.accounts = { ...envelope.accounts, [owner]: account };
    envelope.guest = null;
    storage.setItem(LOADOUT_STORAGE_KEY, JSON.stringify(envelope));
    return account;
  }, context);
}

export async function saveDraft(storage: DraftStorage, owner: string | null, draft: LoadoutDraft, context: MutationContext = {}): Promise<boolean> {
  return Boolean(await mutateDraft(() => {
    const envelope = readDraftEnvelope(storage);
    if (!owner) envelope.guest = { ...draft, submission: undefined };
    else envelope.accounts = { ...envelope.accounts, [owner]: { draft, deviceDrafts: accountOf(envelope, owner)?.deviceDrafts ?? [] } };
    storage.setItem(LOADOUT_STORAGE_KEY, JSON.stringify(envelope));
    return true;
  }, context));
}

export function adoptDeviceDraft(storage: DraftStorage, owner: string, index: number, context: MutationContext & { expectedSignature?: string } = {}): Promise<AccountDraft | null> {
  return mutateDraft(() => {
    const envelope = readDraftEnvelope(storage);
    const current = accountOf(envelope, owner);
    if (!current?.deviceDrafts[index]) throw new Error("This device draft is no longer available. Reload your loadout.");
    if (context.expectedSignature && draftSignature(current.deviceDrafts[index]) !== context.expectedSignature) {
      throw new Error("Device drafts changed in another tab. Review the updated drafts before choosing one.");
    }
    const account = { draft: { ...current.deviceDrafts[index], submission: undefined }, deviceDrafts: current.deviceDrafts.filter((_, position) => position !== index) };
    envelope.accounts = { ...envelope.accounts, [owner]: account };
    storage.setItem(LOADOUT_STORAGE_KEY, JSON.stringify(envelope));
    return account;
  }, context);
}

export function expressionText(record: SavedCorpusRecord): string {
  return record.item.kind === "structure" ? record.item.text : record.item.text.match(/^["“'](.+?)["”']\s*[-–—]/)?.[1] ?? record.item.text;
}

export function resolveSelection(draft: LoadoutDraft, records: SavedCorpusRecord[]) {
  const byKey = new Map(records.map((record) => [record.key, record]));
  const selected = draft.selectedKeys.map((key) => ({ key, record: byKey.get(key) }));
  return {
    selected,
    structures: selected.filter(({ record }) => record?.item.kind === "structure"),
    expressions: selected.filter(({ record }) => record && record.item.kind !== "structure"),
    missing: selected.filter(({ record }) => !record),
    unsynced: selected.filter(({ record }) => record && !record.serverId)
  };
}

export function toggleSelection(draft: LoadoutDraft, record: SavedCorpusRecord, records: SavedCorpusRecord[]): LoadoutDraft {
  if (draft.selectedKeys.includes(record.key)) return { ...draft, selectedKeys: draft.selectedKeys.filter((key) => key !== record.key), submission: undefined };
  const selection = resolveSelection(draft, records);
  const structure = record.item.kind === "structure";
  if ((structure ? selection.structures.length >= MAX_STRUCTURES : selection.expressions.length >= MAX_EXPRESSIONS) || draft.selectedKeys.length >= 8) return draft;
  return { ...draft, selectedKeys: [...draft.selectedKeys, record.key], submission: undefined };
}

export function selectionError(draft: LoadoutDraft, records: SavedCorpusRecord[], signedIn: boolean): string | null {
  if (!draft.goal.trim()) return "Add a specific goal for your mission.";
  if (draft.goal.trim().length > 500) return "Keep your mission goal within 500 characters.";
  if (!draft.selectedKeys.length) return "Select at least one saved expression or structure.";
  const selection = resolveSelection(draft, records);
  if (selection.missing.length) return "Some selected items are no longer in your corpus. Remove them before starting.";
  if (selection.structures.length > MAX_STRUCTURES || selection.expressions.length > MAX_EXPRESSIONS) return "Choose up to 3 structures and 5 expressions.";
  if (signedIn && selection.unsynced.length) return "Your selected items are still waiting to sync. Retry corpus sync before starting.";
  const ids = selection.selected.map(({ record }) => record?.serverId).filter(Boolean);
  if (new Set(ids).size !== ids.length) return "The same corpus item was selected twice. Remove the duplicate before starting.";
  return null;
}

export function prepareSubmission(draft: LoadoutDraft, records: SavedCorpusRecord[], uuid: () => string): LoadoutDraft {
  // An uncertain create may already have committed. Replay the exact original request.
  if (draft.submission?.signature === draftSignature(draft)) return draft;
  const error = selectionError(draft, records, true);
  if (error) throw new Error(error);
  const byKey = new Map(records.map((record) => [record.key, record]));
  return { ...draft, submission: { signature: draftSignature(draft), request: {
    client_id: uuid(), scenario_type: draft.scenarioType, goal: draft.goal.trim(),
    difficulty: draft.difficulty, feedback_level: draft.feedbackLevel, logic_template_id: draft.logicTemplateId,
    corpus_item_ids: draft.selectedKeys.map((key) => byKey.get(key)!.serverId!)
  } } };
}
