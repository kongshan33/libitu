type MissionPhase = "scene_cache" | "planning_request" | "create_request" | "workspace_read" | "navigation_to_ready" | "start_to_ready";
type Outcome = "success" | "error" | "aborted" | "cache_hit" | "cache_miss" | "retry";
type TimingDetail = { outcome: Outcome; request_id?: string; server_ms?: Record<string, number> };
const SERVER_PHASES = new Set(["input_read", "model_generation", "model_repair", "validation", "save_plan", "create", "workspace_session_read", "workspace_runtime_read", "total"]);
const MAX_DURATION_MS = 180_000;

/** Fixed, bounded diagnostic names; never persist or emit learner text or identity. */
export function startMissionPhase(phase: MissionPhase, start = performance.now()) {
  let finished = false;
  return (outcome: Outcome, headers?: Headers) => {
    if (finished) return;
    finished = true;
    const end = performance.now();
    if (!Number.isFinite(start) || start < 0 || end < start || end - start > MAX_DURATION_MS) return;
    const detail: TimingDetail = { outcome };
    const requestId = headers?.get("X-Request-ID");
    if (requestId && /^[a-f0-9]{32}$/i.test(requestId)) detail.request_id = requestId;
    const server: Record<string, number> = {};
    for (const metric of (headers?.get("Server-Timing") ?? "").slice(0, 2048).split(",")) {
      const match = /^\s*([a-z_]+)\s*;\s*dur=(\d+(?:\.\d+)?)\s*$/.exec(metric);
      if (match && SERVER_PHASES.has(match[1]) && Number(match[2]) <= MAX_DURATION_MS) server[match[1]] = Number(match[2]);
    }
    if (Object.keys(server).length) detail.server_ms = server;
    // Keep only the latest measurement per phase, even after retries or long sessions.
    const name = `libitu:mission:${phase}`;
    try {
      performance.clearMeasures(name);
      performance.measure(name, { start, end, detail });
    } catch { /* Diagnostics must never block a Mission. */ }
  };
}

let navigation: { owner: string; sessionId: string; started: number; navigated: number } | undefined;
export function prepareMissionNavigation(owner: string, sessionId: string, started: number) {
  // A single tab-local handoff, consumed only by its verified owner and Mission.
  navigation = { owner, sessionId, started, navigated: performance.now() };
}
export function finishMissionNavigation(owner: string, sessionId: string) {
  const pending = navigation;
  navigation = undefined;
  if (!pending || pending.owner !== owner || pending.sessionId !== sessionId) return;
  startMissionPhase("navigation_to_ready", pending.navigated)("success");
  startMissionPhase("start_to_ready", pending.started)("success");
}
