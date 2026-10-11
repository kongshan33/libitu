# Current routing/protocol release: 0.2.0

Web and extension now update together. Load the extension again and reload the Web/YouTube documents. The launcher opens `/practice/import`; learning uses `/practice/{contentId}` with `/segments` and `/shadow`. Only v4 is enabled; old root links and v2/v3 runtimes are unsupported. Content/video is checked through the public content endpoint; source-tab reuse uses a verified content mapping. The toolbar grant is still required. The additional `webNavigation` permission releases capture when the document changes.

`tests/workspace-v4.browser.mjs` validates real unpacked bridges, rejection of obsolete versions, same-content path navigation and full-document cleanup. Its default run never grants capture. `LIBITU_V4_CAPTURE=1` additionally requires a working real Chrome action shortcut (or manual action) and tests oscillator→tabCapture→PCM extraction. Automated shortcut attempts in this environment did not grant capture; do not count arm/close as live audio qualification. The retired v2 runtime has been removed.

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
- Run bounded caption preflight before opening the import page, leave content/processing API work to the Web app, and focus the existing reader on repeated clicks
- Hand browser captions to Stage 1 through a same-origin bridge and a 15-minute `chrome.storage.session` record, without putting transcript text in the URL
- Let the import page resolve content identity, then let the content workspace read existing results, ensure missing work and explicitly retry failed generations
- Keep the player button disabled with a hover reason for non-English or unknown-language videos, and show an action badge, title, and in-player message for unsupported toolbar clicks
- Enable one local reference-audio session in Stage 1 or Stage 2 after the learner chooses **Enable reference audio** and explicitly invokes the Libitu toolbar action in that same tab
- Use protocol v4 to buffer bounded mono PCM during confirmed normal-speed playback, retain covered spans across same-content stage/segment/sentence navigation, and extract only fully covered sentence WAV files
- Keep the audible monitor active while the grant exists; stop retaining new samples during idle time, microphone practice, replay, hidden-page suspension, missing telemetry, or unsupported playback speed. Disabling, changing source, reloading, closing the tab, worker restart or expiry clears the grant and buffer

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

Stage 1 opens after a bounded passive preflight following the existing lightweight metadata/language gate. The extension first checks observed page-memory captions and can wait up to six seconds for the observer's page event, without making a subtitle network request; it then uses the finite DOM-caption fallback and opens the import page. Server caption fallback belongs to subsequent processing. A response completed afterward becomes available on a later learner retry. Block-only JSON3 remains usable without invented offsets. Failed initial acquisition retains the existing server caption-text fallback, and a source-page navigation during the wait is rejected rather than attaching stale captions.

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
request:  { type: "LIBITU_FRESH_CAPTIONS_REQUEST", version: 4, contentId, requestId, sourceUrl, videoId, language }
response: { type: "LIBITU_FRESH_CAPTIONS_RESPONSE", version: 4, requestId, videoId, status, captionTrack? }
```

`status` retains `ready`, `no_matching_tab`, `no_word_offsets`, `unavailable`, `timeout`, `stale`, `invalid_request`, and `busy`, and adds `observer_missing`, `not_observed`, `request_failed`, `empty_response`, `invalid_response`, `response_too_large`, `observer_timeout`, and `bridge_error`. `ready` means raw offsets are present, not that every word qualifies for highlighting. `no_word_offsets` describes only the observed track, not every available track for the video. Missing early observers ask for a source-page refresh after extension reload; unobserved/failed player requests ask the learner to enable/re-enable English captions before retrying. Raw error messages, source text, and signed URLs are never included in failure responses.

The requesting page must be the top frame at a canonical content path on `http://localhost:3000`. The isolated bridge adds its document nonce; the background verifies content/video against the public read-only API. The background validates the extension sender, document, origin, language and source, then reads one already-open matching YouTube watch tab (preferring the requesting window, then an active tab). No matching tab means an explicit response, not an automatically opened tab. A single synchronous observer snapshot, 2.5-second injection bound, 3.5-second overall background bound and 4-second bridge bound prevent a refresh from waiting indefinitely.

This recovery reader never opens a DOM transcript panel, creates a job, reads/writes the old session handoff, or maintains another result cache. It consumes the early observer's bounded cache, so repeated reads do not create network traffic. An old ready text-only handoff and duplicate-entry focus cannot prevent a new read. One request per requesting tab and four across the extension can run at once; identical in-flight requests share work, others return `busy`. Source or requesting-page navigation discards stale results. Keep the corresponding YouTube tab open. Late installation, an expired caption cache or an already completed request may need a source refresh/re-enabled captions; repeated Libitu Retry alone does not cause a new player subtitle request.

### Stage 1 / Stage 2 buffered reference audio (v4)

Reload the unpacked extension and refresh the Libitu reader after updating. Chrome 116+ still requires one explicit toolbar invocation after the page arms the session; mounting Stage 1, loading JSON3, or selecting a sentence never grants capture automatically. The binding uses exact origin, Chrome tab/document, an isolated bridge nonce, content ID and canonical video ID. Reader/segments/Shadow paths, sentence, level and fragment changes within the content retain it. A full reload does not retain the grant.

