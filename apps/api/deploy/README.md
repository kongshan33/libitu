# Acoustic worker runtime

Run the API and the acoustic worker separately. `mfa-environment.yml` pins the MFA/Python interface; resolve and export a platform-specific explicit lock before production deployment. Do not reuse a macOS lock on Linux.

```sh
micromamba create -f deploy/mfa-environment.yml -p /srv/libitu/mfa
# Prewarm native libraries during image provisioning, not in the first user request.
micromamba run -p /srv/libitu/mfa mfa version
uv run python -m scripts.download_acoustic_models
uv sync --extra acoustics
pnpm worker:acoustic-fast
# In another terminal:
pnpm worker:acoustic-fine
```

The checked-in `acoustic-models.json` records the tested English US ARPA v3.0.0 acoustic/dictionary pair and exact file digests. The provisioning script downloads only these explicit artifacts and verifies size/hash before activation. Configure their paths and matching digest values in the API/worker environment.

Provision FFmpeg, the pinned Silero V5 ONNX model, a compatible MFA dictionary/model pair, and their explicit hashes. Configure the server-owned source manifest and the same analysis environment on API and worker. Keep source files on a private read-only mount available to the worker. Neither arbitrary client URLs nor client file paths are accepted. Configure a service supervisor to restart the worker; unfinished jobs recover from PostgreSQL leases.

See [source grants, retention, API and checks](../../../design/docs/STAGE_TWO_SERVER_REFERENCE.md). The current repository has no deployed production worker host. CPU sizing and latency targets require representative segment benchmarking.

## Independent Stage 2 lanes (2026-10-16)

`pnpm dev` starts separate fast and fine processes. Fast handles Take ASR and server signal/CWT for Takes and References; fine handles MFA and final comparisons. Each lane checks eligible Takes before References. PostgreSQL `worker_lane`, lane-specific `SKIP LOCKED` claims and a fenced atomic handoff preserve checkpoints and clear the fast lease before fine claims. Retries stay in their lane. The old combined claim RPCs deliberately reject obsolete workers: drain/stop them before applying `20261016111833_acoustic_worker_lanes`, then start both new processes. The old `worker:practice` / `worker:acoustics` scripts have been replaced.

Both local workers must use the same absolute `ACOUSTIC_SCHEDULER_PATH` and OS account. On macOS, the fine worker runs at nice 10 with native library threads capped at one. While a fast job holds the activity file lock, a dedicated supervisor pauses the entire MFA child process group, then resumes it within approximately 50 ms of the lock becoming free. Idle database polling does not hold this lock. Lease heartbeat threads continue in the parent worker. A fast crash releases its OS lock; a fine crash causes the surviving supervisor to kill/reap MFA. MFA's active timeout excludes pauses, with an additional 900-second wall-clock cap to bound starvation. Continuous fast traffic can delay fine results; this is a local latency preference, not hard CPU affinity or a throughput guarantee.

Fast keeps the existing CPU int8 small.en recognizer, two threads, beam five and reliability/60/85 rules. It never probes MFA at startup. Fine alone verifies MFA at startup. Registered audio acquisition and browser capture paths are unchanged. API and both workers share the existing account/job/hash-verified audio cache; separate hosts require object-store reads and a different CPU scheduling arrangement.

For Linux, install `stage-two-worker@.service` and enable both `stage-two-worker@fast` and `stage-two-worker@fine`. Retire the old service rather than running duplicate fast instances. Optionally set BOTH `ACOUSTIC_FAST_CPUS` and `ACOUSTIC_FINE_CPUS` to disjoint allowed logical CPU IDs (example on a four-vCPU machine: `0,1` and `2,3`). The worker validates these and sets affinity before model initialization; descendants inherit it. Topology, available CPUs and resource limits must be checked on the actual host. Linux affinity has not been benchmarked on this local macOS run. Do not set CPU lists on macOS.

Run CPU timing in isolation with `python -m scripts.benchmark_worker_lanes --audio ... --text ... --output ...`. It uses actual ASR, signal extraction and MFA but a controlled arrival, so its numbers exclude storage, HTTP and browser rendering. See the checked-in benchmark report for full methodology and separate hosted-storage/local-worker measurements.
