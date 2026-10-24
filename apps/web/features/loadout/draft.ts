import type { LogicTemplateId, SpeakingDifficulty, SpeakingFeedbackLevel, SpeakingScenario, SpeakingSessionCreate, SpeakingPlan, SpeakingTargetRole, SpeakingSupportLevel } from "@libitu/types/speaking";
import type { SavedCorpusRecord } from "../corpus/corpus-storage.ts";
import { isSupportLevel } from "../speaking/support.ts";

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
  targetRoles?: Record<string, SpeakingTargetRole>;
  supportLevel?: SpeakingSupportLevel | null;
  plan?: { signature: string; value: SpeakingPlan };
  selectedCandidateId?: string;
  submission?: { signature: string; request: SpeakingSessionCreate };
};
type AccountDraft = { draft: LoadoutDraft; deviceDrafts: LoadoutDraft[] };
export type DraftEnvelope = { version: 1; guest: LoadoutDraft | null; accounts: Record<string, AccountDraft> };
export type DraftStorage = Pick<Storage, "getItem" | "setItem">;
export type DraftLock = <T>(operation: () => T) => Promise<T>;
export class DraftConflictError extends Error {}

type MutationContext = { lock?: DraftLock; isCurrent?: () => boolean };

const browserDraftLock: DraftLock = async (operation) => typeof navigator !== "undefined" && navigator.locks
  ? navigator.locks.request(LOADOUT_STORAGE_KEY, operation) : operation();

function mutateDraft<T>(operation: () => T, context: MutationContext): Promise<T | null> {
  return (context.lock ?? browserDraftLock)(() => context.isCurrent && !context.isCurrent() ? null : operation());
}

export function emptyDraft(): LoadoutDraft {
  return { scenarioType: "workplace", goal: "", difficulty: "standard", feedbackLevel: "balanced", logicTemplateId: null, selectedKeys: [], supportLevel: "model_frame" };
}

export function draftSignature(draft: LoadoutDraft): string {
  const values: unknown[] = [draft.scenarioType, draft.goal.trim(), draft.difficulty, draft.feedbackLevel, draft.logicTemplateId, draft.selectedKeys];
  // Preserve the signature of legacy uncertain requests so they can be replayed.
  if (draft.targetRoles || draft.plan || draft.selectedCandidateId) values.push(draft.targetRoles ?? null, draft.plan?.value.id ?? null, draft.selectedCandidateId ?? null);
  if (draft.supportLevel != null) values.push(draft.supportLevel);
  return JSON.stringify(values);
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
  if (draft.targetRoles && (typeof draft.targetRoles !== "object" || Array.isArray(draft.targetRoles)
    || !Object.values(draft.targetRoles).every(role => role === "primary" || role === "opportunity"))) return false;
  if (draft.supportLevel != null && !isSupportLevel(draft.supportLevel)) return false;
  if (draft.plan && !validPlan(draft.plan.value)) return false;
  if (draft.plan && typeof draft.plan.signature !== "string") return false;
  if (draft.selectedCandidateId !== undefined && typeof draft.selectedCandidateId !== "string") return false;
  if (!draft.submission) return true;
  const { signature, request } = draft.submission;
  const candidate = draft.plan?.value.candidates.find(value => value.id === draft.selectedCandidateId);
  return typeof signature === "string" && Boolean(request) && typeof request.client_id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.client_id)
    && request.scenario_type === draft.scenarioType && request.goal === (request.plan_id ? candidate?.goal : draft.goal.trim())
    && request.difficulty === draft.difficulty && request.feedback_level === draft.feedbackLevel
    && (request.support_level ?? null) === (draft.supportLevel ?? null)
    && request.logic_template_id === draft.logicTemplateId && signature === draftSignature(draft)
    && Array.isArray(request.corpus_item_ids) && request.corpus_item_ids.length === draft.selectedKeys.length
    && request.corpus_item_ids.every((id) => typeof id === "string" && id.length > 0)
    && new Set(request.corpus_item_ids).size === request.corpus_item_ids.length
    && (!request.plan_id && !request.candidate_id || Boolean(request.plan_id === draft.plan?.value.id && request.candidate_id === candidate?.id));
}

