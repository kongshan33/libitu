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
src/stage-one-bridge.js
scripts/validate-extension.mjs
```

The extension is implemented without a bundler. Keep it directly loadable from `apps/extension` until browser UI complexity justifies build tooling.

Current behavior:

- Adds a Libitu action to the YouTube player's lower-right controls, reattaches it after player redraws, and enables it only when YouTube video metadata verifies a supported language.
- Uses the browser toolbar action as the same language-gated Stage 1 entry. The supported-language list currently contains only English; unsupported clicks explain the limit without opening Stage 1.
- Opens the local Next.js Stage 1 page before caption or API work.
- Reads video metadata and transcript text from the YouTube DOM and passes captions through a short-lived session handoff.
