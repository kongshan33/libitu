# Acoustic worker runtime

Run the API and the acoustic worker separately. `mfa-environment.yml` pins the MFA/Python interface; resolve and export a platform-specific explicit lock before production deployment. Do not reuse a macOS lock on Linux.

```sh
micromamba create -f deploy/mfa-environment.yml -p /srv/libitu/mfa
# Prewarm native libraries during image provisioning, not in the first user request.
micromamba run -p /srv/libitu/mfa mfa version
uv run python -m scripts.download_acoustic_models
uv sync --extra acoustics
uv run --extra acoustics python -m app.workers.acoustic_worker
```

The checked-in `acoustic-models.json` records the tested English US ARPA v3.0.0 acoustic/dictionary pair and exact file digests. The provisioning script downloads only these explicit artifacts and verifies size/hash before activation. Configure their paths and matching digest values in the API/worker environment.

Provision FFmpeg, the pinned Silero V5 ONNX model, a compatible MFA dictionary/model pair, and their explicit hashes. Configure the server-owned source manifest and the same analysis environment on API and worker. Keep source files on a private read-only mount available to the worker. Neither arbitrary client URLs nor client file paths are accepted. Configure a service supervisor to restart the worker; unfinished jobs recover from PostgreSQL leases.

See [source grants, retention, API and checks](../../../design/docs/STAGE_TWO_SERVER_REFERENCE.md). The current repository has no deployed production worker host. CPU sizing and latency targets require representative segment benchmarking.
