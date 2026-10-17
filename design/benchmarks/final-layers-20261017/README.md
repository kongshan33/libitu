# Final three-layer latency after hiding Preview — 2026-10-17

Three real sequential learner-only runs took **43.211, 36.676 and 47.717 seconds** from browser submission start to the rendered final-layer workspace. Median: **43.211 seconds**. Word checking remained visible at a median **13.077 seconds**. No Reference was prepared or bound.

| Run | Upload/submission acknowledged | Word check visible | Final layers visible | Wait after upload acknowledgment | Observed MFA process interval |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 3.768 s | 13.325 s | 43.211 s | 39.443 s | 25.393 s |
| 2 | 2.344 s | 13.062 s | 36.676 s | 34.333 s | 20.112 s |
| 3 | 2.490 s | 13.077 s | 47.717 s | 45.228 s | 29.612 s |
| Median | 2.490 s | 13.077 s | 43.211 s | 39.443 s | 25.393 s |

All three finished `completed`, matched 10/10 words (`full_85_plus`), and exposed Sound, Rhythm and Melody learner evidence. There are no Reference comparison scores. The UI's existing word gates remain unchanged; lower-matching recordings are not expected to produce all three layers.

## Where the time goes

- Upload acknowledgment includes browser file/hash preparation, the merged multipart submission, private cloud storage and database registration/queueing. It is not only raw network transfer.
- The first observed `checking_words` response was at 3.915–5.347 seconds; `word_check_complete` at 13.038–13.304 seconds. The observed interval is about 7.8–9.1 seconds, including ASR, publication and polling uncertainty. It is not an isolated ASR benchmark.
- Server coarse data was first observed at 14.312–14.604 seconds. The current UI intentionally does not render that preview.
- MFA subprocess/supervisor activity lasted approximately 20.1–29.6 seconds. This is the largest observed processing interval. It includes MFA process startup and alignment; it does not isolate internal model loading or alignment kernel time.
- After the sampled MFA group disappeared, final rendering took another 2.1–2.6 seconds, including remaining processing, persistence, polling and browser rendering.

Removing Preview did not change the processing pipeline. It moved the visible graph milestone to fine completion. The earlier ~12-second preliminary-curve benchmark and this final-layer benchmark have different endpoints and cannot establish an inference regression. Further reducing full-result latency requires work on MFA/fine processing, not simply hiding or renaming a UI state.

## Method and scope

- Local macOS, Intel i5-8279U 2.40 GHz, four physical/eight logical cores, 16 GiB RAM. API and workers local, Supabase database/storage remote. No cloud-server timing claim.
- Same 4.22-second public speech sample as earlier submission/read experiments: `speechocean762/0036/000360034.wav`, “WE SPEAK OUT WHEN WE FEEL WE SHOULD SPEAK OUT”. Learner input encoded as Opus. Recording duration excluded.
- One warm resident fast worker and one fine worker, with existing CPU scheduling. Before testing, verified no queued/processing jobs and stopped the older duplicate pair left by earlier tests; the current development pair remains running. No builds or test suites ran during the timed trials.
- Harness uses the production outbox, multipart API, polling hook, layer presentation, comparison adapter, tabs and final layer components. Authentication and source blueprint are fixtures; Sound text-guide annotations are omitted. This is a real processing/rendering harness, not the entire practice page or an accuracy evaluation.
- Timer starts before selecting the audio file, includes upload through UI rendering, and ends after final result DOM publication plus two animation frames. All three layer statuses must be available/partial and the job completed. Sound is the initially visible tab; Rhythm/Melody are mounted as in production and were subsequently opened and captured.
- Polling remains one second after each response. Phase observations are sampled at response arrival and therefore bound milestones rather than measuring exact worker stage durations.
- A separate local process sampler inspected process names every 0.5 seconds plus command overhead. Overlapping MFA child/supervisor observations were combined per trial, not added together. Sampling error is approximately one observation interval; see raw process timestamps. No worker computation code was modified.
- History recording retention off; original acquisition, 60%/85% gates, models and worker logic unchanged.

## Evidence and reproduction

[Summary](summary.json), [browser observations](browser.json), [API/database timings](live.json), [MFA process observations](mfa-processes.json). Screenshots `browser-1.png` through `browser-3.png` and corresponding `-Rhythm` / `-Melody` images capture final components.

From `apps/api`, with the normal dev server and one worker per lane running:

```sh
LIBITU_PLAYWRIGHT_MODULE=/path/to/playwright \
  .venv/bin/python -m scripts.benchmark_practice_submission \
  --run-live --final-results --without-reference --trials 3 \
  --audio /path/to/speechocean762/0036/000360034.wav \
  --text 'WE SPEAK OUT WHEN WE FEEL WE SHOULD SPEAK OUT' \
  --output ../../design/benchmarks/final-layers-20261017/live.json
```

The runner needs free port 8001 and creates temporary database/storage fixtures and a temporary browser route. It records browser/API timings; the process observations in this run were collected separately. Fixture audio and rows were cleaned; an independent hosted query confirmed zero benchmark Takes/analyses/References. Temporary route and API were removed/stopped. Harness TypeScript check, Python compilation and Node syntax check passed before the run.
