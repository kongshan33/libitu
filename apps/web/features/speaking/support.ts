import type { SpeakingDemonstration, SpeakingMessage, SpeakingSupportLevel, SpeakingWorkspace } from "@libitu/types/speaking";

export const SUPPORT_OPTIONS: { value: SpeakingSupportLevel; label: string; description: string }[] = [
  { value: "model_frame", label: "Model + frame", description: "Your partner models the expression, then invites a different idea. A sentence frame stays visible." },
  { value: "model_label", label: "Model + label", description: "Your partner models the expression, then invites a different idea. Only the expression label stays visible." },
  { value: "label_only", label: "Label only", description: "Expression labels stay visible. Your partner creates opportunities without a planned demonstration." },
  { value: "no_hint", label: "No automatic hints", description: "Target wording stays hidden. You can still ask for help or skip a target." }
];
export function isSupportLevel(value: unknown): value is SpeakingSupportLevel {
  return SUPPORT_OPTIONS.some(option => option.value === value);
}
export function currentSupport(workspace: SpeakingWorkspace): { level: SpeakingSupportLevel; version: number } | null {
  if (workspace.support && isSupportLevel(workspace.support.level) && Number.isSafeInteger(workspace.support.version) && workspace.support.version >= 0) return workspace.support;
  return isSupportLevel(workspace.session.support_level) ? { level: workspace.session.support_level, version: 0 } : null;
}
export function reducedSupport(level: SpeakingSupportLevel): SpeakingSupportLevel | null {
  return SUPPORT_OPTIONS[SUPPORT_OPTIONS.findIndex(option => option.value === level) + 1]?.value ?? null;
}
/** Server-verified spans still need to match the exact displayed UTF-16 revision. */
export function validDemonstrations(message: SpeakingMessage, values: SpeakingDemonstration[] = []): SpeakingDemonstration[] {
  if (message.role !== "assistant" || message.status !== "final") return [];
  return values.filter(value => value.message_id === message.id && value.revision === message.revision
    && Number.isInteger(value.start) && Number.isInteger(value.end) && value.start >= 0 && value.end > value.start
    && value.end <= message.text.length && message.text.slice(value.start, value.end) === value.quote)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}
