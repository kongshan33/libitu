import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureContentId, installLoadoutFixture, loadoutOwner, shadowBlueprint, shadowJob } from "./helpers/loadout-fixture.mjs";

// One continuous UI journey. Identity, source, persistence, realtime and assessment
// are synthetic fixtures; this does not claim OAuth or model-quality validation.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3001";
const artifacts = await mkdtemp(join(tmpdir(), "libitu-learner-journey-"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const page = await context.newPage(); page.setDefaultTimeout(30000);
const saved = await installLoadoutFixture(page, { origin, records: [], shadow: true });
const workspaces = new Map(), reports = new Map(), events = [], reportRequests = [];
const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
function workspaceFor(id) {
  if (!workspaces.has(id)) {
    const session = saved.sessions.get(id); assert.ok(session, "runtime requires the mission created in this journey");
    workspaces.set(id, { session: structuredClone(session), version: 1, runtime: null, messages: [], evidence: [], learning: [], policy: null, hint: null, analysis_status: "idle" });
  }
  return workspaces.get(id);
}
function makeReport(workspace) {
  const user = workspace.messages.find(message => message.role === "user"); assert.ok(user);
  const quote = { message_id: user.id, transcript_revision: user.revision, quote: user.text, start: 0, end: user.text.length };
  const words = user.text.match(/[A-Za-z']+/g)?.length ?? 0;
  return { id: "journey-report", session_id: workspace.session.id, session: structuredClone(workspace.session), messages: structuredClone(workspace.messages), status: "ready", input_hash: "journey-frozen-input", rubric_version: "speaking-rubric-v1", analysis_version: "speaking-feedback-v1", attempts: 1, retryable: false, error_code: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), result: {
    dimensions: ["task_fit", "transfer", "scenario_fit", "naturalness"].map(id => ({ id, score: id === "transfer" ? 100 : 75, basis: id === "transfer" ? "coverage" : "ai_assessment", summary: "Synthetic journey assessment of the saved user turn.", criteria: id === "transfer" ? [] : [{ id: `${id}-criterion`, label: "Conversation evidence", rating: 3, reason: "The fixture anchors this assessment to the exact saved utterance.", evidence: [quote] }] })),
    item_results: workspace.session.items.map(item => ({ session_item_id: item.id, kind: item.kind, text: item.text, status: "appropriate", independent_uses: 1, prompted_uses: 0, reason: "Synthetic confirmed-use observation.", evidence: [quote] })),
    statistics: { user_turns: 1, assessed_turns: 1, excluded_turns: 0, word_count: words, average_words: words, selected_expressions: 1, used_expressions: 1, selected_structures: 0, used_structures: 0 },
    refactors: [{ id: "journey-refactor", original: quote, suggested: "To be fair, a smaller test would help us assess the plan safely.", reason: "Preserves the proposal while making the reason explicit.", save_text: "a smaller test", save_kind: "chunk", save_meaning: "A limited trial before a larger change" }], logic_stages: [], notices: ["Synthetic assessment fixture for the continuous learner journey."]
  } };
}
await page.route(/\/api\/speaking\/sessions\/[^/]+\/(workspace|realtime|end|feedback)$/, async route => {
  const request = route.request(); if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
  const match = new URL(request.url()).pathname.match(/\/sessions\/([^/]+)\/(workspace|realtime|end|feedback)$/);
  const token = request.headers().authorization?.split(" ")[1];
  const owner = token ? JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub : null;
  assert.equal(owner, loadoutOwner); const workspace = workspaceFor(match[1]);
  if (match[2] === "workspace") return route.fulfill({ headers, json: workspace });
  if (match[2] === "realtime") return route.fulfill({ headers, json: { runtime_id: "journey-runtime", ticket: "journey-ticket", expires_at: new Date(Date.now() + 30000).toISOString(), websocket_path: `/api/speaking/sessions/${workspace.session.id}/realtime/journey-runtime` } });
  if (match[2] === "end") { workspace.session.status = "completed"; workspace.version++; reports.set(workspace.session.id, makeReport(workspace)); return route.fulfill({ headers, json: workspace }); }
  reportRequests.push({ method: request.method(), sessionId: workspace.session.id });
  if (!reports.has(workspace.session.id)) return route.fulfill({ status: 409, headers, json: { detail: "End the conversation first." } });
  return route.fulfill({ headers, json: reports.get(workspace.session.id) });
});
await page.routeWebSocket("**/api/speaking/sessions/*/realtime/*", socket => {
  const id = new URL(socket.url()).pathname.match(/\/sessions\/([^/]+)\//)[1]; const workspace = workspaceFor(id); let authenticated = false;
  socket.onMessage(raw => {
    const event = JSON.parse(String(raw)); events.push(event);
    if (!authenticated) { assert.equal(event.type, "authenticate"); assert.equal(event.ticket, "journey-ticket"); authenticated = true; socket.send(JSON.stringify({ type: "ready", workspace })); return; }
    if (event.type === "ping") { socket.send(JSON.stringify({ type: "pong" })); return; }
    if (event.type !== "text.submit") return;
    const message = { id: "journey-user-turn", ordinal: 0, role: "user", text: event.text, input_source: "text", status: "final", revision: 1, provider_item_id: "journey-provider-item", response_id: null, client_turn_id: event.client_turn_id, created_at: new Date().toISOString() };
    assert.equal(workspace.messages.length, 0, "this bounded journey sends exactly one user turn");
    workspace.messages.push(message, { ...message, id: "journey-assistant-turn", ordinal: 1, role: "assistant", text: "What would you test first?", provider_item_id: "journey-assistant-item", client_turn_id: null });
    const start = message.text.indexOf("To be fair"); assert.ok(start >= 0);
    workspace.evidence.push({ id: "journey-evidence", session_item_id: workspace.session.items[0].id, message_id: message.id, transcript_revision: 1, start, end: start + 10, quote: "To be fair", match_type: "exact", appropriateness: "uncertain", prompted: false, reason: "This fixture observes the expression in the saved turn." });
    workspace.session.turn_count = 1; workspace.session.status = "active"; workspace.analysis_status = "ready"; workspace.version++;
    socket.send(JSON.stringify({ type: "snapshot", workspace }));
  });
});
try {
  const reader = `${origin}/?${new URLSearchParams({ sourceUrl: shadowBlueprint.source_url, title: shadowBlueprint.title, contentId: fixtureContentId, jobId: shadowJob.id, learnerLevel: "B2" })}#practice`;
  await page.goto(reader, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByRole("button", { name: "Save to corpus", exact: true }).click(); await page.getByRole("button", { name: "Remove from corpus", exact: true }).waitFor();
  await page.locator(".mission-box").getByRole("link", { name: "Open loadout", exact: true }).click();
  await page.getByRole("button", { name: "Select to be fair", exact: true }).click();
  await page.getByLabel("Mission goal", { exact: true }).fill("Share a fair assessment of the plan");
  await page.evaluate(owner => window.__setLoadoutUser(owner), loadoutOwner);
  await page.getByRole("button", { name: "Start mission", exact: true }).click(); await page.waitForURL(/\/speaking\/[a-f0-9-]+/);
  const sessionId = new URL(page.url()).pathname.split("/").at(-1);
  assert.equal(saved.corpusSaves.length, 1); assert.equal(saved.creates.length, 1); assert.equal(saved.creates[0].input.corpus_item_ids.length, 1);
  await page.getByRole("heading", { name: "Share a fair assessment of the plan", exact: true }).waitFor();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const learnerText = "To be fair, we should try a smaller test before changing the full plan.";
  await page.getByRole("textbox", { name: "Message your AI partner", exact: true }).fill(learnerText); await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "View evidence for To be fair", exact: true }).waitFor(); await page.getByText("What would you test first?", { exact: true }).waitFor();
  assert.equal(events.filter(event => event.type === "text.submit").length, 1); assert.equal(events.some(event => event.type === "microphone" && event.enabled), false);
  await page.getByRole("button", { name: "End mission", exact: true }).click(); await page.getByRole("button", { name: "End and review", exact: true }).click();
  await page.waitForURL(`**/speaking/${sessionId}/analytics`); await page.getByRole("heading", { name: "Your mission report", exact: true }).waitFor();
  await page.getByRole("tab", { name: /^Language transfer/ }).click(); await page.getByRole("heading", { name: "Expressions", exact: true }).waitFor();
  await page.getByRole("tabpanel").getByRole("link", { name: new RegExp(learnerText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  assert.equal(await page.locator("#source-journey-user-turn mark").textContent(), learnerText);
  await page.getByRole("button", { name: "Save AI suggestion", exact: true }).click(); await page.getByRole("button", { name: "Saved to corpus", exact: true }).waitFor();
  assert.equal(saved.corpusSaves.length, 2); assert.equal(saved.corpusSaves[1].input.source_locator.source_url, `${origin}/speaking/${sessionId}/analytics`); assert.match(saved.corpusSaves[1].input.usage_context, /AI-generated suggestion/);
  await page.screenshot({ path: join(artifacts, "continuous-journey-report.png"), fullPage: true });
  await page.getByRole("button", { name: /Retry this mission/ }).click(); await page.waitForURL(url => /\/speaking\/[a-f0-9-]+$/.test(url.pathname) && !url.pathname.endsWith(sessionId));
  await page.getByRole("heading", { name: "Share a fair assessment of the plan", exact: true }).waitFor();
  assert.equal(saved.creates.length, 2); assert.notEqual(saved.creates[0].input.client_id, saved.creates[1].input.client_id); assert.deepEqual(saved.creates[0].input.corpus_item_ids, saved.creates[1].input.corpus_item_ids); assert.equal(saved.sessions.size, 2);
  assert.equal(reports.get(sessionId).session.status, "completed"); assert.equal(reports.get(sessionId).messages[0].text, learnerText); assert.ok(reportRequests.length); assert.equal(reportRequests.every(request => request.method === "GET"), true); assert.deepEqual(saved.errors, []);
  console.log(`PASS one continuous Stage1 save → loadout select/sign-in sync/create → Stage4 typed turn/evidence/end → Stage5 frozen evidence/report → corpus suggestion save → new retry mission. Synthetic source/auth/providers; screenshot ${artifacts}`);
} catch (error) { await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }); throw error; }
finally { await context.close(); await browser.close(); }
