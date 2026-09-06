import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { setImmediate as nextTurn } from "node:timers/promises";

const code = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
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
    language: { languageCode: "en", source: "automatic-caption" },
    failReceiver: false
  };
  const chrome = {
    runtime: {
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
  const restart = () => runInNewContext(code, { chrome, URL, URLSearchParams, crypto, setTimeout, clearTimeout });
  restart();
  const dispatch = (message, sender = { tab: video, frameId: 0, url: video.url }) => new Promise((resolve) => {
    if (!listeners.message(message, sender, resolve)) resolve(undefined);
  });
  return { state, calls, tabs, records, listeners, dispatch, restart };
}

test("both entry points open Stage 1 before captions finish, with no API dependency", async () => {
  const h = harness();
  let finishCaptions;
  h.state.captions = new Promise((resolve) => { finishCaptions = resolve; });
  const opened = await h.dispatch({ type: "LIBITU_OPEN_STAGE_ONE" });
  assert.equal(opened.opened, true);
  assert.ok(h.calls.findIndex(([type]) => type === "open") < h.calls.findIndex(([type]) => type === "LIBITU_GET_YOUTUBE_SNAPSHOT"));
  const stage = h.tabs.get(2);
  const url = new URL(stage.url);
  assert.equal(url.searchParams.get("sourceUrl"), video.url);
  assert.equal(url.searchParams.get("language"), "en");
  assert.equal(url.searchParams.has("transcriptText"), false);
  assert.equal(url.searchParams.has("contentId"), false);
  const handoffId = url.searchParams.get("handoffId");
  const reading = h.dispatch({ type: "LIBITU_READ_HANDOFF", handoffId }, { tab: stage, frameId: 0, url: stage.url });
  finishCaptions({ ...snapshot, transcriptText: "0:01\tCaptured after the page opened." });
  assert.equal((await reading).transcriptText, "0:01\tCaptured after the page opened.");
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
