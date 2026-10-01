# Stage 2 Milestone 3: local acoustic comparison

Status: implemented local analysis and comparison. The main-page flow now uses the [Stage 1/2 buffered reference session](STAGE_ONE_BUFFERED_REFERENCE.md), introduced 2026-09-13; the v2 per-sentence capture instructions below are retained for the legacy path. Live YouTube and learner-quality evaluation remain separate checks.

## Production direction

The accepted target is now [file-based reference preparation](STAGE_TWO_FILE_REFERENCE_ARCHITECTURE.md), with selected-segment acquisition proposed as the default. The file pipeline removes reference tab-capture authorization and mandatory real-time listening from the target flow. It remains unimplemented: all operational instructions and local inference details below describe the existing M3 prototype. Source permission, actual range-transfer capability, server runtime parity, and quality gates must be validated before migration.

This document describes the implemented local M3 prototype. The accepted production data policy now permits authenticated learner recordings and derived practice history to be uploaded and retained under separate controls for current analysis, long-term replay, and model training or human review. Training/review is opt-in and off by default.

Reference media follows a different ownership boundary. An ordinary YouTube session may persist approved source locators, sentence identities/bounds, and learner-owned attempts/results, but a browser-captured YouTube reference clip must not become a durable server asset without sufficient content and platform rights. Rights-cleared media supplied directly by its rights holder may use a separate server ingestion pipeline that stores one shared, versioned reference clip and feature set per sentence. User attempts reference that content asset rather than duplicating its bytes. See `DECISIONS.MD` and `design/docs/DATA_ARCHITECTURE.md`; neither the cloud persistence nor licensed ingestion path is implemented yet.

## Try the flow

1. Run `pnpm install`, then `pnpm dev` from the repository root. The web dev/build scripts prepare and verify the pinned acoustic assets automatically. An already-running dev server can use `pnpm --filter @libitu/web prepare:acoustics` once.
2. Use Chrome 116 or newer. Open `chrome://extensions`, reload the unpacked extension at `apps/extension`, and refresh the Libitu page so its new message bridge is loaded. New extension permissions are `tabCapture` and `offscreen`; no cloud API key is needed.
3. Open a completed Stage 1 blueprint and select a sentence in Stage 2. Wait until any video advertisement has ended.
4. Click **Enable practice audio**, then click the **Libitu toolbar icon on this same tab** once. Enabling connects audio for this practice; it does not start playback or encode a clip.
5. Use **Play sentence** at **1×** as usual. The application automatically captures and analyzes an uncached sentence as you listen. Keep the tab visible until it finishes. Loop on continues listening after the first capture without recording the loop again. A native player Play action at the selected boundary also works; simply switching sentences never starts playback.
6. Click **Record sentence**, speak, and **Stop recording**. Record and Replay cancel any active reference clip before opening the microphone or playing your take. Both recordings are analyzed asynchronously on this device; the first run fetches approximately 13 MiB of static model/runtime files before compression and caching.
7. Switch between Rhythm for timing/pauses and Melody for pitch/range, replay the take, and move to the next sentence. The audio session stays enabled. Returning to a prepared sentence uses its cached features immediately. Without a reference, both layers can still display the learner's own measurements. The microphone take remains tied to the current sentence and clears on sentence changes.

**Turn off practice audio** ends tab access while keeping derived results for this practice. Leaving Stage 2, changing content/segment or refreshing closes the session and clears the cache. A disconnected/expired session requires re-enabling. This is automatic preparation during real-time listening, not video download or ingestion-time preprocessing.

The current extension accepts only `http://localhost:3000`. A production domain requires a deliberate, consistent origin update in the manifest, entry/handoff code and reference bridges. Server credentials already used for Stage 1 do not change in this milestone.

## Implementation boundaries

| Owner | Responsibility | Main files |
|---|---|---|
| Web reference controller | Enable one session, begin eligible missing clips on listening, validate continuity, cancel clips independently of authorization | `apps/web/features/stage-two/reference/` |
| Chrome background | Verify top-frame origin/document/tab/session/clip, serialize clips, renew the page lease, manage offscreen lifetime and restart cleanup | `apps/extension/src/reference-capture.js` |
| Offscreen document | Consume one-use stream ID once per session, restore audible playback, create a fresh encoder only for each requested clip, release tracks/context on session end | `apps/extension/src/reference-offscreen.js` |
| Player | Emit raw time, state and rate telemetry before range completion, identifying native playback caused by a paused seek | `apps/web/features/stage-one/components/YouTubePlayer.tsx` |
| Acoustic worker | Silero V5 inference, resampling, Pitchy F0 and evidence quality gates | `apps/web/features/stage-two/acoustics/` |
| Analysis cache and panel | Bounded per-practice reference features, sequential analysis, local loading/retry, measurements and charts | `apps/web/features/stage-two/analysis/`, `components/AcousticComparisonPanel.tsx` |

