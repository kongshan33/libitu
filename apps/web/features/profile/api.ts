export class ProfileApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function readProfileResource<T>(path: string, owner: string, getToken: () => Promise<string | null>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const token = await getToken();
  signal.throwIfAborted();
  let tokenOwner: unknown;
  try { tokenOwner = JSON.parse(atob((token ?? "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub; } catch { /* The API verifies token authenticity. */ }
  if (!token || tokenOwner !== owner) throw new ProfileApiError("Sign in again to view your learning.", 401);
  let response: Response;
  try {
    response = await fetch(`${(process.env.NEXT_PUBLIC_LIBITU_API_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "")}/api/profile${path}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      cache: "no-store", headers: { Authorization: `Bearer ${token}` }
    });
  } catch {
    signal.throwIfAborted();
    throw new ProfileApiError("Could not reach your learning records. Check your connection and retry.", 0);
  }
  signal.throwIfAborted();
  if (!response.ok) throw new ProfileApiError(response.status === 401
    ? "Sign in again to view your learning." : "Your learning records are temporarily unavailable. Please retry.", response.status);
  const result = await response.json() as T;
  signal.throwIfAborted();
  return result;
}
