import { installBufferedCapture } from "./buffer-capture.js";
import { readCurrentYouTubeCaptionTrack, captionTrackToTranscript } from "./youtube-captions.js";
import { createFreshCaptionReader } from "./fresh-captions.js";

const bufferedCapture = installBufferedCapture(chrome);
const freshCaptions = createFreshCaptionReader(chrome);
const WEB_BASE_URL = "http://localhost:3000";
const HANDOFF_PREFIX = "libituHandoff:";
const HANDOFF_TTL_MS = 15 * 60 * 1000;
const CAPTION_OBSERVER_WAIT_MS = 6_000;
const SUPPORTED_LANGUAGE_BASES = new Set(["en"]);
const ENGLISH_ONLY_MESSAGE = "Libitu currently supports English videos only.";
const UNKNOWN_LANGUAGE_MESSAGE = "Libitu could not verify that this video is in English.";
const launches = new Map();
const captures = new Map();
const languageChecks = new Map();
const navigationVersions = new Map();

chrome.action.onClicked.addListener((tab) => {
  if (bufferedCapture.handlesTab(tab)) {
    void bufferedCapture.onToolbarClick(tab);
    return;
  }
  if (!videoIdFromUrl(tab.url)) {
    reportError(tab, "Open a YouTube video to start Libitu.");
    return;
  }
  launch(tab).catch((error) => reportError(tab, error.message));
});

chrome.tabs.onRemoved.addListener((tabId) => { void chrome.storage.session.remove(`libituContentTab:${tabId}`); });

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  freshCaptions.onTabUpdated(tabId, changeInfo);
  if (!changeInfo.url) return;
  const navigation = navigationVersions.get(tabId);
  if (navigation) navigation.version += 1;
  for (const key of languageChecks.keys()) {
    if (key.startsWith(`${tabId}:`)) languageChecks.delete(key);
  }
  if (bufferedCapture.handlesTab({ id: tabId, url: changeInfo.url })) return;
  chrome.action.setBadgeText({ tabId, text: "" });
  chrome.action.setTitle({ tabId, title: "Open Libitu" });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let work;
  if (message?.type === "LIBITU_OPEN_STAGE_ONE" && videoIdFromUrl(sender.tab?.url) && sender.frameId === 0) {
    work = launch(sender.tab);
  } else if (message?.type === "LIBITU_GET_VIDEO_LANGUAGE_SUPPORT" && videoIdFromUrl(sender.tab?.url) && sender.frameId === 0) {
    work = getLanguageSupport(sender.tab, message.videoId);
  } else if (message?.type === "LIBITU_READ_HANDOFF") {
    work = readHandoff(message.handoffId, sender);
  } else if (message?.type === "LIBITU_READ_FRESH_CAPTIONS") {
    work = freshCaptions.read(message, sender);
  } else {
    return false;
  }
  work.then(sendResponse).catch((error) => sendResponse({ error: error.message }));
  return true;
});

function launch(tab) {
  const videoId = videoIdFromUrl(tab.url);
  if (!videoId || !tab.id) return Promise.reject(new Error("Open a YouTube watch page before starting Libitu."));
  const key = `${tab.id}:${videoId}`;
  if (launches.has(key)) return launches.get(key);
  const work = openStageOne(tab, videoId).finally(() => launches.delete(key));
  launches.set(key, work);
  return work;
}

