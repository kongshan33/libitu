# Extension Agent Notes

Read the root `CLAUDE.MD` before editing this app.

## Target

- Chrome Extension Manifest V3
- YouTube page entry point
- Stage 1 and Stage 2 browser-side experience

## Boundaries

- Keep playback and microphone capture in the browser; the Web app owns learner recording and analysis.
- The extension only observes captions and keeps explicitly authorized reference audio in a bounded local buffer. It does not upload audio.
- The Web app may upload reference/learner clips under the separate purpose, retention and ownership rules in the root guide and DECISIONS.MD.

## Implementation pieces

```text
manifest.json
src/background.js
src/content-script.js
src/stage-one-bridge.js
src/content-identity.js
src/buffer-bridge.js
src/buffer-capture.js
src/buffer-offscreen.js
src/buffer-pcm.js
src/buffer-worklet.js
src/reference-offscreen.html
scripts/validate-extension.mjs
```

The extension is implemented without a bundler. Keep it directly loadable from `apps/extension` until browser UI complexity justifies build tooling.

Current behavior (2026-10-10 direct update):

- Extension 0.2.0 enables v4 only: import handoff, content-bound buffered audio and fresh timing. Root query launches, v2 per-clip runtime and v3 full-URL identity are no longer installed. The v2 runtime and its Web fallback have been deleted. Web and extension must update together.
- `content-identity.js` validates canonical content paths and checks `/api/content/{id}/identity` public metadata before buffer arming/fresh captions, without reading processing state. `sender.url` can retain the initial import URL after SPA navigation: validate its origin, and use `webNavigation.getFrame` to verify the current top-level URL/document ID before arming or caption reads. `webNavigation.onCommitted` releases sessions on new document IDs. Only an explicit same-tab Chrome action grants audio; `ping` only probes availability locally; the separate verified `register` action records source mapping for tab reuse. New `arm` performs one identity check, shares pending duplicate work and records ownership before I/O so cancellation fences late results.

- `youtube-caption-observer.js` is a classic top-frame MAIN content script installed at `document_start` across YouTube SPA entry pages. It passively reads only eligible current-video English JSON3 player fetch/XHR responses into bounded page-memory captions. `youtube-captions.js` is the self-contained injected cache reader; it must not regain independent signed-URL fetching or token handling. Preserve original request behavior and reject stale response generations. New code on disk does not install an early observer into an existing document: reload the extension and source page for live verification.

- Protocol v4 supports a bounded browser-local PCM reference buffer across same-content Stage 1/2, segment and sentence changes. It still needs an explicit same-tab toolbar invocation. Observe only eligible visible 1× source playback; microphone/replay/hidden-page states stop retaining new samples. Distinct continuous runs never combine to satisfy one extraction. Prefer the newest fully covering run, return genuine mono PCM WAV, and keep video/capture clock uncertainty explicit.
- The v4 buffer is bounded to 64 MiB and ten minutes, with 4096 coverage spans, 512 extraction IDs, four pending extractions, a 45-second page lease and independent 30-minute session maximum. Full document/source changes, worker restart and disable clear media; only ownership metadata is persisted. The initial samples near video time zero may be unavailable because capture starts after confirmed playback; never manufacture those samples or coverage.
- `buffer-bridge.js`, `buffer-capture.js`, `buffer-offscreen.js`, `buffer-pcm.js` and `buffer-worklet.js` own this flow.

- Adds a Libitu action to the YouTube player's lower-right controls, reattaches it after player redraws, and enables it only when YouTube video metadata verifies a supported language.
- Uses the browser toolbar action as the same language-gated Stage 1 entry. The supported-language list currently contains only English; unsupported clicks explain the limit without opening Stage 1.
- Performs bounded caption preflight after the metadata/language gate, then opens the local import route before Web content/processing API work.
- Reads video metadata and transcript text from the YouTube DOM and passes captions through a short-lived session handoff.
- Uses the toolbar action on the armed content tab to authorize the v4 session (Chrome 116+). Reader/segments/Shadow changes retain the same session; content/document changes, disable, tab closure, worker recovery, a 45-second heartbeat lease or 30-minute session maximum release it.
- Stores only temporary capture ownership metadata for recovery. The buffer stays in memory; extracted WAV clips go to the Web app under its reference-audio controls.
