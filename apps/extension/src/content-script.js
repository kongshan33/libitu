(() => {
if (globalThis.__libituYouTubeEntry) return;
globalThis.__libituYouTubeEntry = true;
let navigationVersion = 0;
let navigating = false;
let activeCapture = null;
let refreshTimer;
let entry;
let entryButton;
let entryStatus;
let staleTranscript;
let entryVideoId;
let languageCheckVersion = 0;
let languageSupport = { supported: false, status: "checking", reason: "Checking video language..." };
let statusTimer;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "LIBITU_SHOW_ERROR") {
    showError(message.message);
    return false;
  }
  if (message?.type === "LIBITU_GET_YOUTUBE_METADATA") {
    sendResponse(readMetadata(message.videoId));
    return false;
  }
  if (message?.type !== "LIBITU_GET_YOUTUBE_SNAPSHOT") return false;

  readYouTubeSnapshot(message.videoId)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        supported: false,
        reason: error instanceof Error ? error.message : "Could not read this YouTube page."
      });
    });
  return true;
});

function readMetadata(expectedVideoId) {
  const url = new URL(window.location.href);
  const videoId = url.searchParams.get("v");

  if (url.origin !== "https://www.youtube.com" || url.pathname !== "/watch" || !videoId) {
    return {
      supported: false,
      reason: "Open a YouTube watch page before starting Libitu."
    };
  }
  const watch = document.querySelector("ytd-watch-flexy");
  const domVideoId = watch?.getAttribute("video-id");
  const heading = document.querySelector("ytd-watch-metadata h1, #above-the-fold h1, h1.title");
  const player = document.querySelector("#movie_player video");
  if (navigating || (expectedVideoId && expectedVideoId !== videoId) || (domVideoId && domVideoId !== videoId) || !heading?.textContent?.trim() || !player) {
    return { supported: false, reason: "This YouTube video is still loading or unavailable. Try again when the player appears." };
  }
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const title = readTitle();
  return { supported: true, videoId, canonicalUrl, title };
}

async function readYouTubeSnapshot(expectedVideoId) {
  const snapshot = readMetadata(expectedVideoId);
  if (!snapshot.supported) return snapshot;
  const version = navigationVersion;
  if (!activeCapture || activeCapture.version !== version || activeCapture.videoId !== snapshot.videoId) {
    const isCurrent = () => navigationVersion === version && readMetadata(snapshot.videoId).supported;
    activeCapture = { version, videoId: snapshot.videoId, work: readTranscriptText(isCurrent) };
  }
  const capture = activeCapture;
  try {
    const transcriptText = await capture.work;
    if (version !== navigationVersion || !readMetadata(snapshot.videoId).supported) {
      return { supported: false, reason: "The YouTube video changed during caption capture." };
    }
    return { ...snapshot, transcriptText, hasTranscript: Boolean(transcriptText) };
  } finally {
    if (activeCapture === capture) activeCapture = null;
  }
}

function readTitle() {
  const titleElement = document.querySelector("ytd-watch-metadata h1, #above-the-fold h1, h1.title");
  const title = titleElement?.textContent?.trim();

  if (title) return title.replace(/\s+-\s+YouTube$/, "");
  return document.title.replace(/\s+-\s+YouTube$/, "") || "Untitled YouTube video";
}

async function readTranscriptText(isCurrent) {
  if (!isCurrent()) return undefined;
  let transcript = readVisibleTranscriptText();
  if (transcript) return transcript;

  const expandButton = document.querySelector("ytd-text-inline-expander #expand");
  if (expandButton instanceof HTMLElement) {
    expandButton.click();
    await delay(400);
  }
  if (!isCurrent()) return undefined;

  const transcriptButton = findTranscriptButton();
  if (transcriptButton) {
    transcriptButton.click();
    transcript = await waitForTranscript(6000, isCurrent);
  }
  return transcript;
}

function findTranscriptButton() {
  const sectionButton = document.querySelector("ytd-video-description-transcript-section-renderer button");
  if (sectionButton instanceof HTMLElement) return sectionButton;

  const transcriptLabel = /transcript|文字稿|文字記錄|字幕|transcripci[oó]n|transcription|transkript/i;
  return Array.from(document.querySelectorAll("button, [role='button']")).find((element) => {
    const label = `${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`;
    return element instanceof HTMLElement && transcriptLabel.test(label);
  });
}

function readVisibleTranscriptText(includeStale = false) {
  const segments = Array.from(document.querySelectorAll("ytd-transcript-segment-renderer"))
    .map((segment) => {
      const time = segment.querySelector(".segment-timestamp")?.textContent?.replace(/\s+/g, "").trim();
      const text = segment.querySelector(".segment-text")?.textContent?.replace(/\s+/g, " ").trim();
      if (!text) return null;
      return time ? `${time}\t${text}` : text;
    })
    .filter(Boolean);

  const text = Array.from(new Set(segments)).join("\n") || undefined;
  return !includeStale && text === staleTranscript ? undefined : text;
}

