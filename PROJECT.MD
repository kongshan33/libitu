# Understand the Libitu project

```yaml
meta:
  contentType: Reference
  status: active
  updated: 2026-09-04
```

This file gives coding agents a fast, factual view of the repository. Read `AGENTS.md` first, then use this page to distinguish implemented behavior from planned product behavior.

## Current objective

Build the smallest reliable loop from a supported YouTube video to a saved corpus item and an AI speaking session. Keep reading and intensive listening compatible with the architecture, but do not let them delay the first complete loop.

## Repository status

| Area | Current state | Next meaningful outcome |
|---|---|---|
| Monorepo | pnpm workspace and Turborepo configured | Keep root commands green |
| Web | Stage 1 preserves streamed node identity, links transcript and logic timestamps, and saves extracted or manually selected corpus locally or to an authenticated account | Add the cross-content corpus library and saved-item editing UI |
| API | FastAPI routes, Clerk identity, recoverable queued blueprint workers, local subtitle punctuation, stage timing, YouTube fallback, and live DeepSeek analysis | Add rate limits and external metrics export |
| Extension | Manifest V3 side panel captures timestamped captions and hands off content/job IDs | Harden caption acquisition across YouTube UI variants and add playback controls |
| Shared packages | Types, pure core helpers, UI tokens, config | Add only contracts used by two or more apps |
| Auth | Clerk UI, Next.js middleware, and FastAPI identity verification are configured locally | Finish hosted Clerk-Supabase trust setup and add real-token integration tests |
| Database | Supabase persists content, jobs, blueprints, and authenticated corpus; the idiom constraint migration is applied | Replace remaining speaking in-memory repositories |
| Cache | Upstash queue, versioned blueprint keys, pending-job recovery, bounded requests, worker heartbeat, and locks implemented | Add rate limiting and a durable retry scheduler |
| AI | sherpa-onnx formats English subtitles locally; DeepSeek V4 Flash produces evidence-checked `mvp-v6` semantic blueprints with CEFR-ranked chunks, idioms, and structures | Add quality fixtures, evals, and speaking adapters |

## Product references

- `design/docs/Libitu_Design_Spec.md`: product behavior and interaction requirements
- `design/docs/MVP_SYSTEM_DESIGN.md`: architecture, state, and data flow
- `design/docs/BACKEND_SYSTEM_DESIGN.md`: API implementation boundary
- `design/docs/DEVELOPMENT_ROADMAP.md`: dependency-ordered delivery plan
- `DECISIONS.MD`: accepted decisions and unresolved choices
- `TASK.MD`: current task queue and acceptance criteria

## Definition of the first complete release

The release is coherent when a learner can:

1. Start from a supported YouTube page
2. Receive or restore a cached blueprint without mandatory login
3. Save at least one chunk or structure
4. Create a speaking session with selected corpus items
5. Complete turns and receive evidence-based feedback
6. Reload and recover the state promised for anonymous or signed-in use

## Current constraints

- Never upload YouTube media or microphone recordings
- Do not claim an integration exists until code and tests prove it
- Keep API schemas explicit and version processing output with `analysis_version`
- Preserve provider boundaries for auth, persistence, captions, and language models
- Exclude spaced repetition from MVP work

## Implementation notes

