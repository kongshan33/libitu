import type { SpeakingOptions, SpeakingSession, SpeakingSessionCreate } from "@libitu/types/speaking";

export class SpeakingApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "SpeakingApiError"; }
}

async function request<T>(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<T> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(`${(process.env.NEXT_PUBLIC_LIBITU_API_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "")}/api/speaking${path}`, {
      ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      headers: { "Content-Type": "application/json", ...init.headers }
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new SpeakingApiError(error instanceof Error && error.name === "TimeoutError"
      ? "The request took too long. Retry to recover the same mission."
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
          : response.status === 503 ? "Mission storage is temporarily unavailable. Your draft is kept on this device."
            : "The mission could not be loaded or saved. Please retry.";
    throw new SpeakingApiError(typeof detail === "string" && detail.length <= 300 ? detail : fallback, response.status);
  }
  const result = await response.json() as T;
  signal.throwIfAborted();
  return result;
}

export function getSpeakingOptions(signal: AbortSignal): Promise<SpeakingOptions> {
  return request<SpeakingOptions>("/options", signal);
}

export function createSpeakingApi(owner: string, getToken: () => Promise<string | null>) {
  async function authorized<T extends SpeakingSession>(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<T> {
    signal.throwIfAborted();
    const token = await getToken();
    signal.throwIfAborted();
    if (!token) throw new SpeakingApiError("Sign in again to continue.", 401);
    let tokenOwner: unknown;
    try { tokenOwner = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub; } catch { /* FastAPI verifies the token. */ }
    if (tokenOwner !== owner) throw new SpeakingApiError("Your account changed. Reload your loadout before continuing.", 401);
    const result = await request<T>(path, signal, { ...init, headers: { Authorization: `Bearer ${token}` } });
    if (result.user_id !== owner) throw new SpeakingApiError("Your account changed. Reload this page before continuing.", 401);
    return result;
  }
  return {
    create: (payload: SpeakingSessionCreate, signal: AbortSignal) => authorized<SpeakingSession>("/sessions", signal, { method: "POST", body: JSON.stringify(payload) }),
    read: (id: string, signal: AbortSignal) => authorized<SpeakingSession>(`/sessions/${encodeURIComponent(id)}`, signal)
  };
}