async function waitForTranscript(timeoutMs, isCurrent) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isCurrent()) return undefined;
    const transcript = readVisibleTranscriptText();
    if (transcript) return transcript;
    await delay(250);
  }
  return undefined;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function refreshEntry() {
  const snapshot = readMetadata();
  if (!snapshot.supported) {
    entry?.remove();
    entryVideoId = undefined;
    return;
  }
  const target = document.querySelector("#movie_player .ytp-right-controls-left")
    ?? document.querySelector("#movie_player .ytp-chrome-controls .ytp-right-controls");
  if (!target) return;
  if (!entry) {
    entry = document.createElement("span");
    entry.id = "libitu-youtube-entry";
    const root = entry.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { position: relative; display: inline-flex; width: 48px; height: 100%; vertical-align: top; }
      button { display: grid; place-items: center; width: 48px; height: 100%; min-height: 36px; margin: 0;
        padding: 0; border: 0; border-radius: 0; cursor: pointer; background: transparent; color: #fff; }
      button:hover { background: rgba(255, 255, 255, .12); }
      button:focus-visible { outline: 2px solid #afa9ec; outline-offset: -4px; border-radius: 4px; }
      button:disabled { opacity: .55; }
      button[data-state="checking"] { cursor: wait; }
      button[data-state="unsupported"], button[data-state="unknown"] { cursor: not-allowed; }
      img { display: block; width: 30px; height: 30px; border-radius: 50%; background: rgba(255, 255, 255, .96);
        object-fit: contain; box-shadow: 0 0 0 1px rgba(255, 255, 255, .2); }
      p { position: absolute; z-index: 70; right: 4px; bottom: calc(100% + 8px); width: max-content;
        max-width: min(280px, 70vw); margin: 0; padding: 8px 10px; border-radius: 4px;
        background: rgba(28, 28, 28, .96); color: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, .35);
        font: 12px/16px Arial, sans-serif; letter-spacing: 0; overflow-wrap: anywhere; pointer-events: none; }
      p:empty { display: none; }
      p[data-mode="hint"] { display: none; }
      :host(:hover) p[data-mode="hint"], :host(:focus-within) p[data-mode="hint"] { display: block; }
    `;
    entryButton = document.createElement("button");
    entryButton.type = "button";
    entryButton.disabled = true;
    const icon = document.createElement("img");
    icon.src = chrome.runtime.getURL("icons/l.png");
    icon.alt = "";
    entryButton.append(icon);
    entryStatus = document.createElement("p");
    entryStatus.setAttribute("role", "status");
    entryButton.addEventListener("click", async () => {
      entryButton.disabled = true;
      entryStatus.textContent = "";
      try {
        const result = await chrome.runtime.sendMessage({ type: "LIBITU_OPEN_STAGE_ONE" });
        if (!result?.opened) throw new Error(result?.error || "Could not open Libitu. Reload YouTube and try again.");
      } catch (error) {
        showError(error.message);
      } finally {
        applyLanguageSupport();
      }
    });
    root.append(style, entryButton, entryStatus);
    applyLanguageSupport();
  }
  if (entry.parentElement !== target) {
    const anchor = Array.from(target.children).find((child) =>
      child.matches(".ytp-subtitles-button, .ytp-settings-button")
    );
    target.insertBefore(entry, anchor ?? target.firstChild);
  }
  if (entryVideoId !== snapshot.videoId) checkEntryLanguage(snapshot.videoId);
}

async function checkEntryLanguage(videoId) {
  entryVideoId = videoId;
  const version = ++languageCheckVersion;
  languageSupport = { supported: false, status: "checking", reason: "Checking video language..." };
  applyLanguageSupport();
  try {
    const result = await chrome.runtime.sendMessage({ type: "LIBITU_GET_VIDEO_LANGUAGE_SUPPORT", videoId });
    if (version !== languageCheckVersion || videoId !== readMetadata().videoId) return;
    languageSupport = result?.status ? result : {
      supported: false,
      status: "unknown",
      reason: result?.error || "Libitu could not verify that this video is in English."
    };
  } catch {
    if (version !== languageCheckVersion) return;
    languageSupport = {
      supported: false,
      status: "unknown",
      reason: "Libitu could not verify that this video is in English."
    };
  }
  applyLanguageSupport();
}

function applyLanguageSupport() {
  if (!entryButton || !entryStatus) return;
  const available = languageSupport.supported === true;
  entryButton.disabled = !available;
  entryButton.dataset.state = languageSupport.status;
  entryButton.title = available ? "Open in Libitu" : languageSupport.reason;
  entryButton.setAttribute("aria-label", available ? "Open in Libitu" : `Libitu unavailable. ${languageSupport.reason}`);
  if (entryStatus.dataset.mode !== "error") {
    entryStatus.dataset.mode = available || languageSupport.status === "checking" ? "" : "hint";
    entryStatus.textContent = available || languageSupport.status === "checking" ? "" : languageSupport.reason;
  }
}

function showError(message) {
  window.clearTimeout(statusTimer);
  refreshEntry();
  if (!entry?.isConnected) {
    // A watch page can fail before its title/player becomes available.
    if (!entry) return;
    const controls = document.querySelector("#movie_player .ytp-right-controls-left")
      ?? document.querySelector("#movie_player .ytp-right-controls");
    controls?.prepend(entry);
  }
  entryStatus.dataset.mode = "error";
  entryStatus.textContent = message;
  statusTimer = window.setTimeout(() => {
    entryStatus.dataset.mode = "";
    applyLanguageSupport();
  }, 4000);
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    refreshEntry();
  }, 100);
}

document.addEventListener("yt-navigate-start", () => {
  staleTranscript = readVisibleTranscriptText(true);
  navigating = true;
  navigationVersion += 1;
  languageCheckVersion += 1;
  entryVideoId = undefined;
  entry?.remove();
  if (entryStatus) {
    entryStatus.dataset.mode = "";
    entryStatus.textContent = "";
  }
});
document.addEventListener("yt-navigate-finish", () => { navigating = false; scheduleRefresh(); });
window.addEventListener("popstate", () => {
  navigationVersion += 1;
  languageCheckVersion += 1;
  entryVideoId = undefined;
  scheduleRefresh();
});
new MutationObserver(scheduleRefresh).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["video-id"] });
refreshEntry();
})();
