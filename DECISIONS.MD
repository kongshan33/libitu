# Track Libitu decisions

```yaml
meta:
  contentType: Reference
  status: active
  updated: 2026-09-04
```

This log records decisions that constrain product behavior or architecture. Add a dated entry when a change affects multiple apps, data ownership, privacy, API contracts, or delivery order.

## Accepted decisions

### 2026-08-30: Use pnpm workspace and Turborepo

- **Status**: accepted
- **Decision**: use pnpm for workspace dependency management and Turborepo for root task orchestration
- **Reason**: the repository contains multiple JavaScript applications and shared packages with independent build tasks
- **Consequence**: use `pnpm-lock.yaml`; root `pnpm lint`, `pnpm build`, and `pnpm test` are the standard verification commands

### 2026-08-30: Organize by deployable app and shared ownership

- **Status**: accepted
- **Decision**: keep web, API, and extension code in `apps`; keep reusable types, pure logic, UI tokens, and config in `packages`
- **Reason**: each deployable surface has different runtime constraints
- **Consequence**: browser-only logic stays out of shared server-safe packages; FastAPI models remain in the API until contract generation is deliberate

### 2026-08-30: Prioritize the input-to-speaking loop

- **Status**: accepted
- **Decision**: the first release prioritizes YouTube blueprint, corpus save, speaking loadout, role-play, and feedback
- **Reason**: this is the smallest flow that tests Libitu's core value
- **Consequence**: reading and intensive listening remain architectural requirements but can ship after the first complete loop

### 2026-08-30: Keep Stage 1 available without login

- **Status**: accepted
- **Decision**: anonymous learners can view Stage 1 and retain eligible local state
- **Reason**: learners should experience product value before account creation
- **Consequence**: private persistence and account merge need explicit rules; public cache data must remain separate from user-owned records

### 2026-08-30: Keep media processing local

- **Status**: accepted
- **Decision**: YouTube audio, video, and microphone recordings never reach Libitu servers
- **Reason**: this reduces privacy, compliance, storage, and platform-policy risk
- **Consequence**: the extension sends accessible transcript text and derived metadata only; unsupported captions produce an explicit failure state

### 2026-08-30: Exclude spaced repetition from MVP

- **Status**: accepted
- **Decision**: do not build review scheduling or calendar-based revision in the MVP
- **Reason**: first validate whether input language transfers into speaking output
- **Consequence**: corpus filters and speaking reuse take priority over review algorithms

### 2026-08-30: Treat integrations as provider boundaries

- **Status**: accepted
- **Decision**: auth, database, captions, and language-model integrations use narrow adapters or dependencies
- **Reason**: provider choices remain unresolved and should not leak through product code
- **Consequence**: documentation must label likely providers as planned until implementation and tests exist

### 2026-09-01: Start the extension with framework-free Manifest V3

- **Status**: accepted
- **Decision**: implement the first Chrome extension increment with native MV3 files and a manifest validation script instead of a bundled React/Vite app
- **Reason**: the immediate milestone needs a loadable YouTube entry and API handoff, not a complex extension UI stack
- **Consequence**: `apps/extension` can be loaded directly as an unpacked extension; introduce build tooling only when side panel complexity or shared UI reuse justifies it

### 2026-09-01: Use Supabase Postgres for durable data

- **Status**: accepted
- **Decision**: use Supabase Postgres with repository-owned SQL migrations, RLS on exposed tables, and an unexposed `private` schema for source payloads
- **Reason**: Libitu needs relational ownership, versioned public processing data, enforceable private-user isolation, and a managed path to backups and observability
- **Consequence**: `supabase/migrations` is the schema source of truth; public processing data remains distinct from private learning records; hosted deployment still requires a dedicated Libitu Supabase project

### 2026-09-01: Use Clerk as the identity provider

- **Status**: accepted
- **Decision**: use Clerk for sign-in and session issuance; FastAPI verifies Clerk session JWTs and derives ownership from the `sub` claim
- **Reason**: Clerk supports the Next.js and Chrome extension surfaces while keeping password and session management outside Libitu
- **Consequence**: application user IDs are Clerk IDs stored as `text`; clients cannot choose `user_id`; Supabase RLS policies use `auth.jwt()->>'sub'`; anonymous Stage 1 remains available

### 2026-09-01: Use Upstash Redis only for ephemeral coordination

- **Status**: accepted
- **Decision**: use Upstash Redis for rate limits, short-lived processing locks, idempotency hints, and polling acceleration
- **Reason**: these workloads need low-latency expiry but must not become durable product state
- **Consequence**: Postgres remains authoritative for jobs, blueprints, corpus, sessions, turns, and feedback; every Redis-backed flow must recover after cache loss

### 2026-09-01: Separate corpus extraction from learner-level ranking