async function openStageOne(tab, videoId) {
  const [snapshot, languageSupport] = await Promise.all([
    sendToVideo(tab.id, { type: "LIBITU_GET_YOUTUBE_METADATA", videoId }),
    getLanguageSupport(tab, videoId)
  ]);
  if (!snapshot?.supported || snapshot.videoId !== videoId) {
    throw new Error(snapshot?.reason || "This YouTube video is still loading. Try again in a moment.");
  }
  if (!languageSupport.supported) throw new Error(languageSupport.reason);
  snapshot.language = languageSupport.languageCode;
  chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  chrome.action.setTitle({ tabId: tab.id, title: "Open Libitu" });
  const records = await chrome.storage.session.get(null);
  for (const [key, binding] of Object.entries(records)) {
    if (!key.startsWith("libituContentTab:") || binding.videoId !== videoId) continue;
    try {
      const existing = await chrome.tabs.get(Number(key.split(":")[1]));
      const current = new URL(existing.url);
      if (current.origin === WEB_BASE_URL && new RegExp(`^/practice/${binding.contentId}(?:/(?:segments|shadow))?$`).test(current.pathname)) {
        await chrome.tabs.update(existing.id, { active: true });
        return { opened: true };
      }
    } catch { /* Closed tabs cannot be reused. */ }
  }
  for (const [key, record] of Object.entries(records)) {
    if (!key.startsWith(HANDOFF_PREFIX)) continue;
    if (Date.now() - record.createdAt > HANDOFF_TTL_MS) {
      await chrome.storage.session.remove(key);
      continue;
    }
    if (record.sourceTabId === tab.id && record.snapshot.videoId === videoId && record.stageTabId) {
      try {
        const existing = await chrome.tabs.get(record.stageTabId);
        const url = new URL(existing.url);
        if (url.origin === WEB_BASE_URL && url.searchParams.get("sourceUrl") === snapshot.canonicalUrl) {
          await chrome.tabs.update(existing.id, { active: true });
          return { opened: true };
        }
      } catch { /* The previous Stage 1 tab was closed. */ }
    }
  }
  const id = crypto.randomUUID();
  const navigationVersion = navigationVersions.get(tab.id)?.version ?? 0;
  const record = {
    id, sourceTabId: tab.id, createdAt: Date.now(), snapshot, navigationVersion,
    status: "pending"
  };
  await chrome.storage.session.set({ [HANDOFF_PREFIX + id]: record });
  // Give the YouTube player a bounded opportunity to finish its caption
  // request before opening Stage 1. This removes the common click-time race
  // while retaining the existing DOM/provider fallback after the deadline.
  const captured = await capture(record);
  if (captured?.stale) {
    throw new Error("The YouTube video changed while captions were loading. Try again.");
  }
  const current = (await chrome.storage.session.get(HANDOFF_PREFIX + id))[HANDOFF_PREFIX + id];
  if (!current || current.snapshot.videoId !== videoId
    || (navigationVersions.get(tab.id)?.version ?? 0) !== navigationVersion) {
    throw new Error("The YouTube video changed while captions were loading. Try again.");
  }
  const params = new URLSearchParams({
    sourceUrl: snapshot.canonicalUrl,
    title: snapshot.title,
    language: snapshot.language,
    handoffId: id
  });
  const stageTab = await chrome.tabs.create({ url: `${WEB_BASE_URL}/practice/import?${params}` });
  record.stageTabId = stageTab.id;
  await chrome.storage.session.set({ [HANDOFF_PREFIX + id]: { ...current, stageTabId: stageTab.id } });
  return { opened: true };
}

function getLanguageSupport(tab, expectedVideoId) {
  const videoId = videoIdFromUrl(tab.url);
  if (!tab.id || !videoId || videoId !== expectedVideoId) {
    return Promise.resolve({ supported: false, status: "unknown", reason: UNKNOWN_LANGUAGE_MESSAGE });
  }
  const key = `${tab.id}:${videoId}`;
  if (languageChecks.has(key)) return languageChecks.get(key);
  const work = detectVideoLanguage(tab.id, videoId).then((result) => {
    const languageCode = normalizeLanguageCode(result?.languageCode);
    if (!languageCode) {
      return { supported: false, status: "unknown", reason: `${UNKNOWN_LANGUAGE_MESSAGE} ${ENGLISH_ONLY_MESSAGE}` };
    }
    const supported = SUPPORTED_LANGUAGE_BASES.has(languageCode.split("-")[0]);
    return {
      supported,
      status: supported ? "supported" : "unsupported",
      languageCode,
      reason: supported ? undefined : ENGLISH_ONLY_MESSAGE
    };
  }).catch(() => ({
    supported: false,
    status: "unknown",
    reason: `${UNKNOWN_LANGUAGE_MESSAGE} ${ENGLISH_ONLY_MESSAGE}`
  }));
  languageChecks.set(key, work);
  return work;
}

