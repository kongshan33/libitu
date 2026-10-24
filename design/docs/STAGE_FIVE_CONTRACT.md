# Stage 5 report contract

2026-10-20 amendment: new reports use `speaking-rubric-v2` /
`speaking-feedback-v3`, described in
[expression-led Mission planning P0–P4](STAGE_THREE_FOUR_MISSION_PLAN.md).
Planned Missions count active primary targets for transfer and report opportunity
targets separately. Skipped targets are excluded; unoffered primary targets do
not represent learner failures. A complete percentage requires an offered
opportunity or spontaneous appropriate use for every remaining primary target.
The frozen confirmed roles/register inform scenario fit, and full assistance
provenance survives freezing. Existing v1 results remain readable without
automatic reassessment. The all-selected denominator below describes legacy
Missions without a confirmed plan.

P3 adds separately validated missed-opportunity suggestions to the same assessment
call; malformed optional suggestions cannot invalidate otherwise valid scores.
Their quotes bind to the first reliable learner reply after a confirmed presented
opportunity, and suggested wording never becomes use evidence. Public feedback
includes the frozen effective support level. Linked-round comparison reads existing
ready compatible reports without triggering analysis or calculating improvement.
P4 records a dedicated positive independent-reference projection for new v3 reports.
Only new explicit-support sessions marked `speaking-evidence-v3` can contribute to
history recommendations; old results are neither upgraded nor backfilled.

P2 adds frozen initial/current support, runtime change history, each attempt's
support level/version, exact model/transfer-question quotes and exposure
certainty. The SQL enqueue allowlist and inline adapter preserve the same fields.
`20261020090509_speaking_support_and_demonstrations` is applied to the connected
development database and local/hosted rollback contracts pass. Existing v1/v2
jobs/results retain their saved inputs and are not regraded on reads.

Partial modeled audio can carry `certainty: possible`, which produces uncertain
assistance rather than independent use; it does not establish a delivered model
or transfer question. Reducing/hiding support preserves earlier session-scoped
label, frame and example exposure. Stage 4 and Stage 5 now share the same narrow
contraction/inflection variant check; model labels and `pattern_family` alone do
not establish unrestricted semantic equivalence. Reflection is advisory content
assessment, presentation is receipt-based evidence, and learner use is assessed
separately. The existing transfer dimension remains selected-item coverage; P2
does not introduce a proven learning-gain or different-content-transfer score.

Implemented locally, 2026-10-01. This page records the accepted contract, implementation and verification limits. The prototype is a layout reference, not evidence of implemented metrics. No production deployment was performed.

- Four dimensions: task fit, language transfer, scenario fit and naturalness. No overall, fluency, pronunciation or mastery score.
- Task/scenario/naturalness: model supplies criterion ratings 0–4 with exact final-user quotes; server validates and normalizes applicable rated criteria to 0–100. Missing evidence is not a zero. Feedback verbosity does not change the rubric. Difficulty is reported as context, not a hidden score multiplier.
- Transfer: unique selected items with at least one confirmed appropriate use divided by all selected items (structures and expressions together). Duplicate uses do not increase coverage. Prompted use counts, with separate independent/prompted observations. Incomplete transcripts or unresolved candidate uses prevent a complete transfer score; show partial observations instead. No user speech means no score.
- Only final USER messages of the frozen transcript contribute to scores. Assistant messages provide context only; interrupted/unavailable assistant text is not presumed heard. Quotations bind message ID, revision and UTF-16 offsets. Invalid references are rejected. The last utterance is re-evaluated even if Stage 4 asynchronous analysis did not finish.
- Logic stages are a separate optional observation, not task achievement. At most three meaning-preserving refactors; do not invent people, deadlines or commitments. Saved suggestions are explicitly AI-origin corpus records linked to the report.
- End closes the realtime connection. A durable owner-scoped job freezes settings, messages, candidate evidence and prompt exposures. End enqueues; worker reconciliation repairs an end/enqueue interruption. Reports survive refresh/process exit; leases fence stale workers. Deletion cascades and prevents late writes. POST is idempotent, explicit bounded retry after failure/partial, GET is read-only.
- Endpoint base `/api/speaking/sessions/{id}/feedback`: POST body `{retry?: boolean}` and GET both return `SpeakingFeedback` from `apps/api/app/schemas/speaking_feedback.py`. Not-ended sessions return 409. Missing/foreign sessions return 404. No report yet returns 404; the Analytics page POSTs once to request it. Report statuses: queued, processing, ready, partial, insufficient_data, failed.
- Public report envelope includes frozen session and messages, result (nullable while queued/failed), versions/hash, attempts, retryable flag and sanitized error code. Private source, leases and provider metadata do not enter API results.
- Frontend `/speaking/[sessionId]/analytics`: four cards with accessible detail switching, exact source links, grouped item observations, up to three refactors, statistics and real save/retry/adjust/new-mission actions. No fake stage-completion checks or active-duration figure. Null scores stay null; incomplete radar does not plot zero. Refresh polling never creates another assessment.
- Retry this mission uses current owned corpus IDs and original settings with a new idempotent session-create ID; deleted source items route to loadout for replacement. Adjust loadout explicitly imports the old mission into a draft without silently overwriting an existing draft. New mission opens setup without mutating existing drafts.

