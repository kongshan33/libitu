# Local independent worker benchmark — 2026-10-16

Machine: Intel MacBook Pro, i5-8279U, four physical/eight logical CPU cores. No cloud CPU results. Public SpeechOcean762 clip `000360034.wav`, 4.22 seconds, “WE SPEAK OUT WHEN WE FEEL WE SHOULD SPEAK OUT”. This is a controlled same-input timing probe, not the user's private Take or a pronunciation accuracy evaluation.

## Controlled queue and CPU comparison

Actual small.en ASR, Praat/Silero/energy, PyWavelets CWT and MFA 3.3.9. Resident ASR startup and one warm-up MFA alignment are excluded. Three rounds rotate mode order. Fine processes use the same native-thread cap and nice setting across modes, so the comparison isolates queue separation and cooperative preemption, rather than attributing all changes to priority settings. Every run independently starts an MFA job; a new Take arrives 0.5 seconds after that job starts. `serial` waits for that MFA, modeling the old worker backlog; `parallel` runs immediately alongside MFA; `yield` runs immediately while the MFA process group yields. The controlled arrival and queue wait are simulated; inference is real.

These timings exclude upload, PostgreSQL, frontend polling and browser paint. They must not be described as upload-to-screen latency.

| Mode | Arrival → coarse, three runs (seconds) | Median (seconds) |
| --- | --- | --- |
| serial | 27.90 / 22.73 / 21.52 | 22.73 |
| parallel | 5.95 / 13.25 / 9.28 | 9.28 |
| yield | 5.37 / 5.06 / 4.39 | 5.06 |

All nine ASR results matched 10/10 source words, retained the `full_85_plus` tier and produced ten coarse word windows. All nine MFA alignments completed. No matching threshold, beam size, original-audio acquisition, or alignment quality check changed. Three runs are a smoke comparison, not p95/p99 capacity evidence. Thermal state and other OS activity still affect results.

With yielding, the median is 5.06 seconds versus 22.73 seconds in the simulated original backlog (about 78% shorter), or 9.28 seconds with unsupervised parallelism (about 45% shorter). The largest benefit is removing MFA queue wait. ASR is still the dominant fast computation: 4.07–5.03 seconds in yielded runs; signal extraction 0.30–0.31 seconds; CWT 0.026–0.033 seconds. MFA paused for approximately 4.35–5.35 seconds, and finished in 17.61–30.62 seconds of wall time. Giving fast jobs priority deliberately delays fine work under load; this does not promise faster final completion or higher throughput.

Raw results: [compute.json](compute.json). Runner: `apps/api/scripts/benchmark_worker_lanes.py`.

## Scheduling guarantees and limitations

Fast and fine are separate OS processes and separate durable PostgreSQL lanes. Handoff clears the fast lease atomically; old tokens cannot publish. Eligible Takes are checked before References in each lane. Fast crashes release the activity lock; a supervisor kills and reaps MFA when its parent worker dies, including while MFA is stopped. Heartbeats continue during pauses. Active MFA timeouts exclude pauses but wall time is bounded by active timeout + 900 seconds. Continuous fast load can starve fine work until this cap; scale/separate hosts before claiming multi-user capacity.

macOS uses cooperative process-group pause/resume (50 ms polling), nice 10, and one native library thread in fine. This is not hard core affinity. Optional Linux disjoint CPU affinity and systemd templates are implemented but untested on a Linux host. Shared scheduler directory and account are required for local yielding. Separate hosts cannot coordinate via this lock.

Implementation references: [Python subprocess process groups](https://docs.python.org/3/library/subprocess.html), [Python signals](https://docs.python.org/3/library/signal.html), and [Python process/CPU APIs](https://docs.python.org/3/library/os.html).

## Verification

Lane SQL regressions cover wrong-lane claims, concurrent lease exclusion, missing prerequisites, atomic handoff, stale writers, crash recovery, partial-tier handoff, retry, cancellation/deletion and service-only grants. Real subprocess tests cover pause/resume, active timeout, fast-worker crash lock release, fine-worker crash cleanup and continued heartbeat. Worker tests prohibit MFA in fast, prohibit ASR in fine, and require reuse of server frames.

Full repository verification passed: `pnpm lint`, `pnpm build`, `pnpm test` (973 API, 370 Web, 114 extension tests). Six disposable-Postgres SQL regression scripts passed. Hosted migration columns and service-only RPC permissions were checked; Supabase advisors reported no warnings/errors (only pre-existing no-policy INFO and unused-index INFO). The local development server was restarted with both new lanes.

## Real upload / API / durable-worker probe

The local dev stack ran the new fast and fine workers against the configured hosted Supabase database. The fixture uploaded one Reference and two Ogg Takes from the same public clip. Take 2 was submitted after Take 1's coarse result was observed, while the slow lane was still working. Authentication and timed source blueprint were isolated test fixtures; actual upload validation, hash checks, cloud objects, PostgreSQL claims/handoff, model inference, checkpoint writes and API serialization were used. The Reference fixture has no subtitle word timestamps, so its coarse output exercises the supported curve-only fallback; final word alignment is real MFA.

| Measurement (seconds) | Take 1 | Take 2 |
| --- | ---: | ---: |
| Create attempt + analysis + upload | 6.31 | 6.53 |
| Upload response → first observed word check / coarse comparison | 9.48 | 9.54 |
| Submission start → first observed coarse comparison | 15.79 | 16.07 |
| Upload response → final comparison | 55.96 | 60.98 |

Both Takes completed with `full_85_plus` and final `comparison=available`; the Reference completed too. Reference creation/upload took 5.05 seconds; coarse was first observed 6.85 seconds after upload, and final output 38.76 seconds after upload. The initial Reference poll was deliberately after creating Take 1, so its coarse observation is an upper bound, not Reference compute time.

The probe sleeps one second between **sequential** Reference/Take polling passes. HTTP duration, multiple responses, and Take 2 creation add to observation delay. These are client-observed upper bounds, not exact checkpoint timestamps or browser paint measurements; the production frontend's own polling cadence is not reproduced. Actual browser display is not claimed to take 5.06 seconds. A one-scenario, two-Take probe is not a tail-latency/load test.

The gap between roughly 5 seconds of isolated fast computation and 9.5 seconds of observed API latency includes queue claim, storage writes, serialization and polling. It cannot be attributed to any single one without additional tracing. Start-to-first-result also includes roughly 6.4 seconds of attempt/analysis creation and upload. Further optimization should batch checkpoint/request round trips and reduce observation delay before changing ASR accuracy settings. The unchanged ASR remains the largest fast compute stage. One fine worker serializes Reference and both Take alignments and yields to fast work, explaining the much longer final-result path. Removing MFA from the first-result path does not eliminate final-result latency.

Raw results: [live.json](live.json). Runner: `apps/api/scripts/benchmark_worker_lanes_live.py --run-live`. All synthetic-owner fixture rows and audio objects were removed; an independent database query confirmed no benchmark profiles remain. The local development stack stays running with both new workers.
