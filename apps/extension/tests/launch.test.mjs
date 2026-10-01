import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { setImmediate as nextTurn } from "node:timers/promises";
import { readCurrentYouTubeCaptionTrack, captionTrackToTranscript } from "../src/youtube-captions.js";
import { createFreshCaptionReader } from "../src/fresh-captions.js";

const code = readFileSync(new URL("../src/background.js", import.meta.url), "utf8")
  .replace('import { installReferenceCapture } from "./reference-capture.js";', "")
  .replace('import { installBufferedCapture } from "./buffer-capture.js";', "")
  .replace('import { readCurrentYouTubeCaptionTrack, captionTrackToTranscript } from "./youtube-captions.js";', "")
  .replace('import { createFreshCaptionReader } from "./fresh-captions.js";', "");
const video = { id: 1, windowId: 1, url: "https://www.youtube.com/watch?v=first-video" };
const snapshot = { supported: true, videoId: "first-video", title: "First video", canonicalUrl: video.url };

function harness() {
  const listeners = {};
  const records = {};
  const tabs = new Map([[1, video]]);
  const calls = [];
  const event = (name) => ({ addListener: (handler) => { listeners[name] = handler; } });
  const state = {
    metadata: snapshot,
    captions: Promise.resolve({ ...snapshot, transcriptText: "0:01\tBrowser captions." }),
    captionTrack: Promise.resolve({ unavailable: true }),
    captionPreparation: { status: "automatic_track_unavailable" },
    language: { languageCode: "en", source: "automatic-caption" },
    quickTimeout: false,
    failReceiver: false
  };
  const chrome = {
    runtime: {
      id: "test-extension",
      onMessage: event("message"),
      getURL: (path) => `chrome-extension://test/${path}`
    },
    action: {
      onClicked: event("click"),
      setBadgeText: (value) => calls.push(["badge", value]),
      setTitle: (value) => calls.push(["title", value])
    },
    scripting: {
      executeScript: async (options) => {
        if (options.files) {
          calls.push(["inject"]);
          return [];
        }
        if (options.func === readCurrentYouTubeCaptionTrack) {
          calls.push(["json3", options.args]);
          return [{ result: await state.captionTrack }];
        }
        if (options.func?.name === "prepareYouTubeCaptions") {
          calls.push(["prepare", options.args]);
          return [{ result: state.captionPreparation }];
        }
        if (options.func?.name === "restoreYouTubeCaptions") {
          calls.push(["restore", options.args]);
          return [{ result: { status: "restored" } }];
        }
        calls.push(["language", options.args?.[0]]);
        return [{ result: structuredClone(state.language) }];
      }
    },
    storage: { session: {
      get: async (key) => structuredClone(key === null ? records : { [key]: records[key] }),
      set: async (values) => { Object.assign(records, structuredClone(values)); },
      remove: async (key) => { delete records[key]; }
    } },
    tabs: {
      onUpdated: event("updated"),
      query: async () => [...tabs.values()].filter((tab) => tab.url.startsWith("https://www.youtube.com/watch")),
      get: async (id) => { if (!tabs.has(id)) throw new Error("Closed tab"); return tabs.get(id); },
      update: async (id) => { calls.push(["focus", id]); return tabs.get(id); },
      create: async ({ url }) => {
        const tab = { id: tabs.size + 1, windowId: 1, url };
        tabs.set(tab.id, tab);
        calls.push(["open", url]);
        return tab;
      },
      sendMessage: async (_id, message) => {
        calls.push([message.type]);
        if (state.failReceiver) { state.failReceiver = false; throw new Error("No receiver"); }
        return message.type === "LIBITU_GET_YOUTUBE_METADATA" ? state.metadata : state.captions;
      }
    }
  };
  const restart = () => runInNewContext(code, {
    chrome, URL, URLSearchParams, crypto, clearTimeout,
    setTimeout: (callback, delay) => setTimeout(callback, state.quickTimeout ? Math.min(delay, 5) : delay),
    readCurrentYouTubeCaptionTrack, captionTrackToTranscript,
    createFreshCaptionReader,
    installReferenceCapture: () => ({ handlesTab: () => false }),
    installBufferedCapture: () => ({ handlesTab: () => false })
  });
  restart();
  const dispatch = (message, sender = { tab: video, frameId: 0, url: video.url }) => new Promise((resolve) => {
    if (!listeners.message(message, sender, resolve)) resolve(undefined);
  });
  return { state, calls, tabs, records, listeners, dispatch, restart };
}

