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
- Passively observe the player's current-video English JSON3 fetch/XHR responses from document start, retaining only sanitized millisecond events and segment offsets; if no usable response is observed, retain the existing timestamped DOM-caption fallback
- Recover the content-script connection after an extension reload by injecting it into the active YouTube watch tab
- Open the Next.js page before caption capture or API requests, and focus the existing reader on repeated clicks
- Hand browser captions to Stage 1 through a same-origin bridge and a 15-minute `chrome.storage.session` record, without putting transcript text in the URL
- Let Stage 1 create/resume the content and job, stream analysis, and preserve content/job IDs for reload and Retry
- Keep the player button disabled with a hover reason for non-English or unknown-language videos, and show an action badge, title, and in-player message for unsupported toolbar clicks
- Enable one local reference-audio session in Stage 1 or Stage 2 after the learner chooses **Enable practice audio** and explicitly invokes the Libitu toolbar action in that same tab
- Use protocol v3 to buffer bounded mono PCM during confirmed normal-speed playback, retain covered spans across same-content stage/segment/sentence navigation, and extract only fully covered sentence WAV files
- Keep the audible monitor active while the grant exists; stop retaining new samples during idle time, microphone practice, replay, hidden-page suspension, missing telemetry, or unsupported playback speed. Disabling, changing source, reloading, closing the tab, worker restart or expiry clears the grant and buffer
- Preserve protocol v2 compatibility for the previous per-sentence encoder client; v2 and v3 share a single offscreen/media ownership lease and cannot capture concurrently

It does not yet:

- Guarantee captions exist for every video
- Guarantee JSON3 contains word-level timing or any individual word's end time; a segment can contain a whole caption block, and event duration describes caption display rather than verified speech boundaries
- Establish live YouTube timing precision or isolate reference speech from other sounds in the captured tab
- Analyze acoustic features inside the extension; Stage 2 playback, microphone capture, and local analysis are owned by the web app

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

After updating the unpacked extension, reload it at `chrome://extensions`, refresh the YouTube source page once, and refresh the Libitu reader. On a Libitu launch, the extension now makes a bounded best-effort attempt to select an advertised English automatic caption track through the visible YouTube controls, waits for the player's own response, and restores the previous caption state after the read. This may fail when YouTube changes its menus or requires a trusted gesture; **Retry word timing** remains available. The toolbar can recover the ordinary missing content-script receiver, but cannot retroactively observe subtitle responses from before the early observer was installed. No production deployment is needed. The web origin is currently `http://localhost:3000`; keep `manifest.json`, `src/background.js`, and the running web server aligned when changing it.

### Caption-first handoff

`youtube-caption-observer.js` runs as a top-frame `document_start` MAIN script across YouTube pages, including home-to-watch SPA entry. It observes only the player's own same-origin `/api/timedtext` GET responses requesting English, non-translated `fmt=json3`. Fetch responses are read through a bounded clone; XHR uses separate completion listeners for text/JSON responses. Original promises, responses, errors and event handlers remain owned by the player. The observer never rebuilds or replays signed URLs, generates/refreshes tokens, changes caption settings, starts playback or requests media. The separate launch preflight may best-effort use visible caption controls when captions are off, then restores that state. Other page/extension wrappers can interfere, so this remains best-effort rather than an official guaranteed caption interface.

The observer keeps at most four current-video tracks / 4 MiB for 15 minutes and copies at most two responses concurrently. Each copy has a 2 MiB decoded-body limit and two-second read deadline; cancelling it never aborts the original player request. At most four pending XHR observations retain listeners, which are removed on completion, reuse, navigation or page exit. Navigation and page exit invalidate old response generations, including A-to-B-to-A changes. Word-offset tracks take precedence over block-only tracks. Only sanitized captions remain in page memory; no request headers or signed URLs are cached.

Stage 1 opens after a bounded passive preflight following the existing lightweight metadata/language gate. The reader first checks observed page-memory captions and can wait up to six seconds for the observer's page event, without making a subtitle network request; it then uses the existing finite DOM/server-caption fallback and opens the page. A response completed afterward becomes available on a later learner retry. Block-only JSON3 remains usable without invented offsets. Failed initial acquisition retains the existing server caption-text fallback, and a source-page navigation during the wait is rejected rather than attaching stale captions.