async function detectVideoLanguage(tabId, videoId) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [videoId],
      func: inspectYouTubeLanguage
    });
    if (result?.languageCode) return result;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return undefined;
}

function inspectYouTubeLanguage(expectedVideoId) {
  const normalize = (value) => typeof value === "string"
    ? value.trim().replaceAll("_", "-").toLowerCase()
    : undefined;
  let pageUrl;
  try { pageUrl = new URL(window.location.href); } catch { return undefined; }
  if (pageUrl.searchParams.get("v") !== expectedVideoId) return undefined;

  let playerResponse;
  try {
    const player = document.querySelector("#movie_player");
    if (typeof player?.getPlayerResponse === "function") playerResponse = player.getPlayerResponse();
  } catch { /* Fall through to YouTube's page-level response. */ }

  const parseResponse = (value) => {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return undefined;
    try { return JSON.parse(value); } catch { return undefined; }
  };
  const responses = [
    parseResponse(playerResponse),
    parseResponse(globalThis.ytInitialPlayerResponse),
    parseResponse(globalThis.ytplayer?.config?.args?.raw_player_response)
  ].filter((response) => response?.videoDetails?.videoId === expectedVideoId);
  const response = responses[0];
  const captions = response?.captions?.playerCaptionsTracklistRenderer;
  const tracks = Array.isArray(captions?.captionTracks) ? captions.captionTracks : [];
  const audioTracks = Array.isArray(captions?.audioTracks) ? captions.audioTracks : [];
  // hasDefaultTrack describes caption defaults, not the video's audio default:
  // dubbed videos can set it on every audio track. Honor the explicit index.
  const indexedAudioTrack = Number.isInteger(captions?.defaultAudioTrackIndex)
    ? audioTracks[captions.defaultAudioTrackIndex]
    : undefined;
  const markedAudioTracks = audioTracks.filter((track) => track?.hasDefaultTrack);
  const defaultAudioTrack = indexedAudioTrack
    ?? (audioTracks.length === 1 ? audioTracks[0] : markedAudioTracks.length === 1 ? markedAudioTracks[0] : undefined);
  // YouTube audio IDs append a numeric track identifier to a language tag.
  const audioTrackLanguage = typeof defaultAudioTrack?.audioTrackId === "string"
    ? /^([a-z]{2,3}(?:-[a-z0-9]{2,8})*)\.\d+$/i.exec(defaultAudioTrack.audioTrackId)?.[1]
    : undefined;
  const defaultCaptionIndex = Number.isInteger(defaultAudioTrack?.defaultCaptionTrackIndex)
    ? defaultAudioTrack.defaultCaptionTrackIndex
    : defaultAudioTrack?.captionTrackIndices?.[0];
  const defaultCaptionLanguage = Number.isInteger(defaultCaptionIndex)
    ? tracks[defaultCaptionIndex]?.languageCode
    : undefined;
  const automaticLanguages = [...new Set(tracks
    .filter((track) => track?.kind === "asr" || /^a\./i.test(track?.vssId ?? ""))
    .map((track) => normalize(track?.languageCode)).filter(Boolean))];
  const uniqueCaptionLanguages = [...new Set(tracks.map((track) => normalize(track?.languageCode)).filter(Boolean))];
  const candidates = [
    [response?.microformat?.playerMicroformatRenderer?.defaultAudioLanguage, "default-audio"],
    [response?.videoDetails?.defaultAudioLanguage, "video-details"],
    [document.querySelector('meta[itemprop="inLanguage"]')?.getAttribute("content"), "page-metadata"],
    [audioTrackLanguage, "audio-track"],
    [automaticLanguages.length === 1 ? automaticLanguages[0] : undefined, "automatic-caption"],
    // Several ASR languages may belong to dubbed audio. A preferred caption
    // alone cannot establish which language the video speaks.
    [automaticLanguages.length <= 1 ? defaultCaptionLanguage : undefined, "default-caption"],
    [uniqueCaptionLanguages.length === 1 ? uniqueCaptionLanguages[0] : undefined, "caption-track"]
  ];
  for (const [value, source] of candidates) {
    const languageCode = normalize(value);
    if (languageCode && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(languageCode)) return { languageCode, source };
  }
  return undefined;
}

