# Complete the next Libitu milestone

```yaml
meta:
  contentType: How-to
  status: active
  updated: 2026-09-06
```

This is the living task queue for coding agents. Work from the first unblocked milestone. Update checkboxes, verification notes, and affected decisions in the same change.

## Milestone 0: keep the foundation green

- [x] Configure pnpm workspace and Turborepo
- [x] Restructure apps and shared packages
- [x] Initialize FastAPI routes and smoke tests
- [x] Add agent and product documentation
- [ ] Add a continuous integration workflow for install, lint, build, and test
- [x] Add web unit-test tooling and one feature-level test

Acceptance criteria:

- `pnpm lint`, `pnpm build`, and `pnpm test` pass from the repository root
- Generated files, dependencies, local environments, and secrets remain ignored

## Milestone 1: connect the web prototype to the API

- [x] Add a typed API client boundary in `apps/web`
- [x] Add development environment configuration for the API base URL
- [x] Replace direct demo rendering with loading, ready, failed, and unsupported states
- [x] Keep demo fixtures available for tests and local story states
- [x] Add contract tests for content resolve, job creation, job SSE/polling, and blueprint retrieval

Acceptance criteria:

- The Stage 1 page can resolve content, create or resume a job, and render its blueprint
- API failures produce a recoverable user-facing state
- Components do not import FastAPI implementation details

Verification notes:

- Stage 1 uses `apps/web/features/stage-one/api/stage-one-api.ts` for content resolve, job creation, SSE progress with polling fallback, and blueprint fetch.
- Stage 1 transcript lines and logic nodes seek the embedded YouTube player. Transcript clicks and playback time updates also activate the latest logic node at or before the current subtitle timestamp. The redundant Chapters UI and estimated chapter timestamps have been removed; the API field remains compatible with existing blueprints. Chunk and structure annotations remain usable when an extracted phrase spans adjacent caption lines.
- Contract coverage lives in `apps/api/tests/test_smoke.py`; web regression tests run through the root test command.

## Milestone 2: implement persistence and identity

- [x] Record the database and auth decisions in `DECISIONS.MD`
- [x] Add the initial relational schema and repository migration directory
- [x] Apply the schema to the hosted Supabase project and clear advisor warnings
- [ ] Replace in-memory repositories behind service interfaces
- [x] Add optional and required authenticated-user dependencies to FastAPI
- [x] Define anonymous local corpus keys and account-merge behavior
- [ ] Add authorization tests for corpus and speaking records

Acceptance criteria:

- Public processing cache data is separate from private learning data
- A learner cannot read or mutate another learner's corpus or sessions
- Anonymous Stage 1 remains usable
- Migrations can create a clean local database deterministically

Verification notes:

- Supabase, Clerk, and Upstash boundaries are defined in `design/docs/DATA_ARCHITECTURE.md`.
- Supabase project `ulrdykwhggcaspylines` has initial, Clerk RLS, processing-document, observability, and idiom-kind migrations applied. Prior advisor warnings were cleared by optimizing Clerk JWT policy expressions; the latest advisor recheck encountered a transport failure.
- Hosted Clerk Third-Party Auth still needs its final Supabase dashboard confirmation for direct Data API access. The corpus path instead verifies Clerk in FastAPI and uses a server-only repository with explicit owner filters. Real-token browser login integration remains unverified.
- Corpus persistence is connected; speaking repository replacement remains pending. New corpus tests cover owner-scoped queries, retry idempotency, cloud-edit preservation, private-source denial, and database failure without memory fallback.
- Auth return targets are explicitly set for login, registration, and cross-flow transfers using the full URL captured on click. Browser regression checks intercept both Clerk modal calls to verify their targets and check Create account hover colors; this does not replace a real credential/OAuth completion test.

## Milestone 3: build the YouTube extension entry

- [x] Choose extension build tooling and record the decision
- [x] Add Manifest V3 configuration and a direct toolbar action
- [x] Detect supported YouTube watch pages
- [x] Read video metadata and visible transcript text in the browser
- [x] Open or hand off to the Stage 1 experience
- [x] Add local cache restoration and unsupported-page behavior
- [x] Add player-control and toolbar one-click entry with SPA video detection
- [x] Open Stage 1 before captions/API work and recover the caption handoff on reload
- [x] Gate both extension entries on verified English video metadata

Acceptance criteria:

- The unpacked extension loads without manifest errors
- A verified English video reaches Stage 1 with no media upload
- Non-English or unknown-language videos, unsupported pages, and missing/mismatched video players show a specific reason and do not create a processing job. Missing browser captions on an English video may use the existing backend caption provider; unavailable captions ultimately produce an explicit unsupported state.

Verification notes:

