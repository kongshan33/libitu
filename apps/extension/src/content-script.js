const SNAPSHOT_REQUEST = "LIBITU_GET_YOUTUBE_SNAPSHOT";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== SNAPSHOT_REQUEST) return false;

  readYouTubeSnapshot()
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        supported: false,
        reason: error instanceof Error ? error.message : "Could not read this YouTube page."
      });
    });
  return true;
});

async function readYouTubeSnapshot() {
  const url = new URL(window.location.href);
  const videoId = url.searchParams.get("v");

  if (!videoId) {
    return {
      supported: false,
      reason: "Open a YouTube watch page before starting Libitu."
    };
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const title = readTitle();
  const transcriptText = await readTranscriptText();
  const language = document.documentElement.lang || undefined;

  return {
    supported: true,
    videoId,
    canonicalUrl,
    title,
    transcriptText,
    hasTranscript: Boolean(transcriptText),
    language
  };
}

function readTitle() {
  const titleElement = document.querySelector("h1 yt-formatted-string, h1.title, title");
  const title = titleElement?.textContent?.trim();

  if (title) return title.replace(/\s+-\s+YouTube$/, "");
  return document.title.replace(/\s+-\s+YouTube$/, "") || "Untitled YouTube video";
}

async function readTranscriptText() {
  let transcript = readVisibleTranscriptText();
  if (transcript) return transcript;

  const expandButton = document.querySelector("ytd-text-inline-expander #expand");
  if (expandButton instanceof HTMLElement) {
    expandButton.click();
    await delay(400);
  }

  const transcriptButton = findTranscriptButton();
  if (transcriptButton) {
    transcriptButton.click();
    transcript = await waitForTranscript(6000);
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

function readVisibleTranscriptText() {
  const segments = Array.from(document.querySelectorAll("ytd-transcript-segment-renderer"))
    .map((segment) => {
      const time = segment.querySelector(".segment-timestamp")?.textContent?.replace(/\s+/g, "").trim();
      const text = segment.querySelector(".segment-text")?.textContent?.replace(/\s+/g, " ").trim();
      if (!text) return null;
      return time ? `${time}\t${text}` : text;
    })
    .filter(Boolean);

  return Array.from(new Set(segments)).join("\n") || undefined;
}

async function waitForTranscript(timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const transcript = readVisibleTranscriptText();
    if (transcript) return transcript;
    await delay(250);
  }
  return undefined;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