The same-origin top-frame `buffer-bridge.js` accepts `{type:"LIBITU_BUFFER_REQUEST",version:4,contentId,videoId,sessionId,requestId,action}`. Session actions `ping`, `arm`, `heartbeat`, `close` and `observe` use `requestId === sessionId`. An observation adds `telemetry:{epochTime,wallTime,time,rate,state,generation}`: epoch and monotonic clocks use milliseconds, video time uses seconds, state is the numeric YouTube player state, and generation identifies a player/continuity epoch. Send observations approximately four times per second and an immediate non-playing observation when playback becomes ineligible. Extract requests use a unique ID and `{start,end}` in video seconds, at most 60 seconds.

Responses use `LIBITU_BUFFER_EVENT`, version 4 and `status`. Session statuses are `available`, `armed`, `enabled`, `coverage`, `closed`, `error`; extraction returns `complete`, `missing` or `error`. Coverage contains `{ranges:[{start,end}],retainedBytes,recording}`. Ranges retain separate continuity boundaries, may overlap after replay, and must not be merged to invent coverage across runs. Completion contains `{audioBase64,mimeType:"audio/wav",durationMs,start,end,captureId}`. The extension emits 16-bit little-endian mono PCM WAV at the actual AudioContext sample rate. `start/end` refer to the requested video window; sample duration is independently measured from the output file.

The offscreen AudioWorklet observes only the granted tab stream and preserves ordinary audible playback. It accumulates mono Int16 PCM in a ring bounded by ten minutes of capture-clock history and 64 MiB, whichever is smaller. Only intervals confirmed by consecutive 1× observations and actual retained PCM become extractable. Pause, seek, buffering, a different generation, timing discontinuity, non-1× speed or a missing PCM block creates a coverage boundary. Telemetry expires after 800 ms and the worklet independently stops collecting without renewed enable messages. The newest complete overlapping run is preferred after an explicit new listening pass. No WebM chunks are treated as independently decodable files.

Video-to-audio mapping remains a browser-clock estimate, with a 120 ms continuity tolerance; it is not acoustic alignment. Capture begins after the first eligible observation, so replay preparation should include bounded pre/post-roll. An interval starting at video zero can remain honestly uncovered if its first samples were missed. JSON3 cannot repair absent PCM, prove precise spoken word ends, or establish phoneme realization. Advertisements, alternate audio and other sounds within the captured tab are not automatically identified.

At most 4 extractions may be pending, 512 request IDs may be used per session, and each WAV is capped at 24 MiB (approximately 32 MiB base64). Coverage metadata is bounded to 4096 spans. Page heartbeats renew a 45-second lease; authorization has a separate 30-minute maximum in both worker and offscreen contexts. The browser retains media in memory only; ownership metadata is the only session storage record. This local experiment adds no media uploads, Supabase Storage, Realtime, MFA, public reference cache or production source-rights approval.

## Verification

`pnpm --filter @libitu/extension test` verifies English-language gating, unsupported feedback, launch ordering, duplicate clicks, receiver recovery, source checks, and session restoration without network calls. Caption tests cover passive fetch/XHR observation with original player results preserved, fine/block timing, duplicate occurrences, malformed/empty/oversized payloads, bounded copy cancellation without aborting the player request, TTL/cache limits, credential exclusion, SPA stale results, immediate snapshot reads, restart handoff, and bridge forwarding. `apps/web/tests/extension-handoff.test.mjs` covers Stage 1 bridge validation, cancellation, bounded fallback, and the API handoff. Mocked caption tests do not establish live YouTube request success or word-timing availability.

The v4 buffer tests additionally exercise sample-level WAV headers/content, video/capture-clock mapping, real PCM coverage, holes, seek/rate/generation changes, byte/time eviction, newest-pass selection, foreign/stale documents, single-session ownership, offscreen setup and late-delivery cancellation, disabled retention, track loss, and context/session cleanup. These tests use synthetic data and do not establish real-tab capture quality or speech-detector accuracy.

`tests/entry.browser.mjs` loads the actual unpacked extension in an isolated Chromium profile against a mocked YouTube SPA and mocked API. Its player fixture mirrors YouTube's nested left/right control groups so button insertion and control redraws remain covered. The Web import consumer and public metadata are fixtures; Web resolve/retry is tested separately by the Web browser suite. Run it with Node. `LIBITU_PLAYWRIGHT_MODULE` can point to an existing Playwright installation and `LIBITU_CHROMIUM_PATH` to a Chrome for Testing executable. Real YouTube DOM variants and actual model completion latency remain separate live checks.

`tests/fresh-captions.browser.mjs` loads the actual unpacked extension in its own temporary Chromium profiles with fully mocked YouTube, JSON3, and web pages. It exercises production document-start observation through actual player-fixture fetch/XHR calls, home-to-watch SPA navigation, background-tab cache reads, late installation, TTL, old handoff independence, block-only timing and stale-source rejection. Network counts must match only explicit player requests: neither observation nor Libitu Retry may add a request. The same Playwright/Chromium environment overrides apply; this is a bridge/runtime smoke test, not proof of live YouTube caption availability.
