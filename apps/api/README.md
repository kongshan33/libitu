# Libitu API

FastAPI backend workspace for content resolution, processing jobs, blueprints, corpus, and speaking sessions.

Current state:

- API contracts mirror `design/docs/MVP_SYSTEM_DESIGN.md`.
- `PROCESSING_MODE=queue` persists content and jobs in Supabase, dispatches work through Upstash, and extracts blueprints with DeepSeek.
- `PROCESSING_MODE=inline` keeps the deterministic local path for tests and dependency-free development.
- The backend owns `ANALYSIS_VERSION`; clients only submit a `content_id`.
- `/health/ready` verifies that the queue worker heartbeat is live and loaded with the API's current analysis version and DeepSeek model.

Run locally:

```bash
pnpm --filter @libitu/api dev
```

This starts both the API server and queue worker. To run them separately, use
`dev:server` and `worker` in two terminals.

Python dependencies are declared in `pyproject.toml`.

## Local subtitle punctuation

English subtitle punctuation and casing use the sherpa-onnx online INT8 model. Install
the ignored local model assets once from the API workspace:

```bash
pnpm --filter @libitu/api setup:punctuation
```

The default files live under `apps/api/.models/`. Deployments may instead set
`PUNCTUATION_MODEL_PATH` and `PUNCTUATION_BPE_VOCAB_PATH`. When the model is absent or
its output changes source words, processing continues with deterministic local merging.
`sherpa-onnx-core` is declared explicitly because uv can otherwise omit its shared ONNX
runtime dependency when resolving sherpa-onnx from source metadata on macOS.