function normalizeLanguageCode(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll("_", "-").toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(normalized) ? normalized : undefined;
}

async function readHandoff(id, sender) {
  if (typeof id !== "string" || sender.frameId !== 0 || !sender.tab) throw new Error("Invalid Stage 1 handoff.");
  const url = new URL(sender.url);
  if (url.origin !== WEB_BASE_URL || url.pathname !== "/practice/import" || sender.id !== chrome.runtime.id || url.searchParams.get("handoffId") !== id) throw new Error("Invalid Stage 1 handoff.");
  const record = (await chrome.storage.session.get(HANDOFF_PREFIX + id))[HANDOFF_PREFIX + id];
  if (!record || Date.now() - record.createdAt > HANDOFF_TTL_MS) return { unavailable: true };
  if (url.searchParams.get("sourceUrl") !== record.snapshot.canonicalUrl) throw new Error("The handoff belongs to another video.");
  return capture(record);
}

function capture(record) {
  if (record.status === "ready") return Promise.resolve({ transcriptText: record.transcriptText, captionTrack: record.captionTrack });
  if (captures.has(record.id)) return captures.get(record.id);
  const navigation = navigationVersions.get(record.sourceTabId) ?? { version: 0, readers: 0 };
  navigationVersions.set(record.sourceTabId, navigation);
  navigation.readers += 1;
  const navigationVersion = navigation.version;
  const isCurrent = async () => {
    if (navigation.version !== navigationVersion) return false;
    try {
      const tab = await chrome.tabs.get(record.sourceTabId);
      return videoIdFromUrl(tab.url) === record.snapshot.videoId
        && navigation.version === navigationVersion;
    } catch { return false; }
  };
  const work = (async () => {
    let transcriptText;
    let captionTrack;
    let stale = false;
    let captionPreparation;
    try {
      if (await isCurrent()) {
        try {
          const prepared = await withTimeout(chrome.scripting.executeScript({
            target: { tabId: record.sourceTabId }, world: "MAIN",
            args: [record.snapshot.videoId], func: prepareYouTubeCaptions
          }), 2_500);
          captionPreparation = prepared?.[0]?.result;
        } catch { /* Automatic caption enabling is best-effort. */ }
        let result;
        try {
          const injected = await withTimeout(chrome.scripting.executeScript({
            target: { tabId: record.sourceTabId }, world: "MAIN",
            args: [record.snapshot.videoId, record.snapshot.language, CAPTION_OBSERVER_WAIT_MS], func: readCurrentYouTubeCaptionTrack
          }), 7_500);
          result = injected?.[0]?.result;
        } catch { /* An unavailable track still permits the existing DOM fallback. */ }
        if (!result?.stale && await isCurrent()) {
          if (result?.captionTrack?.video_id === record.snapshot.videoId) {
            captionTrack = result.captionTrack;
            transcriptText = captionTrackToTranscript(captionTrack);
          } else {
            const snapshot = await withTimeout(chrome.tabs.sendMessage(record.sourceTabId, {
              type: "LIBITU_GET_YOUTUBE_SNAPSHOT", videoId: record.snapshot.videoId
            }), 6_500);
            if (snapshot?.supported && snapshot.videoId === record.snapshot.videoId) transcriptText = snapshot.transcriptText;
            // Opening the transcript panel can be the event that makes the
            // player request captions. Read the observer once more afterward
            // so Stage 1 receives structured timing when it arrived during
            // the DOM fallback window.
            const mayHaveArrived = !result || ["not_observed", "request_failed", "empty_response", "observer_timeout"].includes(result.status);
            if (!captionTrack && mayHaveArrived && await isCurrent()) {
              try {
                const retried = await withTimeout(chrome.scripting.executeScript({
                  target: { tabId: record.sourceTabId }, world: "MAIN",
                  // The DOM fallback already provided the waiting window. This
                  // second read is deliberately immediate so a late player
                  // response cannot add another six-second launch delay.
                  args: [record.snapshot.videoId, record.snapshot.language, 0], func: readCurrentYouTubeCaptionTrack
                }), 2_500);
                const retryResult = retried?.[0]?.result;
                if (retryResult?.captionTrack?.video_id === record.snapshot.videoId) {
                  captionTrack = retryResult.captionTrack;
                  transcriptText = captionTrackToTranscript(captionTrack);
                }
              } catch { /* Keep the safe DOM/provider fallback. */ }
            }
          }
        }
      }
    } catch { /* Missing browser captions use the existing API fallback. */ }
    if (captionPreparation?.changed && await isCurrent()) {
      try {
        await withTimeout(chrome.scripting.executeScript({
          target: { tabId: record.sourceTabId }, world: "MAIN",
          args: [record.snapshot.videoId, captionPreparation.restore], func: restoreYouTubeCaptions
        }), 1_500);
      } catch { /* Keep the page usable if YouTube redraws its controls. */ }
    }
    if (!await isCurrent()) {
      stale = true;
      transcriptText = undefined;
      captionTrack = undefined;
    }
    const key = HANDOFF_PREFIX + record.id;
    const current = (await chrome.storage.session.get(key))[key];
    if (current) await chrome.storage.session.set({ [key]: { ...current, status: "ready", transcriptText, captionTrack } });
    return { transcriptText, captionTrack, ...(stale ? { stale: true } : {}) };
  })().finally(() => {
    captures.delete(record.id);
    navigation.readers -= 1;
    if (!navigation.readers && navigationVersions.get(record.sourceTabId) === navigation) navigationVersions.delete(record.sourceTabId);
  });
  captures.set(record.id, work);
  return work;
}