- **Status**: accepted
- **Decision**: generate one content-level pool of evidenced corpus candidates, label each candidate with CEFR difficulty and quality scores, and personalize the visible subset when the blueprint is read
- **Reason**: language-model analysis is expensive and cacheable by content, while learner level is private and can change; putting level in the generation job would duplicate analysis and mix user concerns into public processing state
- **Consequence**: the `mvp-v2` analysis contract stores up to 24 candidates; blueprint reads return a limited chunk/structure-balanced set ranked for an optional learner level, and later user-profile integration can pass that level without regenerating content

### 2026-09-02: Keep analysis version and queue recovery server-owned

- **Status**: accepted
- **Decision**: FastAPI selects the active analysis version; clients submit only `content_id`, while job IDs, Redis blueprint keys, and Supabase reads are version-specific
- **Reason**: independently versioned extension and web clients created stale jobs and could read a blueprint generated under a different contract
- **Consequence**: pending jobs are re-enqueued idempotently, obsolete queued versions fail without invoking the model, and changing `ANALYSIS_VERSION` invalidates reads without requiring coordinated browser releases

### 2026-09-02: Fail DeepSeek output by cause and salvage safe formatting variance

- **Status**: accepted
- **Decision**: distinguish provider rejection, timeout, truncation, malformed JSON, and schema errors; normalize only bounded formatting differences that retain transcript evidence
- **Reason**: JSON mode guarantees JSON syntax but not the application schema, and one malformed candidate should not be hidden behind an undiagnosable generic error
- **Consequence**: jobs expose actionable safe error messages, worker logs retain field-level diagnostics without model content, and user-triggered retries receive a larger bounded output budget

### 2026-09-02: Use DeepSeek V4 Flash for the mvp-v3 extraction contract

- **Status**: superseded by the compact `mvp-v4` response contract below
- **Decision**: use `deepseek-v4-flash` for Stage 1 and require a mixed pool targeting 8-16 complete chunks plus 4-8 reusable structures
- **Reason**: Stage 1 benefits from lower latency and cost, while extraction quality depends more on full-transcript evidence, explicit selection constraints, and deterministic validation than on using the Pro tier alone
- **Consequence**: `mvp-v3` invalidates earlier blueprint reads, evaluates up to 2,000 caption fragments, filters low-quality chunks, and renders merged sentence-sized transcript lines with conservative punctuation

### 2026-09-02: Keep complete transcript sentences out of the mvp-v4 response

- **Status**: superseded by local transcript formatting in `mvp-v5`
- **Decision**: continue using `deepseek-v4-flash`, but request only short exact sentence-end text anchors and terminal punctuation alongside 12-20 corpus candidates; reconstruct display sentences from the original caption fragments in the API
- **Reason**: repeating a 20,576-character transcript inside the blueprint JSON caused both the 8K and 12K output attempts to end with `finish_reason=length`, while several generated fields were discarded by the application schema
- **Consequence**: `mvp-v4` invalidates the oversized `mvp-v3` contract, guarantees displayed words come from source captions, can split sentences inside a caption row, validates ordered full-transcript coverage, falls back to local merging for bad anchors, and logs completion-token diagnostics for future truncation analysis

### 2026-09-02: Stream validated analysis previews to Stage 1

- **Status**: accepted
- **Decision**: consume DeepSeek Chat Completions as SSE, parse partial JSON server-side, publish only closed Pydantic-valid preview fields through a job SSE endpoint, and retain polling as the browser fallback
- **Reason**: DeepSeek V4 Flash supports a 1M context and 384K maximum output, but streaming changes perceived latency rather than capacity; users should see the video and trustworthy completed sections while the final blueprint is still generating
- **Consequence**: the main request uses `stream: true`; Stage 1 first renders cumulative locally formatted subtitle batches, then progressively renders summary, logic, chapters, and transcript-evidenced candidates. The final blueprint still requires complete JSON and full validation. Input is not silently truncated, the per-job limit is 240,000 characters, and the semantic-only response has a bounded output retry

### 2026-09-03: Format subtitles locally and keep DeepSeek semantic-only

- **Status**: accepted
- **Decision**: use the English sherpa-onnx online punctuation INT8 model in bounded overlapping windows before DeepSeek, validate that only punctuation and casing changed, and omit subtitle boundaries from the `mvp-v5` DeepSeek response
- **Reason**: sentence-boundary arrays grew with video duration, delayed the first useful UI, and repeatedly caused otherwise valid semantic blueprints to be truncated; subtitle formatting does not require generative reasoning
- **Consequence**: the worker adds a `formatting_transcript` stage, publishes cumulative sentence previews through the existing job SSE stream, feeds the formatted transcript to DeepSeek for better semantic context, and falls back to deterministic pause/length merging when the local model is absent, unsupported, or fails source-word alignment. The sherpa model files are local deployment assets and are never stored in Git
- **Supersedes**: the `mvp-v4` sentence-end anchor contract

### 2026-09-03: Use the maintained extraction prompt and add idioms

