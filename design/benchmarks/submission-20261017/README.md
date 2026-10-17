# Consolidated submission and coarse checkpoint — 2026-10-17

Implemented in the f9dc checkout; migration `20261017091904_consolidated_practice_submission` is applied to the connected hosted Supabase. API/web/fast/fine workers run locally. This is not a target-cloud benchmark or an accuracy evaluation.

## What changed

- Analysis-enabled saves use one authenticated multipart `POST /api/practice/attempts/submit` instead of create Take → create analysis → upload audio. Registration of profile/Take/analysis is transactional; the reply is a small Take acknowledgment.
- Cloud object upload still finishes before queueing. The local TTL cache is not used as durable storage. No asynchronous cloud upload or streaming microphone capture was introduced.
- Word-check publication remains immediate and separate. Following it, phase/features/coarse output/fine handoff changed from four worker calls to one atomic fenced RPC. Reference coarse publication/handoff changed from two calls to one.
- The immutable Take identity, Reference binding, deletion fences and independent history-retention consent remain intact. Retention can retry after analysis completes without recreating its cleaned input or resetting its state.
- Original audio acquisition, quality checks, ASR model/parameters and exact 60%/85% gates are unchanged.

## Method and limits

A public SpeechOcean762 sample (`0036/000360034.wav`, 4.22 seconds, “WE SPEAK OUT WHEN WE FEEL WE SHOULD SPEAK OUT”) is used as Reference WAV and a separately encoded Opus Take. This is the same public clip as the preceding lane experiment.

Six trials alternate legacy/merged submission, three per mode, with a prepared Reference and warm resident ASR. Each trial finishes its fine job before the next begins; this is an idle-queue comparison, not an overload test. Both modes use the **new atomic-checkpoint workers**: this A/B isolates submission behavior, not the checkpoint optimization's independent time saving. Host load, ASR and network timing vary between trials.

A temporary browser harness uses the production `createPracticeApi`, `PracticeOutbox` (merged mode), `usePracticeAnalysis` and `ProgressiveComparison`. The legacy path calls the existing three methods in their original sequence. Chromium sends real requests through a loopback fixture API to real hosted Storage/Postgres and independent local workers. Only authentication and the source blueprint are fixtures; processing/results are real.

The timer starts immediately before selecting the already-recorded audio file and includes file reading/hash, submission, queue pickup, computation, database publication, production polling and DOM rendering. “Visible” is DOM insertion plus two animation frames. It is **a benchmark page reusing production components**, not a claim that the entire practice page was profiled. Recording duration, Reference preparation and history-retention upload are outside this timing. History saving is off in these timing runs; its independent on/off and retry semantics are covered by tests.

The Reference fixture has no subtitle word boundaries. Its server F0/energy curves are available; per-word Reference prominence remains unknown. Neither displayed prominence nor 10/10 content matches are pronunciation-accuracy validation.

## Results

Seconds, three-trial medians:

| Measurement | Legacy three requests | Merged request |
|---|---:|---:|
| First submission request → submission response | 7.188 | 3.030 |
| Begin submission → word check rendered | 18.550 | 11.918 |
| Begin submission → preliminary Rhythm/Melody rendered | 18.550 | 14.550 |

Observed reduction in medians: submission 58%, first word feedback 36%, preliminary curves 22%. Small sample size and ASR/network variation prevent attributing every second of the end-to-end difference to this code change.

| Trial | Mode | Submission | Word check visible | Preliminary visible |
|---|---|---:|---:|---:|
| 1 | Legacy | 8.013 | 18.673 | 18.674 |
| 2 | Merged | 3.482 | 16.168 | 16.168 |
| 3 | Legacy | 7.188 | 18.550 | 18.550 |
| 4 | Merged | 2.875 | 11.023 | 13.707 |
| 5 | Legacy | 6.903 | 15.045 | 17.679 |
| 6 | Merged | 3.030 | 11.918 | 14.550 |

All six runs matched 10/10 source words, reached `full_85_plus`, rendered both server signal curves and completed their fine jobs. Reference preparation, measured separately before the trials, took 5.158 seconds for registration/upload and 42.413 seconds to final readiness. This does not add to the prepared-Reference timings above.

Measured worker stages across the six runs:

| Stage | Median | Range |
|---|---:|---:|
| ASR and word checking | 6.592 | 5.889–7.342 |
| VAD/F0/energy extraction | 0.325 | 0.291–0.447 |
| Signal CWT | 0.042 | 0.030–0.059 |
| Word-check publication | 0.938 | 0.817–1.122 |
| Atomic coarse publication and fine handoff | 0.498 | 0.480–0.935 |

The new submission's core database path has six calls in this fixture, versus 18–20 on the legacy path, excluding object storage and the mocked blueprint retrieval. Raw API traces also contain polling/cleanup; the first poll can overlap the browser's response-end timestamp.

The first-result target of 5–8 seconds is **not yet achieved**. ASR is the largest measured computation; CWT is negligible here. The browser's one-second polling interval is a sleep **after** the previous HTTP response. Status reads still serially fetch Take, analysis and Reference/source data, so actual observation spacing exceeds one second. Next: consolidate status reads while retaining ownership/deletion checks, then consider push notifications. Tune ASR only in a separate evaluated change; keep current content tiers stable.

## Verification

- Root `pnpm lint`, `pnpm build`, `pnpm test` passed: 984 API, 370 Web and 114 extension tests. Focused worker checks passed after timing logs were added; final TypeScript check passed after removing the generated benchmark route types.
- New API tests cover multipart validation/size/auth, no mutation on invalid input, response-loss replay, deletion during upload, and retention-only retry after analysis cleanup.
- Disposable PostgreSQL: registration/replay/owner/deletion tests and atomic handoff rollback/lease/gate tests pass. Hosted service-only privileges verified.
- `stage-two-practice-flow.browser.mjs` and `browser-reference-server.browser.mjs` pass at desktop/mobile sizes, including real MediaRecorder and fixture server results.
- The older `server-reference.browser.mjs` stops at its pre-submission assertion for obsolete “File reference ready.” text. It also expects layer access before recording, which predates the current practice flow. This legacy suite is not counted as passing.
- Supabase security advisor reported only the existing informational policy absence on `private.content_payloads`, outside this change ([advisor explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)).
- Benchmark Take/Reference/content/profile rows and private audio were removed. The temporary browser route was removed; normal local services remain running.

## Reproduce

From `apps/api`, with the normal fast/fine workers and web development server running, and no other benchmark occupying port 8001:

```sh
LIBITU_PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
  .venv/bin/python -m scripts.benchmark_practice_submission --run-live \
  --audio /absolute/path/to/public-sample.wav \
  --text 'WE SPEAK OUT WHEN WE FEEL WE SHOULD SPEAK OUT' \
  --output ../../design/benchmarks/submission-20261017/live.json
```

Use a new output directory for another run to preserve this measurement. This opt-in runner writes temporary public-sample records to the configured Supabase and cleans them in `finally`; do not use an arbitrary private audio file without the owner's consent.

Evidence: [browser requests and render timestamps](browser.json), [worker stage durations](worker-stages.json), [summary](summary.json), [API/database calls and cleanup](live.json), and screenshots `browser-1.png` through `browser-6.png`.