The same 15-minute session handoff returns `transcriptText` for compatibility and optional `captionTrack`:

```text
{ version: "youtube-json3-v1", video_id, language, kind: "asr" | "manual" | "unknown",
  events: [{ tStartMs, dDurationMs?, segs: [{ utf8, tOffsetMs? }], aAppend?, wWinId? }] }
```

Only these caption fields cross the bridge. Signed track URLs and their query parameters are never returned, logged, or stored by this reader. Missing offsets remain missing; the extension does not invent word ends or convert raw millisecond timings into integer seconds. Compatibility text uses fractional-second timestamps, while the original safe event fields remain unchanged. Window/style-only events are omitted; textual events and repeated DOM caption occurrences are not deduplicated by text or timestamp. A SPA navigation invalidates a pending request even when the learner returns to the original video before it resolves.

The reader accepts at most 2 MiB of JSON, 10,000 source events, 12,000 segments per event, 50,000 total segments, and 240,000 text characters. Millisecond values must be integers from 0 through 604,800,000; `aAppend` must be 0 or 1. Over-limit payloads fall back as a whole rather than silently truncating the source. Compatibility timestamps use hours for long videos. These are transport bounds, not a promise that all videos expose valid JSON3 or fine-grained alignment.

### Refreshing timing for an already-open reader

The web app can explicitly request fresh caption metadata without an old `handoffId`, reopening Stage 1, or restarting analysis. The same top-frame bridge accepts:

```text
request:  { type: "LIBITU_FRESH_CAPTIONS_REQUEST", requestId, sourceUrl, videoId, language }
response: { type: "LIBITU_FRESH_CAPTIONS_RESPONSE", requestId, videoId, status, captionTrack? }
```

`status` retains `ready`, `no_matching_tab`, `no_word_offsets`, `unavailable`, `timeout`, `stale`, `invalid_request`, and `busy`, and adds `observer_missing`, `not_observed`, `request_failed`, `empty_response`, `invalid_response`, `response_too_large`, `observer_timeout`, and `bridge_error`. `ready` means raw offsets are present, not that every word qualifies for highlighting. `no_word_offsets` describes only the observed track, not every available track for the video. Missing early observers ask for a source-page refresh after extension reload; unobserved/failed player requests ask the learner to enable/re-enable English captions before retrying. Raw error messages, source text, and signed URLs are never included in failure responses.

The requesting page must be the top frame at `http://localhost:3000/`, and its URL must contain a `sourceUrl` matching the requested YouTube video. The background validates the extension sender, document, origin, language and source, then reads one already-open matching YouTube watch tab (preferring the requesting window, then an active tab). No matching tab means an explicit response, not an automatically opened tab. A single synchronous observer snapshot, 2.5-second injection bound, 3.5-second overall background bound and 4-second bridge bound prevent a refresh from waiting indefinitely.

This recovery reader never opens a DOM transcript panel, creates a job, reads/writes the old session handoff, or maintains another result cache. It consumes the early observer's bounded cache, so repeated reads do not create network traffic. An old ready text-only handoff and duplicate-entry focus cannot prevent a new read. One request per requesting tab and four across the extension can run at once; identical in-flight requests share work, others return `busy`. Source or requesting-page navigation discards stale results. Keep the corresponding YouTube tab open. Late installation, an expired caption cache or an already completed request may need a source refresh/re-enabled captions; repeated Libitu Retry alone does not cause a new player subtitle request.

### Stage 1 / Stage 2 buffered reference audio (v3)

Reload the unpacked extension and refresh the Libitu reader after updating. Chrome 116+ still requires one explicit toolbar invocation after the page arms the session; mounting Stage 1, loading JSON3, or selecting a sentence never grants capture automatically. The source tab/document identity ignores only `stage`, `segmentId`, `sentenceId` and the fragment. Other URL parameters, including content/source identity, remain binding. A full reload does not retain the grant.

