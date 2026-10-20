import { installLoadoutFixture, loadoutOwner } from "./loadout-fixture.mjs";
export const speakingSessionId = "06026b50-b7d7-4f00-bf8f-3aab74528b11";
export function speakingWorkspace(owner = loadoutOwner) {
  return { version: 1, runtime: null, messages: [], evidence: [], learning: [], policy: null, analysis_status: "idle", hint: null, help: null,
    session: { id: speakingSessionId, user_id: owner, client_id: "f8a8cb18-8748-4a91-9696-36689457b6c8", scenario_type: "workplace", goal: "Align the migration plan", difficulty: "standard", feedback_level: "balanced", status: "draft", created_at: "2026-10-01T10:00:00Z", turn_count: 0,
      logic_template: { id: "persuasive_pitch", title: "Persuasive pitch", description: "Practice a proposal.", steps: ["Context", "Tension", "Proposal", "Defend"] }, items: [
        { id: "item-1", corpus_item_id: null, ordinal: 0, kind: "chunk", text: "To be fair", meaning: "Acknowledge another perspective", tags: [], slots: {}, source_title: "Workplace conversation" },
        { id: "item-2", corpus_item_id: null, ordinal: 1, kind: "idiom", text: "on the same page", meaning: "Share an understanding", tags: [], slots: {}, source_title: "Workplace conversation" },
        { id: "item-3", corpus_item_id: null, ordinal: 2, kind: "structure", text: "What matters most is [priority].", meaning: "State the priority", tags: [], slots: { priority: "the most important outcome" }, source_title: null }
      ] } };
}
export async function installSpeakingFixture(page, { origin, denyMicrophone = false, deferHints = false } = {}) {
  const auth = await installLoadoutFixture(page, { origin, initialOwner: loadoutOwner, records: [] });
  await page.addInitScript(({ deny }) => {
    window.__speakingTracks = []; window.__denySpeakingMic = deny;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => {
      if (window.__denySpeakingMic) throw new DOMException("Denied", "NotAllowedError");
      const stream = await original(options); window.__speakingTracks.push(...stream.getTracks()); return stream;
    };
  }, { deny: denyMicrophone });
  const state = { workspace: speakingWorkspace(), events: [], connections: [], sockets: [], dropNextText: false, conflict: false, deletes: 0 };
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" };
  await page.route(`**/api/speaking/sessions/${speakingSessionId}{,/**}`, async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const token = req.headers().authorization?.split(" ")[1];
    const owner = token ? JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub : null;
    if (owner !== state.workspace.session.user_id) return route.fulfill({ status: 404, headers, json: { detail: "Mission not found." } });
    if (path.endsWith("/workspace")) return route.fulfill({ headers, json: state.workspace });
    if (path.endsWith("/realtime")) {
      const body = req.postDataJSON(); state.connections.push(body);
      if (state.conflict && !body.takeover) return route.fulfill({ status: 409, headers, json: { detail: "This mission is open elsewhere. Take over to continue here." } });
      return route.fulfill({ headers, json: { runtime_id: "runtime", ticket: "one-use-fixture-ticket", expires_at: new Date(Date.now() + 30000).toISOString(), websocket_path: `/api/speaking/sessions/${speakingSessionId}/realtime/runtime` } });
    }
    if (path.endsWith("/end")) { state.workspace.session.status = "completed"; state.workspace.version++; return route.fulfill({ headers, json: state.workspace }); }
    if (req.method() === "DELETE") { state.deletes++; return route.fulfill({ status: 204, headers }); }
    return route.fulfill({ status: 404, headers, json: { detail: "Not found" } });
  });
  await page.routeWebSocket(`**/api/speaking/sessions/${speakingSessionId}/realtime/*`, socket => {
    state.sockets.push(socket); let authenticated = false;
    socket.onMessage(raw => {
      const event = JSON.parse(String(raw)); state.events.push(event);
      if (!authenticated) {
        if (event.type !== "authenticate" || event.ticket !== "one-use-fixture-ticket") throw Error("First frame must authenticate");
        authenticated = true; socket.send(JSON.stringify({ type: "ready", workspace: state.workspace })); return;
      }
      if (event.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      if (event.type === "microphone") socket.send(JSON.stringify({ type: "state", state: "listening" }));
      if (event.type === "interrupt") { socket.send(JSON.stringify({ type: "audio.clear", item_id: "audio-item" })); socket.send(JSON.stringify({ type: "state", state: "listening" })); }
      if (event.type === "hint" && !deferHints) {
        const item = state.workspace.session.items.find(value => value.id === event.target_item_id) ?? state.workspace.session.items[1];
        state.workspace.help = { id: event.request_id, version: 2, target_item_id: item.id, level: event.level, status: "ready", direction: "Check shared expectations.", expression: item.text, meaning: item.meaning, pattern: "We need to be on the same page about [topic].", example: event.level === "example" ? "We need to be on the same page about the timeline." : null, substitution: null, source: "requested", source_message_id: null, error: null };
        state.workspace.hint = null; state.workspace.version++; socket.send(JSON.stringify({ type: "snapshot", workspace: state.workspace }));
      }
      if (event.type === "text.submit") {
        if (!state.workspace.messages.some(message => message.client_turn_id === event.client_turn_id)) {
          const ordinal = state.workspace.messages.length;
          const message = { id: `message-${ordinal}`, ordinal, role: "user", text: event.text, input_source: "text", status: "final", revision: 1, provider_item_id: `provider-${ordinal}`, response_id: null, client_turn_id: event.client_turn_id, created_at: new Date().toISOString() };
          state.workspace.messages.push(message, { ...message, id: `message-${ordinal + 1}`, ordinal: ordinal + 1, role: "assistant", text: "Which part of the timeline would you adjust first?", client_turn_id: null, provider_item_id: `provider-${ordinal + 1}` });
          const start = event.text.indexOf("To be fair");
          if (start >= 0) { state.workspace.evidence.push({ id: `evidence-${ordinal}`, session_item_id: "item-1", message_id: message.id, transcript_revision: 1, start, end: start + 10, quote: "To be fair", match_type: "exact", appropriateness: "uncertain", prompted: false, reason: "The selected expression appears in your finalized turn. Context was not evaluated in this fixture." }); state.workspace.learning = [{ session_item_id: "item-1", observed_uses: 1, independent_uses: 1, prompted_uses: 0, last_message_id: message.id }]; }
          state.workspace.session.status = "active"; state.workspace.session.turn_count++; state.workspace.analysis_status = "ready"; state.workspace.version++;
        }
        if (state.dropNextText) { state.dropNextText = false; socket.close(); } else socket.send(JSON.stringify({ type: "snapshot", workspace: state.workspace }));
      }
    });
  });
  return { ...state, state, errors: auth.errors };
}