- The first extension version is framework-free and validates `manifest.json` plus referenced files with `apps/extension/scripts/validate-extension.mjs`.
- Both entry points validate the current watch URL/player/title and video language, then open Stage 1 and acquire timestamped browser captions while the web page loads. The current supported-language list contains only `en`. The in-player entry stays disabled while checking and for non-English/unknown languages, exposes a hover reason, uses the existing Libitu icon in YouTube's lower-right control group, and reattaches when the player redraws its controls. Metadata/caption content-script messages are separate, and a missing receiver is injected once before retrying. Unsupported toolbar clicks show a badge/title and in-player message without opening another UI surface.
- Browser captions use a 15-minute `chrome.storage.session` handoff, a same-origin message bridge, and bounded waits. The web app creates the content/job after handoff, replaces its URL with durable IDs, and reuses them on Retry/reload. No media or transcript text is embedded in the launch URL.
- Six extension tests and four additional web tests cover language gating, launch ordering, duplicate clicks, missing receivers, source checks, worker restart, bridge cancellation, and bounded fallback. The real-unpacked-extension Playwright check uses a mocked YouTube SPA/API with YouTube's nested left/right control groups and verifies English enablement, non-English disablement and hover feedback, player-control mounting, page visibility before captions/API completion, navigation invalidation, reader reuse, caption delivery, failed-job Retry without re-resolving the source, durable URL restoration, and narrow-screen overflow. Observed development runs showed the player container and loading state between roughly three and eight seconds under varying development load; these are environment-dependent observations, not a live YouTube playback or model-completion benchmark or a latency guarantee.
- The broader pre-existing Stage 1 browser suite encountered timeouts around corpus restoration and navigation while the local Clerk integration logged session-refresh redirect loops. Real login/corpus browser verification remains environment-dependent; no Clerk credentials were changed as part of this entry optimization.

## Milestone 4: replace blueprint placeholders

- [x] Define the versioned blueprint structured-output schema
- [x] Add a deterministic caption-text processing baseline
- [x] Add a language-model adapter with timeout, retry, and bounded input/output
- [x] Cache jobs by normalized content key and analysis version
- [x] Persist job failure details that are safe to show to learners
- [x] Extract an evidence-checked corpus candidate pool and rank it by learner CEFR level
- [x] Recover pending queue jobs, isolate blueprint caches by analysis version, and reject obsolete work
- [x] Add worker readiness, processing stages, timestamps, timings, and bounded external requests
- [x] Move English subtitle punctuation and sentence segmentation to a local streaming formatter
- [x] Keep the YouTube player mounted while streamed transcript state changes
- [x] Preserve preview-to-final node identity and cancel disposed Stage 1 loading chains
- [ ] Add fixtures for malformed, short, long, and multilingual transcripts

Acceptance criteria:

- Reprocessing the same content and version returns the cached result
- A schema-invalid model response fails safely or retries within policy
- Tests do not require a paid model call

Verification notes:

- Different content IDs now produce source-specific titles, transcript lines, timestamps, and corpus candidates.
- DeepSeek JSON output is validated with Pydantic and retried at most twice for retryable provider or schema failures; automated tests inject a fake analyzer and make no paid calls.
- DeepSeek responses stream into a partial JSON parser and are still checked for truncation and schema errors before completion. Evidence-backed formatting variance is normalized, individually invalid corpus candidates are dropped when valid candidates remain, output budgets start at 32K and remain bounded at 64K, and provider diagnostics include completion-token usage without response or transcript content.
- The `mvp-v9` contract uses the repository-owned Stage 1 system prompt and extracts 16-32 bounded chunks, idioms, and structures with exact source evidence, usage/register/scenario/phonology metadata, CEFR level, and three quality scores. It omits subtitle text and sentence-boundary metadata; duplicate, low-quality, or transcript-unsupported candidates are discarded, while `GET /api/blueprints/{content_id}` applies read-time learner-level ranking and a three-kind-balanced result limit.
- All caption fragments within the explicit 240,000-character job limit remain eligible for evidence. Before punctuation, deterministic token cleanup removes standalone `um`, `uh`, `er`, and `ah`, merges caption continuations, and groups consecutive lines with the same timestamp. The resulting transcript is shared by sherpa-onnx, DeepSeek, Stage 1 display, and evidence checks; the raw caption payload remains stored.
- Reliably punctuated English captions bypass sherpa-onnx. Other captions reach the local model with external punctuation removed, then reuse source words and casing with only the model's normalized punctuation. Duplicate/conflicting marks and high-confidence opening discourse markers are normalized on every path; timestamps and non-filler words remain source-grounded, and invalid or unavailable model output falls back to conservative local merging.
- The backend owns `ANALYSIS_VERSION`; browser clients cannot submit it. Versioned Redis/Supabase reads prevent stale blueprints from crossing analysis versions.
- `pnpm dev` starts API and worker processes together. `/health/ready`, job stage fields, per-stage timings, and structured worker logs make stalled work diagnosable.
- Worker heartbeats include the loaded analysis version and model; readiness reports `stale` when API and worker processes are not running the same extraction contract.
- The Stage 1 web client shows the video immediately, consumes validated summary/logic/corpus and sentence-sized transcript previews over job SSE, and falls back to bounded polling after a stream disconnect. Source URL and YouTube origin state are initialized after hydration so the server and first client render remain identical. The YouTube API owns an imperative iframe inside a React-owned stable container, so transcript callback updates cannot remove the player. The extension opens Stage 1 before caption capture and enqueueing.
- Stage 1 subtitle auto-scroll runs only during active video playback. Paused or ended playback suspends alignment while keeping its control interactive; manual transcript scrolling creates a short alignment pause, and the auto-scroll control always toggles the setting, with alignment resuming when it is turned back on during active playback.
- Eight web regression tests cover cancellation, polling fallback, stale/duplicate previews, stable identities, and learner-level ranking. A mocked-API Playwright check at 1440px and 390px verified one job read, one SSE connection, one blueprint read, and preservation of corpus-card, logic-node, transcript-row, and player-iframe DOM identities across finalization; no real provider requests were made.
- Stage 1 recovers old shared URLs whose job or blueprint belongs to an obsolete analysis version by resolving the current server-owned job before retrying the blueprint read.
- A local benchmark on the 50,385-character Peter Thiel transcript formatted 475 caption rows into 645 timestamped sentences in 4.122 seconds on the development machine without calling DeepSeek.
- Production metadata on 2026-09-05 showed a 54,852-character transcript formatting in 12.491 seconds, then spending 230.952 seconds in DeepSeek and failing after repeated output truncation. The old 210-second browser deadline was shorter than the 251.5-second job. `mvp-v7` adds hard output-field limits, uses 32K then 64K, preserves earlier preview fields across provider attempts, waits up to ten minutes, and retains the preview during Retry. A regression test covers non-regressing previews; a paid live `mvp-v7` long-video run remains pending.
- A failed Stage 1 job remains read-only on initial page load; the visible Retry command explicitly resets and re-enqueues it instead of repeatedly reading the same failed job.
- The job-observability migration was applied to Supabase project `ulrdykwhggcaspylines`; post-migration advisors returned only expected informational notices.
- A consented live test completed `pending -> processing -> ready` in one attempt and persisted the result to Supabase.
- The YouTube transcript fallback was verified against a public captioned video without logging transcript content.