The same-origin top-frame `buffer-bridge.js` accepts `{type:"LIBITU_BUFFER_REQUEST",version:3,sessionId,requestId,action}`. Session actions `ping`, `arm`, `heartbeat`, `close` and `observe` use `requestId === sessionId`. An observation adds `telemetry:{epochTime,wallTime,time,rate,state,generation}`: epoch and monotonic clocks use milliseconds, video time uses seconds, state is the numeric YouTube player state, and generation identifies a player/continuity epoch. Send observations approximately four times per second and an immediate non-playing observation when playback becomes ineligible. Extract requests use a unique ID and `{start,end}` in video seconds, at most 60 seconds.

Responses use `LIBITU_BUFFER_EVENT`, version 3 and `status`. Session statuses are `available`, `armed`, `enabled`, `coverage`, `closed`, `error`; extraction returns `complete`, `missing` or `error`. Coverage contains `{ranges:[{start,end}],retainedBytes,recording}`. Ranges retain separate continuity boundaries, may overlap after replay, and must not be merged to invent coverage across runs. Completion contains `{audioBase64,mimeType:"audio/wav",durationMs,start,end,captureId}`. The extension emits 16-bit little-endian mono PCM WAV at the actual AudioContext sample rate. `start/end` refer to the requested video window; sample duration is independently measured from the output file.

The offscreen AudioWorklet observes only the granted tab stream and preserves ordinary audible playback. It accumulates mono Int16 PCM in a ring bounded by ten minutes of capture-clock history and 64 MiB, whichever is smaller. Only intervals confirmed by consecutive 1× observations and actual retained PCM become extractable. Pause, seek, buffering, a different generation, timing discontinuity, non-1× speed or a missing PCM block creates a coverage boundary. Telemetry expires after 800 ms and the worklet independently stops collecting without renewed enable messages. The newest complete overlapping run is preferred after an explicit new listening pass. No WebM chunks are treated as independently decodable files.

Video-to-audio mapping remains a browser-clock estimate, with a 120 ms continuity tolerance; it is not acoustic alignment. Capture begins after the first eligible observation, so replay preparation should include bounded pre/post-roll. An interval starting at video zero can remain honestly uncovered if its first samples were missed. JSON3 cannot repair absent PCM, prove precise spoken word ends, or establish phoneme realization. Advertisements, alternate audio and other sounds within the captured tab are not automatically identified.

At most 4 extractions may be pending, 512 request IDs may be used per session, and each WAV is capped at 24 MiB (approximately 32 MiB base64). Coverage metadata is bounded to 4096 spans. Page heartbeats renew a 45-second lease; authorization has a separate 30-minute maximum in both worker and offscreen contexts. The browser retains media in memory only; ownership metadata is the only session storage record. This local experiment adds no media uploads, Supabase Storage, Realtime, MFA, public reference cache or production source-rights approval.

### Legacy Stage 2 reference audio (v2 compatibility)

Use Chrome 116 or newer. Reload the unpacked extension, then refresh the Stage 2 page so both use protocol v2. Choose **Enable practice audio** and click the Libitu toolbar icon in that same tab within 30 seconds. Once enabled, requested sentences record automatically when the page asks to capture their reference, using the same authorized stream. The page starts sentence playback only after its encoder is running. Keep other tab sounds and microphone replay stopped during each reference recording.

Authorization remains active between sentences, including while the learner records or replays a microphone take; the extension keeps the tab-audio monitor available but creates no encoder or application recording buffers in those states. Disable reference audio in Stage 2 or click the Libitu toolbar icon again to end the session. Full page reload, leaving Stage 2, changing content/source/segment, tab closure, a lost device, or worker restart ends authorization and requires enabling it again.