The YouTube IFrame API provides controls and timestamps, not PCM. The extension captures the current web tab that contains the player. It uses Chrome's explicit extension-invocation grant; an ordinary web-page click cannot replace that grant. The offscreen AudioContext routes the captured stream to its destination because tabCapture suppresses the tab's normal output. No microphone is opened by reference capture.

Window/extension messages use protocol version 2 with separate session and clip identities. Session actions are `ping`, `arm`, `heartbeat` and `close`; clip actions are `begin`, `stop` and `cancel`. Reload the updated extension and refresh the page together; version 1 is unsupported. Page events require the same window and origin; extension requests require the same top-frame Stage 2 document and tab. The practice URL ignores only `sentenceId` and the hash, so content/source/segment changes close the old connection. Late clip events cannot affect a newer clip. The extension's capture token remains private to its own contexts. Raw bytes use transient bounded base64 messages because Chrome extension messaging uses JSON serialization. Only restart-recovery metadata enters `chrome.storage.session`; no raw audio or feature history is persisted.

The page allows 2 seconds for extension discovery and 40 seconds for enabling; the extension separately bounds toolbar invocation to 30 seconds and stream setup to 10 seconds. A new clip allows 5 seconds for encoder startup, 3 seconds for initial playback and 6 seconds for delivery after stopping. It accepts a selected range up to 60 seconds; the extension limits the full recording to 65 seconds with a 5-second encoding deadline. Initial position must be within 150 ms. After playback starts, unexpected state/rate changes, backwards movement, excessive wall-clock/media-clock divergence, or missing samples invalidate that clip while preserving a healthy session. Explicit Play retries; ordinary native samples do not retry indefinitely. These are playback-continuity guards, not acoustic alignment. Capture-relative trim offsets are estimated from recorder start and player telemetry.

The page sends a heartbeat every 10 seconds against a 45-second lease. The offscreen document also sends a worker heartbeat and independently limits a session to 30 minutes. At most 512 unique clip requests bound stale-request bookkeeping; ordinary cached loops do not consume another request. It uses the `USER_MEDIA` reason; `AUDIO_PLAYBACK` would close it after 30 seconds of silence. Between clips, only the tab stream and audible monitor remain connected: no MediaRecorder, chunks or retained PCM. Hiding the page cancels the active clip and pauses playback, while the connection remains subject to lease expiration. Close, navigation, tab removal, ended tracks, fatal connection failure and worker restart release the stream and AudioContext. A toolbar click during an enabled session turns it off.

All inference is local. The main thread decodes a bounded audio Blob, mixes mono/stereo and trims reference setup time. PCM moves to a dedicated Worker for 16 kHz resampling, stateful Silero inference and pitch extraction. Cancellation, result delivery, failure and the 90-second analysis deadline release the AudioContext/worker. A decoder already running inside the browser may finish after cancellation, but its stale result is ignored.

The practice owns an LRU cache of up to 20 reference results, keyed by analysis version, content ID, source URL, shared sentence ID and exact bounds. It runs one reference analysis at a time and accepts at most two queued/active raw clips totaling 12 MiB. Switching sentences can let already accepted analysis finish for its original key; that result never attaches to the newly selected sentence. Successful analysis (including insufficient-evidence results) releases raw bytes immediately. Model failure can retain a bounded retry input for up to 60 seconds, subject to earlier eviction for new work. The panel offers Retry analysis while those bytes exist and otherwise asks for normal playback again. Cached failures and insufficient results block automatic loop recapture; explicit Play can invalidate and reprepare them. Page exit/refresh clears the cache and pending work. These cache limits do not replace the separate microphone's one-take limit.

## Rhythm and Melody views

The practice workspace exposes Sound, Rhythm and Melody as separate persistent tabs with matching left-side shortcuts. Each has a central canvas and right-side layer focus; the original video, recording and practice-audio controls remain mounted in the shared operation area above the layers. Rhythm shows speaking span, internal pause count/duration and separate reference/user speech timelines. Melody shows median-relative pitch contours and pitch range, with a descriptive range difference when both voices have usable pitch. Empty axes and recovery guidance are shown before usable audio, without sample curves or scores.

