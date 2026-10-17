# Progressive acoustic measurements — 2026-10-16

Implemented: publish durable coarse Rhythm/Melody before sentence MFA. This is progressive publication in the existing background workers. Separate fast/fine queues, CPU isolation, ASR/extraction concurrency, Realtime, asynchronous storage and Reference prewarming are not implemented in this increment.

## Measured locally

Intel i5-8279U Mac; faster-whisper small.en, CPU int8, two threads, beam 5, word timestamps enabled. Existing model/search/reliability and exact 60/85 gates are unchanged. This is not a target cloud CPU benchmark. Other local development processes were running; the variation is not an isolated CPU-contention study.

Public SpeechOcean762 recording `000360034` is 4.22 seconds. Three runs after resident model startup:

| Stage | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| ASR + word check | 5.346 s | 4.994 s | 7.902 s |
| Server VAD/F0/energy | 0.572 s | 0.404 s | 0.406 s |
| Coarse CWT + word aggregation | 0.035 s | 0.036 s | 0.047 s |
| Total normalized audio → coarse signal | 5.953 s | 5.433 s | 8.354 s |

All three produce 10/10 matched words and 10 actual ASR word intervals; five words carry uncertainty diagnostics. MFA invocations: zero. Model process startup was 5.406 s, outside the per-Take measurements. CWT imports were already warm. Audio normalization, upload, queue wait, checkpoint writes, Reference readiness and UI polling are excluded. These are not end-to-end display times, nor a promise of 5–8 seconds on a server.

Six cached human clips (1.28–4.22 seconds) take 18.35–49.79 ms median for the new coarse algorithm including nine boundary perturbations per word. Cached MFA boundaries were used **only as aggregation timing proxies**, not mislabeled subtitle/ASR evidence. No phones or duration channel enter coarse calculation. The coarse curve is independently computed before aggregation. Fine CWT takes 21–39 ms in a single warm probe, excluding MFA itself. [Raw measurements](results.json).

The user's existing Reference is included as a cached-feature timing probe. The requested recent Take no longer had retained audio; this report does not claim a new paired user result or accuracy against human stress annotations. The separate public learner run uses real faster-whisper boundaries. Production Reference uses actual saved subtitle boundaries, or curve-only output if they are missing or unreliable.

## Signal contract

- Shared server Praat autocorrelation F0, Silero VAD and 10ms RMS energy. Browser analysis is never a comparison input.
- Independent PyWavelets 1.8.0 implementation; no Wavelet Prosody Toolkit code or runtime.
- Coarse: normalize pitch in semitones and energy in dB; equal weights; Mexican-hat CWT at 60–240ms scales; positive local prominence. Pitch interpolation is limited to voiced gaps up to 150ms within speech. Display pitch preserves unvoiced gaps.
- Words use the same speech-window 90th percentile on both sides. The signal does not depend on word boundaries. Re-evaluate windows with start/end offsets −50/0/+50ms. A range greater than `max(0.1, 0.3 × value)` is a sensitivity flag, **not a calibrated stress threshold or confidence probability**. Low pitch coverage and wavelet edges are also uncertain.
- Coarse excludes duration. No inference of weak/no stress from low coarse prominence; lengthening remains unevaluated. Fine MFA may add a vowel-duration channel with experimental weights 0.4/0.4/0.2 when sufficient aligned vowels exist.
- Version, feature version, aggregation version, boundary source and sentence-relative time basis are persisted. Fine and coarse estimates are not numerically interchangeable. Both are continuous, uncalibrated relative measurements, without strong/weak classes or correctness scores.

## Reproduce

From `apps/api`, install `uv sync --extra acoustics --extra dev`, then run:

```sh
.venv/bin/python -m scripts.benchmark_progressive_acoustics \
  --input ../../.cache/cwt-experiment/inputs.json \
  --output /tmp/progressive-results.json \
  --public-audio /path/to/speechocean762/0036/000360034.wav
```

The input feature collection is the private offline experiment cache, deliberately not committed. The script writes only the specified local report and does not invoke MFA, upload audio, or create account records. ASR and extraction use the configured local pinned models.

## Rollout and remaining measurement

Hosted migration `20261016101306_progressive_acoustic_checkpoints` adds private raw-frame and coarse-result columns and extends fenced checkpoint/deletion functions. User/lease fences and service-only grants remain. API/Web/worker code still requires normal application deployment on a remote host; a database migration alone does not deploy it.

Existing local workers were restarted for the new Reference policy `reference-source-transcript-v3-progressive` and learner `snapshot.progressive_version=server-prominence-v1`. Old completed Takes remain readable and are not retroactively rebuilt. No original audio acquisition or retention preference change.

Next measurements need a target CPU instance/specification and a new retained same-sentence user/Reference pair. Measure upload→first visible signal separately from upload→final alignment; repeat under concurrency before deciding worker core allocation. ASR remains the dominant measured first-result computation. Beam-size changes require independent matching-tier evaluation.

## Verification

Root lint/build/test passed: 964 API, 370 Web and 114 extension tests; the final Reference-MFA-failure fallback passed a further 42 focused API tests. Local PostgreSQL checkpoint regressions verify durable frames, stale leases, retry reuse, immutable frames and deletion. Hosted columns and service-only grants were verified; no new security warning/error was reported. The existing informational `private.content_payloads` RLS-without-policy notice is unchanged ([advisor explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)).

Final browser regression passed at 1440px and 390px: preliminary Rhythm/Melody, gate badges, automatic final replacement, history navigation, replacement recording and deletion. Screenshots were visually checked under `/tmp/libitu-progressive-ui-final`. These are controlled UI fixtures, not end-to-end inference latency measurements. The current local dev stack is running with `UV_FROZEN=true pnpm dev`; both MFA startup checks and resident ASR initialization succeeded. A transient dependency metadata timeout during an ordinary dev restart was resolved by using the existing lockfile without re-resolution.
