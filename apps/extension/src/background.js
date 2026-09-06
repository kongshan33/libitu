const WEB_BASE_URL = "http://localhost:3000";
const HANDOFF_PREFIX = "libituHandoff:";
const HANDOFF_TTL_MS = 15 * 60 * 1000;
const SUPPORTED_LANGUAGE_BASES = new Set(["en"]);
const ENGLISH_ONLY_MESSAGE = "Libitu currently supports English videos only.";
const UNKNOWN_LANGUAGE_MESSAGE = "Libitu could not verify that this video is in English.";
const launches = new Map();
const captures = new Map();
const languageChecks = new Map();

chrome.action.onClicked.addListener((tab) => {
  if (!videoIdFromUrl(tab.url)) {
    reportError(tab, "Open a YouTube video to start Libitu.");
    return;
  }
  launch(tab).catch((error) => reportError(tab, error.message));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  for (const key of languageChecks.keys()) {
    if (key.startsWith(`${tabId}:`)) languageChecks.delete(key);
  }
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
  const record = {
    id, sourceTabId: tab.id, createdAt: Date.now(), snapshot,
    status: "pending"
  };
  await chrome.storage.session.set({ [HANDOFF_PREFIX + id]: record });
  const params = new URLSearchParams({
    sourceUrl: snapshot.canonicalUrl,
    title: snapshot.title,
    language: snapshot.language,
    handoffId: id
  });
  const stageTab = await chrome.tabs.create({ url: `${WEB_BASE_URL}/?${params}` });
  record.stageTabId = stageTab.id;
  await chrome.storage.session.set({ [HANDOFF_PREFIX + id]: record });
  // The page is already opening while the browser acquires captions.
  void capture(record).catch(() => {});
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
  const defaultAudioTrack = audioTracks.find((track) => track?.hasDefaultTrack) ?? audioTracks[0];
  const defaultCaptionIndex = Number.isInteger(defaultAudioTrack?.defaultCaptionTrackIndex)
    ? defaultAudioTrack.defaultCaptionTrackIndex
    : defaultAudioTrack?.captionTrackIndices?.[0];
  const defaultCaptionLanguage = Number.isInteger(defaultCaptionIndex)
    ? tracks[defaultCaptionIndex]?.languageCode
    : undefined;
  const automaticCaptionLanguage = tracks.find((track) => track?.kind === "asr" || /^a\./i.test(track?.vssId ?? ""))?.languageCode;
  const uniqueCaptionLanguages = [...new Set(tracks.map((track) => normalize(track?.languageCode)).filter(Boolean))];
  const candidates = [
    [response?.microformat?.playerMicroformatRenderer?.defaultAudioLanguage, "default-audio"],
    [response?.videoDetails?.defaultAudioLanguage, "video-details"],
    [document.querySelector('meta[itemprop="inLanguage"]')?.getAttribute("content"), "page-metadata"],
    [automaticCaptionLanguage, "automatic-caption"],
    [defaultCaptionLanguage, "default-caption"],
    [uniqueCaptionLanguages.length === 1 ? uniqueCaptionLanguages[0] : undefined, "caption-track"]
  ];
  for (const [value, source] of candidates) {
    const languageCode = normalize(value);
    if (languageCode) return { languageCode, source };
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
  if (url.origin !== WEB_BASE_URL || url.searchParams.get("handoffId") !== id) throw new Error("Invalid Stage 1 handoff.");
  const record = (await chrome.storage.session.get(HANDOFF_PREFIX + id))[HANDOFF_PREFIX + id];
  if (!record || Date.now() - record.createdAt > HANDOFF_TTL_MS) return { unavailable: true };
  if (url.searchParams.get("sourceUrl") !== record.snapshot.canonicalUrl) throw new Error("The handoff belongs to another video.");
  return capture(record);
}

function capture(record) {
  if (record.status === "ready") return Promise.resolve({ transcriptText: record.transcriptText });
  if (captures.has(record.id)) return captures.get(record.id);
  const work = (async () => {
    let transcriptText;
    try {
      const result = await withTimeout(chrome.tabs.sendMessage(record.sourceTabId, {
        type: "LIBITU_GET_YOUTUBE_SNAPSHOT", videoId: record.snapshot.videoId
      }), 9_000);
      if (result?.supported && result.videoId === record.snapshot.videoId) transcriptText = result.transcriptText;
    } catch { /* Missing browser captions use the existing API fallback. */ }
    const key = HANDOFF_PREFIX + record.id;
    const current = (await chrome.storage.session.get(key))[key];
    if (current) await chrome.storage.session.set({ [key]: { ...current, status: "ready", transcriptText } });
    return { transcriptText };
  })().finally(() => captures.delete(record.id));
  captures.set(record.id, work);
  return work;
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
