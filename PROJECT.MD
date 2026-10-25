# Understand the Libitu project

```yaml
meta:
  contentType: Reference
  status: active
  updated: 2026-10-25
```

This file gives coding agents a fast, factual view of the repository. Read `AGENTS.md` first, then use this page to distinguish implemented behavior from planned product behavior.

## Practice workspace visual refresh — 2026-10-25

Stage 1, segment selection and Stage 2 now use the supplied ElevenLabs-style
reference: white canvas, warm neutral surfaces, lighter typography, pill controls
and black primary actions. The theme is scoped to these workspace pages and their
loading shells. Stage 1 keeps the video and existing Enable reference audio
component, with the summary above the video and underlined transcript highlights;
there is no separate audio player. Segment selection uses neutral cards and a
single purple selection color. Quick, Detailed and Review keep their settings,
recording/authorization flows, history and analysis; learning/error colors remain.
The shared header now centers the Stage navigation independently of the title
and account controls, including its stacked narrow-screen layout. The segment
picker no longer shows the redundant five-minute badge.
Following the user's spacing feedback, practice workspace horizontal insets are
16 px on desktop and 12 px on phones. The picker places Back on the right and
uses a text-only Recommended badge.
The outer workspace fills the viewport; the previous 1280 px cap and automatic
side margins have been removed to address the user's 80 px margin report.
See `TASK.MD` for validation and fixture limitations.

## Release confirmed Mission starts — 2026-10-24

Loadout now clears its pending creation request after a verified successful
create or retry, before navigating to the Mission. The response must match the
account and original client request ID. Confirmation is persisted under the
existing draft lock/CAS before the UI is unlocked; failures retain the exact
retry request. Targets, scenes and settings remain available for a new Mission.
Previously successful requests stayed pending forever, so returning after ending
a Mission replayed the old ID and kept setup controls locked. No API/database or
cancelled startup-optimization change is included. Verification is in `TASK.MD`.

## Mission preparation latency P0/P1 — 2026-10-24

One-button Start now requests one scenario; manual comparison and linked practice
request two. Existing one-to-three-candidate plans remain readable. Planning v5
makes at most one field repair: verified good fields/scenes stay unchanged, the
server chooses patch locations, and the complete merged plan must validate.
Original schema, semantic and practice errors are collected together. Malformed
JSON or an unlocatable structure fails with selection retained, without a full
regeneration. The shared 90-second model / 120-second browser limits remain.

Selected corpus inputs use one owner-filtered batch read. The browser reuses a
matching plan across difficulty, feedback, logic-template and support changes;
scene preferences, target order/roles and source content invalidate it. Exact
uncertain-create replay still takes precedence. A fresh five-target startup now
uses five database HTTP requests (one input read, one plan save, one creation,
two workspace reads), previously nine; this excludes corpus bootstrap and auth.
Server phase timings and correlated request IDs reach browser Performance
measures, including cache hit/miss and click-to-ready. No learner text is logged.

The single-scene migration is applied to the connected development database.
A five-target synthetic Ark request validated in 18.01 seconds (13.85 generation
+ 4.11 local repair); an injected one-field repair took 2.46 seconds. A separate
three-target hosted persistence smoke passed with planning 11.47 seconds,
creation 0.32 seconds and workspace read 0.63 seconds, then removed all synthetic
records. These samples verify the pipeline, not latency percentiles, teaching
quality or Gemini voice. See `TASK.MD` and
`design/benchmarks/mission-planning-20261024/` for verification.

## Loadout planning timeout repair — 2026-10-24

Loadout generation and one-button Start share the same planner. A live browser
reproduction timed out under its former 45-second model budget. New planning now
requests two concise candidates with mandatory non-null sentence frames in the
model-facing schema, while legacy stored plans remain readable. AI frames use a
target placeholder that the server expands from the verified saved expression,
then validates; this prevents the model from silently rewriting selected words.
Repair receives all safe semantic error locations. The two-attempt
shared budget is 90 seconds; browser planning allows 120 seconds and shows that
wait explicitly. Mission creation retains its 20-second timeout and exact retry
identity. The signed-in browser successfully generated and saved the original
five-target plan and opened its ready Mission. 226 focused API tests and 27 Web
tests pass; microphone/runtime verification is outside this repair. Details are
recorded in `TASK.MD`.

## Doubao text-provider migration — 2026-10-23

All former DeepSeek text requests now use Doubao through Volcengine Ark:
Stage 1 streaming blueprints, selection explanations, Mission planning, background
teaching analysis, explicit help and Stage 5 assessment. `ARK_API_KEY` is server-only;
`ARK_MODEL` defaults to `doubao-seed-2-1-lite-260915` and `ARK_BASE_URL` to
`https://ark.cn-beijing.volces.com/api/v3`. Gemini Live retains its own key/model.
Text timeout and Stage 1 budgets use `ARK_*`. Obsolete `DEEPSEEK_*` and
`GEMINI_TEXT_*` entries are ignored. Requests disable thinking and retain existing
JSON/evidence validation, retries, streaming previews and bounded failure handling.
Existing cached blueprints, reports and historical provider verification records
remain unchanged. The supplied key can generate JSON with the Lite model; the
Pro model in the supplied example returns `ModelNotOpen`. Real synthetic checks
pass for streaming blueprints, selection explanations, teaching analysis (after an
initial transport failure) and a complete three-turn assessment. Root lint/build/test
pass (1,589 API, 429 cached Web, 114 cached extension tests). No learner records or
database writes were involved; this migration does not establish model or teaching
quality. Verification details are tracked in `TASK.MD`.

## Linked practice and evidence-based support P3/P4 — 2026-10-20

P3 adds separately validated missed-opportunity rewrites, explicit second rounds with
changed details or swapped roles, and factual comparison of existing ready reports.
Rewrites quote the learner's actual reply to a presented opportunity and remain AI
suggestions, never observations or scores. P4 reads repeated reliable independent
evidence and offers a user-applied reduction of one support level; it does not infer
mastery. Every primary target needs three Missions, two UTC practice dates and two
scene families. See [the contract](design/docs/STAGE_THREE_FOUR_MISSION_PLAN.md).

New explicit-support sessions freeze original corpus IDs and an evidence version;
legacy sources and retries retain their identities and are not retrospectively
upgraded. Migrations `20261020094401_speaking_linked_practice` and
`20261020094408_speaking_support_history` and the evidence-date follow-up
`20261020094938_speaking_support_evidence_dates` are applied to the connected development
database. Both new and all three previous SQL rollback suites pass locally and
hosted. Application and browser verification is tracked in `TASK.MD`; no application
deployment or learning-effect validation is implied.

## Mission demonstrations and manual support P2 — 2026-10-20

P2 adds four explicit support levels independent of difficulty: `model_frame`,
`model_label`, `label_only` and `no_hint`. New drafts start with model plus frame;
old absent/null settings keep legacy behavior. Learners change support manually.
The two modeling levels use a separate `model_then_transfer` policy: one natural
use in the AI's own response, followed by a question inviting different learner
content. Reduced levels retain implicit elicitation without selected wording.
Every explicit level suppresses automatic help cards; requested help stays available.

Server-validated sentence frames, revision-bound UTF-16 demonstration highlights,
versioned safe-boundary support changes and frozen presentation evidence are
implemented. Hiding support does not erase earlier assistance; partially played
demonstrations carry possible exposure and cannot establish independent use.
Stage 4 and Stage 5 share conservative contraction/inflection variant validation.
There is no automatic mastery-based upgrade, semantic-paraphrase matching claim
or measured teaching-effect result. See [the Mission contract](design/docs/STAGE_THREE_FOUR_MISSION_PLAN.md).

Migration `20261020090509_speaking_support_and_demonstrations` is applied to the
connected development database. New and existing planning/feedback SQL rollback
contracts pass locally and on hosted Supabase. Root lint/build/test pass:
1,384 API, 423 Web and 114 extension tests. Existing planning/help and
loadout/analytics browser regressions pass with synthetic fixtures; dedicated
support acceptance passes at 1440/390 px, including cold no-hint, legacy opt-in,
actual visibility after menu animations and explicit help. A real DeepSeek/Supabase probe
passes after fixing an overly strict terminal-punctuation frame check; all synthetic
records are removed. Its runtime receipts are fixtures, not live Gemini or learner
evidence. See [verification details](design/benchmarks/mission-support-20261020/README.md).

## Expression-led Mission planning — 2026-10-20

P0/P1 connects selected language to generated scenarios and frozen, target-specific opportunity plans. New Loadout uses one to three primary targets plus up to two opportunity targets. Its default Start mission action generates or reuses a suitable scene, saves the Mission and opens it; manual scene comparison is optional. Uncertain creation retries reuse the saved request before generating another plan. Stage 4 keeps asynchronous implicit teaching, adds planned primary-target priority, records actual opportunity delivery, and supports skip/restore. Stage 5 freezes complete presentation provenance and excludes skipped or unoffered targets from learner-failure claims. P2 adds demonstrations and manual support; the P3/P4 section above records the later review, linked-round and history increment. See [the implementation contract](design/docs/STAGE_THREE_FOUR_MISSION_PLAN.md) and `TASK.MD` for verification and migration status.

Selection guidance recommends two primary targets plus zero or one opportunity
target while retaining the full allowed budget. Recoverable generated-content
errors get at most one constrained regeneration inside a shared 45-second model
budget; final validation stays strict. System errors keep the selection and offer
retry. Scene-fit advice names one validated candidate and its target-specific
reasons, with explicit role/removal actions rather than automatic target changes.

The two development-database migrations are applied. A bounded real DeepSeek/Supabase probe passed scenario generation, snapshot creation, stale-plan rejection, recovery and feedback freezing; all synthetic records were removed. Runtime opportunity events in that probe are fixtures, so it does not qualify Gemini teaching behavior or learning effects. See [the integration evidence](design/benchmarks/mission-planning-20261020/README.md).

## Mission teaching control and private diagnostics — 2026-10-18

Doubao text analysis observes each finalized learner utterance with frozen context while Gemini Live replies independently. The first two substantive learner utterances default to observation; subsequent automatic teaching needs a contextual recommendation, one pending target, bounded cross-turn eligibility and separate attempt/cooldown counters. Analysis completion now wakes safe-boundary dispatch. Immutable sent attempts, completed-response assessment and actual presentation are recorded separately.

