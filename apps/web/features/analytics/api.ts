import type { SpeakingFeedback } from "@libitu/types/speaking";

export class FeedbackApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "FeedbackApiError"; }
}
export function createFeedbackApi(owner: string, sessionId: string, getToken: () => Promise<string | null>) {
  async function request(signal: AbortSignal, retry?: boolean): Promise<SpeakingFeedback> {
    signal.throwIfAborted();
    const token = await getToken();
    signal.throwIfAborted();
    let subject: unknown;
    try { subject = JSON.parse(atob((token ?? "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub; } catch { /* Server verifies the token. */ }
    if (!token || subject !== owner) throw new FeedbackApiError("Sign in again to view this report.", 401);
    let response: Response;
    try {
      const base = (process.env.NEXT_PUBLIC_LIBITU_API_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");
      response = await fetch(`${base}/api/speaking/sessions/${encodeURIComponent(sessionId)}/feedback`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
        method: retry === undefined ? "GET" : "POST", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(retry === undefined ? {} : { body: JSON.stringify({ retry }) })
      });
    } catch { signal.throwIfAborted(); throw new FeedbackApiError("The report could not be reached. Check your connection and try again.", 0); }
    signal.throwIfAborted();
    if (!response.ok) throw new FeedbackApiError(response.status === 404 ? "This report or mission is no longer available."
      : response.status === 409 ? "End your conversation before requesting a report."
        : response.status === 401 ? "Sign in again to view this report."
          : "The report service is temporarily unavailable. Your conversation is saved.", response.status);
    const report = await response.json() as SpeakingFeedback;
    signal.throwIfAborted();
    if (report.session?.user_id !== owner || report.session.id !== sessionId || report.session_id !== sessionId) throw new FeedbackApiError("Your account or mission changed. Reload to continue.", 401);
    return report;
  }
  return { read: (signal: AbortSignal) => request(signal), create: (retry: boolean, signal: AbortSignal) => request(signal, retry) };
}
export type FeedbackApi = ReturnType<typeof createFeedbackApi>;
