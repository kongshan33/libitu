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

## Implementation pieces

```text
manifest.json
src/background.js
src/content-script.js
src/stage-one-bridge.js
src/stage-two-bridge.js
src/reference-capture.js
src/reference-offscreen.html
src/reference-offscreen.js
scripts/validate-extension.mjs
```

The extension is implemented without a bundler. Keep it directly loadable from `apps/extension` until browser UI complexity justifies build tooling.

Current behavior:

- `youtube-caption-observer.js` is a classic top-frame MAIN content script installed at `document_start` across YouTube SPA entry pages. It passively reads only eligible current-video English JSON3 player fetch/XHR responses into bounded page-memory captions. `youtube-captions.js` is the self-contained injected cache reader; it must not regain independent signed-URL fetching or token handling. Preserve original request behavior and reject stale response generations. New code on disk does not install an early observer into an existing document: reload the extension and source page for live verification.

- Protocol v3 supports a bounded browser-local PCM reference buffer across same-content Stage 1/2, segment and sentence changes. It still needs an explicit same-tab toolbar invocation. Observe only eligible visible 1× source playback; microphone/replay/hidden-page states stop retaining new samples. Distinct continuous runs never combine to satisfy one extraction. Prefer the newest fully covering run, return genuine mono PCM WAV, and keep video/capture clock uncertainty explicit.
- The v3 buffer is bounded to 64 MiB and ten minutes, with 4096 coverage spans, 512 extraction IDs, four pending extractions, a 45-second page lease and independent 30-minute session maximum. Full document/source changes, worker restart and disable clear media; only ownership metadata is persisted. The initial samples near video time zero may be unavailable because capture starts after confirmed playback; never manufacture those samples or coverage.
- `buffer-bridge.js`, `buffer-capture.js`, `buffer-offscreen.js`, `buffer-pcm.js` and `buffer-worklet.js` own this flow. The v2 per-sentence encoder remains compatible, shares the same offscreen document and a mutual-exclusion lease, and retains its narrower URL/clip rules described below. Do not upload recorded reference audio or present the planned cloud/MFA pipeline as delivered.

- Adds a Libitu action to the YouTube player's lower-right controls, reattaches it after player redraws, and enables it only when YouTube video metadata verifies a supported language.
- Uses the browser toolbar action as the same language-gated Stage 1 entry. The supported-language list currently contains only English; unsupported clicks explain the limit without opening Stage 1.
- Opens the local Next.js Stage 1 page before caption or API work.
- Reads video metadata and transcript text from the YouTube DOM and passes captions through a short-lived session handoff.
- Uses the toolbar action on an armed Stage 2 page to authorize one browser-local reference session through `tabCapture` (Chrome 116+). Protocol v2 page messages may start sentence encoders only after this authorization.
- Retains one stream and offscreen AudioContext monitor across sentence changes. Each clip has its own encoder/request ID; completion, cancellation, and clip failures release encoder data while preserving a healthy authorized stream. Idle time, microphone practice, and replay have no active encoder or application audio buffers.
- Binds authorization to the original tab/document/practice URL, ignoring only sentence ID and hash changes. Explicit disable, a second toolbar click, full navigation/reload, tab closure, worker recovery, a 45-second page-heartbeat lease, or the independent 30-minute session maximum releases the stream/context/document.
- Stores only temporary capture ownership metadata for recovery; raw audio is never uploaded or persisted. The web app owns sentence playback, microphone recording, and acoustic analysis.
