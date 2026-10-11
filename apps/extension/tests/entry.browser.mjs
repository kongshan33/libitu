import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const extensionPath = fileURLToPath(new URL("..", import.meta.url));
const origin = "http://localhost:3000";
const context = await chromium.launchPersistentContext("", {
  headless: true,
  ...(process.env.LIBITU_CHROMIUM_PATH ? { executablePath: process.env.LIBITU_CHROMIUM_PATH } : { channel: "chromium" }),
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  viewport: { width: 1440, height: 1000 }
});
context.setDefaultTimeout(30_000);
const errors = [];
let step = "launch";
const contentId = "a0000000-0000-4000-8000-000000000001";

try {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "chrome-extension:") return route.continue();
    if (url.origin === "http://localhost:8000" || (url.origin === origin && url.pathname.startsWith("/api/"))) return route.abort();
    if (url.origin === origin && route.request().resourceType() !== "document") return route.fulfill({ contentType: "application/javascript", body: "/* fixture asset */" });
    if (url.origin === origin) return route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <title>Import handoff fixture</title><p>Waiting for captions</p><script>
      const handoffId=new URL(location.href).searchParams.get('handoffId');
      const requestId=crypto.randomUUID();
      addEventListener('message', event=>{
        if(event.source!==window||event.origin!==location.origin||event.data?.type!=='LIBITU_HANDOFF_RESPONSE'
          ||event.data.version!==4||event.data.requestId!==requestId||event.data.handoffId!==handoffId)return;
        if(event.data.phase==='ready'){window.handoff=event.data;document.querySelector('p').textContent=event.data.transcriptText;}
      });
      window.requestCaptions=()=>postMessage({type:'LIBITU_HANDOFF_REQUEST',version:4,requestId,handoffId},location.origin);
      </script>` });
    if (url.origin === "https://www.youtube.com" && url.pathname === "/api/timedtext") {
      return route.fulfill({ json: { events: [{ tStartMs: 1000, dDurationMs: 1500,
        segs: [{ utf8: "First video captions.", tOffsetMs: 0 }] }] } });
    }
    if (url.origin === "https://www.youtube.com" && url.pathname === "/") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><title>YouTube fixture</title>
        <style>body{font:16px Arial;margin:24px;background:#fff;color:#171717}#movie_player{position:relative;width:100%;aspect-ratio:16/9;background:#222}h1{font-size:22px}ytd-watch-flexy{display:block;max-width:900px}video{width:100%}.ytp-chrome-controls{position:absolute;right:0;bottom:0;left:0;height:48px;background:rgba(0,0,0,.72)}.ytp-right-controls{display:flex;float:right;height:100%}.ytp-button{width:48px;border:0;background:transparent;color:#fff}</style>
        </head><body><h2>YouTube fixture</h2><main></main></body></html>` });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: "" });
  });
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const youtube = await context.newPage();
  await youtube.goto("https://www.youtube.com/");
  assert.equal(await youtube.locator("#libitu-youtube-entry").count(), 0);
  await youtube.evaluate(() => {
    document.dispatchEvent(new Event("yt-navigate-start"));
    history.pushState({}, "", "/watch?v=first-video");
    window.ytInitialPlayerResponse = {
      videoDetails: { videoId: "first-video" },
      captions: { playerCaptionsTracklistRenderer: {
        captionTracks: [{ languageCode: "en", kind: "asr", vssId: "a.en" }],
        audioTracks: [{ captionTrackIndices: [0], defaultCaptionTrackIndex: 0, hasDefaultTrack: true }]
      } }
    };
    document.querySelector("main").innerHTML = `<ytd-watch-flexy video-id="first-video"><div id="movie_player"><video></video><div class="ytp-chrome-controls"><div class="ytp-right-controls"><div class="ytp-right-controls-left"><button class="ytp-button ytp-subtitles-button">CC</button><button class="ytp-button ytp-settings-button">Settings</button></div><div class="ytp-right-controls-right"><button class="ytp-button ytp-fullscreen-button">Full screen</button></div></div></div></div>
      <ytd-watch-metadata><div id="title"><h1>First video</h1></div></ytd-watch-metadata>
      <ytd-video-description-transcript-section-renderer><button>Show transcript</button></ytd-video-description-transcript-section-renderer>
      </ytd-watch-flexy>`;
    document.dispatchEvent(new Event("yt-navigate-finish"));
  });
  const button = youtube.getByRole("button", { name: "Open in Libitu", exact: true });
  await button.waitFor();
  await youtube.locator("#libitu-youtube-entry").evaluate(async (host) => host.shadowRoot.querySelector("img").decode());
  assert.equal(await youtube.locator(".ytp-right-controls-left > #libitu-youtube-entry").count(), 1);
  assert.equal(await youtube.locator(".ytp-right-controls-left > :first-child").getAttribute("id"), "libitu-youtube-entry");
  assert.deepEqual(await youtube.locator("#libitu-youtube-entry").evaluate((host) => {
    const button = host.shadowRoot.querySelector("button");
    const image = host.shadowRoot.querySelector("img");
    return { width: host.getBoundingClientRect().width, height: host.getBoundingClientRect().height,
      buttonWidth: button.getBoundingClientRect().width, imageWidth: image.getBoundingClientRect().width };
  }), { width: 48, height: 48, buttonWidth: 48, imageWidth: 30 });
  await youtube.screenshot({ path: "/tmp/libitu-youtube-entry-desktop.png", fullPage: true });
  await youtube.evaluate(async () => { await fetch("/api/timedtext?v=first-video&lang=en&fmt=json3").then(response => response.json()); });
  await youtube.waitForFunction(() => globalThis.__libituCaptionObserverV1?.read("first-video", "en").status === "ready");
  const startedAt = Date.now();
  const opened = context.waitForEvent("page", { timeout: 45_000 }).catch(() => null);
  await button.click();
  await youtube.evaluate(() => {
    const segment = document.createElement("ytd-transcript-segment-renderer");
    segment.innerHTML = '<span class="segment-timestamp">0:01</span><span class="segment-text">First video captions.</span>';
    document.querySelector("ytd-watch-flexy").append(segment);
  });
  const openedPage = await opened;
  const stage = openedPage ?? context.pages().find((page) => page.url().startsWith(origin));
  assert.ok(stage, `Stage 1 did not open: ${await youtube.locator("#libitu-youtube-entry").evaluate((host) => host.shadowRoot.querySelector("p").textContent)}`);
  assert.equal(new URL(stage.url()).pathname, "/practice/import");
  assert.equal(new URL(stage.url()).searchParams.get("sourceUrl"), "https://www.youtube.com/watch?v=first-video");
  // Chrome-created tabs can start navigation before Playwright attaches its
  // routes. Reload the captured address into the deterministic Web consumer.
  await stage.reload();
  await stage.waitForFunction(() => typeof window.requestCaptions === "function");
  await stage.evaluate(() => window.requestCaptions());
  await stage.waitForFunction(() => window.handoff?.phase === "ready");
  assert.equal(await stage.evaluate(() => window.handoff.transcriptText), "0:01.000\tFirst video captions.");
  const firstViewMs = Date.now() - startedAt;
  step = "reuse pending import";
  const pagesBefore = context.pages().length;
  await button.click();
  await youtube.waitForFunction(() => document.querySelector("#libitu-youtube-entry")?.shadowRoot.querySelector("button").dataset.state !== "capturing");
  assert.equal(context.pages().length, pagesBefore, "pending import is reused");
  // Simulate the Web's completed import; real Web resolve/retry is separately
  // exercised by canonical-routes and content-workspace browser tests.
  step = "reuse canonical content";
  await stage.evaluate(id => history.replaceState(null, "", `/practice/${id}`), contentId);
  await worker.evaluate(async ({ id, videoId }) => {
    const tab = (await chrome.tabs.query({ url: "http://localhost:3000/*" }))[0];
    await chrome.storage.session.set({ [`libituContentTab:${tab.id}`]: { contentId: id, videoId, documentId: "fixture" } });
  }, { id: contentId, videoId: "first-video" });
  await button.click();
  await youtube.waitForFunction(() => document.querySelector("#libitu-youtube-entry")?.shadowRoot.querySelector("button").dataset.state !== "capturing");
  assert.equal(context.pages().length, pagesBefore, "resolved content is reused after handoff removal");

  step = "SPA source change";
  // A YouTube SPA change removes the entry until the new player identity matches.
  await youtube.evaluate(() => {
    document.dispatchEvent(new Event("yt-navigate-start"));
    history.pushState({}, "", "/watch?v=second-video");
    document.dispatchEvent(new Event("yt-navigate-finish"));
  });
  await button.waitFor({ state: "detached" });
  await youtube.evaluate(() => {
    document.querySelector("ytd-watch-flexy").setAttribute("video-id", "second-video");
    document.querySelector("h1").textContent = "Second video";
    window.ytInitialPlayerResponse = {
      videoDetails: { videoId: "second-video" },
      captions: { playerCaptionsTracklistRenderer: {
        captionTracks: [{ languageCode: "en-GB", vssId: ".en-GB" }],
        audioTracks: [{ captionTrackIndices: [0], defaultCaptionTrackIndex: 0, hasDefaultTrack: true }]
      } }
    };
  });
  await button.waitFor();
  assert.equal(await youtube.locator("#libitu-youtube-entry").count(), 1);
  await youtube.evaluate(() => {
    const controls = document.querySelector(".ytp-right-controls-left");
    const replacement = document.createElement("div");
    replacement.className = "ytp-right-controls-left";
    replacement.innerHTML = '<button class="ytp-button ytp-subtitles-button">CC</button><button class="ytp-button ytp-settings-button">Settings</button>';
    controls.replaceWith(replacement);
  });
  await button.waitFor();
  assert.equal(await youtube.locator(".ytp-right-controls-left > #libitu-youtube-entry").count(), 1);
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: "https://www.youtube.com/*" }))[0].id);
  const metadata = await worker.evaluate(async (id) => chrome.tabs.sendMessage(id, { type: "LIBITU_GET_YOUTUBE_METADATA" }), tabId);
  assert.equal(metadata.videoId, "second-video");
  assert.equal(metadata.title, "Second video");
  step = "stale snapshot";
  const capturing = worker.evaluate(async (id) => chrome.tabs.sendMessage(id, { type: "LIBITU_GET_YOUTUBE_SNAPSHOT", videoId: "second-video" }), tabId);
  await youtube.evaluate(() => {
    document.dispatchEvent(new Event("yt-navigate-start"));
    history.pushState({}, "", "/watch?v=chinese-video");
    document.querySelector("ytd-watch-flexy").setAttribute("video-id", "chinese-video");
    document.querySelector("h1").textContent = "Chinese video";
    window.ytInitialPlayerResponse = {
      videoDetails: { videoId: "chinese-video" },
      captions: { playerCaptionsTracklistRenderer: {
        captionTracks: [{ languageCode: "zh-Hans", vssId: ".zh-Hans" }],
        audioTracks: [{ captionTrackIndices: [0], defaultCaptionTrackIndex: 0, hasDefaultTrack: true }]
      } }
    };
    document.dispatchEvent(new Event("yt-navigate-finish"));
  });
  assert.equal((await capturing).supported, false);
  const disabledButton = youtube.locator("#libitu-youtube-entry button");
  await disabledButton.waitFor();
  await disabledButton.waitFor({ state: "visible" });
  await youtube.waitForFunction(() => {
    const button = document.querySelector("#libitu-youtube-entry")?.shadowRoot?.querySelector("button");
    return button?.disabled && button.title.includes("English videos only");
  });
  assert.match(await disabledButton.getAttribute("title"), /English videos only/);
  const languageHint = youtube.locator("#libitu-youtube-entry p");
  assert.match(await languageHint.textContent(), /English videos only/);
  await youtube.locator("#libitu-youtube-entry").hover();
  await languageHint.waitFor({ state: "visible" });
  await youtube.screenshot({ path: "/tmp/libitu-youtube-entry-non-english.png", fullPage: true });
  assert.equal(context.pages().length, pagesBefore);

  await youtube.evaluate(() => {
    document.dispatchEvent(new Event("yt-navigate-start"));
    history.pushState({}, "", "/");
    document.dispatchEvent(new Event("yt-navigate-finish"));
  });
  await button.waitFor({ state: "detached" });

  await stage.setViewportSize({ width: 390, height: 844 });
  await stage.screenshot({ path: "/tmp/libitu-stage-one-entry-mobile.png", fullPage: true });
  assert.equal(await stage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ firstViewMs, checks: "real unpacked extension, English-only gate, SPA entry, v4 import handoff, canonical tab reuse, mobile" }));
} catch (error) {
  console.error("Failed step:", step);
  for (const page of context.pages()) {
    console.error(JSON.stringify({ url: page.url(), entryStatus: await page.locator("#libitu-youtube-entry p").allTextContents(), buttons: await page.locator("#libitu-youtube-entry button").evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute("aria-label"), title: node.title }))), status: await page.locator(".stage-status").allTextContents() }));
  }
  throw error;
} finally {
  await context.close();
}
