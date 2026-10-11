import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const extensionSource = fileURLToPath(new URL("..", import.meta.url));
const observerFile = "src/youtube-caption-observer.js";
const temporary = await mkdtemp(join(tmpdir(), "libitu-passive-captions-"));
const contexts = [];
const sourceUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;
const videoIds = ["first-video", "other-video", "late--video"];
const contentId = videoId => `a0000000-0000-4000-8000-00000000000${videoIds.indexOf(videoId) + 1}`;
const webUrl = videoId => `http://localhost:3000/practice/${contentId(videoId)}`;
const privateValue = "fixture-private-signature";
const fine = (start = 1040) => ({
  signedUrl: `https://www.youtube.com/api/timedtext?signature=${privateValue}`,
  events: [{ tStartMs: start, dDurationMs: 1500, secret: privateValue,
    segs: [{ utf8: "We", acAsrConf: 0 }, { utf8: " can.", tOffsetMs: 300, token: privateValue }] }],
});
const block = { events: [{ tStartMs: 1040, dDurationMs: 1500, segs: [{ utf8: "We can." }] }] };
const results = [];
let step = "launching isolated extension";
const deadline = setTimeout(() => {
  console.error(`Passive caption browser verification exceeded 90 seconds at: ${step}`);
  void Promise.all(contexts.map((context) => context.close().catch(() => {})));
}, 90_000);

// The fixture's player, not Libitu, starts every caption request. Both transports
// are real browser networking intercepted below; observer snapshots are never mocked.
const youtubeHtml = `<!doctype html><html lang="en"><title>Caption fixture</title>
  <ytd-watch-flexy><div id="movie_player"><video></video>
  <div class="ytp-chrome-controls"><div class="ytp-right-controls"></div></div></div>
  <ytd-watch-metadata><h1>Caption fixture</h1></ytd-watch-metadata></ytd-watch-flexy>
  <script>
    window.fixture = {
      setVideo(videoId) {
        document.dispatchEvent(new Event("yt-navigate-start"));
        history.pushState({}, "", "/watch?v=" + videoId);
        document.querySelector("ytd-watch-flexy").setAttribute("video-id", videoId);
        window.ytInitialPlayerResponse = { videoDetails: { videoId, title: "Caption fixture" },
          captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: "en", kind: "asr", vssId: "a.en",
          baseUrl: "https://www.youtube.com/api/timedtext?v=" + videoId + "&lang=en&kind=asr&signature=${privateValue}" }] } } };
        document.dispatchEvent(new Event("yt-navigate-finish"));
      },
      async requestCaptions(transport, variant, videoId = new URL(location.href).searchParams.get("v")) {
        const url = "/api/timedtext?v=" + videoId + "&lang=en&kind=asr&fmt=json3&fixture=" + variant
          + "&signature=${privateValue}&pot=fixture-private-token";
        if (transport === "fetch") {
          const response = await fetch(new Request(url));
          return { status: response.status, body: await response.json() };
        }
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", url);
          xhr.responseType = transport === "xhr-json" ? "json" : "text";
          xhr.addEventListener("load", () => resolve({ status: xhr.status,
            body: xhr.responseType === "json" ? xhr.response : JSON.parse(xhr.responseText) }));
          xhr.addEventListener("error", () => reject(new Error("Fixture player XHR failed")));
          xhr.send();
        });
      }
    };
    const player = document.getElementById("movie_player");
    player.getPlayerResponse = () => window.ytInitialPlayerResponse;
    player.getOption = () => ({ languageCode: "en", kind: "asr", vssId: "a.en" });
    const initialVideoId = new URL(location.href).searchParams.get("v");
    if (initialVideoId) fixture.setVideo(initialVideoId);
  </script></html>`;

