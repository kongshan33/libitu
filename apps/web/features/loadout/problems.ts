import { SpeakingApiError } from "./api/speaking-api.ts";

export type MissionProblem = {
  kind: "system" | "fit" | "other";
  title: string;
  message: string;
  detail?: string;
  phase: "preparing" | "saving";
};

export function missionProblem(error: unknown, phase: MissionProblem["phase"]): MissionProblem {
  const detail = error instanceof Error ? error.message : "The request could not be completed. Please retry.";
  if (error instanceof SpeakingApiError && (error.code || error.status === 0 || error.status >= 500 || error.status === 429 || phase === "preparing" && error.status === 409)) {
    const persistence = phase === "saving" || error.code?.startsWith("persistence_");
    return {
      kind: "system", phase,
      title: persistence ? "Saving is temporarily unavailable" : "Scene preparation couldn't finish",
      message: "Your selection is kept. This is a system issue, not evidence that you chose the wrong targets.",
      detail
    };
  }
  return { kind: "other", phase, title: "Your mission hasn't started", message: detail };
}

export function missionFitProblem(): MissionProblem {
  return {
    kind: "fit", phase: "preparing", title: "Review this scene's target fit",
    message: "No prepared scene fits every primary target yet. Review one scene's reasons before deciding what to change."
  };
}