- Stage 1 resolves content, creates or resumes a processing job, streams validated job previews over SSE, and fetches the completed blueprint through `apps/web/features/stage-one/api/stage-one-api.ts`.
- Initial load and Retry share one abortable effect. Cleanup cancels fetch, SSE, and polling; cancellation never falls back to polling. Identical previews are suppressed. Preview and final corpus items share content-derived UI identities, a learner-level ranking policy, a 12-item limit, and source-evidence highlighting. Logic IDs and timestamps remain stable across finalization, and cached ready jobs skip stale previews. Normal streaming updates and development Strict Mode remain enabled.
- Web regression tests run with Node 22.15+ via `pnpm --filter @libitu/web test`, using built-in test mocks without paid providers. The optional `apps/web/tests/stage-one-render.browser.mjs` check uses Playwright and an existing dev server to verify DOM identity and request counts on desktop/mobile; `LIBITU_PLAYWRIGHT_MODULE` can select an externally installed Playwright runtime.
- Stage 1 uses the YouTube IFrame API for timestamp seeking. Transcript lines and logic nodes seek the same stable player; streamed transcript callback changes do not destroy its iframe. The redundant Chapters UI and inferred chapter timestamps are removed; `chapters` remains in the backend contract for compatibility with cached blueprints.
- Stage 1 transcript selection now opens an analysis card on mouseup. The card sends the selected span plus the current, previous, and next subtitle lines to `/api/corpus/analyze-selection`; the configured DeepSeek adapter follows separate explanation and seven-module syntax task sections, explains the exact selection in context, and validates any boundary expansion against the current subtitle. Complete selections show no redundant boundary message; only `needs_expansion` renders a suggested unit and reason. Explanation stays first, syntax remains available, inferred chips are editable, and accepted expressions or reusable structures use the same local/account save flow as extracted candidates. Provider failures are visibly labelled and never replaced with fabricated meanings or IPA.
- Transcript annotations use amber for chunks and teal for structures. The API emits annotations for new analyses, while the web adapter reconstructs split-caption annotations for cached blueprints.
- Selection cards dismiss on outside pointer interaction unless pinned with the top-right pin toggle. Each new transcript selection replaces the old card, resets pin/note/tab state, and gets a unique identity so late analysis or save completions cannot overwrite or dismiss the new card. Desktop/mobile browser regression coverage checks dismissal, pinning, replacement, and stale responses.
- `apps/web/features/stage-one/data/stage-one-demo.ts` is now a fixture only; the Stage 1 component does not import it directly.
- In queue mode, processing jobs return `pending`, are pushed to Upstash, and are consumed by `apps/api/app/workers/blueprint_worker.py`. Tests use the deterministic inline path and never call a paid model.
- `pnpm dev` starts the API server and blueprint worker together. `/health/ready` reports a missing or unreachable queue worker instead of allowing silent pending-job accumulation.
- The worker prefers browser-provided captions, falls back to `youtube-transcript-api`, and asks DeepSeek V4 Flash for validated JSON blueprint output.
- Analysis version selection is server-owned. Job IDs and blueprint cache keys include the active version; pending jobs are safely re-enqueued and obsolete queued versions fail without a model call.
- Stage 1 detects missing current-version blueprints behind old shared job URLs and resolves the server-owned active job instead of retrying the stale job forever.
- Jobs expose their current processing stage, timestamps, per-stage milliseconds, and an ephemeral validated analysis preview. The worker publishes cumulative local subtitle batches before consuming DeepSeek SSE, handles two jobs concurrently by default, and emits structured lifecycle logs without transcript content.
- `mvp-v6` loads the maintained Stage 1 system prompt from `apps/api/app/prompts/stage_one_system.txt` and asks DeepSeek for 16-32 evidenced chunks, idioms, and structures plus summary, chapters, logic, key points, and scenarios. Candidates retain usage, register, scenario, phonology, pattern-family, CEFR, and quality-score metadata; blueprint reads rank and return a three-kind-balanced subset for the requested learner level without rerunning the model.
- English subtitle punctuation and truecasing use the local sherpa-onnx INT8 model in bounded overlapping windows. Output is accepted only when its normalized word sequence matches the source; missing models, unsupported languages, or alignment failures use conservative deterministic merging.
- Stage 1 displays the source video immediately and streams locally formatted sentence batches from `/api/jobs/{job_id}/events`, then progressively fills DeepSeek summary, logic, and evidenced corpus candidates; browser polling remains a disconnect fallback. One-job input is explicitly capped at 240,000 characters, and semantic-only output budgets scale from 16K to a bounded retry without carrying transcript sentence metadata.
- The Chrome extension can detect YouTube watch pages, attempt to open the transcript panel, capture timestamped captions, create a FastAPI job, and hand its `contentId`/`jobId` to Next.js Stage 1.
- Missing captions produce an unsupported state instead of returning the old Anthropic demo blueprint.
- Private corpus and speaking endpoints derive ownership from a verified Clerk user instead of accepting a client-provided `user_id`.
- Anonymous corpus saves use `libitu:corpus:v1` in localStorage. Login atomically claims guest items into an account-specific pending outbox, merges with the account list, and acknowledges each successful upload separately. Source/kind/phrase keys deduplicate retries; existing cloud edits win. Logout and account switches never expose or transfer another account's pending items. Failed sync remains visible and retryable, and storage failures are not reported as successful saves.
- Saved shows this video's stored snapshots, independent of the currently ranked candidate pool. Saved cards use a delete icon; other tabs show a check for saved items and a plus for unsaved items. Full learning metadata and reusable slots survive reload. A cross-video corpus library and saved-item editing UI remain planned.
- Configured corpus requests use the Supabase server repository with explicit owner filters, verified source access, and idempotent inserts. Queue mode without a database returns 503; only unconfigured inline development/tests retain the in-memory adapter. The frontend never receives a Supabase secret or writes with an unverified user ID.
- Supabase project `ulrdykwhggcaspylines` has the initial, Clerk RLS, processing-document, job-observability, and idiom-kind migrations applied. Prior advisors reported only intentional private-schema RLS and unused-index informational notices; the latest advisor recheck encountered a transport failure.
- The Next.js app includes Clerk middleware, provider wiring, and sign-in controls. Hosted Supabase Third-Party Auth still requires its final dashboard save before Clerk tokens can be used directly with the Data API.
- Account buttons capture the full current browser URL at click time and pass it as Clerk's forced return target for both sign-in and sign-up, including transfers between the two flows. Source/job/content parameters and fragments are preserved without reading browser state during server rendering. Primary-button hover/focus uses defined design tokens.
- Upstash stores the processing queue, short-lived content/job/blueprint state, and processing locks. These keys expire and are not the durable source of truth.
- The Supabase processing-document migration is applied and the server repository is active for content, private transcripts, jobs, and blueprint documents.
- A live end-to-end queue test reached `ready` after one attempt and persisted four logic nodes and six corpus candidates. The YouTube fallback separately fetched 1,847 timestamped caption lines from a public test video.
- `design/docs/DATA_ARCHITECTURE.md` defines Supabase, Clerk, and Upstash responsibilities.