export function validPlan(value: unknown): value is SpeakingPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as SpeakingPlan;
  return typeof plan.id === "string" && plan.version === 1 && ["workplace", "everyday"].includes(plan.scenario_type)
    && typeof plan.brief === "string" && typeof plan.created_at === "string"
    && (plan.practice_source == null || typeof plan.practice_source.parent_session_id === "string"
      && typeof plan.practice_source.root_session_id === "string" && ["details", "role_swap"].includes(plan.practice_source.variation)
      && /^[a-f0-9]{64}$/.test(plan.practice_source.parent_snapshot_hash))
    && Array.isArray(plan.candidates) && plan.candidates.length >= 1 && plan.candidates.length <= 3
    && plan.candidates.every(candidate => candidate && typeof candidate === "object")
    && new Set(plan.candidates.map(candidate => candidate.id)).size === plan.candidates.length
    && plan.candidates.every(candidate => candidate && ["id", "title", "setting", "goal", "user_role", "ai_role"].every(key => typeof candidate[key as keyof typeof candidate] === "string" && String(candidate[key as keyof typeof candidate]).trim().length > 0)
      && (candidate.changes === undefined || Array.isArray(candidate.changes) && candidate.changes.length <= 4
        && candidate.changes.every(change => change && ["setting", "goal", "user_role", "ai_role"].includes(change.field) && typeof change.before === "string" && typeof change.after === "string"))
      && ["casual", "neutral", "professional", "formal"].includes(candidate.register)
      && Array.isArray(candidate.targets) && candidate.targets.length >= 1 && candidate.targets.length <= 5
      && candidate.targets.every(target => target && typeof target.corpus_item_id === "string" && target.corpus_item_id.trim().length > 0
        && ["primary", "opportunity"].includes(target.role) && ["high", "medium", "low", "unknown"].includes(target.fit)
        && ["available", "partial", "unknown"].includes(target.metadata_status)
        && (target.sentence_frame == null || typeof target.sentence_frame === "string" && target.sentence_frame.trim().length > 0 && target.sentence_frame.length <= 500)
        && ["communicative_function", "fit_reason", "trigger_question", "skip_when"].every(key => typeof target[key as keyof typeof target] === "string" && String(target[key as keyof typeof target]).trim().length > 0)));
}