- **Status**: accepted
- **Decision**: load the Stage 1 DeepSeek system prompt from a repository-owned text file and make `idiom` a first-class corpus kind alongside `chunk` and `structure`
- **Reason**: idioms have different canonical-text and evidence rules from verbatim chunks, while prompt-owned usage, register, scenario, phonology, and pattern-family fields need explicit schema support instead of being discarded
- **Consequence**: `mvp-v6` invalidates earlier blueprint caches, accepts 16-32 candidates, preserves the expanded learning metadata, reserves read-time result capacity for all available kinds, and extends personal-corpus validation and storage constraints to idioms
- **Supersedes**: the `mvp-v5` two-kind extraction contract

### 2026-09-03: Explain the learner's exact selection before recommending a save unit

- **Status**: accepted
- **Decision**: treat selected transcript text as the primary explanation target, use adjacent subtitles only as semantic evidence, and preserve the selected boundary unless the model identifies an objectively broken edge whose completion is an exact span of the current subtitle
- **Reason**: a learner often selects a short but valid phrase because its contextual meaning is unclear; expanding every short selection into a sentence hides the answer they asked for and produces noisy corpus entries
- **Consequence**: `/api/corpus/analyze-selection` uses the configured DeepSeek adapter, returns context-specific explanation plus a detailed phrase-or-sentence syntax contract, validates model-proposed expansions against subtitle evidence, and labels provider fallbacks instead of fabricating meaning or IPA

### 2026-09-04: Preserve Stage 1 identity through streamed finalization

- **Status**: accepted
- **Decision**: use content-derived corpus UI identities and consistent logic IDs across previews and final results, apply the same learner-level selection policy to previews, and give each page load one abortable lifecycle shared with Retry
- **Reason**: preview-only IDs forced React to remount cards and logic nodes, unranked previews changed abruptly at completion, and ignoring stale callbacks left fetch/SSE/polling work alive
- **Consequence**: finalization updates existing DOM nodes when evidence is unchanged; selected nodes and local saves survive; duplicate previews are suppressed; aborting a load closes its stream and does not trigger fallback polling. Development Strict Mode and progressive rendering remain enabled. Server-side blueprint IDs and analysis versions are unchanged

### 2026-09-04: Use one timestamped logic navigation

- **Status**: accepted
- **Decision**: remove the separate Chapters region from Stage 1 and keep Logic Flow as the content navigation
- **Reason**: chapters identify topics, while logic nodes explain progression and relationships. Current chapters have labels but no source timestamps, so inferred chapter navigation duplicates logic with weaker evidence
- **Consequence**: delete frontend chapter-time inference and UI. Retain the `chapters` field in the current extraction contract and cache documents for compatibility; this change does not trigger paid reprocessing

### 2026-09-04: Persist and merge personal corpus by verified account

- **Status**: accepted
- **Decision**: save guest corpus locally, persist signed-in corpus through authenticated FastAPI to Supabase, and automatically import guest saves into the first signed-in account
- **Reason**: React state does not survive reload, and private learning data must be separated from shared blueprint candidates
- **Consequence**: claim guest records into an account-specific local outbox before upload, acknowledge entries individually, and deduplicate using account plus source/kind/phrase-derived keys. Existing cloud edits win; failures remain retryable without clearing pending data. Account switches abort stale work and cannot claim another account's pending entries. Saved uses actual current-video records and delete icons; other tabs use plus/check states. Speaking drafts, history, and progress merge rules remain pending

### 2026-09-04: Return authentication to the initiating reader URL

- **Status**: accepted
- **Decision**: capture the current browser URL when opening authentication and supply it as the forced redirect for both login and registration, including transfers between them
- **Reason**: Stage 1 context lives in query parameters; returning to the default home URL loses the active source and job
- **Consequence**: preserve the full same-origin browser URL, including query parameters and fragment, using Clerk's modal options. Do not derive the return target from an arbitrary query-string redirect or read browser state during server rendering

## Pending decisions

| ID | Decision | Needed before | Required evidence |
|---|---|---|---|
| D-003 | YouTube caption acquisition policy | Extension milestone | Browser feasibility, platform policy, unsupported behavior |
| D-004 | Language-model provider and output contract | Real processing milestone | Structured output, latency, cost, data policy |
| D-005 | API contract sharing method | Web integration milestone | OpenAPI generation versus maintained TypeScript contracts |
| D-006 | Remaining anonymous state merge rules (corpus accepted above) | Speaking/history milestones | Draft and progress conflicts, consent, retention |
| D-007 | Transcript and feedback retention | Production persistence | Privacy expectations, deletion behavior, operating cost |

## Decision entry template

```markdown
### YYYY-MM-DD: Decision title

- **Status**: proposed, accepted, superseded, or rejected
- **Decision**: one concrete choice
- **Reason**: evidence and tradeoff that led to the choice
- **Consequence**: code, data, product, and operational effects
- **Supersedes**: optional earlier decision
```
