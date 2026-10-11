// Shared synthetic identity for local playback/recording regression suites.
// Real login transitions and persistence behavior are covered separately.
export async function installSignedInPractice(page) {
  await page.addInitScript(() => {
    const owner = "practice-browser-fixture";
    const user = { id: owner, organizationMemberships: [] };
    const session = { id: "session-fixture", user, status: "active",
      lastActiveToken: { jwt: { claims: { sub: owner } } },
      getToken: async () => `header.${btoa(JSON.stringify({ sub: owner }))}.fixture` };
    const resources = { user, session, client: { sessions: [session] }, organization: null };
    window.Clerk = { loaded: true, ...resources, __internal_lastEmittedResources: resources,
      telemetry: { record() {} }, __internal_environment: {}, load: async () => {},
      addListener: (callback, options) => { if (!options?.skipInitialEmit) callback(resources); return () => {}; },
      mountUserButton() {}, unmountUserButton() {}, __internal_updateProps() {} };
  });
  await page.route(/clerk\.(accounts\.dev|com)/, (route) => route.fulfill({ contentType: "application/javascript", body: "/* local identity fixture */" }));
  // Local playback suites have no previously uploaded private reference.
  await page.route(/\/api\/references\/(captures\/latest|capability)(\?|$)/, route => {
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,authorization" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    return route.fulfill({ headers, json: new URL(route.request().url()).pathname.endsWith("/latest") ? null : { available: false, input_mode: null } });
  });
  await page.route(/\/api\/(practice\/attempts|corpus)(\?|$|\/)/, async (route) => {
    const request = route.request(), url = new URL(request.url());
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,authorization",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (url.pathname === "/api/corpus") return route.fulfill({ json: [], headers });
    if (request.method() === "GET" && url.pathname.endsWith("/analysis")) return route.fulfill({ json: null, headers });
    if (request.method() === "GET") return route.fulfill({ json: { items: [], next_offset: null }, headers });
    if (request.method() === "POST") {
      const input = request.postDataJSON();
      if (input.recording) throw new Error("Local-media regression must not enable cloud recording retention.");
      return route.fulfill({ status: 201, json: { ...input, id: input.client_id, recording_state: "none", created_at: new Date().toISOString() }, headers });
    }
    throw new Error(`Unexpected practice fixture operation: ${request.method()}`);
  });
}