test("both entry points wait for bounded caption capture before opening Stage 1", async () => {
  const h = harness();
  let finishCaptions;
  h.state.captions = new Promise((resolve) => { finishCaptions = resolve; });
  const opening = h.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" });
  await nextTurn();
  assert.equal(h.calls.some(([type]) => type === "open"), false);
  finishCaptions({ ...snapshot, transcriptText: "0:01\tCaptured before the page opened." });
  const opened = await opening;
  assert.equal(opened.opened, true);
  await nextTurn();
  assert.ok(h.calls.findIndex(([type]) => type === "LIBITU_GET_YOUTUBE_SNAPSHOT") < h.calls.findIndex(([type]) => type === "open"));
  const stage = h.tabs.get(2);
  const url = new URL(stage.url);
  assert.equal(url.searchParams.get("sourceUrl"), video.url);
  assert.equal(url.searchParams.get("language"), "en");
  assert.equal(url.searchParams.has("transcriptText"), false);
  assert.equal(url.searchParams.has("contentId"), false);
  const handoffId = url.searchParams.get("handoffId");
  const reading = h.dispatch({ type: "LIBITU_READ_HANDOFF", handoffId }, { tab: stage, frameId: 0, url: stage.url });
  assert.equal((await reading).transcriptText, "0:01\tCaptured before the page opened.");
  h.listeners.click(video);
  await nextTurn();
  assert.equal(h.calls.filter(([type]) => type === "open").length, 1);
  assert.equal(h.calls.filter(([type]) => type === "focus").length, 1);
});

test("rapid clicks share one launch and missing receivers are injected once", async () => {
  const h = harness();
  h.state.failReceiver = true;
  await Promise.all([h.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" }), h.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" })]);
  assert.equal(h.calls.filter(([type]) => type === "open").length, 1);
  assert.equal(h.calls.filter(([type]) => type === "inject").length, 1);
});

