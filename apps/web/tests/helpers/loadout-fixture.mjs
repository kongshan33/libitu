import { contentContextFixture } from "./content-context-fixture.mjs";
import assert from "node:assert/strict";

export const loadoutOwner = "loadout-browser-a";
export const fixtureContentId = "15eabce1-7847-4f3e-aa20-f1e49e53a015";
export const fixtureRecords = [
  ["structure", "What matters most is [priority]."],
  ["structure", "The reason I suggest [action] is [reason]."],
  ["structure", "If we [action], we can [outcome]."],
  ["structure", "I would rather [choice] than [alternative]."],
  ["chunk", "to be fair"],
  ["chunk", "from my perspective"],
  ["idiom", "on the same page"],
  ["chunk", "take this forward"],
  ["idiom", "break the ice"],
  ["chunk", "a practical next step"]
].map(([kind, text], index) => ({
  key: JSON.stringify([index < 5 ? fixtureContentId : "15eabce1-7847-4f3e-aa20-f1e49e53a016", kind, text.toLowerCase().match(/[a-z0-9']+/g).join(" ")]),
  contentId: index < 5 ? fixtureContentId : "15eabce1-7847-4f3e-aa20-f1e49e53a016",
  sourceUrl: `https://www.youtube.com/watch?v=${index < 5 ? "loadout1234" : "loadout5678"}`,
  sourceTitle: index < 5 ? "Workplace conversation" : "Everyday conversation",
  item: { id: `blueprint-candidate-${index}`, kind, text, meaning: `Meaning for ${text}`,
    tags: [], meta: "0:01 · B2", slots: {}, saved: true }
}));

const logicTemplates = [
  ["persuasive_pitch", "Persuasive pitch", ["Context", "Tension", "Proposal", "Defend"]],
  ["technical_troubleshoot", "Technical troubleshoot", ["Problem", "Evidence", "Cause", "Solution"]],
  ["stakeholder_alignment", "Stakeholder alignment", ["Context", "Priorities", "Tradeoffs", "Agreement"]],
  ["status_update", "Status update", ["Progress", "Blockers", "Next steps"]],
  ["disagreement", "Constructive disagreement", ["Acknowledge", "Concern", "Alternative", "Align"]],
  ["onboarding", "Onboarding", ["Welcome", "Context", "Steps", "Check"]]
].map(([id, title, steps]) => ({ id, title, description: `Practice ${title.toLowerCase()}.`, steps }));

// This exercises Clerk's React resource boundary with a synthetic identity. It
// deliberately does not contact Clerk/OAuth or prove a real hosted sign-in.
function browserFixture({ records, initialOwner, shadow, seedCorpus }) {
  if (!sessionStorage.getItem("loadout-fixture-initialized")) {
    if (seedCorpus) localStorage.setItem("libitu:corpus:v1", JSON.stringify({ version: 1, guest: records, pending: {} }));
    sessionStorage.setItem("loadout-fixture-owner", initialOwner ?? "");
    sessionStorage.setItem("loadout-fixture-initialized", "1");
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
    openSignIn(options) { window.__loadoutAuthCalls.push(options); },
    openSignUp(options) { window.__loadoutAuthCalls.push(options); },
    __internal_updateProps() {}
  };
  window.__loadoutAuthCalls = [];
  window.__setLoadoutUser = (owner) => {
    sessionStorage.setItem("loadout-fixture-owner", owner ?? "");
    clerk.user = owner ? { id: owner, organizationMemberships: [] } : null;
    clerk.session = owner ? { id: `session-${owner}`, user: clerk.user, status: "active",
      lastActiveToken: { jwt: { claims: { sub: owner } } },
      getToken: async () => `header.${btoa(JSON.stringify({ sub: owner }))}.fixture` } : null;
    clerk.client = { sessions: clerk.session ? [clerk.session] : [] };
    clerk.__internal_lastEmittedResources = { user: clerk.user, session: clerk.session,
      client: clerk.client, organization: null };
    for (const listener of listeners) listener(clerk.__internal_lastEmittedResources);
  };
  window.__setLoadoutUser(sessionStorage.getItem("loadout-fixture-owner") || null);
  window.Clerk = clerk;
  if (shadow) {
    window.__loadoutPlayers = [];
    window.YT = { Player: class {
      time = 0; rate = 1; playing = false; destroyed = false;
      constructor(_element, { events }) {
        this.events = events;
        window.__loadoutPlayers.push(this);
        queueMicrotask(() => events.onReady());
      }
      getCurrentTime() { return this.time; } seekTo(seconds) { this.time = seconds; }
      playVideo() { this.playing = true; this.events.onStateChange({ data: 1 }); }
      pauseVideo() { this.playing = false; this.events.onStateChange({ data: 2 }); }
      getPlaybackRate() { return this.rate; } getAvailablePlaybackRates() { return [0.5, 1, 1.25]; }
      setPlaybackRate(rate) { this.rate = rate; this.events.onPlaybackRateChange?.({ data: rate }); }
      destroy() { this.destroyed = true; this.playing = false; }
    } };
    window.__loadoutMicrophoneTracks = [];
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (options) => {
      const stream = await getMedia(options);
      window.__loadoutMicrophoneTracks.push(...stream.getTracks());
      return stream;
    };
  }
}

export const shadowJob = { id: "loadout-shadow-job", content_id: fixtureContentId, status: "ready",
  blueprint_id: "loadout-shadow-blueprint", analysis_version: "mvp-v9", processing_stage: "completed",
  analysis_preview: null, error_message: null };
export const shadowBlueprint = { id: shadowJob.blueprint_id, content_id: fixtureContentId,
  title: "Shadow to loadout", source_url: fixtureRecords[0].sourceUrl, summary: "Save a take before continuing.",
  chapters: [], logic_flow: [{ id: "logic-1", title: "Opening", subtitle: "An introduction", time: "0:01" }],
  corpus_items: [{ ...fixtureRecords[4].item, meaning: null }], transcript: [{ id: "sentence-v2-loadout", time: "0:01", parts: ["Let's begin."],
    start_ms: 1000, end_ms: 4000, source_token_start: 0, source_token_end: 2,
    segmentation_version: "sentence-v2", boundary_source: "syntax_merge", boundary_confidence: "medium" }],
  segments: [{ id: "loadout-segment", sequence: 1, title: "Opening", summary: "Practice the opening.",
    start_ms: 1000, end_ms: 4000, transcript_start_index: 0, transcript_end_index: 1, phonology_tags: [], recommended: true }] };

export async function installLoadoutFixture(page, {
  origin, records = fixtureRecords, initialOwner = null, shadow = false, seedCorpus = true, sharedState
} = {}) {
  // Clerk's development middleware otherwise redirects document navigation to
  // a real handshake before the synthetic React identity can hydrate. This
  // device marker is not a session token: middleware remains signed out.
  await page.context().addCookies([{ name: "__clerk_db_jwt", value: "synthetic-browser-device", url: origin }]);
  const state = sharedState ?? { errors: [], requests: [], corpusSaves: [], creates: [], sessionReads: [],
    cloud: new Map(), sessions: new Map(), failNextCreate: false, corpusGate: null, createGate: null,
    practiceGate: null, practiceRequests: [], practiceRows: new Map(), practiceCompleted: 0 };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.addInitScript(browserFixture, { records, initialOwner, shadow, seedCorpus });
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,authorization",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (url.pathname.startsWith("/api/")) {
      const token = request.headers().authorization?.split(" ")[1];
      const owner = token ? JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub : null;
      state.requests.push({ method: request.method(), path: url.pathname, owner });
      if (url.pathname === `/api/profile/videos/${fixtureContentId}` && request.method() === "PUT") {
        assert.ok(owner);
        return route.fulfill({ status: 204, headers });
      }
      if (url.pathname === "/api/speaking/options") return route.fulfill({ headers,
        json: { logic_templates: logicTemplates, max_structures: 3, max_expressions: 5, min_items: 1 } });
      if (shadow) {
        if (url.pathname === `/api/content/${fixtureContentId}`) return route.fulfill({ json: contentContextFixture(shadowBlueprint, shadowJob), headers });
        if (url.pathname === `/api/jobs/${shadowJob.id}`) return route.fulfill({ json: shadowJob, headers });
        if (url.pathname === `/api/blueprints/${fixtureContentId}`) return route.fulfill({ json: shadowBlueprint, headers });
        if (url.pathname.includes("/sound")) return route.fulfill({ status: 404, json: { detail: "Outside navigation fixture." }, headers });
        if (url.pathname === "/api/references/capability") return route.fulfill({ json: { available: false, input_mode: null }, headers });
        if (url.pathname === "/api/references/captures/latest") return route.fulfill({ json: null, headers });
        if (/^\/api\/practice\/attempts\/[^/]+\/analysis$/.test(url.pathname)) return route.fulfill({ json: null, headers });
        if (url.pathname === "/api/practice/attempts") {
          assert.ok(owner);
          if (request.method() === "GET") return route.fulfill({ json: { items: [...state.practiceRows.values()], next_offset: null }, headers });
          const input = request.postDataJSON();
          assert.ok(!input.recording, "navigation fixture must never enable audio retention");
          state.practiceRequests.push(input);
          if (state.practiceGate) await state.practiceGate;
          const row = { ...input, id: input.client_id, sentence_text: "Let's begin.", recording_state: "none", created_at: new Date().toISOString() };
          state.practiceRows.set(row.id, row);
          await route.fulfill({ status: 201, json: row, headers });
          state.practiceCompleted++;
          return;
        }
      }
      assert.ok(owner, `${request.method()} ${url.pathname} requires a fixture identity`);
      if (url.pathname === "/api/corpus") {
        if (!state.cloud.has(owner)) state.cloud.set(owner, new Map());
        const cloud = state.cloud.get(owner);
        if (request.method() === "GET") {
          if (state.corpusGate) await state.corpusGate;
          return route.fulfill({ json: [...cloud.values()], headers });
        }
        assert.equal(request.method(), "POST");
        const input = request.postDataJSON();
        state.corpusSaves.push({ owner, input });
        const key = input.source_locator.client_key;
        const row = cloud.get(key) ?? { ...input, id: `00000000-0000-4000-8000-${String(cloud.size + 1).padStart(12, "0")}` };
        cloud.set(key, row);
        return route.fulfill({ status: 201, json: row, headers });
      }
      if (url.pathname === "/api/speaking/plans" && request.method() === "POST") {
        const input = request.postDataJSON();
        state.planRequests ??= []; state.plans ??= new Map();
        state.planRequests.push({ owner, input });
        const serial = state.planRequests.length;
        const plan = { id: `20000000-0000-4000-8000-${String(serial).padStart(12, "0")}`, version: 1,
          scenario_type: input.scenario_type, brief: input.brief, created_at: new Date().toISOString(),
          candidates: Array.from({ length: input.candidate_count ?? 2 }, (_, index) => ({ id: `30000000-0000-4000-8000-${String(serial * 10 + index).padStart(12, "0")}`,
            title: index ? "Agree on a team handoff" : "Plan a small launch", setting: "A short planning discussion with a colleague.",
            goal: index ? "Agree on owners and next steps" : "Agree on a practical launch plan", user_role: "Project lead", ai_role: "Colleague",
            register: "professional", targets: input.targets.map(target => ({ ...target, communicative_function: "Explain and align priorities",
              fit: state.nextPlanFit ?? "high", fit_reason: "The decision calls for the communicative function of this target.",
              trigger_question: "What would you recommend for our next step?", skip_when: "The conversation no longer needs this decision.", metadata_status: "partial",
              sentence_frame: (() => { const item = [...state.cloud.get(owner).values()].find(row => row.id === target.corpus_item_id); return item.kind === "structure" ? item.text : `${item.text}, [your idea].`; })() })) })) };
        state.plans.set(plan.id, { owner, plan });
        if (state.planGate) await state.planGate;
        if (state.failNextPlan) { state.failNextPlan = false; return route.fulfill({ status: 503, headers, json: { detail: "Scene generation temporarily unavailable." } }); }
        return route.fulfill({ status: 201, headers, json: plan }).catch(() => {});
      }
      if (url.pathname === "/api/speaking/sessions" && request.method() === "POST") {
        const input = request.postDataJSON();
        state.creates.push({ owner, input });
        assert.ok(input.corpus_item_ids.length >= 1);
        const rows = input.corpus_item_ids.map((id) => [...state.cloud.get(owner).values()].find((row) => row.id === id));
        assert.ok(rows.every(Boolean), "submission must use synchronized server IDs, never blueprint candidate IDs");
        assert.equal(new Set(input.corpus_item_ids).size, input.corpus_item_ids.length);
        const savedPlan = input.plan_id ? state.plans?.get(input.plan_id) : null;
        const candidate = savedPlan?.plan.candidates.find(value => value.id === input.candidate_id);
        if (input.plan_id) {
          assert.equal(savedPlan?.owner, owner);
          assert.ok(candidate);
          assert.equal(input.goal, candidate.goal);
          assert.deepEqual(input.corpus_item_ids, candidate.targets.map(target => target.corpus_item_id));
        } else {
          assert.ok(rows.filter((row) => row.kind === "structure").length <= 3);
          assert.ok(rows.filter((row) => row.kind !== "structure").length <= 5);
        }
        let session = [...state.sessions.values()].find((row) => row.client_id === input.client_id && row.user_id === owner);
        if (!session) {
          session = { ...input, id: `10000000-0000-4000-8000-${String(state.sessions.size + 1).padStart(12, "0")}`,
            user_id: owner, logic_template: logicTemplates.find((row) => row.id === input.logic_template_id) ?? null,
            status: "draft", created_at: new Date().toISOString(), turn_count: 0,
            items: rows.map((row, ordinal) => ({ id: `snapshot-${ordinal}`, corpus_item_id: row.id, ordinal,
              kind: row.kind, text: row.text, meaning: row.meaning, tags: row.tags, slots: row.slots,
              source_title: row.source_locator.source_title })) };
          if (candidate) session.mission_plan = { ...candidate, plan_id: input.plan_id, candidate_id: candidate.id, version: 1,
            scenario_type: input.scenario_type, targets: candidate.targets.map((target, index) => ({ ...target, session_item_id: session.items[index].id })) };
          state.sessions.set(session.id, structuredClone(session));
        }
        if (state.createGate) await state.createGate;
        if (state.failNextCreate) {
          state.failNextCreate = false;
          return route.fulfill({ status: 503, json: { detail: "Fixture connection interrupted. Please retry." }, headers });
        }
        return route.fulfill({ status: 201, json: state.createResponseTransform ? state.createResponseTransform(structuredClone(session)) : session, headers });
      }
      const match = url.pathname.match(/^\/api\/speaking\/sessions\/([^/]+)(\/workspace)?$/);
      if (match && request.method() === "GET") {
        state.sessionReads.push({ owner, id: match[1] });
        const session = state.sessions.get(match[1]);
        state.workspaces ??= new Map();
        if (session && !state.workspaces.has(session.id)) state.workspaces.set(session.id, { session, version: 0, runtime: null, messages: [], evidence: [], learning: [], policy: null, analysis_status: "idle", hint: null,
          support: session.support_level ? { level: session.support_level, version: 0 } : null, demonstrations: [],
          opportunities: session.mission_plan?.targets.map(target => ({ session_item_id: target.session_item_id, role: target.role, status: "planned", skipped_reason: null, skipped_at: null, sent: false, bound: false, reflected: false, presented: false, last_response_id: null })) ?? [] });
        const result = match[2] ? state.workspaces.get(match[1]) : session;
        return route.fulfill(session?.user_id === owner ? { json: result, headers }
          : { status: 404, json: { detail: "Session not found." }, headers });
      }
      throw new Error(`Unexpected fixture API request: ${request.method()} ${url.pathname}`);
    }
    if (url.hostname.endsWith(".clerk.accounts.dev") || url.hostname.includes("clerk.com")) {
      return route.fulfill({ contentType: "application/javascript", body: "/* synthetic identity installed */" });
    }
    if (shadow && url.pathname.startsWith("/acoustic-assets/")) return route.abort();
    if (url.origin === origin) return route.continue();
    return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><body>External resource fixture</body>" });
  });
  return state;
}