## Rubric and evidence

Each AI dimension has three equally weighted criteria. Task fit uses goal relevance, necessary information and progress toward the goal. Scenario fit uses register, interpersonal fit and clear intent. Naturalness uses sentence construction, word combinations and clear expression. Interpret these in the learner's specific goal; no persuasive argument is required for an everyday task.

The common scale is 0 (observed language does not meet the criterion), 1 (substantial gaps), 2 (partly meets), 3 (mostly meets), 4 (clearly meets). Missing evidence is null. A dimension receives a score only with all three grounded ratings, at least eight reliable user words, full declared user-turn review and citations across at least two user messages when two exist. The server rounds `100 × sum(ratings) / 12` to the nearest integer. These thresholds are conservative product rules, not a validated proficiency scale.

The provider returns message ID, transcript revision and exact quotation. The server resolves a unique exact substring to UTF-16 positions. Repeated ambiguous quotations, stale revisions, AI quotations and explicitly wrong positions are rejected; no fuzzy matching repairs them. The first real-provider check exposed unreliable model-generated positions, which is why final positions are calculated by the server.

Transfer counts unique appropriately used selected items, not occurrences. Prompted attribution shares Stage 4's session-scoped wording/example ledger; old unscoped exposures retain their original two-user-turn window. This is not a claim that all possible coaching was detected. Exact lexical and valid Stage 4 candidates omitted by the final analyzer remain uncertain and prevent a complete transfer score. Repeated use never inflates the denominator. The final assessment is separate from Stage 4 observations and can disagree with preliminary evidence.

Refactors are optional and deliberately conservative. Validation preserves content-token order, names, numbers, pronouns and modal/polarity commitments, accepting mainly surface grammar changes. Many useful paraphrases are therefore omitted. Saveable text must occur in the accepted suggestion. Changed retry suggestions receive new IDs; unchanged suggestions remain idempotent when saved.

## Runtime and storage

Migration `20261001114235_speaking_feedback_jobs.sql` is applied. It extends `speaking_feedback` with nullable scores and a frozen source, JSON result, versions/hash, state and lease. New reports use the versioned result; legacy scalar reports are not silently regraded. Inputs are limited to 2 MiB, results to 1 MiB. The source allowlist excludes realtime credentials, connection tickets and private provider instructions.

The database owns parent-session locks, immutable enqueue, one active claim, 120-second leases, at most three processing attempts, explicit retry and deletion cascades. Configured storage failure never falls back to memory. The in-memory adapter is only for dependency-free fixtures and does not survive another process. GET never starts paid work. `ready` and `insufficient_data` reports are immutable; normal POST returns the saved job. Failed retries retain a previously validated report for the same input.