Voice and Chat share requested Usage/Example cards; automatic direction appears only after the AI reply is assessed as reflecting the teaching intent. Actual expression/example exposure remains assisted for the rest of that Mission; overlap/unknown provenance is not labeled independent. Detailed traces are owner-readable through GET `/api/speaking/sessions/{id}/diagnostics`, separate from the runtime snapshot. There is no diagnostic timeline UI. The hosted `20261018111206_speaking_teaching_diagnostics` migration and rollback checks pass. Root lint/build/test pass (1,111 API, 390 Web, 114 cached extension tests); hint-card browser checks pass at 1440/390 px with synthetic auth/API/provider events and inspected screenshots. Readable retention is 30 days, with same-session append cleanup and no scheduled global physical purge. See [behavior, API and reliability limits](design/docs/STAGE_FOUR_TEACHING_CONTROL.md).

A bounded live Gemini/DeepSeek/Supabase browser probe now records seven canonical learner turns (six voice, one typed). All six voice first replies began before their analysis started; one policy from turn 5 bound while eligible to turn 6. Its content assessment was `not_reflected`, and Gemini named the expression despite the implicit-teaching constraint, so cross-turn delivery passed but teaching compliance did not. Usage/Example visibility acknowledgments and subsequent assisted use were recorded. An invalid model quote offset was rejected and retained only as uncertain lexical evidence. Synthetic identity and WAV input do not qualify real sign-in, physical microphones or general teaching quality. Temporary database records were removed; [full per-turn model, execution and presentation logs](design/benchmarks/teaching-live-20261018/run-01/README.md) retain the evidence.

The follow-up fix removes selected wording from Gemini's initial mission configuration and implicit controls, assigns the communicative act explicitly to the learner, and separates teaching attempts from opening/silence triggers. Deterministic target-disclosure checks run after the response before advisory effect assessment; they do not delay or buffer audio. Stage 4 analysis now requests exact quotes and derives their UTF-16 ranges from unique occurrences in the frozen learner text. Wrong ranges can be repaired only when unambiguous; repeated quotes and persisted evidence retain strict validation. Logs expose anchor provenance and deterministic/advisory assessment sources. No public API schema or database migration is needed.

A later live probe stopped before strategy coverage with `audio_rate`. PCM and high-frequency playback/display receipts now bypass the provider/state lock; completed-playback writes run in the tracked background drain, and shutdown reconciles already-received complete ACKs. Microphone/text controls retain single-reader ordering; provider writes, frame validation and rate limits remain unchanged. The failed run remains in [its own report](design/benchmarks/teaching-live-20261018/run-03/README.md), separate from any later successful coverage.

Post-fix live evidence is [recorded separately](design/benchmarks/teaching-live-20261018/README.md). Run-04 completed without `audio_rate`: three finalized voice turns began audio before analysis, but four unconfirmed ASR fragments left strategy/quote coverage incomplete. Run-05 used preregistered typed inputs with real audio: one policy crossed turn 3→4 while eligible, Gemini asked the learner to frame the compromise without supplying the expression, and the deterministic check plus advisory assessment passed. An actual direction ACK and unique server-derived quote `[0,16)` were persisted. Its first analysis overlapped 20 incoming audio packets; a later persistence 503 prevented a fifth reply, so this is bounded feature evidence, not a wholly successful session or broad reliability claim. Both journals drained with zero reported gaps and temporary records were removed. Prewritten target use does not establish teaching causality.

Final post-fix root checks ran after the live sessions: lint/build/test pass, including 1,179 API and 390 Web tests, with 114 extension tests replayed from cache. One existing Starlette deprecation warning remains. No deployment was performed.

## Mission startup, silence and audio bursts — 2026-10-18

AI opening now follows the browser's initial microphone-mode acknowledgment, avoiding cancellation/silent delivery during startup. Voice-enabled connections give a brief follow-up after at least 15 seconds of silence following generation and acknowledged playback, capped at two until nonblank user input. Speech/transcription, generation, playback and lifecycle gates prevent competing prompts; microphone-off Chat does not auto-prompt. A bounded token bucket tolerates short audio catch-up batches while retaining sustained-rate protection. Timers/budgets reset on reconnect; real microphone/provider timing remains unmeasured.

## Mission speech-onset tuning — 2026-10-18

Gemini automatic voice detection now requires a 300 ms speech onset instead of 100 ms to reduce brief background-noise interruptions. Low sensitivity, automatic barge-in and the 1200 ms end-of-speech silence window remain in place. New connections use the setting; the tradeoff is potentially slower deliberate interruption or missed very short utterances. Real microphone/noise effectiveness remains unmeasured.

## Chat empty-message visibility — 2026-10-18

Chat renders saved messages and live transcript fragments only when they contain non-whitespace text. Noise-triggered voice placeholders stay hidden and appear normally when transcription arrives. Empty-state and scroll behavior follow visible messages; runtime storage and turn handling are unchanged.

## Mission loading consistency — 2026-10-18

Replace generic loading cards with the Mission layout: task heading, voice workspace, composer and desktop language sidebar. Reuse page breakpoints and respect reduced motion.

Mission entry now retains Loadout during route navigation and uses one consistent Mission skeleton for authentication and workspace loading. The leftover generic Speaking route fallback has been removed; errors and retry remain explicit.


## Stage 1 video scroll and loading cleanup — 2026-10-18

The persistent media host now relays native iframe scroll chaining into Stage 1's independently scrolling center panel. The iframe remains mounted and unobscured; narrow layouts retain ordinary document scrolling. Empty extracted-corpus regions show skeletons without redundant loading copy; failure and Saved empty states remain explicit.

## Stage 1 progressive reveal — 2026-10-18

Stage 1 now reveals newly committed summary, logic, transcript and corpus content with a short downward stagger. Stable identities prevent existing rows from replaying during streaming/finalization. Same-frame previews coalesce into a non-urgent React update; completion and cancellation discard queued previews. Empty regions retain independent skeletons. Animations use opacity/translation only, cap batch work and delay, and respect reduced motion; data availability is not gated by animation.

## Direct Stage 2 entry — 2026-10-17

Remove the mandatory Ready to practice screen. Confirming a segment enters Shadow directly (Quick by default); unauthenticated learners retain the existing sign-in gate and return target. The picker prefetches the selected segment’s Shadow route/code. Existing `/segments?segmentId=…&step=prepare` links replace into Shadow without a preparation history entry. Content-owned media, reference capture/cache, and account-owned save queues keep their existing ownership. Reference preparation remains available in Detailed; this does not auto-enable capture, playback, microphone or upload consent.

## Stage 2 Quick and Review — 2026-10-17

Desktop setup follow-up: Quick settings scroll within the workspace, with Start kept in a separate footer so it remains accessible in short windows. Review also scrolls within its available height; Detailed layout is unchanged.

Follow-up: place the mode switch inside Detailed’s existing header so it does not consume a row of the outer reader grid. Keep the original practice area and layer styles. Review gives the sibling word-result and analysis components distinct take-scoped keys, preventing duplicate-key reconciliation errors.

Stage 2 defaults to Quick, with range selection, optional short-sentence skipping, playback/text settings, sequential listening and recording, background analysis, round summaries and targeted practice. Each recording lasts twice the original sentence duration (independent of playback speed), or ends early with Done. Quick waits through a visible 2-second preparation countdown after playback; Pause discards unfinished audio and Resume replays the current sentence. Completed takes and Detailed behavior are unchanged. Detailed retains the original component and styles. Review restores segment history, filters results, selects takes, replays available audio and reuses existing three-layer evidence; absent Reference still permits learner-only analysis.

The recorder, API, decoder and database now support the source-derived Quick duration. Migration `20261017121513_quick_shadowing_duration` is applied to hosted Libitu; application deployment is separate. Existing upload byte limits and retention consent remain. Validation: root test/lint/build pass (1002 API, 376 Web, 114 extension tests); desktop/mobile browser checks used synthetic media/API fixtures, including 90-second recording and save recovery. No pronunciation accuracy claim follows from these checks.


## Current objective

Build the smallest reliable loop from a supported YouTube video to a saved corpus item and an AI speaking session. Keep reading and intensive listening compatible with the architecture, but do not let them delay the first complete loop.

The provisional launch market is overseas. Mainland-China-specific hosting and regulatory work is outside the current launch scope; target-country privacy, consumer, copyright, and platform obligations still apply.

Stage 2 browser-captured references can now be uploaded for private server source-transcript MFA/VAD/F0 analysis without a file-source registration. Source-aligned reference prosody is cached and paired with the exact saved learner take. Sound/Rhythm each use two compact Reference / Your voice rows; Melody uses one normalized chart with linked full-word labels and playback highlighting. Registered file adapters remain supported. General remote acquisition and validated pronunciation detection remain planned. See [current implementation](design/docs/STAGE_TWO_BROWSER_REFERENCE_SERVER.md).

## Repository status

Offline Rhythm CWT experiment (2026-10-16): independent PyWavelets analysis reuses full 10ms MFA/F0/energy evidence and reports continuous, uncalibrated relative prominence with uncertainty. Six human clips measured about 13–17ms median incremental computation; the latest user's bound Reference was included, but its Take audio had already been cleaned and no paired user result could be reconstructed. Public learner probes retain the existing 60/85 gates. That experiment did not modify production; the separately approved progressive integration below now persists full server frames and publishes CWT previews. Accuracy remains unmeasured without human labels. See [results and limitations](design/benchmarks/rhythm-cwt-20261016/README.md).

Analysis latency optimization (2026-10-14): consented retention and learner analysis share one browser upload. Analysis is durably queued before retention finishes; retention retries do not recreate completed/cleaned analysis inputs. Reference and learner workers prefer a hash-verified, account/job/purpose-scoped local handoff (30-minute TTL, 256 MiB bound), falling back to private cloud storage on another host or cache loss. MFA reuses versioned compiled lexicons with cross-process build locks; audio, model extraction and outputs remain job-local. Model hash checks are reused within a process and invalidated on file changes. MFA binary version is checked once at worker startup, before queue claims; sentence alignment does not run a version probe. Source acquisition, quality checks, evidence identity, learner ASR and 60/85 gates are unchanged. No database migration is required.

Reference recovery status (2026-10-14): entering a sentence displays “Checking reference…” during the read-only saved-reference lookup. Uploading appears only during actual reference upload work. The recording guide also waits for lookup before offering preparation. Acquisition, upload and recording gates are unchanged.