The `tabCapture` permission requires an explicit extension invocation; a page message alone never opens the tab stream. Chrome's tab stream suppresses normal local audio output, so the offscreen document routes it through an AudioContext monitor until the session closes. This follows Chrome's [tabCapture integration](https://developer.chrome.com/docs/extensions/reference/api/tabCapture) and [service worker/offscreen capture guidance](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture). The document uses the `USER_MEDIA` reason: `AUDIO_PLAYBACK` would impose a 30-second silence timeout, which is unsuitable for an authorized stream retained between sentences. See [offscreen document lifetime rules](https://developer.chrome.com/docs/extensions/reference/api/offscreen#reasons).

The bridge accepts only top-frame `http://localhost:3000` pages whose URL has `stage=2`. Each session is bound to its ID, tab, document and practice URL; only `sentenceId` and the URL fragment may change without ending it. Each clip has a separate single-use request ID and a selected range of at most 60 seconds. One session and one encoder may be active across the extension. A cancelled encoder must acknowledge cleanup before the next begins, and stale clip commands cannot affect its replacement.

The page sends a heartbeat every 10 seconds; authorization expires after 45 seconds without one. An independent offscreen maximum closes the session after 30 minutes. Session setup and clip startup have 10-second bounds, active recording 65 seconds, and finalization 5 seconds. A session accepts at most 512 distinct clip requests to bound stale-request bookkeeping. Raw clips remain in memory and are limited to 6 MiB before base64 encoding (8 MiB in the local message). Only session/tab/document metadata enters `chrome.storage.session` for restart cleanup; audio is never uploaded or persisted. Capture times describe browser timing, not acoustic alignment.

## Verification

`pnpm --filter @libitu/extension test` verifies English-language gating, unsupported feedback, launch ordering, duplicate clicks, receiver recovery, source checks, and session restoration without network calls. Caption tests cover passive fetch/XHR observation with original player results preserved, fine/block timing, duplicate occurrences, malformed/empty/oversized payloads, bounded copy cancellation without aborting the player request, TTL/cache limits, credential exclusion, SPA stale results, immediate snapshot reads, restart handoff, and bridge forwarding. Reference tests check two clips reusing one authorized stream, no idle encoding, ownership validation, serialized cancellation and replacement, stale events, URL containment, heartbeat/session limits, payload limits, final chunks, and restart/resource cleanup. `apps/web/tests/extension-handoff.test.mjs` covers Stage 1 bridge validation, cancellation, bounded fallback, and the API handoff. Mocked caption tests do not establish live YouTube request success or word-timing availability.

The v3 buffer tests additionally exercise sample-level WAV headers/content, video/capture-clock mapping, real PCM coverage, holes, seek/rate/generation changes, byte/time eviction, newest-pass selection, foreign/stale documents, shared v2/v3 ownership, offscreen setup and late-delivery cancellation, disabled retention, track loss, and context/session cleanup. These tests use synthetic data and do not establish real-tab capture quality or speech-detector accuracy.

`tests/entry.browser.mjs` loads the actual unpacked extension in an isolated Chromium profile against a mocked YouTube SPA and mocked API. Its player fixture mirrors YouTube's nested left/right control groups so button insertion and control redraws remain covered. Start the web server on port 3000, then run it with Node. `LIBITU_PLAYWRIGHT_MODULE` can point to an existing Playwright installation and `LIBITU_CHROMIUM_PATH` to a Chrome for Testing executable. Real YouTube DOM variants and actual model completion latency remain separate live checks.

`tests/fresh-captions.browser.mjs` loads the actual unpacked extension in its own temporary Chromium profiles with fully mocked YouTube, JSON3, and web pages. It exercises production document-start observation through actual player-fixture fetch/XHR calls, home-to-watch SPA navigation, background-tab cache reads, late installation, TTL, old handoff independence, block-only timing and stale-source rejection. Network counts must match only explicit player requests: neither observation nor Libitu Retry may add a request. The same Playwright/Chromium environment overrides apply; this is a bridge/runtime smoke test, not proof of live YouTube caption availability.

`tests/reference.browser.mjs` uses an isolated temporary extension copy with a test-only action shortcut and a local oscillator. Its strict mode requires one session to produce two decoded, non-silent reference clips across a sentence URL change, followed by stream/document cleanup. It uses no microphone or external media and cannot establish live YouTube quality; use `LIBITU_REFERENCE_HEADFUL=1` if a browser build does not dispatch extension shortcuts in headless mode.

Some macOS Chrome builds do not dispatch extension shortcuts from Playwright keyboard events in either mode. `LIBITU_REFERENCE_BRIDGE_ONLY=1` verifies the real unpacked v2 bridge's arm/close and metadata cleanup without claiming capture passed. `LIBITU_REFERENCE_HEADFUL=1 LIBITU_REFERENCE_MANUAL_ACTION=1` leaves the toolbar invocation to a human in the isolated test window; the strict remaining assertions still require actual recorded, decoded audio and cleanup. The production tabCapture path requires this end-to-end check before claiming live source feasibility.