// Injected in the YouTube MAIN world. This only performs a best-effort UI
// action when an English automatic track is advertised. It does not read or
// reconstruct the track URL, and the caller restores the previous caption
// state after the player has had a chance to request JSON3.
async function prepareYouTubeCaptions(expectedVideoId) {
  const current = () => {
    try {
      const url = new URL(window.location.href);
      return url.origin === "https://www.youtube.com" && url.pathname === "/watch"
        && url.searchParams.get("v") === expectedVideoId;
    } catch { return false; }
  };
  if (!current()) return { status: "stale" };
  const parse = (value) => {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return undefined;
    try { return JSON.parse(value); } catch { return undefined; }
  };
  let playerResponse;
  try {
    const player = document.querySelector("#movie_player");
    if (typeof player?.getPlayerResponse === "function") playerResponse = player.getPlayerResponse();
  } catch { /* Use page-level response below. */ }
  const response = [playerResponse, globalThis.ytInitialPlayerResponse,
    globalThis.ytplayer?.config?.args?.raw_player_response].map(parse)
    .find((item) => item?.videoDetails?.videoId === expectedVideoId);
  const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const automatic = Array.isArray(tracks) && tracks.some((track) => track?.kind === "asr" || /^a\./i.test(track?.vssId ?? ""));
  if (!automatic) return { status: "automatic_track_unavailable" };
  const button = document.querySelector(".ytp-subtitles-button");
  if (!(button instanceof HTMLElement)) return { status: "control_unavailable" };
  const active = button.getAttribute("aria-pressed") === "true" || button.classList.contains("ytp-button-active")
    || /turn off|disable|关闭|關閉/i.test(button.getAttribute("aria-label") ?? "");
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const labels = (element) => `${element?.getAttribute?.("aria-label") ?? ""} ${element?.textContent ?? ""}`;
  const settings = document.querySelector(".ytp-settings-button");
  if (settings instanceof HTMLElement) {
    settings.click();
    await delay(120);
    const captionMenu = [...document.querySelectorAll(".ytp-menuitem, .ytp-panel-menu button, [role='menuitem']")]
      .find((element) => /subtitles|captions|字幕|cc/i.test(labels(element)));
    if (captionMenu instanceof HTMLElement) {
      captionMenu.click();
      await delay(120);
      const menuItems = () => [...document.querySelectorAll(".ytp-menuitem, .ytp-panel-menu button, [role='menuitem']")];
      const selectedMenu = menuItems().find((element) => element.getAttribute("aria-checked") === "true"
        || /selected|checked/.test(element.className ?? ""));
      const previousLabel = selectedMenu ? labels(selectedMenu).trim() : undefined;
      const automaticMenu = menuItems()
        .find((element) => /english.*auto.?generated|auto.?generated.*english/i.test(labels(element)));
      if (automaticMenu instanceof HTMLElement) {
        if (active && !previousLabel) return { status: "already_enabled" };
        const sameTrack = selectedMenu === automaticMenu;
        if (!sameTrack) automaticMenu.click();
        return { status: sameTrack && active ? "already_enabled_auto" : "enabled_auto", changed: !sameTrack,
          restore: { wasActive: active, previousLabel } };
      }
      settings.click();
      await delay(80);
    }
  }
  if (active) return { status: "already_enabled" };
  // Some player versions expose only the CC button. In that case enabling the
  // player's advertised default is still useful; the observer will validate
  // whether the returned track actually contains word offsets.
  button.click();
  return { status: "enabled_default", changed: true };
}

