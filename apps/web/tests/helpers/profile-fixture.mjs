import assert from "node:assert/strict";
import { analyticsReport } from "./analytics-fixture.mjs";

export const profileOwner = "profile-browser-a";
export const otherProfileOwner = "profile-browser-b";
export const profileContentId = "15eabce1-7847-4f3e-aa20-f1e49e53a015";
export const profileSessionId = "10000000-0000-4000-8000-000000000001";
export const profileSourceUrl = "https://www.youtube.com/watch?v=abcdef12345";

export const profileHistory = Array.from({ length: 23 }, (_, index) => ({
  id: `profile-history-${index}`,
  kind: index % 2 ? "speaking" : "shadowing",
  title: index === 0 ? "Explain the project handoff" : `Practice record ${index + 1}`,
  occurred_at: new Date(Date.UTC(2026, 9, 2, 6, 0) - index * 3_600_000).toISOString(),
  duration_ms: index % 2 ? null : 12_500,
  turn_count: index % 2 ? 4 : null,
  status: index % 2 ? "completed" : "recorded",
  content_id: index % 2 ? null : profileContentId,
  source_url: index % 2 || index === 22 ? null : profileSourceUrl,
  sentence_id: index % 2 ? null : `sentence-${index}`,
  session_id: index % 2 ? `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` : null,
  feedback: null
}));

export const profileFeedbackSessionId = profileHistory[1].session_id;

export function profileFeedbackReport(status = "ready") {
  const report = analyticsReport(status);
  report.session_id = profileFeedbackSessionId;
  report.session.id = profileFeedbackSessionId;
  report.session.user_id = profileOwner;
  return report;
}

export function profileFeedbackSummary(status = "ready") {
  const report = profileFeedbackReport(status);
  return {
    id: report.id, session_id: report.session_id, status: report.status,
    rubric_version: report.rubric_version, analysis_version: report.analysis_version,
    goal: report.session.goal, scenario_type: report.session.scenario_type,
    difficulty: report.session.difficulty, created_at: report.created_at,
    updated_at: report.updated_at, practiced_at: report.session.created_at,
    dimensions: report.result.dimensions.map(({ id, score, basis, summary }) => ({ id, score, basis, summary }))
  };
}

export function profileResponse({ owner = profileOwner, range = "4w", timezone = "Asia/Shanghai", empty = false } = {}) {
  const isOther = owner === otherProfileOwner;
  const history = empty || isOther ? [] : profileHistory;
  const bucket = range === "all" ? "month" : "day";
  const count = range === "4w" ? 28 : range === "3m" ? 90 : 7;
  const dates = Array.from({ length: count }, (_, index) => bucket === "month"
    ? `2026-${String(index + 4).padStart(2, "0")}-01`
    : new Date(Date.UTC(2026, 9, 2) - (count - index - 1) * 86_400_000).toISOString().slice(0, 10));
  return {
    timezone, range, generated_at: "2026-10-02T06:00:00Z",
    overview: {
      shadowing_attempts: empty ? 0 : isOther ? 2 : 37,
      speaking_sessions: empty || isOther ? 0 : 9,
      corpus_total: empty ? 0 : isOther ? 3 : 64,
      corpus_structures: empty ? 0 : isOther ? 1 : 18,
      corpus_week_added: empty ? 0 : isOther ? 1 : 5,
      shadowing_duration_ms: empty ? 0 : isOther ? 14_000 : 735_000,
      current_streak_days: empty ? 0 : isOther ? 1 : 3,
      active_days: empty ? 0 : isOther ? 1 : 11
    },
    activity: {
      bucket, start_date: dates[0], end_date: "2026-10-02",
      items: dates.map((date, index) => ({ date,
        shadowing_attempts: empty ? 0 : (index + 1) % 4,
        speaking_turns: empty || isOther ? 0 : index % 3,
        corpus_added: empty ? 0 : index % 5 === 0 ? 2 : 0
      }))
    },
    resume_speaking: empty || isOther ? null : {
      session_id: profileSessionId, goal: "Agree on the project timeline", status: "active",
      turn_count: 4, updated_at: "2026-10-02T05:00:00Z"
    },
    last_practiced_source: empty || isOther ? null : {
      content_id: profileContentId, sentence_id: "sentence-0", sentence_text: "Explain the project handoff",
      source_url: profileSourceUrl,
      title: "A practical team update", start_ms: 15_000, practiced_at: "2026-10-02T06:00:00Z"
    },
    recent_videos: { items: [], next_offset: null },
    recent_history: { items: history.slice(0, 5), next_offset: history.length > 5 ? 5 : null },
    latest_feedback: null, latest_feedback_unavailable_reason: "not_available"
  };
}

