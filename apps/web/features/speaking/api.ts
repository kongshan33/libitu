import type { SpeakingRuntimeTicket, SpeakingWorkspace } from "@libitu/types/speaking";
import { startMissionPhase } from "./mission-timing.ts";

export class ConversationApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "ConversationApiError"; }
}
const apiBase = () => (process.env.NEXT_PUBLIC_LIBITU_API_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");
export function runtimeSocketUrl(path: string): string {
  const base = new URL(apiBase());
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith("/api/speaking/sessions/") || url.search || url.hash) throw new Error("The conversation connection address is invalid.");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
export function createConversationApi(owner: string, sessionId: string, getToken: () => Promise<string | null>) {
  async function request<T>(suffix: string, signal: AbortSignal, method = "GET", body?: unknown): Promise<T> {
    const finish = suffix === "/workspace" ? startMissionPhase("workspace_read") : undefined;
    let outcome: "success" | "error" = "error";
    let response: Response | undefined;
    try {
      signal.throwIfAborted();
      const token = await getToken();
      signal.throwIfAborted();
      let subject: unknown;
      try { subject = JSON.parse(atob((token ?? "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub; } catch { /* The server verifies the token. */ }
      if (!token || subject !== owner) throw new ConversationApiError("Sign in again to continue with this account.", 401);
      try {
        response = await fetch(`${apiBase()}/api/speaking/sessions/${encodeURIComponent(sessionId)}${suffix}`, {
          method, signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
      } catch { signal.throwIfAborted(); throw new ConversationApiError("Connection unavailable. Please try again.", 0); }
      signal.throwIfAborted();
      if (!response.ok) {
        const fallback = response.status === 409 ? "This mission is open elsewhere. Take over to continue here."
          : response.status === 404 ? "This mission is no longer available."
            : response.status === 401 ? "Sign in again to continue."
              : response.status === 503 ? "The conversation service is unavailable. Your saved mission is safe."
                : "The request could not be completed. Please try again.";
        let detail: unknown;
        try { detail = (await response.json()).detail; } catch { /* Safe fallback. */ }
        throw new ConversationApiError(typeof detail === "string" && detail.length <= 300 ? detail : fallback, response.status);
      }
      if (response.status === 204) return undefined as T;
      const result = await response.json() as T;
      signal.throwIfAborted();
      if (result && typeof result === "object" && "session" in result) {
        const session = result.session as SpeakingWorkspace["session"];
        if (session.user_id !== owner || session.id !== sessionId) throw new ConversationApiError("Your account or mission changed. Reload to continue.", 401);
      }
      outcome = "success";
      return result;
    } finally { finish?.(signal.aborted ? "aborted" : outcome, response?.headers); }
  }
  return {
    read: (signal: AbortSignal) => request<SpeakingWorkspace>("/workspace", signal),
    connect: (clientId: string, takeover: boolean, signal: AbortSignal) => request<SpeakingRuntimeTicket>("/realtime", signal, "POST", { client_connection_id: clientId, takeover }),
    end: (signal: AbortSignal) => request<SpeakingWorkspace>("/end", signal, "POST"),
    delete: (signal: AbortSignal) => request<void>("", signal, "DELETE")
  };
}
export type ConversationApi = ReturnType<typeof createConversationApi>;