async function launch(label, { lateObserver = false } = {}) {
  let extensionPath = extensionSource;
  if (lateObserver) {
    // Test-only extension copy: simulate a page which missed document_start,
    // then inject the real production observer rather than faking its response.
    extensionPath = join(temporary, "late-extension");
    await cp(join(extensionSource, "src"), join(extensionPath, "src"), { recursive: true });
    await cp(join(extensionSource, "icons"), join(extensionPath, "icons"), { recursive: true });
    const manifest = JSON.parse(await readFile(join(extensionSource, "manifest.json"), "utf8"));
    manifest.content_scripts = manifest.content_scripts.map((entry) => ({
      ...entry, js: entry.js.filter((file) => file !== observerFile),
    })).filter((entry) => entry.js.length > 0);
    await writeFile(join(extensionPath, "manifest.json"), JSON.stringify(manifest));
  }
  const context = await chromium.launchPersistentContext(join(temporary, `${label}-profile`), {
    headless: true,
    ...(process.env.LIBITU_CHROMIUM_PATH ? { executablePath: process.env.LIBITU_CHROMIUM_PATH } : { channel: "chromium" }),
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  contexts.push(context);
  const counts = { timedtextReads: 0, playerRequests: 0, forbiddenRequests: 0 };
  const requests = [];
  let delayedRoute;
  let delayedArrived;
  const delayed = new Promise((resolve) => { delayedArrived = resolve; });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "chrome-extension:") return route.continue();
    if (url.origin === "http://localhost:3000" && url.pathname.startsWith("/practice/")) {
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Cached reader</title><p>Already available plain captions.</p>" });
    }
    if (url.origin === "https://www.youtube.com" && ["/", "/watch"].includes(url.pathname)) {
      return route.fulfill({ contentType: "text/html", body: youtubeHtml });
    }
    if (url.origin === "https://www.youtube.com" && url.pathname === "/api/timedtext") {
      counts.timedtextReads += 1;
      assert.equal(url.searchParams.get("fmt"), "json3");
      assert.equal(url.searchParams.get("lang"), "en");
      assert.ok(["fetch", "xhr"].includes(route.request().resourceType()));
      assert.equal(route.request().frame().url().startsWith("https://www.youtube.com/"), true);
      const variant = url.searchParams.get("fixture");
      requests.push({ videoId: url.searchParams.get("v"), transport: route.request().resourceType(), variant });
      if (variant === "delayed") {
        delayedRoute = route;
        delayedArrived();
        return;
      }
      assert.ok(["fine", "later", "block"].includes(variant), "Only player fixture requests are allowed; Libitu must not fetch captions");
      return route.fulfill({ json: variant === "block" ? block : fine(variant === "later" ? 2040 : 1040) });
    }
    counts.forbiddenRequests += 1;
    return route.abort();
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
  await worker.evaluate(ids => {
    globalThis.fetch = async url => {
      const path = new URL(url).pathname;
      if (!path.endsWith("/identity")) throw new Error("Expected identity-only lookup");
      const id = path.split("/").at(-2);
      const videoId = ids[Number(id.slice(-1)) - 1];
      return Response.json({ content_id: id, kind: "youtube", source_url: `https://www.youtube.com/watch?v=${videoId}` });
    };
  }, videoIds);
  const youtube = await context.newPage();
  const web = await context.newPage();
  async function playerRequest(transport, variant = "fine") {
    counts.playerRequests += 1;
    return youtube.evaluate(({ transport, variant }) => window.fixture.requestCaptions(transport, variant), { transport, variant });
  }
  async function refresh(videoId, overrides = {}, retries = 0) {
    const result = await web.evaluate(({ videoId, overrides }) => new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { window.removeEventListener("message", listener); reject(new Error("Fresh bridge did not respond")); }, 5500);
      function listener(event) {
        if (event.source !== window || event.origin !== location.origin
          || event.data?.type !== "LIBITU_FRESH_CAPTIONS_RESPONSE" || event.data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", listener);
        resolve(event.data);
      }
      window.addEventListener("message", listener);
      window.postMessage({ type: "LIBITU_FRESH_CAPTIONS_REQUEST", version: 4, contentId: location.pathname.split("/")[2], requestId,
        sourceUrl: "https://www.youtube.com/watch?v=" + videoId, videoId, language: "en", ...overrides }, location.origin);
    }), { videoId, overrides });
    assert.equal(/fixture-private|signature|baseUrl|signedUrl|"pot"/.test(JSON.stringify(result)), false, "Signed source credentials must not cross the bridge");
    // A loaded local machine can hit the real bounded bridge deadline. Exercise
    // the user's explicit Retry without weakening any expected caption status.
    if (result.status === "timeout" && retries < 2) return refresh(videoId, overrides, retries + 1);
    return result;
  }
  async function observed(videoId, start = 1040, status = "ready") {
    await youtube.waitForFunction(({ videoId, start, status }) => {
      const result = globalThis.__libituCaptionObserverV1?.read(videoId, "en");
      return result?.status === status && result.captionTrack?.events[0]?.tStartMs === start;
    }, { videoId, start, status }, { timeout: 5000 });
  }
  return { context, worker, youtube, web, counts, requests, playerRequest, refresh, observed,
    delayed, releaseDelayed: async () => delayedRoute?.fulfill({ json: fine(4040) }) };
}

