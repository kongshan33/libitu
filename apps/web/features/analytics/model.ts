import type { FeedbackDimensionId, FeedbackReference, FeedbackRefactor, SpeakingFeedback, SpeakingMessage, SpeakingSession, SpeakingSessionCreate } from "@libitu/types/speaking";
import type { SavedCorpusRecord } from "../corpus/corpus-storage.ts";
import type { LoadoutDraft } from "../loadout/draft.ts";
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
  return { draft: { scenarioType: session.scenario_type, goal: session.goal, difficulty: session.difficulty, feedbackLevel: session.feedback_level, logicTemplateId: session.logic_template?.id ?? null, selectedKeys }, missing };
}
export function retryMissionRequest(session: SpeakingSession, records: SavedCorpusRecord[], clientId: string): SpeakingSessionCreate {
  const { missing } = draftFromMission(session, records);
  if (missing) throw new Error("Some original items are no longer in your corpus. Adjust the loadout to choose replacements.");
  return { client_id: clientId, scenario_type: session.scenario_type, goal: session.goal, difficulty: session.difficulty,
    feedback_level: session.feedback_level, logic_template_id: session.logic_template?.id ?? null,
    corpus_item_ids: [...session.items].sort((a, b) => a.ordinal - b.ordinal).map(item => item.corpus_item_id!) };
}
export function suggestionRecord(report: SpeakingFeedback, refactor: FeedbackRefactor, origin: string): SavedCorpusRecord {
  if (!refactor.save_text?.trim() || !validReference(refactor.original, report.messages)) throw new Error("This suggestion has no verified source to save.");
  const sourceUrl = `${origin}/speaking/${encodeURIComponent(report.session_id)}/analytics`;
  return { key: `speaking-feedback:${report.id}:${refactor.id}`, sourceUrl, sourceTitle: "AI suggestion · Speaking report",
    item: { id: `feedback-${refactor.id}`, kind: refactor.save_kind, text: refactor.save_text, meaning: refactor.save_meaning ?? undefined,
      tags: [], meta: "AI-generated suggestion", saved: true, sourceText: refactor.original.quote,
      usageNote: `AI-generated suggestion from speaking report ${report.id}. ${refactor.reason}` } };
}
