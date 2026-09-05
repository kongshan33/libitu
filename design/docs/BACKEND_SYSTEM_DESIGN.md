# Libitu Backend System Design

Version 0.4

This document translates the MVP backend boundary into the initial FastAPI implementation in `apps/api`.

## Current Status

The backend product design is directionally complete in `MVP_SYSTEM_DESIGN.md`: it defines core modules, data entities, cache strategy, and public API boundaries.

The backend has accepted provider boundaries for persistence, identity, and ephemeral caching. Supabase Postgres durably stores public processing documents, Clerk is the identity provider, and Upstash Redis provides disposable queue coordination and polling acceleration. Corpus and speaking services still use in-memory storage.

See `DATA_ARCHITECTURE.md` for schema ownership, RLS, credentials, and migration rules.

## App Boundary

`apps/api` owns:

- Content resolution for YouTube URLs, article URLs, and pasted text.
- Processing job creation, polling fallback, and SSE progress previews.
- Stage 1 blueprint retrieval.
- Corpus CRUD.
- Speaking session and turn submission.

It does not own:

- YouTube audio or video handling.
- Chrome extension local playback control.
- Browser microphone capture.
- Long-term scheduling or spaced review.

## Initial Route Surface

| API | Method | Status | Notes |
|---|---|---|---|
| `/health` | `GET` | Implemented | Local health check. |
| `/health/ready` | `GET` | Implemented | Verifies queue-mode worker heartbeat. |
| `/api/content/resolve` | `POST` | Implemented | Produces deterministic content IDs and normalized keys. |
| `/api/jobs` | `POST` | Implemented | Creates or resumes a queued job; inline mode is retained for deterministic tests. |
| `/api/jobs/{job_id}` | `GET` | Implemented | Polls job state. |
| `/api/jobs/{job_id}/events` | `GET` | Implemented | Streams processing stages and validated partial analysis previews as SSE. |
| `/api/blueprints/{content_id}` | `GET` | Implemented | Returns the active-version blueprint with read-time learner-level ranking. |
| `/api/corpus` | `GET` / `POST` | Implemented | Clerk identity required; storage remains in memory. |
| `/api/corpus/{item_id}` | `PATCH` / `DELETE` | Implemented | Clerk identity and owner match required; storage remains in memory. |
| `/api/speaking/sessions` | `POST` | Implemented | Clerk identity required; creates an in-memory session. |
| `/api/speaking/sessions/{session_id}/turns` | `POST` | Implemented | Owner match required; returns deterministic placeholder AI feedback. |

## Next Implementation Decisions

1. Replace corpus and speaking in-memory stores with repository interfaces backed by Supabase.
2. Finish hosted Clerk-Supabase trust and pass session tokens to private API calls.
3. Define anonymous local-state import rules before implementing account merge.
4. Add Upstash rate limits and a durable retry scheduler around real job execution.
5. Add typed API client generation for the web app and extension.

Before DeepSeek runs, the worker formats English captions locally with sherpa-onnx in
bounded overlapping windows. It accepts punctuation and casing only when the normalized
word sequence still matches the source, preserves source timestamps, and publishes
cumulative sentence batches into ephemeral Redis job state. Unsupported languages,
missing model assets, and alignment failures fall back to deterministic pause/length
merging.

DeepSeek generation is consumed as an SSE stream and owns semantic analysis only.
Partial JSON stays inside the API; only closed fields that pass Pydantic validation are
merged with the local subtitle preview. The browser receives those snapshots through
the job event endpoint, while the durable Supabase job record and final blueprint remain
completion-only sources of truth.