Reference source-transcript alignment (2026-10-14): new references skip independent ASR and align the immutable source sentence directly with MFA. Preserve audio integrity/quality and ordered, bounded, plausible-duration word/phone coverage checks. Results explicitly use `content.status=source_transcript`, never fabricated ASR `matched` evidence. Cached comparisons and frontend reference measurements accept this basis; historical verified references retain their old basis. New references use `reference-source-transcript-v2` plus acoustic engine identity, independent of learner ASR configuration. Latest-capture recovery excludes older policy/engine results; existing historical takes and objects are not rewritten. Learner ASR, 60/85 gates, capture acquisition and retention remain unchanged. No schema migration is required.

Reference status copy (2026-10-14): the preparation card and recording guide share sentence-specific server status. Uploaded references with incomplete content/alignment checks show the reason and Retry reference analysis without another upload disclosure. Pending analysis, upload incomplete, cancellation, deletion, expiry and Ready remain distinct. Registered references use the same status descriptions. Existing acquisition, recording eligibility and exact reference content checks are unchanged; tolerant reference validation is a proposal, not implemented.

Stage 2 reference recording guidance (2026-10-14): when server recording analysis is enabled, require an uploaded, unexpired reference for the selected content/segment/sentence before opening the microphone. Show Prepare reference beside the recording flow; reuse the existing extension authorization, 1× preparation, consent and upload/retry paths. Queued/processing references with uploaded audio allow recording, and the new take freezes that reference ID at recording start. Failed/deleted/expired or incomplete sentence results require preparation/retry. Local-only practice remains available with server analysis off. Historical takes are never rebound; the proposed one-time attachment/resume implementation was withdrawn before migration deployment at the user's request.

Stage 2 development worker startup (2026-10-14): the API dev script explicitly removes pnpm's default four-script concurrency limit so all five persistent services start, including the reference acoustic worker. Previously the fifth script could wait indefinitely while reference jobs remained queued and eligible learner jobs waited for their bound reference. Reference acquisition and analysis gates are unchanged.

Stage 2 direct component restoration (2026-10-13): at the user’s explicit request, copy SoundComparison.tsx, LayerComparison.tsx (including Rhythm and PitchOverlay), and LayerFocus.tsx verbatim from /Users/river/Documents/Libitu. Their internal presentation now matches that workspace byte for byte; existing shared CSS already matches. Own Sound conceal/reveal state in StageTwoShadowing via the original controlled props, scoped to the selected sentence/take. Keep prototype status badges, recording-state visibility, word gates and source/reference acquisition outside these restored components. Word differences remain in the separate word-check result; unavailable acoustic measurements remain blank in the data adapter, while the original Sound practice-target cues are retained.

Stage 2 analysis state clarification (2026-10-13): verified the fetched origin/main at d84bd9d. Keep its internal Sound/Rhythm/Melody layout, diagrams and explanation panel; prototype styling applies only to compact layer status badges. Hide layers before recording, during microphone/encoding work and until the selected take has a durable word check (or completed legacy evidence). Then retain the exact 60/85 gates, show locks, pending ellipses, insufficient/interrupted dashes or colored evidence badges. Sound has no aggregate score: use a completion mark, with an asterisk for matched-only scope; Rhythm/Melody display real experimental similarity scores when present, otherwise a completion mark for available measurements. Existing unpaired learner evidence remains viewable. Deleted/no-analysis takes hide layers; retry/error controls remain available. Source/reference acquisition is unchanged.

Stage 2 analysis appearance restoration (2026-10-13): restore the main-worktree presentation of the three analysis layers: 52 px tabs and the original Sound Shadow mode/Hide text/Reveal all toolbar; status badges follow the prototype as clarified below. Remove refactor-only mobile workspace and unmatched-word box overrides. Keep the 60/85% gates, disabled tabs, exact take/reference mapping and truthful unmatched-word notes. Sound review visibility stays local to the selected take; it does not alter recording support snapshots or the word-check result. Rhythm/Pitch drawing and LayerFocus were not restyled by this refactor.


Stage 2 directory and state follow-up (2026-10-13): the expanded directory shows sentence text plus practiced/unpracticed, highest reliable word match and an exact >=85% word-pass marker in the upper right. During microphone request, recording and encoding it folds into the numbered rail; afterwards it restores the learner’s manual fold preference. The existing progress API also reads owner/content-scoped durable word-check counts in keyset pages, excluding deleted takes/analyses and unreliable/legacy checks; no migration is needed. Deleting playback audio preserves counts, while deleting the winning analysis/take falls back to the next surviving best. Completed saved references remain Ready while local preview work runs or fails; explicit source errors/deletions remain visible. Shared black/red media buttons and the waveform are separately centered. Original acquisition and analysis gates remain unchanged.

Stage 2 practice refactor (2026-10-12): steps 1–5 are documented in [STAGE_TWO_REFACTOR_CONTRACT.md](design/docs/STAGE_TWO_REFACTOR_CONTRACT.md). The approved target uses <60% word-check only, 60–<85% Sound-only and >=85% all-layer scope, separate Listen/Record, sentence text and practiced/best-word-match navigation and recognition feedback that does not override eligibility. New backend learner jobs use practice-gated-v3 with durable word checks and measurement checkpoints; existing v2 jobs retain their exact-word pipeline. Checkpoint and support/feedback migrations are applied to the hosted Libitu database. The API now stores immutable versioned text-support snapshots and owner-bound, idempotent recognition-error feedback without changing tiers; old request hashes and legacy text visibility remain compatible. The new local practice UI defaults to hidden text, separates Listen/Record, saves recording-start/final-peek snapshots, reveals word differences, disables ineligible layers and records recognition feedback without changing gates. New gated measurements map onto the source word axis with unmatched gaps; legacy results remain viewable. Full-content practiced restoration uses a service-only scalar aggregation over surviving owned records, merged with page-lifetime pending takes. Its migration is applied to hosted Libitu. Short-sentence/segment boundaries, paginated history restoration, per-sentence manual take selection, late saves and audio-only/full deletion recovery are implemented and verified locally at desktop/mobile. Stable video folding retains one player. Step 6 (final wider regression) remains pending; the API/worker application deployment is separate from the completed database migration. Original-video reference acquisition is unchanged.

Stage 2 prototype appearance correction (2026-10-12): the sentence directory folds from 260 px into a 56 px numbered rail while retaining practiced markers and manual navigation. The video/reference preparation share a compact card with actual setup/preparation/analysis/ready/error states and telemetry-based preparation progress. Recording uses the shared black Record/red Stop media buttons and a live waveform derived from the recorder’s existing microphone stream. Practice settings opens upward with segmented speed/text controls, a loop checkbox and the existing range select. The three requested redundant sentences are removed. Original reference acquisition, consent, bound take analysis and persistence remain unchanged; no new database or application deployment is involved.

Reference sentence identity correction (2026-10-12): reference capability, saved-capture recovery and preparation snapshot the same derived blueprint view used by the public blueprint route. Recovered caption timing can change sentence identities without rewriting cached semantic analysis; references no longer search those raw cached rows for a displayed sentence. Exact server-owned sentence/bounds, access and upload validation remain enforced. The browser reference panel suppresses its idle playback instruction when recovery/upload has an error.

Original video history (2026-10-11): `/profile` now has an Original videos section, and `/profile/history` supports Videos alongside the unified list. Authenticated ready-content visits update the existing `user_content_states` record; surviving owned Shadow/corpus sources also populate the list. One row per public YouTube content ID opens `/practice/{contentId}` directly in Stage 1. No new migration, playback, analysis request, practice-count or streak inflation is introduced. Failed visit saves offer Retry; account switching does not adopt an already mounted source. See [profile implementation](design/docs/PROFILE_IMPLEMENTATION.md).

Routing and responsibility architecture (2026-10-10): R0–R5 are implemented. At the user's request R3 directly replaces root query learning URLs with `/practice/import` and content-based Reader/segments/Shadow routes, and enables extension v4 only (extension 0.2.0). No legacy route adapter, dual protocol or entry switch remains active. R4's required link producers, content-tab mapping and owner-bound continuation v2 are included; old continuation records are ignored. The content layout retains the controller, reference cache and actual MediaHost across navigation; public content reads/retry semantics and root save ownership remain unchanged. R5 removes the retired v2 capture runtime, Web fallback and legacy entry loader; route state comes from the URL and the content controller accepts resolved IDs only. Invalid client-side links clear prior activation state so Back can recover. Extension source verification reads the shared public `content.content_id` contract. After an import SPA transition, the original sender URL is used only for origin checks; the live top-level document URL and document ID establish current content ownership. Web/extension must update together. Verification and the outstanding real-toolbar tabCapture boundary are tracked in TASK.MD. No database migration or deployment was performed.

Reference setup latency correction (2026-10-10): v4 `ping` is a local capability probe. Explicit `arm` performs one read of `/api/content/{id}/identity`, using public metadata without blueprint/job reads; concurrent identical arms share that check. Passive content-tab reuse uses a separate verified `register` action. The Web UI stays in preparing until the extension acknowledges armed; cancellation, document/source changes and late results cannot re-arm a closed setup. Toolbar capture authorization is unchanged. Reload the extension and Web page together.

Stage 2 sentence-switch capture correction (2026-10-11): the extension no longer treats a URL-less tab `loading` status as a document exit. Sentence/query changes retain the content/document-owned practice-audio session; source URL changes, top-level document commits, pagehide, tab closure and lease expiry still release it. The Web sentence control continues to suspend only the old sample and update the local URL selection. The live toolbar grant remains a separate manual acceptance boundary.

Cross-page loading correction (2026-10-11): the root generic route fallback and the generic Corpus, Loadout and profile route fallbacks are removed. These destinations render their own page shell and auth/data placeholders directly; Landing renders immediately. Client navigation keeps the prior page until the destination commits, avoiding the previous root → route → page placeholder sequence. The dedicated import/content workspace and speaking fallbacks remain in their owning boundaries.

Import loading correction (2026-10-10): `/practice/import` reuses the Reader skeleton for both route loading and pending caption handoff/content resolution. It creates no player while waiting; failures show a separate error/retry panel. The shared content layout chooses its cold-entry skeleton from the target pathname: Reader uses the Reader shell; segments/Shadow use skeletons matching their respective page structures. Once content is ready, internal navigation retains that content while the next route loads; no nested content-route loading boundary replaces it. The fallback reads no search parameters or workspace data. Caption/resolve/analysis sequencing and the persistent media owner are unchanged.

