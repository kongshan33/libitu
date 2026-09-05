chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;

  chrome.sidePanel.setOptions({
    tabId,
    path: "src/sidepanel.html",
    enabled: isYouTubeWatchUrl(tab.url)
  });
});

function isYouTubeWatchUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.youtube.com" && parsed.pathname === "/watch" && parsed.searchParams.has("v");
  } catch {
    return false;
  }
}