`pnpm dev` includes the feedback worker. To run it separately: `pnpm --filter @libitu/api worker:feedback`; `uv run python -m app.workers.speaking_feedback_worker --once` runs one worker cycle from `apps/api`. The worker reconciles completed missions missing a report, then claims work. API end remains successful if enqueue temporarily fails; the worker or Analytics page repairs that gap. Long-lived worker supervision in a hosted environment is still required.

Assessment reuses server-only `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL`. Each attempt has a 45-second provider timeout, 8,000 output-token cap, 128 KiB response cap and 160 KiB complete-input cap; the outer worker deadline is 75 seconds. At most 100 user turns are supported. Oversized input is not silently truncated or scored in part. Per-account spend enforcement and production monitoring remain operational work.

API CORS follows configured `CLERK_AUTHORIZED_PARTIES`, consistent with the existing identity/runtime origin configuration. Initial implementation was verified in an isolated worktree on localhost:3001/8001. The 2026-10-02 integration preserves the original checkout's localhost:3000/8000 configuration; ignored environment files were not copied. Server-only development processes need a separately launched feedback worker or a restart through `pnpm dev` to process jobs. The local feedback worker was launched during integration after a read-only check found no pending or unreported completed Missions; normal future end/request jobs can now be processed.

## Initial implementation verification

- Fixed evaluator cases and unit tests cover negative/uncertain/missing evidence, structures and expressions, prompted use, unique Unicode quotes, revision changes, AI-only input, a final turn without Stage 4 analysis, conservative rewrites, provider failure and resource bounds. They verify contracts and deterministic calculations, not human grading accuracy.
- Real Supabase rollback assertions passed for owner isolation, idempotency, source secrecy/immutability, leases/reclaims, late completion, retry limits, service-only grants and cascading deletion. Advisors reported no new warnings/errors.
- `apps/api/scripts/smoke_speaking_feedback.py --live` passed with isolated synthetic corpus/session records and one bounded final DeepSeek assessment: all three user turns reviewed, 18/18 dimension quotations validated, four scores produced, both selected items confirmed, same-job retry/read recovery and cross-owner rejection verified. Earlier calls correctly returned partial when model offsets failed validation; the corrected contract passed. Synthetic records were deleted afterward. This is synthetic text-provider/storage integration, not live microphone or real OAuth acceptance.
- Analytics and Stage 4 browser regressions passed at 1440/768/390 px, covering end → report → read-only review, keyboard tabs/source focus, null scores/radar, generation/retry/failure/insufficient data, real corpus POST provenance and idempotency, deleted-source replacement, retained drafts, lost-create acknowledgement recovery and account changes. Browser identity and API/provider events were fixtures. Desktop/tablet/mobile screenshots and reduced motion were checked.
- `apps/web/tests/learner-journey.browser.mjs` passed one continuous journey: Stage 1 actual Save to corpus action → Loadout selection/login sync/create → Stage 4 typed user turn/evidence/reply → end/report → quoted-source focus → corpus suggestion save → retry as a fresh mission with original settings. It renders the actual app and clients with synthetic source/auth/provider responses; it does not claim live OAuth completion.
- Root lint/build/test pass: 711 API + 282 web + 112 extension = 1,105 passing tests. Two optional pre-existing acoustic tests require `parselmouth`/`onnxruntime` and are skipped in this worktree's development-only Python environment. Stage 5 tests do not require those packages.

Human-reviewed rubric calibration, score stability across representative conversations, physical-device voice acceptance and real Clerk/OAuth end-to-end verification remain separate. No accuracy percentage or general English level is claimed.

## Personal-page integration — 2026-10-02

The original checkout now includes this implementation and a read-only latest-report summary in `/profile`. Completed practice history opens Analytics; unversioned legacy rows fall back to conversation review. The summary verifies current versions, dimensions, status, ownership and null scores, sorts by practice time and does not infer five-dimensional general ability. See [profile scope and verification](PROFILE_IMPLEMENTATION.md). Integration verification uses fixtures and a real read-only Supabase projection, without another paid assessment or historical-report backfill.

Implementation references: [DeepSeek JSON output](https://api-docs.deepseek.com/guides/json_mode/), [Supabase database functions and privileges](https://supabase.com/docs/guides/database/functions).