## Milestone 5: complete corpus and speaking

- [x] Connect Stage 1 corpus list, create, and delete with local/account persistence
- [x] Open corpus cards with full source context and persist on-demand analysis details
- [ ] Add the cross-content corpus library and saved-item editing interface
- [ ] Build speaking loadout selection limits
- [ ] Implement the role-play adapter and turn persistence
- [ ] Detect selected-item use with transparent evidence
- [ ] Generate four-dimension session feedback with supporting turns
- [ ] Add end-to-end coverage for save, loadout, role-play, and feedback

Acceptance criteria:

- A saved input item can be selected and detected in a speaking session
- Feedback references actual turns and distinguishes measurements from model judgments
- Reloading preserves signed-in state

Partial verification notes:

- Selection-card lifecycle is covered by the desktop/mobile browser check: outside dismissal, internal interactions, pin/unpin, replacement of a pinned card, and rejection of late responses for repeated text. New cards start unpinned with a fresh note and explanation tab.

- Corpus cards open a native modal with the original subtitle context and complete explanation/syntax tabs. Unsaved candidates use a page-session cache; new saves include that detail, while legacy saved items call AI only when detail is absent and persist the result to localStorage or the owner-scoped Supabase record. Desktop/mobile browser checks cover dialog bounds, source highlighting, tab switching, save-button isolation, cache reuse, and legacy hydration.

- Stage 1 supports manual transcript selection into a corpus analysis card. The backend exposes `/api/corpus/analyze-selection`, uses maintained explanation and seven-module syntax prompt sections, preserves short phrase boundaries by default, and accepts a completion only when it is an exact span of the current subtitle. The card omits boundary commentary for complete selections and shows a suggestion only when expansion is needed. Provider failures are explicit rather than disguised as generated analysis. Accepted expressions and structure templates use the same durable save path as extracted candidates, including learning metadata and slots.
- Anonymous saves survive reload in localStorage. Login claims guest records into an account-bound outbox and uploads them idempotently; acknowledged items are removed individually, existing cloud edits win, and failures keep unsynced data with a Retry action. Saved is scoped to the current video and uses delete icons, not add icons.
- Twelve corpus-storage web tests cover guest reload/removal, detail hydration, partial merge, account isolation, late-response cancellation, storage failure, uncertain saves, remote deletion failure, corrupt data, token ownership, and cross-tab write-loop prevention. Backend coverage verifies owner-scoped detail generation is persisted and generated only once.
- On 2026-09-04, all 19 web tests and 46 backend tests passed. Desktop/mobile browser checks verified guest save/reload/delete and trash icons even after a saved item's text changed; the four-tab layout was constrained to avoid scrolling/clipping the entire right panel. A live Supabase test verified idiom insert/list/update/delete, edit-preserving duplicate writes, and cross-owner rejection through the server repository. Synthetic data was cleaned up; real Clerk login/logout in the browser remains a separate unverified integration.

## Later milestones

- [ ] Intensive listening and local shadowing
- [ ] Reading workspace, starting with pasted text
- [ ] Article URL extraction after supported-source rules are defined
- [ ] Product analytics and privacy-reviewed event tracking
- [ ] Deployment, observability, backups, and production runbooks

Do not add spaced repetition, social features, server-side media processing, or voice role-play unless a new accepted decision changes MVP scope.