Navigation prefetch (2026-10-10): internal links retain viewport prefetch and warm their full destination on pointer, keyboard or touch intent. Ready Reader warms segment selection; selection warms preparation; preparation warms the exact Shadow route and component code. Known form/action destinations also warm on intent or overlap existing confirmation work. New session/content IDs still require successful creation/resolution before navigation. Prefetch never mounts destination client effects, resolves captions, creates sessions or starts recording. Stage 2 skeletons show only the broad selection/preparation/Shadow layout: a heading, sidebar, video and analysis block as applicable. Per-sentence rows, imitation controls and nested analysis/history details are omitted at the user’s request; responsive ordering is retained.

Route loading correction (2026-10-08): the shared root loading boundary is stage-neutral. Valid Stage 2 deep links initialize the reader directly in Shadow and retain the practice skeleton through blueprint/auth loading; invalid segments return to the reader.

Page loading skeletons (2026-10-08): Stage 2 lazy-code loading uses a practice-shaped skeleton instead of Opening practice text. Corpus, Loadout, profile/history, mission and analytics route/data loading use shared accessible skeletons, including saved-take/history/analysis sections. Reduced motion disables pulse. Empty/error states, save/upload progress and asynchronous assessment status remain explicit.

Saved Shadow practice presentation (2026-10-08): saved takes use bordered cards with separate metadata/actions, small shared buttons and an outlined destructive variant. Reference deletion uses the same variant. Shared button background clipping removes the white halo outside inset edges without changing control dimensions.

Audio save notifications (2026-10-08): pending reference uploads and practice saves share a fixed, responsive notification stack. Blue processing cards and warm error cards use icons, concise headings and retry actions without shifting content. Read-only reference recovery does not count as an upload or trigger an unload warning. Empty queues show no notice; completion removes it. Client-side navigation preserves active saves.

Stage 2 audio preferences (2026-10-08): reference analysis, recording analysis and recording retention share a collapsed Audio settings disclosure. Existing choices and explanatory copy are preserved; processing status, errors and recovery actions remain visible. Prepare-this-sentence uses the outlined secondary button.

Stage 1 loading feedback (2026-10-08): the root route now has a server-renderable loading shell; empty transcript, logic and extracted-expression regions show decorative skeletons only while loading. Each region yields to real streamed content immediately; errors/retry, Saved, player ownership and extension caption preflight remain unchanged. Reduced-motion preferences disable the pulse. This improves pending-state feedback, not network/provider latency or pre-response browser blank time.

Stage 1 card correspondence (2026-10-08): annotations and the sidebar now use the same merged candidate/saved list. Exact source phrases with word boundaries carry card identities; unrelated partial phrases are no longer highlighted. Clicking a highlight selects its category (or retains Saved for a saved card), scrolls/focuses the matching card and does not seek playback.

Stage 1 saved-card highlighting (2026-10-08): transcript annotations derive from extraction candidates plus the current source’s saved corpus. Manual saves, restored records and removals update highlights using source wording while retaining caption text, sentence identity and word timing.


Loadout draft-save feedback now reserves its space while hidden, avoiding form movement on input and option changes. Textarea focus uses a neutral thin outline, and directional links default to the same outlined secondary appearance as directional buttons. All user-facing wording and destinations remain unchanged; the proposed Learn terminology is not adopted.


All visible selects use the shared Radix components, including Loadout settings/source and Corpus sorting. Menus use borderless option highlights, a light panel edge/shadow and inset trigger arrows. DirectionButton/DirectionLink standardize back/next actions at 40 px with 16 px icons; multiline navigation cards keep their card geometry. Reader outer bottom padding is removed and shell height fills the remaining viewport, placing its entry bar against the bottom edge.


Caption cleanup (2026-10-04): English caption normalization removes square-bracket non-speech cues (including their contents), stray square brackets and repeated angle speaker markers before analysis. The web adapter also cleans cached transcript text before corpus annotation. Spoken JSON3 offsets remain source-based; sentence timestamps and identities are preserved for cached display.

Shared application header (2026-10-04): Corpus, My learning/history, Loadout, saved mission, conversation and analytics reuse AppHeader with identical responsive gutters, navigation destinations, active styling and account controls. Mission-specific controls remain in their own content toolbar. Landing and reader retain their specialized entry/stage navigation.

Reader footer follow-up (2026-10-04): the Stage 2 entry bar spans the viewport horizontally, canceling the reader gutter only for this footer. Its content keeps internal padding; other reader sections retain their responsive gutters.

Page canvas follow-up (2026-10-04): the global background and framed page wrappers now use white, including reader, loadout, speaking, analytics and profile/history gutters. Inner warm-neutral surfaces and responsive spacing remain unchanged.

Reader annotation follow-up (2026-10-04): the user approved responsive outer spacing for the reader (16 px, 12 px below 640 px, 8 px below 400 px) without a page border. Corpus now matches the stage navigation links; reference-audio enable actions have a white outlined surface and the reader reference panel has no outer frame. Transcript labels show minute:second values while seeking retains precise timings; timestamps have their own nonshrinking column. The saved-language action uses the standard small button, and shell height accounts for both outer gutters so the footer remains vertically balanced.

Visual-system follow-up (2026-10-04): Inter normal/italic variable fonts are bundled locally and loaded by the root layout. Shared text fields/native and Radix selects own focus, error, placeholder and disabled appearance while keeping existing dimensions. Purple selection tokens unify generic selection controls; learning colors remain separate. Auxiliary async actions now expose pending feedback, and obsolete button-only paint has been removed. Root checks and desktop/mobile fixture checks across nine screens pass; fixtures do not verify real providers. See [the visual system](design/docs/VISUAL_SYSTEM.md).

Shared button system (2026-10-04): web actions now use shared Button/ButtonLink roles, preserving purple primary actions and existing control geometry. Secondary, soft, ghost, destructive and recording actions share focus, disabled, pressed and reduced-motion behavior. Key asynchronous actions preserve their idle footprint while showing disabled loading progress. Selection controls remain separate. Desktop/mobile fixture button checks pass at 1440/390 px, including stable loading size and recording/destructive states. See [usage and verification](design/docs/BUTTON_SYSTEM.md).

Visual consistency pass (2026-10-03): existing web headers and signed-out mission/report gates now share the landing `libitu.` wordmark, preserving their contextual sizes and tagline positions. Warm-neutral surfaces, radius tiers, lighter popover/dialog shadows, keyboard focus and reduced-motion feedback use shared tokens. Existing purple primary actions and all learning/status colors remain. Grid structure, spacing, dimensions and responsive breakpoints are unchanged; the existing font stack remains to avoid a font-metric migration. Extension toolbar bitmap branding is unchanged in this web pass. Root lint/build and 1,185 tests pass; desktop/mobile fixture rendering and corpus/profile regressions pass. Browser verification uses synthetic identity/content and does not constitute real login, media or provider acceptance.

Landing page (2026-10-03): `/` now introduces Libitu with a validated video form, optional Shadow explanation, illustrative language-transfer example and real Clerk account controls. Source/content/job/handoff query links retain the existing Stage 1 workspace. Pasted watch/share/mobile/Shorts URLs normalize to a canonical video URL; missing titles no longer borrow demo metadata. Same-tab input drafts survive refresh and authentication redirects. The prominent prototype-style “or / Add to Chrome” entry opens a verified configured store URL or clearly labelled installation guidance. Stage 1 explicitly says no sign-in is required. Root lint/build/tests and responsive browser checks passed. Real Clerk login/register forms and switching were verified; completed OAuth/email login remains a separate acceptance check. See [implementation and verification](design/docs/LANDING_IMPLEMENTATION.md).

YouTube multilingual language gate (2026-10-02): the extension honors `defaultAudioTrackIndex` and the default track's language identifier before caption fallbacks. It no longer treats the first ASR caption as the spoken language when several dubbed languages exist, or assumes the first `hasDefaultTrack` identifies the audio default. Ambiguous multilingual metadata remains unsupported. The reported Lisa Su video (`-sKAMB10eh0`) supplied the regression structure; 118 extension tests and manifest validation pass. Live verification of the updated extension requires a manual extension reload and source-page refresh.

Corpus library (2026-10-02): `/corpus` now provides cross-source search, OR-within/AND-between filters, recency/value/transferability/alphabetical sorting, grid/list layouts, stable multi-selection, source-backed detail, persisted editing/deletion and bounded merging into the existing Loadout draft. Guest and authenticated storage share the existing corpus boundary. Decks, corpus usage aggregation and review scheduling remain outside this increment. See [implementation and verification](design/docs/CORPUS_LIBRARY_IMPLEMENTATION.md).

Stage 5 (2026-10-01): completed missions now open `/speaking/[sessionId]/analytics`. Four-dimension reports use a frozen transcript, exact quoted evidence, deterministic score aggregation and a durable DeepSeek assessment worker. Reports recover after refresh; selected-language observations distinguish prompted use, uncertain data stays unscored, up to three conservative refactors can be saved to corpus, and retry/adjust actions preserve the previous mission and existing drafts. The feedback migration is applied; real provider/storage and responsive browser checks passed. Human rubric calibration and production qualification remain pending. See [contract, operation and verification](design/docs/STAGE_FIVE_CONTRACT.md).

Personal learning center (2026-10-02): `/profile` and `/profile/history` now show Clerk account information, separate saved Shadow takes and participated Missions, corpus counts, recorded Shadow duration, local-calendar streaks, real activity trends and paginated practice history. The history page has server-side All / Shadowing / Missions filters, local-date groups, times, practice status, source/report links and retryable incremental loading. Authenticated FastAPI reads existing owner-scoped records; no new assessment or database schema is introduced. A separate card now reads the latest compatible four-dimension Stage 5 report, and completed Mission history opens Analytics. These reads never request assessment or convert session scores into general ability. Account-bound browser continuation restores ready source/segment/sentence locations; older saved attempts link back to their source. Ability dimensions remain explicitly unassessed. Corpus navigation now opens the independent `/corpus` management page. See [scope and verification](design/docs/PROFILE_IMPLEMENTATION.md).

Stage 4 (2026-10-01): `/speaking/[sessionId]` now provides the shared Voice/Chat workspace, continuous Gemini Live voice with automatic turns and interruption, text input, recoverable transcripts, selected-language evidence, asynchronous DeepSeek analysis and a deterministic next-response teaching controller. Owner-scoped Supabase CAS storage, one-use runtime tickets, takeover/end/delete fencing and interrupted-playback recovery are implemented; the migration is applied. Real text/voice + analyzer + database smoke checks and responsive browser checks passed. Stage 5 reports are implemented above; manual transcript editing and production performance qualification remain separate. See [implementation, configuration and verification limits](design/docs/STAGE_FOUR_IMPLEMENTATION.md).

