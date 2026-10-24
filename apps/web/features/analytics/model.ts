import type { FeedbackDimensionId, FeedbackReference, FeedbackRefactor, SpeakingFeedback, SpeakingMessage, SpeakingSession, SpeakingSessionCreate, SpeakingPlan, SpeakingSupportLevel } from "@libitu/types/speaking";
import type { SavedCorpusRecord } from "../corpus/corpus-storage.ts";
import type { LoadoutDraft } from "../loadout/draft.ts";
import { expressionText, missionInputSignature } from "../loadout/draft.ts";
export const DIMENSIONS: { id: FeedbackDimensionId; label: string; description: string }[] = [
  { id: "task_fit", label: "Task fit", description: "Progress toward your mission goal" },
  { id: "transfer", label: "Language transfer", description: "Selected language used appropriately" },
  { id: "scenario_fit", label: "Scenario fit", description: "Tone and choices for the situation" },
  { id: "naturalness", label: "Naturalness", description: "Clarity, grammar and expression" }
];
export function validReference(reference: FeedbackReference, messages: SpeakingMessage[]): SpeakingMessage | null {
  const message = messages.find(value => value.id === reference.message_id);
  return message?.role === "user" && message.status === "final" && message.revision === reference.transcript_revision
    && Number.isInteger(reference.start) && Number.isInteger(reference.end) && reference.start >= 0 && reference.end > reference.start
    && reference.end <= message.text.length && message.text.slice(reference.start, reference.end) === reference.quote ? message : null;
}
export function draftFromMission(session: SpeakingSession, records: SavedCorpusRecord[]): { draft: LoadoutDraft; missing: number } {
  const byId = new Map(records.filter(record => record.serverId).map(record => [record.serverId, record]));
  let missing = 0;
  const selectedKeys = [...session.items].sort((a, b) => a.ordinal - b.ordinal).map(item => {
    const record = item.corpus_item_id ? byId.get(item.corpus_item_id) : null;
    if (record) return record.key;
    missing++; return `missing-session-item:${item.id}`;
  });
  const targets = new Map(session.mission_plan?.targets.map(target => [target.session_item_id, target.role]));
  const targetRoles = session.mission_plan ? Object.fromEntries(
    [...session.items].sort((a, b) => a.ordinal - b.ordinal).map((item, index) => [selectedKeys[index], targets.get(item.id) ?? "opportunity"])
  ) : undefined;
  return { draft: { scenarioType: session.scenario_type, goal: session.goal, difficulty: session.difficulty, feedbackLevel: session.feedback_level, logicTemplateId: session.logic_template?.id ?? null, selectedKeys,
    ...(targetRoles ? { targetRoles } : {}), ...(session.support_level != null ? { supportLevel: session.support_level } : {}) }, missing };
}
export function secondRoundSupport(report: SpeakingFeedback): SpeakingSupportLevel {
  return report.effective_support_level === "no_hint" ? "no_hint" : "label_only";
}
export function practiceDraft(report: SpeakingFeedback, plan: SpeakingPlan, support: SpeakingSupportLevel, records: SavedCorpusRecord[]): LoadoutDraft {
  if (plan.practice_source?.parent_session_id !== report.session_id) throw new Error("This second round no longer matches the original mission.");
  const { draft, missing } = draftFromMission(report.session, records);
  if (missing) throw new Error("Some original language is unavailable. Keep your current draft or prepare a new mission.");
  const items = [...report.session.items].sort((a, b) => a.ordinal - b.ordinal);
  const sameSlots = (value: Record<string, string> | undefined) => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  if (items.some((item, index) => {
    const record = records.find(record => record.key === draft.selectedKeys[index])!;
    const current = record.item;
    return item.kind !== current.kind || item.text !== expressionText(record) || (item.meaning ?? "") !== (current.meaning ?? "") || sameSlots(item.slots) !== sameSlots(current.slots);
  })) throw new Error("The original language has changed. Linked rounds need the same language; prepare a new mission instead.");
  const roles = report.session.mission_plan?.targets;
  if (!roles || plan.candidates.some(candidate => candidate.targets.length !== items.length || candidate.targets.some((target, index) =>
    target.corpus_item_id !== items[index].corpus_item_id || target.role !== roles.find(role => role.session_item_id === items[index].id)?.role))) {
    throw new Error("The second round did not preserve your original targets and roles.");
  }
  const result: LoadoutDraft = { ...draft, scenarioType: plan.scenario_type, goal: plan.brief, supportLevel: support };
  return { ...result, plan: { signature: missionInputSignature(result, records), value: plan }, selectedCandidateId: plan.candidates[0]?.id };
}
export function validMissedOpportunities(report: SpeakingFeedback) {
  return (report.result?.missed_opportunities ?? []).filter(suggestion => suggestion.basis === "ai_suggestion"
    && validReference(suggestion.original, report.messages) && report.session.items.some(item => item.id === suggestion.session_item_id));
}
export function retryMissionRequest(session: SpeakingSession, records: SavedCorpusRecord[], clientId: string): SpeakingSessionCreate {
  const { missing } = draftFromMission(session, records);
  if (missing) throw new Error("Some original items are no longer in your corpus. Adjust the loadout to choose replacements.");
  return { client_id: clientId, scenario_type: session.scenario_type, goal: session.goal, difficulty: session.difficulty,
    feedback_level: session.feedback_level, logic_template_id: session.logic_template?.id ?? null,
    corpus_item_ids: [...session.items].sort((a, b) => a.ordinal - b.ordinal).map(item => item.corpus_item_id!),
    ...(session.support_level != null ? { support_level: session.support_level } : {}),
    ...(session.mission_plan ? { plan_id: session.mission_plan.plan_id, candidate_id: session.mission_plan.candidate_id } : {}) };
}
export function suggestionRecord(report: SpeakingFeedback, refactor: FeedbackRefactor, origin: string): SavedCorpusRecord {
  if (!refactor.save_text?.trim() || !validReference(refactor.original, report.messages)) throw new Error("This suggestion has no verified source to save.");
  const sourceUrl = `${origin}/speaking/${encodeURIComponent(report.session_id)}/analytics`;
  return { key: `speaking-feedback:${report.id}:${refactor.id}`, sourceUrl, sourceTitle: "AI suggestion · Speaking report",
    item: { id: `feedback-${refactor.id}`, kind: refactor.save_kind, text: refactor.save_text, meaning: refactor.save_meaning ?? undefined,
      tags: [], meta: "AI-generated suggestion", saved: true, sourceText: refactor.original.quote,
      usageNote: `AI-generated suggestion from speaking report ${report.id}. ${refactor.reason}` } };
}