// Synthetic Clerk resources exercise the React identity boundary without OAuth,
// external credentials, or mutations to a real user's account.
function browserFixture({ initialOwner }) {
  if (!sessionStorage.getItem("profile-fixture-initialized")) {
    sessionStorage.setItem("profile-fixture-owner", initialOwner ?? "");
    sessionStorage.setItem("profile-fixture-initialized", "1");
  }
  const listeners = new Set();
  const clerk = {
    loaded: true, user: null, session: null, organization: null,
    client: { sessions: [] }, telemetry: { record() {} },
    __internal_environment: {}, __internal_lastEmittedResources: null,
    load: async () => {}, mountUserButton() {}, unmountUserButton() {},
    addListener(callback, options) {
      listeners.add(callback);
      if (!options?.skipInitialEmit) callback(clerk.__internal_lastEmittedResources);
      return () => listeners.delete(callback);
    },
    openSignIn(options) { window.__profileAuthCalls.push(options); },
    openSignUp(options) { window.__profileAuthCalls.push(options); },
    __internal_updateProps() {}
  };
  window.__profileAuthCalls = [];
  window.__setProfileUser = (owner) => {
    sessionStorage.setItem("profile-fixture-owner", owner ?? "");
    clerk.user = owner ? {
      id: owner, firstName: owner.endsWith("-b") ? "Robin" : "Alex",
      fullName: owner.endsWith("-b") ? "Robin Chen" : "Alex Morgan",
      username: null, imageUrl: "", hasImage: false,
      createdAt: new Date("2026-04-12T08:00:00Z"), organizationMemberships: [],
      primaryEmailAddress: { emailAddress: `${owner}@example.test` }
    } : null;
    clerk.session = owner ? { id: `session-${owner}`, user: clerk.user, status: "active",
      lastActiveToken: { jwt: { claims: { sub: owner } } },
      getToken: async () => `header.${btoa(JSON.stringify({ sub: owner }))}.fixture` } : null;
    clerk.client = { sessions: clerk.session ? [clerk.session] : [] };
    clerk.__internal_lastEmittedResources = { user: clerk.user, session: clerk.session,
      client: clerk.client, organization: null };
    for (const listener of listeners) listener(clerk.__internal_lastEmittedResources);
  };
  window.__setProfileUser(sessionStorage.getItem("profile-fixture-owner") || null);
  window.Clerk = clerk;
}

export async function installProfileFixture(page, { origin, initialOwner = profileOwner, empty = false } = {}) {
  const state = {
    errors: [], requests: [], responses: [], empty,
    failProfile: false, failHistory: false,
    profileGate: null, historyGate: null,
    transformProfile: null, transformHistory: null, feedbackReports: new Map()
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.addInitScript(browserFixture, { initialOwner });
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,authorization",
      "access-control-allow-methods": "GET,OPTIONS" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (url.pathname.startsWith("/api/")) {
      const token = request.headers().authorization?.split(" ")[1];
      const owner = token ? JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub : null;
      const entry = { method: request.method(), path: url.pathname, owner, query: Object.fromEntries(url.searchParams) };
      state.requests.push(entry);
      assert.ok(owner, "personal API must use an authenticated fixture identity");
      assert.equal(request.method(), "GET", "profile is read-only");
      if (url.pathname === "/api/corpus") return route.fulfill({ headers, json: [] });
      const feedbackMatch = url.pathname.match(/^\/api\/speaking\/sessions\/([^/]+)\/feedback$/);
      if (feedbackMatch) {
        const report = state.feedbackReports.get(feedbackMatch[1]);
        return route.fulfill(report && report.session.user_id === owner
          ? { headers, json: report }
          : { headers, status: 404, json: { detail: "Report not found." } });
      }
      if (url.pathname === "/api/profile") {
        assert.ok(["4w", "3m", "all"].includes(entry.query.range));
        assert.ok(entry.query.timezone, "summary supplies a concrete timezone");
        let result = profileResponse({ owner, range: entry.query.range, timezone: entry.query.timezone, empty: state.empty });
        if (state.transformProfile) result = state.transformProfile(result, entry);
        const fail = state.failProfile, gate = state.profileGate;
        state.failProfile = false;
        if (gate) await gate;
        await route.fulfill({ headers, status: fail ? 503 : 200,
          json: fail ? { detail: "Learning data is temporarily unavailable." } : result });
        state.responses.push(entry);
        return;
      }
      if (url.pathname === "/api/profile/history") {
        const offset = Number(entry.query.offset ?? 0), limit = Number(entry.query.limit ?? 20);
        const items = state.empty || owner === otherProfileOwner ? [] : profileHistory.filter((item) => !entry.query.kind || entry.query.kind === "all" || item.kind === entry.query.kind);
        let result = { items: items.slice(offset, offset + limit), next_offset: offset + limit < items.length ? offset + limit : null };
        if (state.transformHistory) result = state.transformHistory(result, entry);
        const fail = state.failHistory, gate = state.historyGate;
        state.failHistory = false;
        if (gate) await gate;
        await route.fulfill({ headers, status: fail ? 503 : 200,
          json: fail ? { detail: "Practice history is temporarily unavailable." } : result });
        state.responses.push(entry);
        return;
      }
      throw new Error(`Unexpected profile fixture request: ${request.method()} ${url.pathname}`);
    }
    if (url.hostname.endsWith(".clerk.accounts.dev") || url.hostname.includes("clerk.com")) {
      return route.fulfill({ contentType: "application/javascript", body: "/* synthetic identity installed */" });
    }
    if (url.origin === origin) return route.continue();
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><body>External resource fixture</body>" });
  });
  return state;
}
