# Libitu Backend System Design

Version 0.4

This document translates the MVP backend boundary into the initial FastAPI implementation in `apps/api`.

## Current Status

The backend product design is directionally complete in `MVP_SYSTEM_DESIGN.md`: it defines core modules, data entities, cache strategy, and public API boundaries.

The backend has accepted provider boundaries for persistence, identity, and ephemeral caching. Supabase Postgres durably stores public processing documents, personal corpus and speaking loadout snapshots. Clerk is the identity provider, and Upstash Redis provides disposable queue coordination and polling acceleration. Unconfigured inline development and deterministic tests may use in-memory adapters; configured persistence failures never silently fall back to memory. Real speaking runtime and durable feedback are now implemented; see [Stage 4](STAGE_FOUR_IMPLEMENTATION.md) and [Stage 5](STAGE_FIVE_CONTRACT.md) for current contracts and production qualification limits. The route table below records the initial surface, not the complete current API.

Routing architecture R1 (2026-10-10) is implemented in the [route and responsibility architecture](ROUTING_AND_RESPONSIBILITY_ARCHITECTURE.md): `GET /api/content/{content_id}` is a no-store public YouTube metadata/current-processing read; `POST /api/jobs` accepts explicit `retry_failed` and `expected_attempt_count`; practice analysis controls and speaking end/delete are service-owned. Existing endpoint paths and omitted-field client behavior remain supported. Supabase conditional updates and Redis Lua compare generation/state atomically without new tables or migrations; job state is durable-first. Worker startup consumes the reserved attempt count, so API and blueprint worker must be upgraded together. The Web Reader now uses the R2 content controller to adopt this contract; new canonical routes and extension v4 remain R3 work.

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
| `/api/corpus` | `GET` / `POST` | Implemented | Clerk identity required; configured Supabase persistence. |
| `/api/corpus/{item_id}` | `PATCH` / `DELETE` | Implemented | Owner-scoped persisted edits/deletion. |
| `/api/speaking/options` | `GET` | Implemented | Public static logic templates and selection limits. |
| `/api/speaking/sessions` | `POST` | Implemented | Authenticated, owner-checked, idempotent atomic loadout snapshots. |
| `/api/speaking/sessions/{session_id}` | `GET` | Implemented | Owner-scoped session settings and ordered snapshots. |
| `/api/speaking/sessions/{session_id}/turns` | `POST` | Planned integration | Persisted sessions explicitly return 501; deterministic replies are inline fixtures only. |

## Next Implementation Decisions

1. Implement the real role-play adapter, turn persistence, evidence-based selected-item detection and session feedback after the saved loadout boundary.
2. Finish hosted Clerk-Supabase trust and pass session tokens to private API calls.
3. Keep accepted corpus import and account-bound local loadout drafts; define remaining history/progress merge rules.
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