Speaking loadout (2026-09-30): `/loadout` now uses the shared real corpus with scenario, goal, difficulty, feedback and optional logic settings. Chunks/idioms share five expression slots, structures have three, and at least one item is required. Account-bound browser drafts survive refresh and login. Authenticated creation persists ordered language snapshots atomically through Supabase, with idempotent retries and an owner-scoped session preparation page. The migration is applied; real database/RPC/API snapshot, ownership and concurrent-retry checks passed with isolated synthetic accounts. The Stage 4 increment adds real role-play and turn persistence; Stage 5 above adds final assessment. See [contract and verification](design/docs/LOADOUT_IMPLEMENTATION.md).

Sound/layout correction (2026-09-29): video and practice controls remain above the three-layer workspace. Sound now restores all ten prototype phenomenon filters, two marked text flows, exact-occurrence highlights, linking arcs, inline badges, hover/focus dictionary IPA and the color legend. Both rows support hide/individual reveal. Five existing rule types supply possible-reading targets; vowel/pause timings remain measured data. Additional acoustic realization detectors are still unavailable.

Browser reference server analysis and compact workspace (2026-09-29): implements the flow above. This supersedes the default local-only alignment and earlier duplicate measurement/score-sidebar layout; older dated entries below are historical. The new reference-wait migration is applied to the connected project. Root lint/build/test (803 tests), desktop/mobile browser acceptance and real synthetic reference/learner ASR/MFA/storage/cleanup smoke checks passed.

Browser reference alignment (2026-09-26): the local PCM reference path now feeds a browser Worker for caption-conditioned word/phoneme alignment, alongside its existing Silero/Pitchy measurements. The same bounded captured clip owns both results; basic measurements publish before alignment finishes. Local reference words can be displayed alone or paired in the browser with the matching saved learner word sequence. Reference audio and derived alignments remain page-local. No server file-source registration is needed for this path. Forced alignment does not independently verify spoken content, and cross-engine scores remain empty. See [runtime, limits and verification](design/docs/STAGE_TWO_LOCAL_ALIGNMENT.md).

Stage 2 result recovery and partial evidence (2026-09-24): reading an existing analysis is independent of consent to analyze new recordings. Initial entry and sentence changes restore the latest saved take; history refreshes and late saves preserve a manual selection. A new recording enters the workspace through its exact acknowledged take ID, and a changed save version refreshes the same selected ID. Learner-only Sound now displays available vowel-duration and boundary-pause measurements with empty comparison scores. File reference plus local learner audio shows explicit REF/YOU states across all three layers; its Melody curves use normalized sentence time and are not aligned word by word. This display/state increment adds no detector or upload authorization. Root lint/build/test and desktop/mobile result, Sound and persistence regressions passed; synthetic microphone recordings also ran actual local Silero/Pitchy inference. See [the increment](design/docs/STAGE_TWO_SOUND_COMPARISON.md).

Three-layer paired comparison (2026-09-23): saved takes now show Reference / Your recording in Sound, Rhythm and Melody using the prototype layout. New `practice-comparison-v2` results retain aligned phone durations and boundary timing, with experimental vowel-timing, boundary-pause, Rhythm and Melody resemblance scores plus coverage. Eight Sound realization checks remain unsupported and unscored; there is no overall Sound grade or observed stress detector. Revoked references also hide nested assessments. See [implemented checks, formulas and limits](design/docs/STAGE_TWO_SOUND_COMPARISON.md).

Learner analysis (2026-09-22): purpose-specific opt-in, temporary private input, durable PostgreSQL worker jobs, independent local ASR content checks before MFA, per-word duration/pause/relative-pitch comparison and saved results are implemented. Historical results recover after refresh; cancellation and deletion fence late workers. Paired reference output requires a matching permitted file source, while learner-only measurements work independently. No pronunciation score, observed stress classifier or general YouTube reference upload is enabled. See [setup, lifecycle and limits](design/docs/STAGE_TWO_PRACTICE_ANALYSIS.md).

Rhythm text display (2026-09-22): local and file-reference practice now show sentence text with dictionary syllable-stress dots and detected pause bars/durations. All syllables use three sizes of solid amber dots, dark to light for primary/secondary/unstressed dictionary stress, including single-syllable words. Alternative stress patterns remain unknown. Compact REF phrase rows carry pause bars and durations; the duplicate speech/pause timeline is removed. MFA positions and approximate caption positions are identified separately. Unplaceable reference pauses and all learner pauses retain audio-relative times; actual sentence emphasis and learner word alignment remain unevaluated. Sound and Rhythm share one dictionary request/cache per practice.

Server reference preparation (2026-09-22): operator-registered permitted file sources now support automatic selected-segment preparation, private normalized WAV assets, a PostgreSQL-backed acoustic worker queue with leases/retry/cancellation/deletion, incremental sentence measurements and authenticated SSE/status recovery. Stage 2 uses file playback/current-next prefetch and displays reference measurements in all three layers when a permitted source exists. Ordinary YouTube sources keep the local flow. This foundation was followed by the learner-analysis increment above; validated sound detectors remain planned. The migration is applied; real synthetic storage and desktop/mobile browser checks passed. All 16 licensed seed clips ran real VAD/F0 measurements; two clips also passed real MFA word/phone alignment (accuracy remains unlabelled). See [implementation and operational limits](design/docs/STAGE_TWO_SERVER_REFERENCE.md).


Shadow login and practice persistence (2026-09-19): clicking Start shadowing now requires Clerk sign-in and preserves the selected source/segment/sentence return URL. Completed takes save account-owned practice records; optional, explicitly selected recording retention stores learner audio in a private Supabase bucket. Sentence history supports replay and record/audio deletion after refresh. A bounded page-level outbox retries failed saves across sentence/stage navigation; unacknowledged data is still page-local and is released on refresh/exit/account change. The schema/bucket migration is applied and a synthetic live storage round trip passed. Browser authentication fixtures do not prove real Clerk/OAuth completion. Browser-only acoustic measurements are still not saved. The later reference and learner pipelines add server evidence; durable offline pending saves and production account-deletion/retention jobs remain separate work. See [contract and limits](design/docs/STAGE_TWO_PERSISTENCE.md). This supersedes earlier blanket descriptions of all Stage 2 learner audio being temporary.

An offline acoustic benchmark foundation is now available under `apps/api/benchmarks/acoustics/v1`: versioned Pydantic/JSON Schema contracts, source/audio integrity and split checks, target-level metrics, independent annotation instructions, and 16 licensed public speech clips (4 adult speakers, 49.107 seconds, all dev). Its 64 annotation work items remain pending; no human phenomenon gold labels, detector inference, accuracy claim, or online integration was added. A separate 256-recording collection plan is unexecuted. See [the benchmark](design/docs/STAGE_TWO_ACOUSTIC_BENCHMARK.md); F1–F4 now have the bounded implementations described above; source expansion and validated M4b detectors remain pending.

Stage 1/2 now share an explicitly enabled, source-owned local audio buffer (v3). Valid continuous 1× playback supplies PCM coverage; the selected segment reports actual sentence coverage, permits visible/cancellable preparation, and reuses current/next reference analysis across stages. It consumes the existing JSON3 sentence/word mapping without pretending provider word starts establish acoustic ends or phoneme realization. No server audio ingestion, MFA, Realtime or cross-user audio cache was added. See [the implemented flow and limits](design/docs/STAGE_ONE_BUFFERED_REFERENCE.md). This is a local correction to the supplied capture-flow proposal; the file target is now available conditionally for operator-registered permitted sources.

The web app, API and extension are currently local development versions. Work and
verification target that local setup, not a deployed production website.

| Area | Current state | Next meaningful outcome |
|---|---|---|
| Monorepo | pnpm workspace and Turborepo configured | Keep root commands green |
| Web | Stage 1 corpus persistence, Loadout drafts, Stage 4 Voice/Chat and Stage 5 evidence-linked reports with retry/adjust actions, plus private activity/history and latest-report summaries; pending Shadow saves survive client-side route changes | Complete real OAuth acceptance; add Decks and corpus usage aggregation |
| API | FastAPI routes, Clerk identity, recoverable queued blueprint workers, local subtitle punctuation, stage timing, YouTube fallback, and live Doubao text analysis | Add rate limits and external metrics export |
| Extension | YouTube player-control button and toolbar action verify English video metadata, perform a bounded passive caption preflight, then open Stage 1; session handoff preserves browser captions | Harden caption acquisition across YouTube UI variants and add playback controls |
| Shared packages | Types, pure core helpers, UI tokens, config | Add only contracts used by two or more apps |
| Auth | Clerk UI, Next.js middleware, and FastAPI identity verification are configured locally | Finish hosted Clerk-Supabase trust setup and add real-token integration tests |
| Database | Supabase persists content, jobs, blueprints, corpus, speaking snapshots/transcripts/evidence and leased immutable-input assessment reports | Qualify operational recovery, retention and production supervision |
| Cache | Upstash queue, versioned blueprint keys, pending-job recovery, bounded requests, worker heartbeat, and locks implemented | Add rate limiting and a durable retry scheduler |
| AI | Local caption cleanup, Doubao text semantic blueprints, Gemini Live conversation/teaching control and bounded Doubao text session assessment with validated quotes | Calibrate conversation judgments against independent human-reviewed examples |

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

- Never upload or persist third-party YouTube audiovisual media without sufficient content and platform rights
- Allow authenticated learner recordings and derived learning records to use server storage under purpose-specific analysis, retention, deletion, and model-training choices
- Do not claim an integration exists until code and tests prove it
- Keep API schemas explicit and version processing output with `analysis_version`
- Preserve provider boundaries for auth, persistence, captions, and language models
- Exclude spaced repetition from MVP work

## Implementation notes

