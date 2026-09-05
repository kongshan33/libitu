# Libitu Agent Guide

This is the main repository convention document for future coding agents. Read `AGENTS.md` first, then read this file before making changes.

## Required Reading Order

1. `AGENTS.md`
2. `CLAUDE.MD`
3. `PROJECT.MD`
4. `TASK.MD`
5. `DECISIONS.MD`
6. The design or system document relevant to the task

## Product

Libitu is an English fluency training product that turns real-world English input into active speaking practice.

The MVP has three loops:

- Input loop: YouTube listening and article / pasted-text reading.
- Corpus loop: extract, edit, and save reusable chunks and sentence structures.
- Output loop: speak with AI using selected corpus items in practical work/life scenarios.

Core product references:

- `design/docs/MVP_SYSTEM_DESIGN.md`
- `design/docs/Libitu_Design_Spec.md`
- `design/docs/BACKEND_SYSTEM_DESIGN.md`
- `design/docs/DATA_ARCHITECTURE.md`
- `design/docs/DESIGN.md` (non-canonical visual reference)
- `design/docs/DEVELOPMENT_ROADMAP.md`

Document roles:

- `PROJECT.MD` records current implementation truth and the active objective.
- `TASK.MD` is the living milestone queue with acceptance criteria.
- `DECISIONS.MD` records accepted and pending cross-cutting decisions.
- `Libitu_Design_Spec.md` defines product behavior and interaction requirements.
- `DEVELOPMENT_ROADMAP.md` defines dependency order, not day-to-day status.

## Repository Shape

This is a pnpm + Turborepo monorepo.

```text
apps/
  web/          Next.js web app for Stage 3/4/5, corpus, reading workspace, and current Stage 1 prototype
  api/          FastAPI backend for content, jobs, blueprints, corpus, and speaking APIs
  extension/    Chrome Extension workspace for YouTube entry, transcript capture, local playback, and shadowing

packages/
  types/        Shared TypeScript product types
  core/         Shared pure business helpers
  ui/           Shared design tokens and future shared UI
  config/       Shared tooling config, currently TypeScript base config

design/
  docs/         Product, system, backend, and visual design docs
  prototypes/   Static HTML prototypes
  assets/       Design images and previews
```

## Tech Stack

- Package manager: `pnpm@10.19.0`
- Monorepo runner: Turborepo
- Web: Next.js 15, React 19, TypeScript strict, ESLint flat config
- API: FastAPI, Pydantic v2, uv, pytest
- Extension target: Chrome Extension Manifest V3
- Persistence: Supabase Postgres connected; migrations are applied, repository wiring is pending
- Auth: Clerk frontend and FastAPI identity boundaries exist; hosted Supabase Third-Party Auth confirmation is pending
- Ephemeral cache: Upstash Redis queue, expiring processing state, and worker locks are implemented

Do not assume Clerk-Supabase hosted trust, React Query, production queue recovery, or DeepSeek quality evals are already configured. Check the current implementation state below.

## Commands

From the repo root:

```bash
pnpm install
pnpm lint
pnpm build
pnpm test
pnpm exec supabase --help
pnpm dev
```

`pnpm dev` starts the web app plus the FastAPI server and queue worker. The worker exits cleanly when `PROCESSING_MODE=inline`.

API setup:

```bash
cd apps/api
uv sync --extra dev
pnpm --filter @libitu/api dev

# Or run the API server and worker independently:
pnpm --filter @libitu/api dev:server
pnpm --filter @libitu/api worker
```

API tests can be run through the root `pnpm test`, or directly:

```bash
cd apps/api
.venv/bin/pytest tests
```

## Current Implementation State

Web:

- Current homepage renders Stage 1 from the typed FastAPI client in `apps/web/features/stage-one`.
- Stage 1 demo data remains a fixture in `apps/web/features/stage-one/data/stage-one-demo.ts`.
- ClerkProvider, middleware, and signed-in/signed-out controls are wired in `apps/web`.
- Shared CSS tokens are imported from `@libitu/ui/tokens.css`.
- Next.js development uses `.next`, while production builds use `.next-build`, so root build verification cannot corrupt a running dev server.

API:

- `apps/api` is initialized and route contracts mirror the MVP API boundary.
- Queue mode persists content, jobs, and blueprints through Supabase; inline mode uses deterministic in-memory storage for tests and dependency-free development.
- Queue-mode jobs return `pending`; the separate blueprint worker fetches missing captions and calls the DeepSeek structured-analysis adapter.
- Tests force inline deterministic processing and never use Upstash, YouTube, or a paid model.
- Speaking turns return deterministic placeholder feedback.
- Private corpus and speaking routes require a Clerk-derived identity; no client-provided owner ID is trusted.

