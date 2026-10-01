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
const errors = [];
const counts = { resolve: 0, jobs: 0, reads: 0, blueprint: 0 };
let resolveRoute;
let resolveBody;
const job = { id: "entry-job", content_id: "entry-content", status: "processing", processing_stage: "analyzing", analysis_preview: null };
const blueprint = {
  id: "entry-blueprint", content_id: job.content_id, title: "First video", source_url: "https://www.youtube.com/watch?v=first-video",
  summary: "A discussion of useful ideas.", chapters: [], logic_flow: [], corpus_items: [],
  transcript: [{ time: "0:01", parts: ["First video captions."] }]
};
const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };

try {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "chrome-extension:") return route.continue();
    if (url.pathname.startsWith("/api/")) {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (url.pathname === "/api/content/resolve") {
        counts.resolve += 1;
        resolveBody = route.request().postDataJSON();
        resolveRoute = route;
        return;
      }
      if (url.pathname === "/api/jobs") { counts.jobs += 1; job.status = "processing"; return route.fulfill({ json: job, headers }); }
      if (url.pathname === "/api/jobs/entry-job") { counts.reads += 1; return route.fulfill({ json: job, headers }); }
      if (url.pathname === "/api/blueprints/entry-content") { counts.blueprint += 1; return route.fulfill({ json: blueprint, headers }); }
      throw new Error(`Unexpected API request: ${url.pathname}`);
    }
    if (url.origin === origin || url.hostname.endsWith(".clerk.accounts.dev")) return route.continue();
    if (url.origin === "https://www.youtube.com" && url.pathname === "/") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><title>YouTube fixture</title>
        <style>body{font:16px Arial;margin:24px;background:#fff;color:#171717}#movie_player{position:relative;width:100%;aspect-ratio:16/9;background:#222}h1{font-size:22px}ytd-watch-flexy{display:block;max-width:900px}video{width:100%}.ytp-chrome-controls{position:absolute;right:0;bottom:0;left:0;height:48px;background:rgba(0,0,0,.72)}.ytp-right-controls{display:flex;float:right;height:100%}.ytp-button{width:48px;border:0;background:transparent;color:#fff}</style>
        </head><body><h2>YouTube fixture</h2><main></main></body></html>` });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: "" });
  });
  await context.addInitScript(() => {
    if (location.origin !== "http://localhost:3000") return;
    window.__streams = [];
    window.EventSource = class extends EventTarget {
      constructor() { super(); window.__streams.push(this); }
      close() {}
    };
    window.YT = { Player: class {
      constructor(_element, { events }) { queueMicrotask(() => events.onReady()); }
      getCurrentTime() { return 0; }
      seekTo() {}
      playVideo() {}
      destroy() {}
    } };
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
  const startedAt = Date.now();
  const opened = context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
  await button.click();
  await youtube.evaluate(() => {
    const segment = document.createElement("ytd-transcript-segment-renderer");
    segment.innerHTML = '<span class="segment-timestamp">0:01</span><span class="segment-text">First video captions.</span>';
    document.querySelector("ytd-watch-flexy").append(segment);
  });
  const openedPage = await opened;
  const stage = openedPage ?? context.pages().find((page) => page.url().startsWith(origin));
  assert.ok(stage, `Stage 1 did not open: ${await youtube.locator("#libitu-youtube-entry").evaluate((host) => host.shadowRoot.querySelector("p").textContent)}`);
  await stage.locator(".youtube-player iframe").waitFor();
  await stage.getByText("Reading captions from YouTube.", { exact: true }).waitFor();
  const firstViewMs = Date.now() - startedAt;
  console.log(JSON.stringify({ firstViewMs, phase: "video visible after bounded caption preflight" }));
  assert.equal(counts.resolve, 0, "Stage 1 must render before content resolve/API work");
  const iframe = await stage.locator(".youtube-player iframe").elementHandle();
  await stage.waitForFunction(() => document.querySelector(".youtube-player iframe"));
  const resolveDeadline = Date.now() + 10_000;
  while (!resolveRoute && Date.now() < resolveDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(resolveRoute, "Stage 1 must submit the captured transcript");
  assert.equal(resolveBody.transcript_text, "0:01\tFirst video captions.");
  assert.equal(resolveBody.title, "First video");
  assert.equal(resolveBody.language, "en");
  await stage.screenshot({ path: "/tmp/libitu-stage-one-handoff-desktop.png", fullPage: true, animations: "disabled" });
  const pagesBefore = context.pages().length;
  await button.click();
  assert.equal(context.pages().length, pagesBefore);
  await resolveRoute.fulfill({ json: { content_id: job.content_id, source_url: blueprint.source_url, title: blueprint.title }, headers });
  await stage.waitForFunction(() => window.__streams.length === 1);
  assert.equal(new URL(stage.url()).searchParams.has("handoffId"), false);
  assert.equal(new URL(stage.url()).searchParams.get("jobId"), job.id);
  job.status = "failed";
  await stage.evaluate((failedJob) => {
    window.__streams[0].dispatchEvent(Object.assign(new Event("job"), { data: JSON.stringify(failedJob) }));
  }, { ...job, error_code: "analysis_failed", error_message: "Analysis temporarily unavailable." });
  await stage.getByRole("button", { name: "Retry", exact: true }).click();
  await stage.waitForFunction(() => window.__streams.length === 2);
  assert.deepEqual(counts, { resolve: 1, jobs: 2, reads: 1, blueprint: 0 });
  await stage.evaluate((readyJob) => {
    window.__streams[1].dispatchEvent(Object.assign(new Event("job"), { data: JSON.stringify(readyJob) }));
  }, { ...job, status: "ready" });
  await stage.locator(".transcript-line").waitFor();
  assert.equal(await iframe.evaluate((element) => element.isConnected), true);
  assert.deepEqual(counts, { resolve: 1, jobs: 2, reads: 1, blueprint: 1 });
  job.status = "ready";
  await stage.reload();
  await stage.locator(".transcript-line").waitFor();
  assert.deepEqual(counts, { resolve: 1, jobs: 2, reads: 2, blueprint: 2 });

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
  await youtube.waitForFunction(() => document.querySelector("#libitu-youtube-entry")?.shadowRoot?.querySelector("button")?.disabled);
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
  assert.equal(counts.resolve, 1);

  await stage.setViewportSize({ width: 390, height: 844 });
  await stage.screenshot({ path: "/tmp/libitu-stage-one-entry-mobile.png", fullPage: true });
  assert.equal(await stage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ firstViewMs, counts, checks: "real unpacked extension, English-only gate, SPA entry, pending captions/API, deduplication, handoff, retry, refresh, mobile" }));
} catch (error) {
  for (const page of context.pages()) {
    console.error(JSON.stringify({ url: page.url(), entryStatus: await page.locator("#libitu-youtube-entry p").allTextContents(), status: await page.locator(".stage-status").allTextContents(), counts }));
  }
  throw error;
} finally {
  await context.close();
}