try {
  const fixture = await launch("document-start");
  const { context, worker, youtube, web, counts, playerRequest, refresh, observed } = fixture;
  await youtube.goto("https://www.youtube.com/");
  assert.equal(await youtube.evaluate(() => globalThis.__libituCaptionObserverV1?.version), 1,
    "The real manifest observer must install on the YouTube home page before SPA navigation");
  await youtube.evaluate(() => window.fixture.setVideo("first-video"));
  await web.goto("http://localhost:3000/practice/import");
  await web.evaluate(url => history.replaceState(null, "", url), webUrl("first-video"));
  const identifiers = await worker.evaluate(async ({ source, web }) => {
    const tabs = await chrome.tabs.query({});
    return { sourceTabId: tabs.find((tab) => tab.url === source)?.id, stageTabId: tabs.find((tab) => tab.url === web)?.id };
  }, { source: sourceUrl("first-video"), web: webUrl("first-video") });
  assert.ok(identifiers.sourceTabId && identifiers.stageTabId);
  const oldHandoff = { id: "old-caption-handoff", ...identifiers, createdAt: Date.now(), status: "ready",
    transcriptText: "0:01\tOld plain caption.", snapshot: { supported: true, videoId: "first-video", canonicalUrl: sourceUrl("first-video"), title: "Caption fixture", language: "en" } };
  await worker.evaluate(async ({ record, contentId }) => chrome.storage.session.set({
    ["libituHandoff:" + record.id]: record,
    ["libituContentTab:" + record.stageTabId]: { contentId, videoId: "first-video", documentId: "fixture" }
  }), { record: oldHandoff, contentId: contentId("first-video") });
  await youtube.getByRole("button", { name: "Open in Libitu", exact: true }).click();
  step = "captions-off response through background-tab bridge";
  assert.equal(context.pages().filter((page) => page.url().startsWith("http://localhost:3000")).length, 1);
  assert.equal((await refresh("first-video")).status, "not_observed", "A player with captions off has no response to observe");
  assert.deepEqual(await worker.evaluate(async ({ sourceTabId, stageTabId }) => ({
    sourceActive: (await chrome.tabs.get(sourceTabId)).active,
    readerActive: (await chrome.tabs.get(stageTabId)).active,
  }), identifiers), { sourceActive: false, readerActive: true }, "Recovery must work while YouTube stays in the background");
  assert.equal(counts.timedtextReads, 0, "Duplicate entry and recovery reads must not start timedtext requests");

  step = "real player XHR and fetch responses";
  assert.deepEqual(await playerRequest("xhr-json"), { status: 200, body: fine() });
  await observed("first-video");
  const first = await refresh("first-video");
  assert.equal(first.status, "ready");
  assert.equal(first.captionTrack.events[0].segs[1].tOffsetMs, 300);
  const repeated = await refresh("first-video");
  assert.equal(repeated.status, "ready", JSON.stringify(repeated));
  assert.deepEqual(repeated.captionTrack, first.captionTrack);
  assert.equal(counts.timedtextReads, 1, "Observer cache rereads add no network work");
  assert.deepEqual(await playerRequest("fetch", "later"), { status: 200, body: fine(2040) },
    "The observer must not consume or replace the player's fetch response");
  await observed("first-video", 2040);
  assert.equal((await refresh("first-video")).captionTrack.events[0].tStartMs, 2040);

  assert.deepEqual(await playerRequest("xhr-text"), { status: 200, body: fine() });
  await observed("first-video");

  // The player may still receive an old video's delayed response after SPA
  // navigation. It must not populate the new video's caption snapshot.
  const delayedPlayer = playerRequest("fetch", "delayed");
  step = "late old-video response and block-only SPA captions";
  await fixture.delayed;
  await youtube.evaluate(() => window.fixture.setVideo("other-video"));
  await web.goto(webUrl("other-video"));
  await fixture.releaseDelayed();
  assert.deepEqual(await delayedPlayer, { status: 200, body: fine(4040) });
  assert.equal(await youtube.evaluate(() => globalThis.__libituCaptionObserverV1.read("first-video", "en").status), "stale");
  assert.equal((await refresh("other-video")).status, "not_observed");
  assert.deepEqual(await playerRequest("xhr-text", "block"), { status: 200, body: block });
  await observed("other-video", 1040, "no_word_offsets");
  const blockResult = await refresh("other-video");
  assert.equal(blockResult.status, "no_word_offsets");
  assert.equal(blockResult.captionTrack.events[0].segs[0].utf8, "We can.");
  assert.equal("tOffsetMs" in blockResult.captionTrack.events[0].segs[0], false);
  assert.equal((await refresh("other-video", { sourceUrl: sourceUrl("first-video"), videoId: "first-video" })).status, "invalid_request");
  assert.equal(counts.timedtextReads, counts.playerRequests);
  assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.session.get("libituHandoff:old-caption-handoff"))["libituHandoff:old-caption-handoff"]), oldHandoff);
  assert.equal(/fixture-private|signature|baseUrl|signedUrl|"pot"/.test(JSON.stringify(await worker.evaluate(() => chrome.storage.session.get(null)))), false);
  await youtube.close();
  assert.equal((await refresh("other-video")).status, "no_matching_tab");
  assert.equal(counts.forbiddenRequests, 0);
  results.push({ scenario: "document-start-home-spa", ...counts, transports: fixture.requests.map((request) => request.transport) });

  const late = await launch("late-install", { lateObserver: true });
  step = "late observer installation and actual next player response";
  await late.youtube.goto(sourceUrl("late--video"));
  await late.web.goto(webUrl("late--video"));
  assert.equal(await late.youtube.evaluate(() => typeof globalThis.__libituCaptionObserverV1), "undefined");
  assert.deepEqual(await late.playerRequest("fetch"), { status: 200, body: fine() });
  assert.equal((await late.refresh("late--video")).status, "observer_missing");
  const sourceTabId = await late.worker.evaluate(async () => (await chrome.tabs.query({ url: "https://www.youtube.com/watch*" }))[0].id);
  // The production observer captures its clock at installation. Control only
  // that clock before late injection, never the observer's returned snapshots.
  await late.youtube.evaluate(() => {
    const realNow = Date.now;
    window.fixture.clockOffset = 0;
    Date.now = () => realNow() + window.fixture.clockOffset;
  });
  await late.worker.evaluate(async ({ sourceTabId, observerFile }) => chrome.scripting.executeScript({
    target: { tabId: sourceTabId }, world: "MAIN", files: [observerFile],
  }), { sourceTabId, observerFile });
  assert.equal((await late.refresh("late--video")).status, "not_observed", "Late injection cannot reconstruct a past response");
  assert.equal(late.counts.timedtextReads, 1);
  assert.deepEqual(await late.playerRequest("xhr-json"), { status: 200, body: fine() });
  await late.observed("late--video");
  assert.equal((await late.refresh("late--video")).status, "ready");
  await late.youtube.evaluate(() => { window.fixture.clockOffset = 16 * 60_000; });
  step = "clock-expired source snapshot and player-driven recovery";
  assert.equal((await late.refresh("late--video")).status, "not_observed", "Expired snapshots must not be reused or actively refreshed");
  assert.equal(late.counts.timedtextReads, 2);
  await late.youtube.evaluate(() => { window.fixture.clockOffset = 0; });
  assert.deepEqual(await late.playerRequest("fetch"), { status: 200, body: fine() });
  await late.observed("late--video");
  assert.equal((await late.refresh("late--video")).status, "ready");
  assert.equal(late.counts.timedtextReads, late.counts.playerRequests);
  assert.equal(late.counts.forbiddenRequests, 0);
  results.push({ scenario: "late-install-next-player-response", ...late.counts, transports: late.requests.map((request) => request.transport) });
  console.log(JSON.stringify({ freshCaptionSmoke: "passed", passiveObserver: true, scenarios: results, realMediaRequests: 0, fixtureOnly: true }));
} finally {
  clearTimeout(deadline);
  await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  // Only the test-owned directory created above is removed. User profiles and
  // the production unpacked extension are never modified.
  await rm(temporary, { recursive: true, force: true });
}
