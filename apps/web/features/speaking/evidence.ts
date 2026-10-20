import type { SpeakingEvidence, SpeakingMessage, SpeakingWorkspace } from "@libitu/types/speaking";
/** UI also verifies the evidence boundary so stale analysis never highlights revised text. */
export function validEvidence(message: SpeakingMessage, evidence: SpeakingEvidence[]): SpeakingEvidence[] {
  if (message.role !== "user" || message.status !== "final") return [];
  return evidence.filter(item => item.message_id === message.id && item.transcript_revision === message.revision && Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.end > item.start && item.end <= message.text.length && message.text.slice(item.start, item.end) === item.quote).sort((a, b) => a.start - b.start || b.end - a.end);
}
export function observedItemIds(workspace: SpeakingWorkspace): Set<string> {
  return new Set(workspace.messages.flatMap(message => validEvidence(message, workspace.evidence)).map(evidence => evidence.session_item_id));
}
export function assistanceLabel(evidence: SpeakingEvidence): string {
  switch (evidence.assistance) {
    case "usage": return "With a hint";
    case "example": return "With an example";
    case "direction": return "With a direction cue";
    case "overlap": case "unknown": return "Assistance uncertain";
    case "independent": return "Independent";
    default: return evidence.prompted ? "Prompted" : "Independent";
  }
}