- Caption-first timing (2026-09-13): an early, top-frame MAIN-world observer passively copies the current video's English JSON3 responses from the player's own fetch/XHR requests. It never reconstructs/replays signed URLs or generates tokens. A launch may best-effort select an advertised English automatic track through visible controls, records the prior selection when possible, restores the prior caption state after the read, gives the observer up to six seconds to see the player's response, then performs only the existing bounded DOM/server-caption fallback before creating Stage 1. It never waits indefinitely or adds a second polling delay. The observer retains only bounded current-video tracks, discards stale SPA responses and distinguishes missing observer, unobserved captions and acquisition/format failures. Private YouTube menus and trusted-gesture requirements can make automatic selection or restoration fail; JSON3 without offsets remains usable block timing. Live target-video recovery after this change still requires verification.
- Rich sources produce shared `sentence-v3` rows with caption-origin word starts and explicitly estimated/nullable word ends. Legacy plain-text `sentence-v2` navigation remains compatible. Stage 1/2 use one source-token mapping; missing, ambiguous or very long estimated word intervals do not receive fabricated highlighting. Basic embedded playback does not wait for audio analysis. The 50 ms word clock updates local classes rather than page state; Stage 2 code is dynamically loaded.
- Stage 1 shows word-timing availability beneath its subtitle controls; Stage 2 shows it beneath the selected sentence. Notices use the exact highlighting eligibility gate, distinguish unavailable/partial data from switched-off/hidden text, and never block playback. Coverage is memoized from current captions, not recomputed on playback ticks, and adds no network request.
- Old-cache timing recovery is a separate, non-blocking enhancement after the completed blueprint is visible. A bounded extension request reads fresh JSON3 from an already open, matching YouTube tab without depending on the old handoff. A timing-only API accepts matching video/language and unchanged source words, preserves the original source text and semantic analysis, and saves only caption timing. Failed acquisition or validation keeps listening available and offers an explicit retry. Stage 1 applies recovered views while paused; an active Stage 2 keeps its sentence/recording snapshot and asks the learner to return to Stage 1 before applying the update. No automatic reload, new analysis job or media capture is involved.
- Raw caption metadata accompanies private source text and queued content; new blueprint documents retain timing metadata. Timing-only changes reuse existing semantic analysis through a bounded derived-view cache, with a separate caption fingerprint. Different source words cannot inherit old timing. Final JSON is gzip-compressed when accepted; an opt-in SSE protocol sends unchanged word timings only once per connection, with full reconnect snapshots and client-side identity-checked restoration. Live YouTube endpoint coverage and acoustic word-end accuracy remain unverified; see `design/docs/SENTENCE_SEGMENTATION.md`.

- Stage 1 resolves content, creates or resumes a processing job, streams validated job previews over SSE, and fetches the completed blueprint through `apps/web/features/stage-one/api/stage-one-api.ts`.
- Initial load and Retry share one abortable effect. Cleanup cancels fetch, SSE, and polling; cancellation never falls back to polling. Identical previews are suppressed. Preview and final corpus items share content-derived UI identities, a learner-level ranking policy, a 12-item limit, and source-evidence highlighting. Logic IDs and timestamps remain stable across finalization, and cached ready jobs skip stale previews. Normal streaming updates and development Strict Mode remain enabled.
- Web regression tests run with Node 22.15+ via `pnpm --filter @libitu/web test`, using built-in test mocks without paid providers. The optional `apps/web/tests/stage-one-render.browser.mjs` check uses Playwright and an existing dev server to verify DOM identity and request counts on desktop/mobile; `LIBITU_PLAYWRIGHT_MODULE` can select an externally installed Playwright runtime.
- Stage 1 uses the YouTube IFrame API for timestamp seeking. Transcript lines and logic nodes seek the same stable player; transcript clicks and normal playback select the latest timestamped logic node at or before the active subtitle. Streamed transcript callback changes do not destroy the iframe. The redundant Chapters UI and inferred chapter timestamps are removed; `chapters` remains in the backend contract for compatibility with cached blueprints.
- Stage 1 transcript selection now opens an analysis card on mouseup. The card sends the selected span plus the current, previous, and next subtitle lines to `/api/corpus/analyze-selection`; the configured Doubao text adapter follows separate explanation and seven-module syntax task sections, explains the exact selection in context, and validates any boundary expansion against the current subtitle. Complete selections show no redundant boundary message; only `needs_expansion` renders a suggested unit and reason. Explanation stays first, syntax remains available, inferred chips are editable, and accepted expressions or reusable structures use the same local/account save flow as extracted candidates. Provider failures are visibly labelled and never replaced with fabricated meanings or IPA.
- Stage 1 exposes source-grounded practice segments, a bottom Stage 2 CTA, and a timeline/card picker. Stage 2 Milestone 1 adds a sentence directory, previous/next and keyboard navigation, separate play/pause/seek, mutually exclusive sentence or segment looping, and the playback speeds reported by YouTube. Preparation reports the actual available sentence count without simulated audio-analysis progress. Switching a sentence or range pauses playback; entering or refreshing Stage 2 restores the selected sentence without autoplay.
- Stage 1 and Stage 2 share server-finalized transcript rows: `sentence-v2` for plain captions and `sentence-v3` for structured caption sources. The local spaCy small English pipeline conservatively merges incomplete punctuation candidates; complete long sentences are not split into child units or cut at a word limit. Each row carries a source/timing fingerprint, normalized source token range, boundary provenance/confidence, and caption-estimated start/end. Same-timestamp sentences and repeated text remain independently selectable. Stage 2 consumes versioned rows directly; wholly legacy client responses retain the previous navigation fallback. `stage`, `segmentId`, and `sentenceId` recover selection, stale sentence IDs fall back safely, and timings remain approximate rather than acoustic evidence.
- Existing blueprints receive a bounded, process-local cached sentence view on read without new Doubao text calls or changes to persisted semantic analysis and personal corpus snapshots. Legacy punctuation is treated as uncertain, and lost internal caption anchors cannot be recovered. New worker results retain the richer source anchors and the exact sentence metadata through SSE, finalization, and personalization. See `design/docs/SENTENCE_SEGMENTATION.md` for evaluation and limitations.
- Stage 2 pure sentence and playback-controller tests run in the normal web suite. `apps/web/tests/stage-two-navigation.browser.mjs` uses an existing dev server and mocked API/player to exercise desktop, tablet, and mobile navigation, looping, playback speed, and refresh recovery. Real YouTube seek precision is not established by the mock.
- Stage 2 Milestone 2 adds microphone recording for the selected shared sentence ID, with permission/error states, Stop/Cancel, a timer, and local Replay/Re-record/Delete. Browser MediaRecorder produces one temporary take for the current sentence, capped at 60 seconds. A new successful take replaces the old one; cancellation or failure preserves the previous take. Changing sentences or leaving/refreshing Stage 2 clears the take, and hiding the tab cancels unfinished capture. Audio is held in a Blob/object URL in page memory only; microphone tracks, timers, and playback resources are released on cancellation and exit. Reference playback is paused during recording, and replay/reference playback are mutually exclusive. This M2 increment adds no media upload, model call, score, or recording history. The M3 implementation described below adds local reference access and Rhythm/Melody measurements; Sound detectors and the Stage 3 mission remain planned.
- Recorder lifecycle tests run in the normal web suite. `apps/web/tests/stage-two-recording.browser.mjs` additionally checks actual Chrome encoding/decoding/replay with synthetic microphone input and mocked API/YouTube playback at desktop/mobile widths. This verifies the local media path without recording a person; physical microphone permissions/devices, Safari, and live YouTube interaction still need manual checks.
- Stage 2 Milestone 3 adds browser-local reference capture and acoustic comparison. On Chrome 116+, Enable practice audio plus one same-tab toolbar invocation opens a practice audio session without autoplay. Normal sentence listening at 1× automatically prepares each missing reference; sentence changes reuse authorization and an in-memory cache of up to 20 reference results. Microphone recording/replay cancels any active reference clip. The tab stream remains connected between clips, but no idle MediaRecorder or retained PCM runs. Leaving/refreshing closes the session and clears its cache. Playback discontinuities and invalid/late captures fail explicitly. Both reference and microphone clips are analyzed asynchronously with self-hosted, pinned Silero V5 / ONNX Runtime Web and Pitchy. The panel shows quality-gated speaking span, internal pauses, pitch range and speaker-relative curves, with no ASR, Sound detector or pronunciation score. This is automatic preparation during listening, not ingestion-time preprocessing. No additional API key is needed; initial model/runtime assets total approximately 13 MiB before compression/cache. Stage 1 and the dynamically mounted Stage 2 consume one page-level reference context, and same-source history updates with transient loading status keep the extension lease and REC badge alive. See `design/docs/STAGE_TWO_ACOUSTICS.md` for setup and validation limits.
- The local-only M2/M3 media lifetime remains the implemented prototype. The accepted production direction permits authenticated learner attempts, recordings, versioned assessment evidence, and progress profiles to persist on the server. Upload for immediate analysis, keeping a recording for later playback, and using it for model training are separate purposes and controls; training is opt-in and off by default. Unlicensed YouTube reference audio is not a server asset. Ordinary YouTube practice stores the video locator and sentence bounds; licensed content supplied directly by its rights holder may be ingested once, split into shared reference clips, and reused by learner attempts without duplicating the reference audio per user.
- Stage 2 Milestone 4 now has a text-only Sound guide: a pinned, vendored CMU pronunciation dictionary and conservative rules suggest linking, weak forms, within-word flaps, coalescent assimilation and cluster elision. A sentence-bound API reads the finalized server sentence; the web highlights the exact occurrence, offers filters and explanations, shows unknown/multiple dictionary readings, and caches up to 20 guides for the current practice. Original and learner recordings have separate explicit Sound abstention states. This adds no new API key or paid LLM call. M4's aligned, individually validated acoustic detectors remain unfinished; usable M3 VAD/pitch is not Sound evidence. See `design/docs/STAGE_TWO_SOUND.md`.
- Stage 2 now presents Sound, Rhythm and Melody as three distinct persistent tabs, with matching left-side shortcuts, a central layer canvas and a right-side layer focus. Sound has dictionary-IPA word cards, conditional phenomenon badges, filters, source-bound detail, Hide text, individual word reveal and Reveal all. Rhythm shows dictionary syllable stress, text-anchored reference pauses and saved learner word timing; Melody shows relative pitch contours and pitch range. All three share the current sentence, recording and existing analysis/cache state; tab changes preserve guide filters and hints without playing audio or restarting analysis. Left/Right, Home and End navigate the tab list. The shared practice area stays above the layer workspace: the video comes first, followed by one neutral operation bar containing Play reference, Record/Stop, Replay mine, Range, Loop and Speed. Reference-audio connection appears as a compact status row below the controls, setup details are collapsed under How It Works, and actionable errors remain visible. Desktop keeps the controls on one wrapping row; mobile stacks the same groups without changing their order. This layout follows `design/prototypes/toneflow_stage2_three_layer.html` and the control styling in `design/docs/DESIGN.md` without adding illustrative scores, word-stress marks or unimplemented detectors.
- Transcript annotations use amber for chunks and teal for structures. The API emits annotations for new analyses, while the web adapter reconstructs split-caption annotations for cached blueprints.
- Stage 1 auto-scroll follows the active playback subtitle only while the video is playing. Paused or ended playback suspends alignment while leaving the control available to change the setting; manual transcript scrolling still creates a temporary pause, but the auto-scroll control continues to toggle on/off and turning it back on resumes alignment during active playback.
- Selection cards dismiss on outside pointer interaction unless pinned with the top-right pin toggle. Each new transcript selection replaces the old card, resets pin/note/tab state, and gets a unique identity so late analysis or save completions cannot overwrite or dismiss the new card. Desktop/mobile browser regression coverage checks dismissal, pinning, replacement, and stale responses.
- `apps/web/features/stage-one/data/stage-one-demo.ts` is now a fixture only; the Stage 1 component does not import it directly.
- In queue mode, processing jobs return `pending`, are pushed to Upstash, and are consumed by `apps/api/app/workers/blueprint_worker.py`. Tests use the deterministic inline path and never call a paid model.
- `pnpm dev` starts the API server and blueprint worker together. `/health/ready` reports a missing or unreachable queue worker instead of allowing silent pending-job accumulation.
- The worker prefers browser-provided captions, falls back to `youtube-transcript-api`, and asks Doubao for validated JSON blueprint output.
- Analysis version selection is server-owned. Job IDs and blueprint cache keys include the active version; pending jobs are safely re-enqueued and obsolete queued versions fail without a model call.
- Stage 1 detects missing current-version blueprints behind old shared job URLs and resolves the server-owned active job instead of retrying the stale job forever.
- Jobs expose their current processing stage, timestamps, per-stage milliseconds, and an ephemeral validated analysis preview. The worker publishes cumulative local subtitle batches before consuming Doubao text SSE, handles two jobs concurrently by default, and emits structured lifecycle logs without transcript content.
- `mvp-v9` loads the maintained Stage 1 system prompt from `apps/api/app/prompts/stage_one_system.txt` and asks Doubao text for 16-32 evidenced chunks, idioms, and structures plus summary, chapters, logic, key points, and scenarios. Every generated text field has a hard word bound and the prompt forbids transcript reproduction. Candidates retain usage, register, scenario, phonology, pattern-family, CEFR, and quality-score metadata; blueprint reads rank and return a three-kind-balanced subset for the requested learner level without rerunning the model.
- English transcript normalization removes only standalone `um`, `uh`, `er`, and `ah` tokens and joins caption continuations. Independent complete sentences are no longer combined solely because they share a timestamp. The finalized source words are shared by Doubao text, displayed subtitles, and evidence validation; raw caption text remains stored as the source payload.
- English subtitles with reliable source sentence punctuation bypass sherpa-onnx and receive deterministic normalization. Other subtitles are sent to the local INT8 model without external sentence punctuation; model punctuation is attached to the original source words, model casing is ignored, and all paths normalize duplicate/conflicting marks and high-confidence opening discourse markers. Missing models, unsupported languages, or alignment failures use conservative deterministic merging.
- Stage 1 displays the source video immediately and streams locally formatted sentence batches from `/api/jobs/{job_id}/events`, then progressively fills Doubao text summary, logic, and evidenced corpus candidates; browser polling remains a disconnect fallback. One-job input is explicitly capped at 240,000 characters, and semantic-only output budgets scale from 32K to a bounded 64K retry without carrying transcript sentence metadata. Retry previews are monotonic, so a fresh provider attempt cannot clear fields already shown. The browser waits up to ten minutes for an active long job and keeps its last preview during explicit Retry.
- A 2026-09-05 production diagnosis found that the latest 54,852-character failed transcript spent 12.491 seconds formatting and 230.952 seconds in DeepSeek before `analysis_response_truncated`; total job time was 251.5 seconds. The former browser deadline was 210 seconds, so it could report failure while the worker was still active. This evidence drove the `mvp-v7` output bounds, 32K/64K budgets, monotonic previews, and longer client deadline.
- The Chrome extension adds a Libitu icon button to the YouTube player's lower-right control bar and uses the toolbar action for the same launch. Both inspect YouTube's video-language metadata against an explicit supported-language list, currently `en` only. The player button stays disabled while checking and for non-English or unknown languages; its hover hint explains why. Unsupported toolbar clicks show an action badge/title and an in-player message without launching. URL, video DOM, and SPA navigation checks still guard entry; player-control redraws reattach the button, and repeated clicks focus the existing Stage 1 tab.
- Stage 1 opens after lightweight metadata validation, before caption capture or API calls. A random handoff ID refers to a 15-minute extension-session record; the same-origin web bridge delivers browser captions with bounded waits and the existing backend caption fallback. Transcript text stays out of the URL. Stage 1 owns content/job creation, replaces handoff parameters with durable content/job IDs, and preserves abortable loading, explicit Retry, and streamed previews.
- Missing captions produce an unsupported state instead of returning the old Anthropic demo blueprint.
- Private corpus and speaking endpoints derive ownership from a verified Clerk user instead of accepting a client-provided `user_id`.
- Anonymous corpus saves use `libitu:corpus:v1` in localStorage. Login atomically claims guest items into an account-specific pending outbox, merges with the account list, and acknowledges each successful upload separately. Source/kind/phrase keys deduplicate retries; existing cloud edits win. Logout and account switches never expose or transfer another account's pending items. Failed sync remains visible and retryable, and storage failures are not reported as successful saves.
- Saved shows this video's stored snapshots, independent of the currently ranked candidate pool. Saved cards use a delete icon; other tabs show a check for saved items and a plus for unsaved items. Clicking any corpus card opens a full explanation/syntax dialog with the captured subtitle and adjacent context. Candidate details are cached for the page session without saving the item; saving carries that detail into local/account persistence. Legacy saved items generate their missing detail on first open and persist it, so later opens are cache hits. Full learning metadata, reusable slots, context, and analysis survive reload. The cross-source `/corpus` library now adds filtering, selection, persisted editing/deletion and Loadout handoff.
- Configured corpus requests use the Supabase server repository with explicit owner filters, verified source access, and idempotent inserts. Queue mode without a database returns 503; only unconfigured inline development/tests retain the in-memory adapter. The frontend never receives a Supabase secret or writes with an unverified user ID.
- Supabase project `ulrdykwhggcaspylines` has the initial, Clerk RLS, processing-document, job-observability, and idiom-kind migrations applied. Prior advisors reported only intentional private-schema RLS and unused-index informational notices; the latest advisor recheck encountered a transport failure.
- The Next.js app includes Clerk middleware, provider wiring, and sign-in controls. Hosted Supabase Third-Party Auth still requires its final dashboard save before Clerk tokens can be used directly with the Data API.
- Account buttons capture the full current browser URL at click time and pass it as Clerk's forced return target for both sign-in and sign-up, including transfers between the two flows. Source/job/content parameters and fragments are preserved without reading browser state during server rendering. Primary-button hover/focus uses defined design tokens.
- Upstash stores the processing queue, short-lived content/job/blueprint state, and processing locks. These keys expire and are not the durable source of truth.
- The Supabase processing-document migration is applied and the server repository is active for content, private transcripts, jobs, and blueprint documents.
- A live end-to-end queue test reached `ready` after one attempt and persisted four logic nodes and six corpus candidates. The YouTube fallback separately fetched 1,847 timestamped caption lines from a public test video.
- `design/docs/DATA_ARCHITECTURE.md` defines Supabase, Clerk, and Upstash responsibilities.


