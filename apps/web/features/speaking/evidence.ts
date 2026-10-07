import type { SpeakingEvidence, SpeakingMessage, SpeakingWorkspace } from "@libitu/types/speaking";
/** UI also verifies the evidence boundary so stale analysis never highlights revised text. */
export function validEvidence(message: SpeakingMessage, evidence: SpeakingEvidence[]): SpeakingEvidence[] {
  if (message.role !== "user" || message.status !== "final") return [];
  return evidence.filter(item => item.message_id === message.id && item.transcript_revision === message.revision && Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.end > item.start && item.end <= message.text.length && message.text.slice(item.start, item.end) === item.quote).sort((a, b) => a.start - b.start || b.end - a.end);
}
export function observedItemIds(workspace: SpeakingWorkspace): Set<string> {
  return new Set(workspace.messages.flatMap(message => validEvidence(message, workspace.evidence)).map(evidence => evidence.session_item_id));
}