test("unsupported URLs and mismatched video DOM never open Stage 1", async () => {
  const h = harness();
  h.listeners.click({ ...video, url: "https://www.youtube.com/" });
  await nextTurn();
  assert.equal(h.calls[0][0], "badge");
  h.state.metadata = { ...snapshot, videoId: "previous-video" };
  assert.match((await h.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" })).error, /still loading/);
  assert.equal(h.calls.some(([type]) => type === "open"), false);
});

test("non-English and unknown videos stay out of Stage 1 and explain the English-only limit", async () => {
  const nonEnglish = harness();
  nonEnglish.state.language = { languageCode: "zh-Hans", source: "default-caption" };
  const support = await nonEnglish.dispatch({ type: "LIBITU_GET_VIDEO_LANGUAGE_SUPPORT", videoId: "first-video" });
  assert.deepEqual(JSON.parse(JSON.stringify(support)), {
    supported: false,
    status: "unsupported",
    languageCode: "zh-hans",
    reason: "Libitu currently supports English videos only."
  });
  nonEnglish.listeners.click(video);
  await nextTurn();
  assert.equal(nonEnglish.calls.some(([type]) => type === "open"), false);
  assert.equal(nonEnglish.calls.some(([type]) => type === "badge"), true);
  assert.match(nonEnglish.calls.find(([type]) => type === "title")[1].title, /English videos only/);
  assert.equal(nonEnglish.calls.some(([type]) => type === "LIBITU_SHOW_ERROR"), true);

  const unknown = harness();
  unknown.state.language = undefined;
  const result = await unknown.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" });
  assert.match(result.error, /could not verify.*English/i);
  assert.equal(unknown.calls.some(([type]) => type === "open"), false);
});

test("handoffs survive worker restart and reject unrelated origins and videos", async () => {
  const h = harness();
  await h.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" });
  await nextTurn();
  const stage = h.tabs.get(2);
  const handoffId = new URL(stage.url).searchParams.get("handoffId");
  h.restart();
  const sender = { tab: stage, frameId: 0, url: stage.url };
  assert.equal((await h.dispatch({ type: "LIBITU_READ_HANDOFF", handoffId }, sender)).transcriptText, "0:01\tBrowser captions.");
  assert.ok((await h.dispatch({ type: "LIBITU_READ_HANDOFF", handoffId }, { ...sender, url: stage.url.replace("localhost", "example.com") })).error);
  assert.ok((await h.dispatch({ type: "LIBITU_READ_HANDOFF", handoffId }, { ...sender, url: stage.url.replace("first-video", "wrong-video") })).error);
  assert.equal(h.calls.filter(([type]) => type === "LIBITU_GET_YOUTUBE_SNAPSHOT").length, 1);
});

test("missing or wrong-video captions fall back without attaching unrelated text", async () => {
  const h = harness();
  h.state.captions = Promise.resolve({ ...snapshot, videoId: "other-video", transcriptText: "Wrong captions" });
  await h.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" });
  const stage = h.tabs.get(2);
  const handoffId = new URL(stage.url).searchParams.get("handoffId");
  assert.equal((await h.dispatch({ type: "LIBITU_READ_HANDOFF", handoffId }, { tab: stage, frameId: 0, url: stage.url })).transcriptText, undefined);
});

const json3Track = {
  version: "youtube-json3-v1", video_id: "first-video", language: "en", kind: "asr",
  events: [{ tStartMs: 1040, dDurationMs: 850, segs: [{ utf8: "A" }, { utf8: " caption.", tOffsetMs: 120 }] }]
};

test("JSON3 acquisition completes before opening Stage 1, persists safe timing, and skips DOM capture", async () => {
  const h = harness();
  let finish;
  h.state.captionTrack = new Promise((resolve) => { finish = resolve; });
  const opening = h.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" });
  await nextTurn();
  assert.equal(h.calls.some(([type]) => type === "open"), false);
  finish({ captionTrack: structuredClone(json3Track) });
  assert.equal((await opening).opened, true);
  assert.ok(h.calls.findIndex(([type]) => type === "json3") < h.calls.findIndex(([type]) => type === "open"));
  const stage = h.tabs.get(2);
  const handoffId = new URL(stage.url).searchParams.get("handoffId");
  const reading = h.dispatch({ type: "LIBITU_READ_HANDOFF", handoffId }, { tab: stage, frameId: 0, url: stage.url });
  const result = await reading;
  assert.equal(result.transcriptText, "0:01.040\tA caption.");
  assert.deepEqual(result.captionTrack, json3Track);
  assert.equal(h.calls.some(([type]) => type === "LIBITU_GET_YOUTUBE_SNAPSHOT"), false);
  assert.equal(stage.url.includes("caption"), false);
  assert.deepEqual(h.records[`libituHandoff:${handoffId}`].captionTrack, json3Track);
  h.restart();
  assert.deepEqual((await h.dispatch({ type: "LIBITU_READ_HANDOFF", handoffId }, { tab: stage, frameId: 0, url: stage.url })).captionTrack, json3Track);
  assert.equal(h.calls.filter(([type]) => type === "json3").length, 1);
});

test("automatic caption preparation is best-effort and restores a captions-off player", async () => {
  const h = harness();
  h.state.captionPreparation = { status: "enabled_auto", changed: true };
  let finish;
  h.state.captionTrack = new Promise((resolve) => { finish = resolve; });
  const opening = h.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" });
  await nextTurn();
  assert.ok(h.calls.some(([type]) => type === "prepare"));
  finish({ captionTrack: structuredClone(json3Track) });
  assert.equal((await opening).opened, true);
  assert.ok(h.calls.findIndex(([type]) => type === "restore") < h.calls.findIndex(([type]) => type === "open"));
});

test("block-only JSON3 remains usable without a DOM wait or invented offsets", async () => {
  const h = harness();
  const track = { ...json3Track, kind: "manual", events: [{ tStartMs: 40, segs: [{ utf8: "A whole caption block." }] }] };
  h.state.captionTrack = Promise.resolve({ captionTrack: track });
  await h.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" });
  const stage = h.tabs.get(2);
  const handoffId = new URL(stage.url).searchParams.get("handoffId");
  const result = await h.dispatch({ type: "LIBITU_READ_HANDOFF", handoffId }, { tab: stage, frameId: 0, url: stage.url });
  assert.equal(result.transcriptText, "0:00.040\tA whole caption block.");
  assert.equal(result.captionTrack.events[0].segs[0].tOffsetMs, undefined);
  assert.equal(h.calls.some(([type]) => type === "LIBITU_GET_YOUTUBE_SNAPSHOT"), false);
});

test("old JSON3 captures cannot attach after A to B to A navigation", async () => {
  const h = harness();
  let finish;
  h.state.captionTrack = new Promise((resolve) => { finish = resolve; });
  const opening = h.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" });
  await nextTurn();
  h.listeners.updated(1, { url: "https://www.youtube.com/watch?v=second-video" });
  h.listeners.updated(1, { url: video.url });
  finish({ captionTrack: json3Track });
  const result = await opening;
  assert.match(result.error, /changed while captions were loading/);
  assert.equal(h.calls.some(([type]) => type === "open"), false);
  assert.equal(h.calls.some(([type]) => type === "LIBITU_GET_YOUTUBE_SNAPSHOT"), false);
});

test("navigation detected in the injected page never falls through to a new video's DOM", async () => {
  const h = harness();
  h.state.captionTrack = Promise.resolve({ stale: true });
  await h.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" });
  const stage = h.tabs.get(2);
  const handoffId = new URL(stage.url).searchParams.get("handoffId");
  assert.equal((await h.dispatch({ type: "LIBITU_READ_HANDOFF", handoffId }, { tab: stage, frameId: 0, url: stage.url })).transcriptText, undefined);
  assert.equal(h.calls.some(([type]) => type === "LIBITU_GET_YOUTUBE_SNAPSHOT"), false);
});

test("an unresponsive page-injection request has an outer bound and falls back to DOM", async () => {
  const h = harness();
  h.state.quickTimeout = true;
  h.state.captionTrack = new Promise(() => {});
  await h.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" });
  const stage = h.tabs.get(2);
  const handoffId = new URL(stage.url).searchParams.get("handoffId");
  const result = await h.dispatch({ type: "LIBITU_READ_HANDOFF", handoffId }, { tab: stage, frameId: 0, url: stage.url });
  assert.equal(result.transcriptText, "0:01\tBrowser captions.");
  assert.equal(result.captionTrack, undefined);
  assert.equal(h.calls.filter(([type]) => type === "json3").length, 2);
  assert.equal(h.calls.filter(([type]) => type === "LIBITU_GET_YOUTUBE_SNAPSHOT").length, 1);
});

test("fresh caption requests bypass old ready handoffs and duplicate-entry focus without rewriting either", async () => {
  const h = harness();
  await h.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" });
  await nextTurn();
  const stage = h.tabs.get(2);
  const handoffId = new URL(stage.url).searchParams.get("handoffId");
  const sender = { tab: stage, url: stage.url, frameId: 0, documentId: "stage-document", id: "test-extension" };
  assert.equal((await h.dispatch({ type: "LIBITU_READ_HANDOFF", handoffId }, sender)).captionTrack, undefined);
  const originalRecords = structuredClone(h.records);
  await h.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" });
  assert.equal(h.calls.filter(([type]) => type === "focus").length, 1);
  h.state.captionTrack = Promise.resolve({ captionTrack: json3Track });
  const result = await h.dispatch({ type: "LIBITU_READ_FRESH_CAPTIONS", requestId: "fresh-one",
    sourceUrl: video.url, videoId: "first-video", language: "en" }, sender);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.captionTrack, json3Track);
  assert.deepEqual(h.records, originalRecords);
  assert.equal(h.calls.filter(([type]) => type === "open").length, 1);
  assert.equal(h.calls.filter(([type]) => type === "LIBITU_GET_YOUTUBE_SNAPSHOT").length, 1);
  assert.equal(h.calls.filter(([type]) => type === "json3").length, 2);
});
