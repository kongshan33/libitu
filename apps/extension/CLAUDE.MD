# Extension Agent Notes

Read the root `CLAUDE.MD` before editing this app.

## Target

- Chrome Extension Manifest V3
- YouTube page entry point
- Stage 1 and Stage 2 browser-side experience

## Boundaries

- Keep YouTube playback control in the browser.
- Keep microphone capture and pitch detection in the browser.
- Do not upload YouTube audio/video or raw microphone audio.
- Send only transcript text, selected corpus data, and derived metadata to the backend.

## Planned Pieces

```text
manifest.json
src/background.js
src/content-script.js
src/sidepanel.html
src/sidepanel.css
src/sidepanel.js
scripts/validate-extension.mjs
```

The first extension increment is implemented without a bundler. Keep it directly loadable from `apps/extension` until side panel complexity justifies build tooling.

Current behavior:

- Enables the side panel for YouTube watch pages.
- Reads video metadata and transcript text that is already visible in the YouTube DOM.
- Sends metadata and optional transcript text to the local FastAPI API.
- Opens the local Next.js Stage 1 page with source parameters.
- Stores the last handoff snapshot in `chrome.storage.local`.