Both acoustic panels read the same existing analysis results and reference cache. Switching tabs keeps the current sentence, playback, recording and Sound guide state; it creates no additional worker or analysis request. Inactive panels remain mounted but hidden, and tab keyboard navigation uses Left/Right, Home and End. Timing and pitch retain their independent quality gates. Rhythm explicitly leaves word stress unevaluated; Melody leaves nuclear stress and word-level curve alignment unevaluated.

## What the measurements mean

| Output | Meaning | Limit |
|---|---|---|
| Speaking span | Last detected speech end minus first speech start | Includes internal pauses; excludes outer silence |
| Internal pauses | Detected speech gaps at least 200 ms | Shorter gaps remain visible but are not counted |
| Pitch curve | `12 × log2(F0 / speaker median F0)` | Each voice has its own center; blank frames are unvoiced/unreliable |
| Pitch range | 90th minus 10th percentile, expressed in semitones | Describes variation, not a target accent or correctness |
| Horizontal position | Normalized progress from first to last speech | No word/phoneme alignment; unequal recordings may contain different words |

Timing abstains for near-silence, audio below 500 ms or detected speech below 400 ms. Pitch also requires accepted voiced estimates for at least 200 ms and 15% of detected speech. Missing pitch alone does not suppress usable timing. Tables and curves follow the same quality result. Model/decoder errors remain visible with Retry analysis and never fall back silently to synthetic features or an amplitude-only VAD.

No pronunciation score, content-consistency check, stress detector, phoneme alignment, or Sound phenomenon detector is implemented. Advertisements, music and overlapping speakers are not identified automatically. Caption boundaries remain approximate, so an incomplete sentence can still pass playback continuity checks. Pitchy is a practical baseline; accuracy on breathy/creaky voices, low pitch, accents, noisy microphones and octave errors needs human-labelled evaluation.

LLM rule inference remains distinct from audio evidence. M4a now adds a separate dictionary/rule Sound guide (`STAGE_TWO_SOUND.md`) for possible weak forms, linking, flaps, assimilation and elision; those suggestions cannot prove that either speaker actually realized them. No Sound detector is enabled. The M3 acoustic path does not introduce DeepSeek calls, Whisper, MFA, CREPE, a cloud scoring API or database changes.

## Assets and verification

Versions, model hashes, licenses, resampling and detector thresholds are recorded in `apps/web/features/stage-two/acoustics/README.md`. `prepare:acoustics` validates pinned source packages and file hashes, copies runtime/model/license assets to the ignored versioned public directory, and the worker checks model integrity before inference. Turbo build caching includes these generated public assets. Deploy the public directory alongside the Next.js build.

The normal web suite includes deterministic signal tests and fake-boundary lifecycle tests for decoders, workers, reference sessions and the bounded analysis cache. Extension tests cover multiple clips sharing one authorized stream, idle-without-encoding behavior, clip/session identity, cancellation races, sentence versus practice navigation, restart cleanup, lease/max-duration bounds, late permissions, final encoding and bridge validation.

`apps/web/tests/stage-two-acoustics.browser.mjs` runs actual Silero/Pitchy inference, same-origin model/WASM loading and Chrome microphone encoding on an existing dev server. It uses a generated artificial English voice and a simulated extension/YouTube player, verifies desktop/mobile output and capture failures, and asserts no media/feature API mutations. On macOS it generates a fixture with `say` and `ffmpeg`; alternatively set `LIBITU_SPEECH_WAV` to a 6-second speech WAV. `LIBITU_PLAYWRIGHT_MODULE` may point to an existing Playwright runtime.

Existing M1 navigation and M2 recording browser regressions remain applicable. Passing synthetic cases establishes the local integration and state/resource behavior; it does not establish real-speaker detector accuracy, live YouTube seek precision, or mobile/Safari reference-capture support. Detailed run results are recorded in `TASK.MD`.

The optional `apps/extension/tests/reference.browser.mjs` loads the real unpacked extension in an isolated Chrome profile. `LIBITU_REFERENCE_BRIDGE_ONLY=1` verified v2 `armed → closed` and removal of transient metadata with no active capture/offscreen document. This environment's CDP keyboard input did not invoke Chrome's toolbar action. Full capture verification therefore remains explicit: use `LIBITU_REFERENCE_HEADFUL=1 LIBITU_REFERENCE_MANUAL_ACTION=1`, then invoke Libitu in that isolated test window while it is armed. The full test requires two decoded, non-silent local-oscillator clips across a sentence URL change from one authorized session, followed by stream/offscreen cleanup; it has not passed here without that physical toolbar action.