Data infrastructure:

- Supabase project `ulrdykwhggcaspylines` has the initial schema and RLS optimization migrations applied.
- Supabase security and performance advisors have no warnings or errors; informational unused-index notices are expected before real data exists.
- `apps/api/app/auth.py` contains optional and required Clerk identity dependencies.
- `apps/api/app/integrations/upstash.py` creates the optional Upstash Redis client.
- `apps/api/app/integrations/processing_queue.py` owns queue keys, expiring state, and locks.
- `apps/api/app/integrations/youtube_transcript.py` wraps the unofficial caption provider; browser captions remain preferred.
- `apps/api/app/integrations/deepseek.py` requests and validates DeepSeek JSON output with timeout and retry controls.
- `apps/api/app/integrations/supabase_repository.py` activates only when `SUPABASE_SECRET_KEY` is configured.
- The local server repository, YouTube transcript fallback, Upstash worker, sherpa-onnx subtitle formatting, DeepSeek V4 Flash SSE analysis, and validated Stage 1 job previews are wired; live quality evaluation remains required for the `mvp-v5` extraction contract.
- Local ignored environment files point web and API development at Clerk and Supabase. Never commit or print their values.
- Hosted Supabase Third-Party Auth still needs its final dashboard confirmation, and FastAPI storage remains in memory.

Extension:

- `apps/extension` contains a loadable Manifest V3 extension.
- The extension has a YouTube content script, side panel, background service worker, and manifest validation script.
- It attempts to open YouTube's transcript panel, sends timestamped captions and metadata to FastAPI, then opens Stage 1 with the created `contentId` and `jobId`.
- Stage 1 embeds the selected YouTube video and reads the exact blueprint created by the extension; missing captions fail explicitly.

## Code Organization Rules

- Put application-specific code under the owning `apps/*` workspace.
- Put reusable TypeScript types in `packages/types`.
- Put pure reusable business logic in `packages/core`.
- Put shared visual tokens and future cross-app UI in `packages/ui`.
- Put shared config in `packages/config`.
- Do not put browser-only extension logic in `packages/core`; keep it in `apps/extension`.
- Do not put FastAPI schemas in `packages/types` unless also creating a deliberate API contract generation path.

## Web Conventions

- Use TypeScript strict.
- Prefer feature folders under `apps/web/features/<feature-name>`.
- Keep route files in `apps/web/app` thin; route files should compose feature components.
- Keep mock/demo data separate from components.
- Use shared types from `@libitu/types` where the shape is product-level.
- Use `@libitu/core` only for pure logic with no React, DOM, Next.js, or browser APIs.
- Use `next/link` for internal navigation.
- The design language is restrained, dense, product-oriented, and based on the tokens in `packages/ui/src/tokens.css`.

## API Conventions

- Use FastAPI with Pydantic v2.
- Keep routers in `apps/api/app/routers`.
- Keep request/response models in `apps/api/app/schemas`.
- Keep business/storage orchestration in `apps/api/app/services`.
- Use `Annotated` for FastAPI path/query/dependency declarations.
- Prefer explicit return types on route handlers.
- Keep the current in-memory store replaceable; do not spread storage dictionaries into routers.
- Add or update smoke tests when adding API routes.

## Extension Conventions

- Target Chrome Extension Manifest V3.
- YouTube audio/video must stay in the user's browser.
- No YouTube audio or video should be uploaded to Libitu servers.
- Microphone and pitch work belong in the extension/browser layer.
- Backend may receive transcript text and derived metadata, not raw media.

## Git And Files

- `node_modules/`, `.next/`, `.turbo/`, `.venv/`, `__pycache__/`, `.pytest_cache/`, and env files are ignored.
- Use `pnpm-lock.yaml`; do not reintroduce `package-lock.json`.
- Keep generated caches and local virtual environments out of commits.

## Working Style

- Migration first: preserve the current behavior while improving structure.
- Make small, surgical changes.
- Do not add speculative abstractions.
- When documents disagree, follow the precedence in `Libitu_Design_Spec.md`. Treat code as implementation truth and documents as intended behavior; surface the mismatch before expanding it.
- Update `PROJECT.MD`, `TASK.MD`, and `DECISIONS.MD` when a change affects status, milestones, or an accepted decision.
- Verify with `pnpm lint`, `pnpm build`, and `pnpm test` when touching shared structure, web, or API.
