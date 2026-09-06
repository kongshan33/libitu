# Libitu Chrome Extension

Chrome extension workspace for YouTube page entry, transcript capture, local playback control, local microphone capture, and shadowing flows.

The extension owns browser-local concerns. It should share product types from `@libitu/types`, pure business helpers from `@libitu/core`, and design tokens from `@libitu/ui`.

## Current implementation

The first Manifest V3 version is loadable as an unpacked Chrome extension from `apps/extension`.

It can:

- Show a Libitu icon button in the player's lower-right control bar, including after YouTube in-site navigation or player-control redraws
- Detect YouTube's video language from audio/video metadata and caption tracks against an explicit supported-language list, currently English only
- Enable Stage 1 launch from the page button or browser toolbar only after validating the URL, current player, and English language
- Read the current video ID, canonical URL, and title without waiting for captions
- Attempt to open YouTube's transcript panel and capture timestamped caption segments
- Recover the content-script connection after an extension reload by injecting it into the active YouTube watch tab
- Open the Next.js page before caption capture or API requests, and focus the existing reader on repeated clicks
- Hand browser captions to Stage 1 through a same-origin bridge and a 15-minute `chrome.storage.session` record, without putting transcript text in the URL
- Let Stage 1 create/resume the content and job, stream analysis, and preserve content/job IDs for reload and Retry
- Keep the player button disabled with a hover reason for non-English or unknown-language videos, and show an action badge, title, and in-player message for unsupported toolbar clicks

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

Open an English YouTube watch page and click either the Libitu icon in the player's bottom control bar or the toolbar icon. Both open Stage 1 directly after the video language is verified. Non-English or unknown-language videos remain on YouTube and explain the current English-only limit.

After updating the unpacked extension, reload it at `chrome://extensions` and refresh YouTube to display the injected button. The toolbar can also recover an already-open watch tab by injecting the missing receiver. The web origin is currently `http://localhost:3000`; keep `manifest.json`, `src/background.js`, and the running web server aligned when changing it.

## Verification

`pnpm --filter @libitu/extension test` verifies English-language gating, unsupported feedback, launch ordering, duplicate clicks, receiver recovery, source checks, and session restoration without network calls. `apps/web/tests/extension-handoff.test.mjs` covers bridge validation, cancellation, bounded fallback, and the API handoff.

`tests/entry.browser.mjs` loads the actual unpacked extension in an isolated Chromium profile against a mocked YouTube SPA and mocked API. Its player fixture mirrors YouTube's nested left/right control groups so button insertion and control redraws remain covered. Start the web server on port 3000, then run it with Node. `LIBITU_PLAYWRIGHT_MODULE` can point to an existing Playwright installation and `LIBITU_CHROMIUM_PATH` to a Chrome for Testing executable. Real YouTube DOM variants and actual model completion latency remain separate live checks.
