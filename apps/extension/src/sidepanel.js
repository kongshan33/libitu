const API_BASE_URL = "http://localhost:8000";
const WEB_BASE_URL = "http://localhost:3000";
const REQUEST_TIMEOUT_MS = 15000;
const SNAPSHOT_REQUEST = "LIBITU_GET_YOUTUBE_SNAPSHOT";

const elements = {
  refresh: document.querySelector("#refresh"),
  start: document.querySelector("#start"),
  state: document.querySelector("#state"),
  title: document.querySelector("#title"),
  url: document.querySelector("#url"),
  transcript: document.querySelector("#transcript"),
  transcriptStatus: document.querySelector("#transcript-status")
};

let currentSnapshot = null;

elements.refresh.addEventListener("click", refreshSnapshot);
elements.start.addEventListener("click", startBlueprint);
elements.transcript.addEventListener("input", syncStartAvailability);
refreshSnapshot();

async function refreshSnapshot() {
  setState("loading", "Reading the current YouTube page.");
  elements.start.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab is available.");

    const snapshot = await readSnapshotFromTab(tab);
    currentSnapshot = snapshot;
    renderSnapshot(snapshot);
  } catch (error) {
    currentSnapshot = null;
    elements.title.textContent = "Open a YouTube video";
    elements.url.textContent = "";
    elements.transcript.value = "";
    elements.transcriptStatus.textContent = "Transcript is unavailable.";
    setState("warning", error instanceof Error ? error.message : "Could not read the current page.");
  }
}

async function readSnapshotFromTab(tab) {
  if (!isYouTubeWatchUrl(tab.url)) {
    return {
      supported: false,
      reason: "Open a YouTube watch page before starting Libitu."
    };
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, { type: SNAPSHOT_REQUEST });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/content-script.js"]
      });
      return await chrome.tabs.sendMessage(tab.id, { type: SNAPSHOT_REQUEST });
    } catch {
      throw new Error("Libitu could not connect to this YouTube tab. Reload the page and try again.");
    }
  }
}

function isYouTubeWatchUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.youtube.com" && parsed.pathname === "/watch" && parsed.searchParams.has("v");
  } catch {
    return false;
  }
}

async function startBlueprint() {
  if (!currentSnapshot?.supported) return;

  const transcriptText = elements.transcript.value.trim() || undefined;
  setState("loading", "Sending metadata to Libitu and preparing the blueprint.");
  elements.start.disabled = true;

  try {
    const content = await request("/api/content/resolve", {
      method: "POST",
      body: JSON.stringify({
        kind: "youtube",
        source_url: currentSnapshot.canonicalUrl,
        title: currentSnapshot.title,
        transcript_text: transcriptText,
        language: currentSnapshot.language
      })
    });

    const job = await request("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        content_id: content.content_id
      })
    });

    await chrome.storage.local.set({
      libituLastSnapshot: {
        contentId: content.content_id,
        jobId: job.id,
        sourceUrl: currentSnapshot.canonicalUrl,
        title: currentSnapshot.title,
        hasTranscript: Boolean(transcriptText),
        updatedAt: new Date().toISOString()
      }
    });

    setState("ready", "Analysis started. Opening Stage 1.");
    await chrome.tabs.create({ url: stageOneUrl(currentSnapshot, content, job) });
  } catch (error) {
    elements.start.disabled = false;
    setState("warning", error instanceof Error ? error.message : "Libitu API is unavailable.");
  }
}

function renderSnapshot(snapshot) {
  if (!snapshot?.supported) {
    elements.title.textContent = "Unsupported page";
    elements.url.textContent = snapshot?.reason ?? "";
    elements.transcript.value = "";
    elements.transcriptStatus.textContent = "Open a supported YouTube watch page.";
    setState("warning", snapshot?.reason ?? "This page is not supported.");
    return;
  }

  elements.title.textContent = snapshot.title;
  elements.url.textContent = snapshot.canonicalUrl;
  elements.transcript.value = snapshot.transcriptText ?? "";
  elements.transcriptStatus.textContent = snapshot.hasTranscript
    ? "Timestamped captions were captured from the browser."
    : "No captions were found automatically.";
  syncStartAvailability();
  setState(
    snapshot.hasTranscript ? "ready" : "warning",
    snapshot.hasTranscript
      ? "Transcript captured. Ready to create a Stage 1 blueprint."
      : "No captions were found. Paste a transcript to continue."
  );
}

async function request(path, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers
      }
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Libitu API timed out. Check that the API and worker are running.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return response.json();
}

async function readErrorMessage(response) {
  try {
    const payload = await response.json();
    if (typeof payload.detail === "string") return payload.detail;
  } catch {
    return `Request failed with status ${response.status}.`;
  }

  return `Request failed with status ${response.status}.`;
}

function stageOneUrl(snapshot, content, job) {
  const params = new URLSearchParams({
    sourceUrl: snapshot.canonicalUrl,
    title: snapshot.title,
    contentId: content.content_id,
    jobId: job.id
  });

  if (snapshot.language) params.set("language", snapshot.language);

  return `${WEB_BASE_URL}/?${params.toString()}`;
}

function syncStartAvailability() {
  elements.start.disabled = !currentSnapshot?.supported || !elements.transcript.value.trim();
}

function setState(kind, message) {
  const indicator = elements.state.querySelector(".indicator");
  indicator.className = `indicator ${kind === "loading" ? "loading" : kind === "warning" ? "warning" : ""}`.trim();
  elements.state.querySelector("p").textContent = message;
}