async function restoreYouTubeCaptions(expectedVideoId, restore) {
  try {
    const url = new URL(window.location.href);
    if (url.origin !== "https://www.youtube.com" || url.pathname !== "/watch" || url.searchParams.get("v") !== expectedVideoId) return { status: "stale" };
    const button = document.querySelector(".ytp-subtitles-button");
    if (!(button instanceof HTMLElement)) return { status: "control_unavailable" };
    const active = button.getAttribute("aria-pressed") === "true" || button.classList.contains("ytp-button-active");
    if (!restore?.wasActive) {
      if (active) button.click();
      return { status: "restored" };
    }
    if (!restore.previousLabel) return { status: "restored" };
    const settings = document.querySelector(".ytp-settings-button");
    if (!(settings instanceof HTMLElement)) return { status: "control_unavailable" };
    settings.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const labels = (element) => `${element?.getAttribute?.("aria-label") ?? ""} ${element?.textContent ?? ""}`;
    const captionMenu = [...document.querySelectorAll(".ytp-menuitem, .ytp-panel-menu button, [role='menuitem']")]
      .find((element) => /subtitles|captions|字幕|cc/i.test(labels(element)));
    if (!(captionMenu instanceof HTMLElement)) return { status: "control_unavailable" };
    captionMenu.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const previous = [...document.querySelectorAll(".ytp-menuitem, .ytp-panel-menu button, [role='menuitem']")]
      .find((element) => labels(element).trim() === restore.previousLabel);
    if (previous instanceof HTMLElement) previous.click();
    return { status: previous instanceof HTMLElement ? "restored" : "restore_unavailable" };
  } catch { return { status: "control_unavailable" }; }
}

async function sendToVideo(tabId, message) {
  try {
    return await withTimeout(chrome.tabs.sendMessage(tabId, message), 1_500);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content-script.js"] });
    return withTimeout(chrome.tabs.sendMessage(tabId, message), 1_500);
  }
}

function withTimeout(work, milliseconds) {
  let timer;
  return Promise.race([work, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The YouTube page did not respond. Reload it and try again.")), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function videoIdFromUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://www.youtube.com" && url.pathname === "/watch" ? url.searchParams.get("v") : null;
  } catch {
    return null;
  }
}

function reportError(tab, message) {
  if (!tab.id) return;
  chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
  chrome.action.setTitle({ tabId: tab.id, title: message });
  chrome.tabs.sendMessage(tab.id, { type: "LIBITU_SHOW_ERROR", message }).catch(() => {});
}
