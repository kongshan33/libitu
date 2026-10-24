import type { SpeakingOptions, SpeakingSession, SpeakingSessionCreate, SpeakingPlan, SpeakingPlanCreate, PracticeVariation, PracticeComparison, SupportRecommendation, SupportRecommendationRequest } from "@libitu/types/speaking";
import { validPlan } from "../draft.ts";
import { startMissionPhase } from "../../speaking/mission-timing.ts";

const PLAN_ERROR_CODES = new Set([
  "timeout", "rate_limit", "provider_http_error", "provider_transport_error", "provider_failure",
  "invalid_provider_json", "analyzer_not_configured", "analyzer_response_too_large", "analyzer_content_type",
  "analyzer_response_incomplete", "invalid_provider_envelope", "plan_target_mismatch",
  "plan_implicit_instruction_discloses_target", "plan_duplicate_scenarios", "invalid_output_schema", "invalid_output",
  "plan_invalid_frame",
  "persistence_rejected", "persistence_unavailable", "persistence_transport_error", "persistence_response_schema"
]);
export class SpeakingApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null, readonly requestId: string | null = null) { super(message); this.name = "SpeakingApiError"; }
}

async function request<T>(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<T> {
  const planning = path === "/plans" || path.endsWith("/practice-plans");
  signal.throwIfAborted();
  let response: Response | undefined;
  const finish = planning ? startMissionPhase("planning_request") : path === "/sessions" && init.method === "POST" ? startMissionPhase("create_request") : undefined;
  let outcome: "success" | "error" = "error";
  try {
    try {
      response = await fetch(`${(process.env.NEXT_PUBLIC_LIBITU_API_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "")}/api/speaking${path}`, {
        ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(planning ? 120_000 : 20_000)]),
        headers: { "Content-Type": "application/json", ...init.headers }
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new SpeakingApiError(error instanceof Error && error.name === "TimeoutError"
        ? planning ? "Preparing a scene took too long. Your targets are kept; try starting again." : "The request took too long. Please retry."
        : "Could not reach the server. Check your connection and retry.", 0);
    }
    signal.throwIfAborted();
    if (!response.ok) {
      let detail: unknown;
      try { detail = (await response.json()).detail; } catch { /* Use the safe status message. */ }
      signal.throwIfAborted();
      const fallback = response.status === 401 ? "Sign in again to continue."
        : response.status === 404 ? "This mission or one of its selected items is no longer available."
          : response.status === 409 ? "This saved request no longer matches the mission. Change your setup before trying again."
            : response.status === 503 ? path === "/plans" ? "Scene preparation is temporarily unavailable. Your targets are kept; try starting again." : "Mission storage is temporarily unavailable. Your draft is kept on this device."
              : "The mission could not be loaded or saved. Please retry.";
      const rawCode = planning ? response.headers.get("X-Speaking-Plan-Error") : null;
      const rawId = planning ? response.headers.get("X-Speaking-Plan-Request-ID") : null;
      throw new SpeakingApiError(typeof detail === "string" && detail.length <= 300 ? detail : fallback, response.status,
        rawCode && PLAN_ERROR_CODES.has(rawCode) ? rawCode : null, rawId && /^[a-f0-9]{32}$/i.test(rawId) ? rawId : null);
    }
    let result: T;
    try { result = await response.json() as T; }
    catch {
      signal.throwIfAborted();
      throw new SpeakingApiError("The server returned an unreadable response. Your selection is kept; please retry.", 502, path === "/plans" ? "invalid_output" : null);
    }
    signal.throwIfAborted();
    outcome = "success";
    return result;
  } finally { finish?.(signal.aborted ? "aborted" : outcome, response?.headers); }
}

export function getSpeakingOptions(signal: AbortSignal): Promise<SpeakingOptions> {
  return request<SpeakingOptions>("/options", signal);
}

export function createSpeakingApi(owner: string, getToken: () => Promise<string | null>) {
  async function authorized<T extends SpeakingSession | SpeakingPlan | PracticeComparison | SupportRecommendation>(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<T> {
    signal.throwIfAborted();
    const token = await getToken();
    signal.throwIfAborted();
    if (!token) throw new SpeakingApiError("Sign in again to continue.", 401);
    let tokenOwner: unknown;
    try { tokenOwner = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub; } catch { /* FastAPI verifies the token. */ }
    if (tokenOwner !== owner) throw new SpeakingApiError("Your account changed. Reload your loadout before continuing.", 401);
    const result = await request<T>(path, signal, { ...init, headers: { Authorization: `Bearer ${token}` } });
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new SpeakingApiError("The server returned an incomplete response. Your selection is kept; please retry.", 502, path === "/plans" ? "invalid_output_schema" : null);
    }
    if ("user_id" in result && result.user_id !== owner) throw new SpeakingApiError("Your account changed. Reload this page before continuing.", 401);
    return result;
  }
  return {
    practicePlan: async (parentId: string, variation: PracticeVariation, signal: AbortSignal) => {
      const plan = await authorized<SpeakingPlan>(`/sessions/${encodeURIComponent(parentId)}/practice-plans`, signal, { method: "POST", body: JSON.stringify({ variation }) });
      if (!validPlan(plan) || plan.practice_source?.parent_session_id !== parentId || plan.practice_source.variation !== variation) {
        throw new SpeakingApiError("The second-round scenes could not be verified. Please prepare them again.", 502);
      }
      return plan;
    },
    comparison: async (childId: string, signal: AbortSignal) => {
      const comparison = await authorized<PracticeComparison>(`/sessions/${encodeURIComponent(childId)}/practice-comparison`, signal, { cache: "no-store" });
      if (comparison.child_session_id !== childId || !["ready", "pending", "unavailable", "incompatible"].includes(comparison.status)) throw new SpeakingApiError("This comparison no longer matches the mission.", 502);
      return comparison;
    },
    supportRecommendation: async (payload: SupportRecommendationRequest, signal: AbortSignal) => {
      const recommendation = await authorized<SupportRecommendation>("/support-recommendations", signal, { method: "POST", body: JSON.stringify(payload) });
      if (recommendation.current_level !== payload.current_level || !Array.isArray(recommendation.targets)
        || recommendation.targets.length !== payload.targets.length
        || recommendation.targets.some((target, index) => target.corpus_item_id !== payload.targets[index].corpus_item_id || target.role !== payload.targets[index].role)) {
        throw new SpeakingApiError("The practice history no longer matches your selection. Check it again.", 502);
      }
      return recommendation;
    },
    plan: async (payload: SpeakingPlanCreate, signal: AbortSignal) => {
      const plan = await authorized<SpeakingPlan>("/plans", signal, { method: "POST", body: JSON.stringify(payload) });
      if (!validPlan(plan) || plan.candidates.length !== (payload.candidate_count ?? 2)
        || plan.scenario_type !== payload.scenario_type || plan.brief !== payload.brief
        || plan.candidates.some(candidate => candidate.targets.length !== payload.targets.length
          || candidate.targets.some((target, index) => target.corpus_item_id !== payload.targets[index].corpus_item_id || target.role !== payload.targets[index].role))) {
        throw new SpeakingApiError("The generated scenes did not match your targets. Please generate again.", 502, "invalid_output_schema");
      }
      return plan;
    },
    create: async (payload: SpeakingSessionCreate, signal: AbortSignal) => {
      const session = await authorized<SpeakingSession>("/sessions", signal, { method: "POST", body: JSON.stringify(payload) });
      // Only a verified acknowledgement may release the immutable retry request.
      // Restored sessions may be active/completed and their source cards deleted.
      if (session.user_id !== owner || session.client_id !== payload.client_id
        || typeof session.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.id)) {
        throw new SpeakingApiError("The saved mission could not be verified against your original request. Your pending request is kept; please retry.", 502);
      }
      return session;
    },
    read: (id: string, signal: AbortSignal) => authorized<SpeakingSession>(`/sessions/${encodeURIComponent(id)}`, signal)
  };
}