/** Old drafts retain every selection; these defaults do not discard extra items. */
export function targetRole(draft: LoadoutDraft, key: string): SpeakingTargetRole {
  return draft.targetRoles?.[key] ?? (draft.selectedKeys.indexOf(key) < 2 || draft.selectedKeys.indexOf(key) >= 4 ? "primary" : "opportunity");
}
export function missionInputSignature(draft: LoadoutDraft, records: SavedCorpusRecord[]): string {
  const byKey = new Map(records.map(record => [record.key, record]));
  // Version the scene inputs separately from the immutable Mission-create request.
  // Settings used only during conversation/feedback must not spend another plan.
  return JSON.stringify(["scene-input-v2", draft.scenarioType, draft.goal.trim(),
    draft.selectedKeys.map(key => {
      const record = byKey.get(key);
      const item = record?.item;
      return [key, record?.serverId ?? null, targetRole(draft, key), item ? [
        item.kind, expressionText(record!), item.meaning ?? null, item.usageNote ?? null, item.tags,
        Object.entries(item.slots ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        record?.sourceTitle ?? null, item.register ?? null, item.scenarioTags ?? [],
        item.kind === "structure" ? item.patternFamily ?? null : null
      ] : null];
    })]);
}
/** Support is independent of scene fit, so a manual change can reuse the plan. */
export function changeDraftSupport(draft: LoadoutDraft, level: SpeakingSupportLevel): LoadoutDraft {
  return draft.supportLevel === level ? draft : { ...draft, supportLevel: level, submission: undefined };
}
export function missionSelectionError(draft: LoadoutDraft, records: SavedCorpusRecord[], signedIn: boolean): string | null {
  if (!draft.selectedKeys.length) return "Select at least one primary target.";
  const selection = resolveSelection(draft, records);
  if (selection.missing.length) return "Some selected items are no longer in your corpus. Remove them before continuing.";
  if (selection.structures.length > MAX_STRUCTURES) return "Choose up to 3 structures for this mission. Your previous selections are kept until you adjust them.";
  const primary = draft.selectedKeys.filter(key => targetRole(draft, key) === "primary").length;
  if (!primary || primary > 3 || draft.selectedKeys.length - primary > 2) return "Choose 1–3 primary targets and up to 2 opportunity targets. Your previous selections are kept until you adjust them.";
  if (signedIn && selection.unsynced.length) return "Your selected items are still waiting to sync. Retry corpus sync before continuing.";
  const ids = selection.selected.map(({ record }) => record?.serverId).filter(Boolean);
  if (new Set(ids).size !== ids.length) return "The same corpus item was selected twice. Remove the duplicate before continuing.";
  return null;
}
export function currentCandidate(draft: LoadoutDraft, records: SavedCorpusRecord[]) {
  if (draft.plan?.signature !== missionInputSignature(draft, records)) return undefined;
  return draft.plan.value.candidates.find(candidate => candidate.id === draft.selectedCandidateId);
}
function matchingCandidates(draft: LoadoutDraft, records: SavedCorpusRecord[]) {
  if (draft.plan?.signature !== missionInputSignature(draft, records)) return [];
  const expected = draft.selectedKeys.map(key => records.find(record => record.key === key)?.serverId);
  return draft.plan.value.candidates.filter(candidate => candidate.targets.length === expected.length
    && candidate.targets.every((target, index) => target.corpus_item_id === expected[index] && target.role === targetRole(draft, draft.selectedKeys[index]))
    && candidate.targets.some(target => target.role === "primary"));
}
const primaryFitGaps = (candidate: SpeakingPlan["candidates"][number]) => candidate.targets.filter(target => target.role === "primary" && (target.fit === "low" || target.fit === "unknown"));
const highPrimaryFits = (candidate: SpeakingPlan["candidates"][number]) => candidate.targets.filter(target => target.role === "primary" && target.fit === "high").length;
/** Reuse the learner's suitable choice, then rank suitable cached scenes stably. */
export function automaticCandidate(draft: LoadoutDraft, records: SavedCorpusRecord[]) {
  const candidates = matchingCandidates(draft, records).filter(candidate => !primaryFitGaps(candidate).length);
  return candidates.find(candidate => candidate.id === draft.selectedCandidateId)
    ?? candidates.reduce<(typeof candidates)[number] | undefined>((best, candidate) => !best || highPrimaryFits(candidate) > highPrimaryFits(best) ? candidate : best, undefined);
}
/** Explain one verified scene; never combine incompatible reasons across scenes. */
export function sceneFitAdvice(draft: LoadoutDraft, records: SavedCorpusRecord[]) {
  const candidates = matchingCandidates(draft, records);
  const candidate = candidates.find(value => value.id === draft.selectedCandidateId)
    ?? candidates.reduce<(typeof candidates)[number] | undefined>((best, value) => {
      if (!best) return value;
      const gaps = primaryFitGaps(value).length, previousGaps = primaryFitGaps(best).length;
      return gaps < previousGaps || gaps === previousGaps && highPrimaryFits(value) > highPrimaryFits(best) ? value : best;
    }, undefined);
  if (!candidate) return undefined;
  const targets = primaryFitGaps(candidate).flatMap(target => {
    const record = records.find(value => value.serverId === target.corpus_item_id);
    return record ? [{ key: record.key, text: expressionText(record), fit: target.fit, reason: target.fit_reason }] : [];
  });
  return targets.length ? { candidate, targets } : undefined;
}
export type SceneTargetAdjustment = "opportunity" | "remove";
export function sceneAdjustmentError(draft: LoadoutDraft, key: string, action: SceneTargetAdjustment): string | null {
  if (draft.submission) return "Recover the pending mission before changing its targets.";
  if (draft.plan?.value.practice_source) return "Unlink this second round before changing its targets.";
  if (!draft.selectedKeys.includes(key) || targetRole(draft, key) !== "primary") return "This primary target is no longer selected.";
  const primary = draft.selectedKeys.filter(value => targetRole(draft, value) === "primary").length;
  if (primary <= 1) return "Keep at least one primary target. Choose a different scene or add another primary target first.";
  if (action === "opportunity" && draft.selectedKeys.length - primary >= 2) return "You already have two opportunity targets. Remove one before moving this target.";
  return null;
}
/** Only an explicit learner action changes a target; it invalidates the old plan. */
export function adjustSceneTarget(draft: LoadoutDraft, key: string, action: SceneTargetAdjustment): LoadoutDraft {
  if (sceneAdjustmentError(draft, key, action)) return draft;
  const roles = Object.fromEntries(draft.selectedKeys.map(value => [value, targetRole(draft, value)]));
  if (action === "remove") delete roles[key]; else roles[key] = "opportunity";
  return { ...draft, selectedKeys: action === "remove" ? draft.selectedKeys.filter(value => value !== key) : draft.selectedKeys,
    targetRoles: roles, plan: undefined, selectedCandidateId: undefined, submission: undefined };
}
export function missionPlanError(draft: LoadoutDraft, records: SavedCorpusRecord[]): string | null {
  const error = missionSelectionError(draft, records, true);
  if (error) return error;
  const candidate = currentCandidate(draft, records);
  if (!candidate) return "Generate matching scenes, then choose one for your mission.";
  if (candidate.targets.some(target => target.role === "primary" && (target.fit === "low" || target.fit === "unknown"))) return "This scene does not yet fit every primary target. Choose another scene or adjust your targets.";
  return null;
}
export function toggleMissionSelection(draft: LoadoutDraft, record: SavedCorpusRecord): LoadoutDraft {
  if (draft.plan?.value.practice_source || draft.submission) return draft;
  const roles = Object.fromEntries(draft.selectedKeys.map(key => [key, targetRole(draft, key)]));
  if (draft.selectedKeys.includes(record.key)) {
    delete roles[record.key];
    return { ...draft, selectedKeys: draft.selectedKeys.filter(key => key !== record.key), targetRoles: roles, plan: undefined, selectedCandidateId: undefined, submission: undefined };
  }
  if (draft.selectedKeys.length >= 5) return draft;
  const primary = Object.values(roles).filter(role => role === "primary").length;
  roles[record.key] = primary < 2 || Object.values(roles).filter(role => role === "opportunity").length >= 2 ? "primary" : "opportunity";
  return { ...draft, selectedKeys: [...draft.selectedKeys, record.key], targetRoles: roles, plan: undefined, selectedCandidateId: undefined, submission: undefined };
}
export function preparePlannedSubmission(draft: LoadoutDraft, records: SavedCorpusRecord[], uuid: () => string): LoadoutDraft {
  if (draft.submission?.signature === draftSignature(draft)) return draft;
  const error = missionPlanError(draft, records);
  if (error) throw new Error(error);
  const candidate = currentCandidate(draft, records)!;
  if (draft.plan?.value.practice_source && draft.supportLevel == null) throw new Error("Choose a support level for this second round.");
  const expected = draft.selectedKeys.map(key => records.find(record => record.key === key)!.serverId!);
  if (candidate.targets.length !== expected.length || candidate.targets.some((target, index) => target.corpus_item_id !== expected[index] || target.role !== targetRole(draft, draft.selectedKeys[index]))) throw new Error("This scene no longer matches your selected targets. Generate matching scenes again.");
  return { ...draft, submission: { signature: draftSignature(draft), request: {
    client_id: uuid(), scenario_type: draft.scenarioType, goal: candidate.goal,
    difficulty: draft.difficulty, feedback_level: draft.feedbackLevel, logic_template_id: draft.logicTemplateId,
    ...(draft.supportLevel != null ? { support_level: draft.supportLevel } : {}),
    corpus_item_ids: candidate.targets.map(target => target.corpus_item_id), plan_id: draft.plan!.value.id, candidate_id: candidate.id
  } } };
}

/** A verified create/recovery ends the pending request, not the reusable setup. */
export function acknowledgeSubmission(draft: LoadoutDraft, clientId: string): LoadoutDraft {
  if (!draft.submission || draft.submission.request.client_id !== clientId
    || draft.submission.signature !== draftSignature(draft)) {
    throw new Error("The mission confirmation no longer matches this pending request.");
  }
  return { ...draft, submission: undefined };
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

export async function saveDraft(storage: DraftStorage, owner: string | null, draft: LoadoutDraft, context: MutationContext & { expectedDraft?: LoadoutDraft } = {}): Promise<boolean> {
  return Boolean(await mutateDraft(() => {
    const envelope = readDraftEnvelope(storage);
    const existing = (owner ? accountOf(envelope, owner)?.draft : envelope.guest) ?? emptyDraft();
    if (context.expectedDraft && JSON.stringify(existing) !== JSON.stringify(context.expectedDraft)) {
      throw new DraftConflictError("Your draft changed in another tab. Review the updated setup before starting.");
    }
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
    if (current.draft.submission) throw new Error("Recover the pending mission before using another draft.");
    if (context.expectedSignature && draftSignature(current.deviceDrafts[index]) !== context.expectedSignature) {
      throw new Error("Device drafts changed in another tab. Review the updated drafts before choosing one.");
    }
    const remaining = current.deviceDrafts.filter((_, position) => position !== index);
    if (current.deviceDrafts[index].plan?.value.practice_source && (current.draft.selectedKeys.length || current.draft.goal.trim())) remaining.push(current.draft);
    const account = { draft: { ...current.deviceDrafts[index], submission: undefined }, deviceDrafts: remaining };
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
    ...(draft.supportLevel != null ? { support_level: draft.supportLevel } : {}),
    corpus_item_ids: draft.selectedKeys.map((key) => byKey.get(key)!.serverId!)
  } } };
}

/** Explicit report import preserves existing work and uncertain create requests. */
export function importMissionDraft(storage: DraftStorage, owner: string, draft: LoadoutDraft, context: MutationContext = {}): Promise<"active" | "saved" | null> {
  return mutateDraft(() => {
    const envelope = readDraftEnvelope(storage);
    const previous = accountOf(envelope, owner);
    const imported = { ...draft, submission: undefined };
    const hasDraft = previous && (previous.draft.goal.trim() || previous.draft.selectedKeys.length || previous.draft.submission);
    if (hasDraft) {
      const alreadySaved = previous.deviceDrafts.some(value => draftSignature(value) === draftSignature(imported));
      envelope.accounts = { ...envelope.accounts, [owner]: { ...previous, deviceDrafts: alreadySaved ? previous.deviceDrafts : [...previous.deviceDrafts, imported] } };
    } else envelope.accounts = { ...envelope.accounts, [owner]: { draft: imported, deviceDrafts: previous?.deviceDrafts ?? [] } };
    storage.setItem(LOADOUT_STORAGE_KEY, JSON.stringify(envelope));
    return hasDraft ? "saved" : "active";
  }, context);
}

/** Merge under the same lock as other draft writes, preserving the latest settings. */
export function addCorpusToDraft(storage: DraftStorage, owner: string | null, incoming: string[], records: SavedCorpusRecord[], context: MutationContext = {}): Promise<LoadoutDraft | null> {
  return mutateDraft(() => {
    const envelope = readDraftEnvelope(storage);
    let account = owner ? accountOf(envelope, owner) : undefined;
    if (owner) {
      if (!account) account = { draft: envelope.guest ? { ...envelope.guest, submission: undefined } : emptyDraft(), deviceDrafts: [] };
      else if (envelope.guest) account = { ...account, deviceDrafts: [...account.deviceDrafts, { ...envelope.guest, submission: undefined }] };
      envelope.guest = null;
    }
    const current = (owner ? account?.draft : envelope.guest) ?? emptyDraft();
    if (current.submission) throw new Error("A mission start is awaiting confirmation. Open Loadout to recover it before changing the selection.");
    if (current.plan?.value.practice_source) throw new Error("Open Loadout and unlink the second round before changing its targets.");
    const selectedKeys = [...new Set([...current.selectedKeys, ...incoming])];
    const byKey = new Map(records.map((record) => [record.key, record]));
    if (selectedKeys.some((key) => !byKey.has(key))) throw new Error("Your loadout contains an unavailable item. Open Loadout to remove it, then try again.");
    const structures = selectedKeys.filter((key) => byKey.get(key)?.item.kind === "structure").length;
    if (structures > MAX_STRUCTURES || selectedKeys.length - structures > MAX_EXPRESSIONS) {
      throw new Error("Combined selection exceeds the loadout limit: 3 structures and 5 expressions (chunks + idioms). Adjust your selection or open Loadout to free slots.");
    }
    const draft = { ...current, selectedKeys, submission: undefined };
    if (owner) envelope.accounts = { ...envelope.accounts, [owner]: { draft, deviceDrafts: account?.deviceDrafts ?? [] } };
    else envelope.guest = draft;
    storage.setItem(LOADOUT_STORAGE_KEY, JSON.stringify(envelope));
    return draft;
  }, context);
}
