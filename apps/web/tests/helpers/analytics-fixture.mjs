import { installLoadoutFixture, loadoutOwner } from "./loadout-fixture.mjs";
import { speakingWorkspace, speakingSessionId } from "./speaking-fixture.mjs";
export function analyticsReport(status = "ready") {
  const session = speakingWorkspace().session;
  session.status = "completed"; session.turn_count = 3;
  session.items.forEach((item, index) => { item.corpus_item_id = `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`; });
  const messages = [
    { role: "assistant", text: "What would you propose for the migration?" },
    { role: "user", text: "🙂 To be fair, the current system still works. What matters most is a safe transition." },
    { role: "assistant", text: "What is your main concern about the plan?" },
    { role: "user", text: "The risk is that we move too fast. I suggest we test a smaller change first." },
    { role: "assistant", text: "How would you explain that to the team?" },
    { role: "user", text: "I would explain the risk and ask for their ideas." }
  ].map((value, index) => ({ ...value, id: `report-message-${index}`, ordinal: index, input_source: "text", status: "final", revision: 1, provider_item_id: null, response_id: null, client_turn_id: null, created_at: "2026-10-01T10:01:00Z" }));
  function ref(index, quote = messages[index].text) { const message = messages[index]; const start = message.text.indexOf(quote); return { message_id: message.id, transcript_revision: message.revision, quote, start, end: start + quote.length }; }
  const first = ref(1, "To be fair"), structure = ref(1, "What matters most is a safe transition."), proposal = ref(3);
  return { id: "9ff20269-065f-40c9-ae36-252fb25fbc13", session_id: speakingSessionId, status, input_hash: "fixture-input-hash", rubric_version: "speaking-rubric-v1", analysis_version: "speaking-feedback-v1", attempts: 1, retryable: status === "failed" || status === "partial", error_code: status === "failed" ? "analysis_unavailable" : null, created_at: "2026-10-01T10:05:00Z", updated_at: "2026-10-01T10:05:30Z", session, messages,
    result: ["queued", "processing", "failed"].includes(status) ? null : {
      dimensions: [
        { id: "task_fit", score: 75, basis: "ai_assessment", summary: "You proposed a smaller test and explained the risk. A shared next step was not established in this conversation.", criteria: [
          { id: "goal", label: "Respond to the mission", rating: 3, reason: "Your proposal addresses how to move the migration forward while managing risk.", evidence: [proposal] },
          { id: "support", label: "Make your reasoning clear", rating: 3, reason: "You connect the pace of change with the need for a safe transition.", evidence: [structure] }
        ] },
        { id: "transfer", score: status === "partial" ? null : 67, basis: "coverage", summary: "Two of three selected items have confirmed appropriate use. One was used after a hint.", criteria: [] },
        { id: "scenario_fit", score: 75, basis: "ai_assessment", summary: "Your tone fits a collaborative workplace discussion.", criteria: [{ id: "tone", label: "Collaborative tone", rating: 3, reason: "You acknowledge the current system before suggesting a change.", evidence: [first] }] },
        { id: "naturalness", score: 50, basis: "ai_assessment", summary: "The meaning is clear. One sentence could be more concise without changing your proposal.", criteria: [{ id: "clarity", label: "Clear expression", rating: 2, reason: "The proposal is understandable; combining the risk and suggestion would make the relationship clearer.", evidence: [proposal] }] }
      ],
      item_results: session.items.map((item, index) => ({ session_item_id: item.id, kind: item.kind, text: item.text, status: index === 1 ? "not_observed" : "appropriate", independent_uses: index === 0 ? 1 : 0, prompted_uses: index === 2 ? 1 : 0, reason: index === 1 ? "This expression was not observed in your final transcript." : index === 0 ? "Acknowledges another perspective before stating your concern." : "States the priority clearly after a hint.", evidence: index === 1 ? [] : [index === 0 ? first : structure] })),
      statistics: { user_turns: 3, assessed_turns: 3, excluded_turns: 0, word_count: 45, average_words: 15, selected_expressions: 2, used_expressions: 1, selected_structures: 1, used_structures: 1 },
      refactors: [{ id: "refactor-1", original: proposal, suggested: "To avoid moving too fast, I suggest testing a smaller change first.", reason: "Connects the concern and proposal while preserving your meaning.", save_text: "To avoid [risk], I suggest [action].", save_kind: "structure", save_meaning: "Link a concern to a proposed action" }],
      logic_stages: [{ label: "Context", status: "observed", reason: "You describe why the current system still matters.", evidence: [first] }, { label: "Proposal", status: "observed", reason: "You suggest a smaller test.", evidence: [proposal] }, { label: "Defend", status: "not_observed", reason: "No defense of the proposal was observed in the available turns.", evidence: [] }],
      notices: ["This report uses the saved text transcript. Speech timing and pronunciation were not assessed."]
    } };
}
export async function routeFeedbackFixture(page, state = { report: analyticsReport(), posts: [], gets: 0, missing: false }) {
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
  await page.route(`**/api/speaking/sessions/${speakingSessionId}/feedback`, async route => {
    const request = route.request(); if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const owner = JSON.parse(Buffer.from(request.headers().authorization?.split(" ")[1].split(".")[1] ?? "", "base64url").toString()).sub;
    if (owner !== loadoutOwner) return route.fulfill({ status: 404, headers, json: { detail: "Not found" } });
    if (request.method() === "POST") { state.posts.push(request.postDataJSON()); state.missing = false; }
    else { state.gets++; if (state.missing) return route.fulfill({ status: 404, headers, json: { detail: "Not found" } }); }
    if (state.gate) await state.gate;
    return route.fulfill({ headers, json: state.report });
  });
  return state;
}
export async function installAnalyticsFixture(page, { origin, status = "ready", missing = false } = {}) {
  const auth = await installLoadoutFixture(page, { origin, records: [], initialOwner: loadoutOwner });
  const report = analyticsReport(status);
  auth.cloud.set(loadoutOwner, new Map(report.session.items.map(item => {
    const key = `corpus-fixture:${item.corpus_item_id}`;
    return [key, { id: item.corpus_item_id, kind: item.kind, text: item.text, meaning: item.meaning, tags: [], slots: {}, content_id: null,
      source_locator: { client_key: key, source_title: "Workplace conversation", source_url: "https://example.com/source", snapshot: { id: item.id, meta: "Saved corpus" } } }];
  })));
  const feedback = await routeFeedbackFixture(page, { report, posts: [], gets: 0, missing });
  auth.sessions.set(report.session.id, report.session);
  return { auth, feedback };
}
