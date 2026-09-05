# Libitu Chrome Extension

Chrome extension workspace for YouTube page entry, transcript capture, local playback control, local microphone capture, and shadowing flows.

The extension owns browser-local concerns. It should share product types from `@libitu/types`, pure business helpers from `@libitu/core`, and design tokens from `@libitu/ui`.

## Current implementation

The first Manifest V3 version is loadable as an unpacked Chrome extension from `apps/extension`.

It can:

- Enable the side panel on YouTube watch pages
- Read the current video ID, canonical URL, title, and page language
- Attempt to open YouTube's transcript panel and capture timestamped caption segments
- Recover the content-script connection after an extension reload by injecting it into the active YouTube watch tab
- Send metadata and transcript text to the FastAPI `/api/content/resolve` endpoint
- Create or resume a processing job through `/api/jobs`
- Open the Next.js Stage 1 page immediately with the created content and job IDs while processing continues
- Store the latest handoff snapshot in `chrome.storage.local`

It does not yet:

- Guarantee captions exist for every video
- Control playback or seek timestamps
- Run local microphone, pitch, or shadowing features

## Local development

Start the web app, API, and blueprint worker from the repository root:

```bash
pnpm dev
```

Then load the extension in Chrome:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Choose "Load unpacked"
4. Select `apps/extension`

Open a YouTube watch page, click the Libitu extension action, and press "Start blueprint" from the side panel.