2026-09-30 layer guidance correction: restore the right-side Layer focus, Feedback and Tip cards for Sound, Rhythm and Melody. Sound guidance follows the selected phenomenon and uses the current sentence’s rule suggestions; conceal mode also hides word-specific sidebar text. Desktop places guidance beside the layer canvas; narrow screens place it below. The video remains above the workspace. Removing the experimental score sidebar did not authorize removing instructional guidance; no illustrative scores or detected-error claims are restored.


2026-10-15 Reference retry repair: preparing the same browser capture after deletion/expiry now allocates a new deterministic generation; active generations remain idempotent and historical rows/take bindings are never revived. HTTP 410 during upload/status/retry clears stale readiness and stops polling, allowing explicit preparation again. MFA version probes use isolated temporary runtime directories, cache only exact successful version checks and distinguish process startup failures from version mismatches. The UI distinguishes alignment-service outages, timeouts and alignment failures from caption timing/coverage failures. Reference still uses source-transcript MFA with quality checks; acquisition and learner ASR/60–85 gates are unchanged.


MFA startup validation (2026-10-15): both reference and learner workers check the pinned MFA version before reconciling or claiming jobs. A startup failure exits with a service-level diagnostic and leaves queued jobs untouched. Each sentence invokes alignment directly, retaining audio/model integrity, quality checks and versioned result caches. Restart workers after changing the installed MFA runtime.


Stage 2 unified analysis (2026-10-15): Audio settings now has one Server analysis switch for captured/registered Reference and new learner takes, default on. A versioned browser/account preference explicitly remembers off; legacy separate preferences are superseded. Historical recording retention remains separate and default off. Turning analysis off prevents new capture registration, registered-file preparation/upload/retry and learner analysis; submitted tasks continue and saved results remain readable. Microphone activation and original audio acquisition remain explicit.


2026-10-15 Sound presentation: restore the supplied screenshot’s text-first default appearance. All shows candidate phonology marks/linking arcs without per-word acoustic measurement clutter, even after analysis completes. Vowel len. explicitly shows retained vowel durations; Linking shows measured boundary pauses. Keep the existing wrapping typography, IPA reveal, Reference/Your voice rows, guidance sidebar, tab state badges, Rhythm/Melody and server analysis/gates unchanged. This is a presentation adjustment, not a rollback of analysis or a fabricated pending state.


2026-10-15: learner acoustic analysis now runs independently of pending Reference analysis after the unchanged 60/85 word gate. Save the learner checkpoint before waiting; resume final comparison without downloading, decoding, ASR or MFA again. Queue claiming permits missing learner checkpoints even after ASR succeeds, including lease recovery. The hosted `parallel_learner_acoustics` migration updates the claim predicate only; owner, expiry, lease and service-role boundaries remain intact.

