# Analysis result query benchmark — 2026-10-17

Status polling now reads the owned Take, analysis and relevant Reference data through one service-only SQL snapshot. It previously made 3, 5 or 7 serial database requests depending on the analysis state. The response excludes raw acoustic checkpoints and unrelated Reference sentences. Ownership, source visibility, deletion, expiry, sentence identity and live local source grants remain enforced. Hosted migration: `20261017094154_practice_analysis_read_snapshot`.

## Measured results

Three alternating trials per mode, using the same 4.22-second public speech clip, prepared Reference, merged submission API and independent fast/fine workers. Times below are medians in seconds.

| Measurement | Previous serial reads | Snapshot read |
| --- | ---: | ---: |
| Submit request | 2.765 | 2.648 |
| Start submission → word feedback rendered | 13.285 | 10.700 |
| Start submission → preliminary Rhythm/Melody rendered | 14.089 | 12.017 |
| Status request before preliminary output, API duration | 0.828 | 0.272 |
| Status request across all phases, API duration | 1.362 | 0.284 |
| Database requests per status request | 3 / 5 / 7 | 1 |

Preliminary output appeared 2.072 seconds earlier at the median (14.7%); word feedback appeared 2.585 seconds earlier (19.5%). This small sample includes ASR and network variation, so the entire end-to-end difference cannot be attributed to database reads alone. Submission code was identical in both modes.

| Trial | Read mode | Submit | Word feedback | Preliminary curves |
| --- | --- | ---: | ---: | ---: |
| 1 | Serial | 3.588 | 15.003 | 15.003 |
| 2 | Snapshot | 2.648 | 12.218 | 12.218 |
| 3 | Serial | 2.765 | 13.285 | 13.285 |
| 4 | Snapshot | 2.627 | 10.654 | 11.937 |
| 5 | Serial | 2.706 | 10.672 | 14.089 |
| 6 | Snapshot | 2.674 | 10.700 | 12.017 |

All six trials returned 10/10, `full_85_plus`, displayed both Reference and learner curves, and subsequently completed fine analysis. Polling still waits one second after each response. Faster reads therefore generate more polls per unit of time, but each poll now requires only one database request. Before preliminary output, 17 serial and 24 snapshot polls were measured; across all phases, 45 and 83 respectively.

## Remaining cost

Worker stage medians across six Takes:

| Stage | Seconds | Range |
| --- | ---: | ---: |
| ASR and word check | 5.665 | 5.130–6.879 |
| Server signal extraction | 0.311 | 0.265–0.356 |
| CWT | 0.042 | 0.033–0.056 |
| Enter checking-words checkpoint | 0.273 | 0.251–0.328 |
| Publish word check | 0.917 | 0.836–1.133 |
| Publish coarse result and hand off | 0.480 | 0.438–0.511 |

ASR remains the largest fast-path compute cost. Submission still takes about 2.65 seconds, with additional queue, persistence and polling time before rendering. The 5–8-second first-results target has not been reached. ASR parameter evaluation and reducing queue/persistence delays are future work; no model parameters, polling intervals or queue policies changed in this increment.

## Method and limits

- Local macOS: Intel i5-8279U at 2.40 GHz, four physical/eight logical cores, 16 GiB RAM. API and workers run locally against hosted Supabase database/storage. These are not target-cloud timings.
- Chromium benchmark page reuses production `PracticeOutbox`, API submission, polling hook and `ProgressiveComparison`. Authentication and source blueprint are fixtures; this is not a whole-practice-page benchmark.
- Browser timing starts before file input and includes file reading/hash, upload, queueing, computation, persistence, polling and DOM rendering plus two animation frames. Recording duration is excluded. API request durations in the table use the server wrapper and exclude browser/proxy overhead; end-to-end browser times include it.
- Both modes use merged submission and the same checkpoint workers. Only baseline GET analysis requests are routed to a frozen copy of the preceding serial-read implementation. That route exists only in the isolated benchmark API. Each trial waits for fine completion before the next starts; no builds/tests run during measurement.
- Resident ASR was warm; history audio retention was off. Its independent switch and the 60%/85% rules remain unchanged. No original-audio acquisition code changed.
- Reference was prepared before Take timing: creation/upload 5.838 seconds, final ready 34.278 seconds. Reference preparation is excluded from the table, so these results do not describe a simultaneously unprepared Reference.
- Reference and Take use the same public clip (Take encoded as Opus). The Reference fixture lacks subtitle word boundaries, so its signal curves are available while coarse per-word Reference prominence is uncertain. This validates transport/processing/rendering timing, not pronunciation or stress accuracy.
- Fixture rows and audio were removed. A separate hosted query confirmed zero benchmark Takes, analyses, References and contents. Temporary browser route and benchmark API were removed/stopped. Normal development services remain running.

## Evidence and reproduction

- [Summary](summary.json), [API/database trace](live.json), [browser timings](browser.json), [worker stages](worker-stages.json).
- Screenshots `browser-1.png` through `browser-6.png`; final snapshot screenshot visually checked for word feedback and both preliminary comparisons.
- Runner: `apps/api/scripts/benchmark_practice_submission.py`; old read fixture: `apps/api/scripts/fixtures/practice_analysis_serial_read.py`.

With the normal development stack and workers running, from `apps/api`:

```sh
LIBITU_PLAYWRIGHT_MODULE=/path/to/playwright \
  .venv/bin/python -m scripts.benchmark_practice_submission --run-live --compare-reads \
  --audio /path/to/speechocean762/0036/000360034.wav \
  --text 'WE SPEAK OUT WHEN WE FEEL WE SHOULD SPEAK OUT' \
  --output ../../design/benchmarks/result-query-20261017/live.json
```

The runner writes disposable rows/audio to configured Supabase and cleans them up. It requires a free local port 8001 and no existing temporary submission-benchmark page.

## Verification

Root `pnpm lint`, `pnpm build` and `pnpm test` passed: 996 API, 370 Web and 114 extension tests. A final focused service/read run passed 46 tests. Disposable PostgreSQL SQL regressions passed for missing/foreign/deleted Takes, absent analyses, source access, Reference ownership/expiry/deletion, field projection and function grants. Hosted migration and service-only execute permissions were verified. The existing informational RLS-without-policy advisor item on `private.content_payloads` is unrelated to this change.

This increment does not deploy the application to a cloud host. Realtime, streaming upload, asynchronous storage and Reference prewarming remain separate work.