Learner workers preload one isolated resident `small.en` process before claiming jobs. Reuse the existing CPU/int8/two-thread model, English/beam-5/temperature-0 settings and reliability thresholds. Requests are serialized per worker, timeout at 180 seconds, and kill/reap the child on failure; the next request rebuilds it. Reference still uses source-transcript MFA; acquisition and audio/alignment quality rules are unchanged. Extra workers each retain their own model memory; parallelism requires both workers and sufficient CPU/RAM, and cold MFA lexicon initialization may still serialize.


Parallel-analysis verification (2026-10-15): root lint/build/test passed (941 API, 368 Web, 114 extension; unchanged Web/extension tasks cached). Disposable PostgreSQL with all repository migrations passed the queue regression, including crash recovery after ASR, durable acoustic checkpoint waiting, retry-budget preservation, stale leases, owner isolation and deletion. Hosted claim migration applied and verified: service role can claim, anon/authenticated cannot. Security advisor has no warning/error (existing informational private.content_payloads RLS-without-policy notice). Local dev stack restarted; both MFA startup checks passed and the learner worker confirmed resident ASR readiness before claiming. The real same-input ASR benchmark recorded 8.794 s → 5.490 s median across three runs, identical evidence, 2.839 s one-time startup; end-to-end parallel wall time remains unmeasured.


2026-10-15 parallel end-to-end measurement: three real storage/queue/inference/UI runs with 3.746-second synthetic speech completed in 50.746/80.131/57.191 s from Reference registration, or 37.342/71.490/48.306 s from learner audio PUT. MFA remains the largest compute stage (17–34 s/invocation). Run 2 found Reference result-save HTTPError causing backoff and repeated MFA; learner checkpoint resume avoided recomputation. Audio local cache hit throughout; final persist-to-display delay 1.161–2.961 s. Fixture auth/source and local environment limit generalization. No additional optimization was shipped in this measurement. Evidence/method/next candidates: design/benchmarks/stage-two-20261015/results.json and STAGE_TWO_REFACTOR_CONTRACT.md. Synthetic data/test page cleaned, regular dev restored.


2026-10-16 progressive acoustics: new >=85% Takes persist complete 10ms server F0/energy, then publish `coarse_ready` before MFA. Reference publishes and caches server signals before source-transcript MFA; two sides share computation and aggregation, using ASR/subtitle boundaries with explicit provenance. Preview uses F0+energy only; fine MFA adds Sound, existing final layers and optional duration-aware relative prominence. The UI labels preliminary results and uncertainty, polls at one second, and retains previews after fine-analysis failures. Historical missing frames are not reconstructed. Hosted migration `20261016101306_progressive_acoustic_checkpoints` applied; remote application deployment remains separate. Existing worker topology is unchanged; CPU-isolated queues and ASR/extraction parallelism remain planned. Local compute-only evidence and limitations: [report](design/benchmarks/progressive-acoustics-20261016/README.md).

## 2026-10-16 independent acoustic workers

Implemented: separate `stage_two_worker --lane fast|fine` processes, started together by `pnpm dev`. Fast handles learner ASR/word gates and server F0/energy/CWT for Takes and References; fine handles MFA and final comparisons. A service-only PostgreSQL lane claim and fenced handoff (`20261016111833_acoustic_worker_lanes`) preserve checkpoints, reset the downstream retry budget and invalidate the fast lease atomically. Each lane prioritizes eligible Takes over References. Fast startup preloads ASR without probing MFA; fine alone verifies MFA. Old combined entrypoints/claim RPCs reject use. Original audio acquisition, quality checks, recognition settings and 60%/85% thresholds are unchanged.

Local macOS scheduling: fine runs at nice 10 with native library threads capped at one; a separate supervisor pauses/resumes the MFA process group when the fast lane holds a shared activity lock. Parent heartbeats continue, locks release on crashes, and the supervisor reaps MFA if its owning worker exits. Active MFA timeout excludes pauses with a bounded additional 900 seconds of wall time. Empty queue polling does not pause MFA. Both workers must share the scheduler directory/account. This prioritizes first results and may extend fine completion under load; it is not hard CPU affinity. Optional disjoint Linux CPU sets and systemd templates are provided but not validated on a cloud host. No production worker deployment is implied.

Validation and timing: see [local lane comparison](design/benchmarks/worker-lanes-20261016/README.md). The local benchmark separates controlled CPU/queue timing from real hosted-storage/local-worker polling; browser paint and target-cloud timings are not inferred from either. Existing previews remain visible through fine processing/failure; no frontend redesign or new matching classes.

## 2026-10-17 consolidated practice submission

The analysis-enabled browser outbox now sends metadata and audio in one authenticated multipart request to `POST /api/practice/attempts/submit`. Profile/Take/analysis registration is transactional; audio remains durable in private storage before queueing. The response is the small persisted Take acknowledgment. Explicit history retention stays independent and reuses the same incoming bytes. Uncertain responses reuse the immutable identity; retrying retention does not reset or reupload a completed analysis.

Fast workers immediately publish word checks, then atomically save raw measurements and coarse output and hand off to fine. Reference coarse results use the same atomic handoff. Original audio acquisition, quality checks, ASR settings, exact 60%/85% gates, and history consent are unchanged. Hosted migration: `20261017091904_consolidated_practice_submission`. No cloud application deployment is implied. Timing method and measurements: [submission benchmark](design/benchmarks/submission-20261017/README.md).

Submission benchmark (2026-10-17): public 4.22s clip, prepared Reference, three alternating trials per mode using new checkpoint workers. Median submit 7.188→3.030s; word feedback rendered 18.550→11.918s; preliminary curves rendered 18.550→14.550s. Browser harness reuses production submission/polling/visual components; target-cloud and whole-practice-page performance are not inferred. Fixture rows/audio cleaned. Root lint/build/test passed (984 API, 370 Web, 114 extension); current desktop/mobile practice and browser-reference suites passed. Legacy file-reference suite still has a pre-submission obsolete UI assertion; see benchmark record.

## 2026-10-17 consolidated analysis status reads

Analysis polling now uses one service-only `practice_analysis_read_snapshot` RPC to read the owned Take, analysis and current-sentence Reference data in a single statement snapshot. Projection omits raw Take frames, learner checkpoints, Reference measurements/phoneme arrays and unrelated sentences. Source visibility/ownership and parent deletion are checked in SQL; expiry, live local source grants and exact sentence text/timing remain checked in the service. The existing AnalysisView, gates and UI polling interval are unchanged. Mutation responses share the same formatter and resolve Reference once. Hosted migration: `20261017094154_practice_analysis_read_snapshot`. Benchmark: [status-read comparison](design/benchmarks/result-query-20261017/README.md).

Result-query benchmark (2026-10-17): three alternating trials per mode with identical merged submission and prepared Reference. Median status request before preliminary output 0.828→0.272s; word feedback rendered 13.285→10.700s; preliminary curves rendered 14.089→12.017s from submission start. Read database round trips reduced from 3/5/7 to one. ASR remains the largest fast-path compute stage (5.665s median). Fixture rows/audio cleaned and hosted zero counts verified. Local browser harness scope and small-sample limits: [report](design/benchmarks/result-query-20261017/README.md).


## 2026-10-17 optional Reference for learner analysis

Reference preparation is optional. With server analysis enabled, a learner may record immediately without uploaded Reference audio; the Take freezes a null Reference identity and follows the existing word check, fast signal checkpoint, and fine learner alignment pipeline. It completes with learner measurements and no comparison score, without waiting for Reference. The unchanged below-60%, 60–<85% Sound-only, and >=85% all-layer gates still apply. Existing eligible References can be bound at recording start and use the paired flow. Active original-audio capture still blocks simultaneous microphone recording.

The UI describes optional Reference comparison and promotes completed learner-only fine results beyond the preliminary badge. Learner-only CWT tables omit the empty Reference column and determine uncertainty from learner evidence; absence of a comparison alone does not invalidate that evidence. Reference acquisition, quality checks, server-analysis preference and independent history-retention switch are unchanged. A Reference prepared after a null-reference Take is not retroactively attached in this increment. Existing backend nullable Reference support and worker completion are reused; no schema migration is required.

Verification: root lint/build/test passed (999 API, 370 Web, 114 extension). Reference-free practice browser regression passed at 1440px and 390px with synthetic microphone audio and fixture API results, including null-reference submissions, all matching tiers, preview-to-final display and history navigation. Worker regression verifies independent fast/fine completion without waiting or comparison scores; targeted service/worker tests passed 45 cases. These checks do not measure live inference accuracy or latency.

2026-10-17 UI cleanup: remove the duplicate optional-Reference card above sentence practice. Reference preparation, status and retry remain in the existing upper Reference panel; sentence practice leads directly with the sentence and recording controls. Learner-only analysis and consent/retention settings are unchanged.

2026-10-17 presentation change: hide preliminary Rhythm/Melody curves and Preview badges in sentence practice. Word feedback remains immediate; eligible layers show a brief pending state until fine evidence is available. Failed/cancelled fine work shows unavailable rather than coarse fallback. Completed learner measurements remain viewable without a valid Reference. Fine layer presentation, background checkpoints, 60/85 gates, original acquisition and retention are unchanged. Earlier first-curve benchmarks describe the previous preview UI, not the current time to visible final layers.

2026-10-17 final-layer benchmark after hiding Preview: three real 4.22s learner-only trials rendered full learner layers at 43.211/36.676/47.717s from submission start (median 43.211s), word checks at median 13.077s. Median after upload acknowledgment: 39.443s. Sampled MFA process interval 20.1–29.6s is the largest observed stage. Public audio, local CPU plus hosted Supabase, fixture auth/source and production render components; no inference accuracy/cloud performance claim. Duplicate old test workers removed before timing; fixtures cleaned afterward. [Evidence and limits](design/benchmarks/final-layers-20261017/README.md).


### 2026-10-17 Reference loading presentation cleanup

Remove the duplicate yellow preparation progress bar and amber preparation/analysis backgrounds in Shadow; keep the video playback progress indicator. Restore existing sentence References silently without a visible Checking state or analysis spinner. While availability is unresolved, show neutral Reference copy (or the existing extension-off/setup controls), then show the actual resolved status. Directory practice progress reports learner Takes and best word matches, not Reference availability; retain the cached background lookup and upload deduplication. Audio acquisition, recording availability and analysis gates are unchanged.

2026-10-17 Enable setup follow-up: show the setup spinner only during the extension handshake. Once armed and waiting for a toolbar click, stop the spinner, show “Click Libitu in Chrome’s toolbar”, and retain the setup instructions and Cancel action. The extension protocol, authorization and audio acquisition remain unchanged.
