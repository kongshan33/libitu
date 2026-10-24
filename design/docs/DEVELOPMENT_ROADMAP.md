# Deliver the Libitu MVP

```yaml
meta:
  contentType: How-to
  status: active
  updated: 2026-10-20
```

This roadmap orders implementation by dependency and product risk. Each phase must produce a testable learner outcome before the next phase expands scope.

Routing architecture update (2026-10-10): R3 directly enables `/practice/import`, `/practice/{contentId}`, `/segments` and `/shadow` with a shared content layout/media host. Main steps push; selection and explicit returns replace. The user removed compatibility requirements: root query learning links and old extension protocols are unsupported, entry links use new paths, continuation uses v2 only, and Web/extension 0.2.0 must update together. R4 entry work is included; R5 cleanup is implemented. See [architecture](ROUTING_AND_RESPONSIBILITY_ARCHITECTURE.md) and TASK.MD for checks and the outstanding real-toolbar capture qualification. No product phase, provider, database schema or consent boundary changes.

Stage 2 practice refactor update (2026-10-12): execute [the accepted contract](STAGE_TWO_REFACTOR_CONTRACT.md) in six ordered steps: contract (complete), backend three-tier gate (implemented), persistence/feedback (implemented; both migrations applied to hosted Libitu), practice UI (implemented and locally verified at desktop/mobile), full navigation/history acceptance (implemented; hosted directory RPC verified), then final wider regression/documentation. Reuse existing original-video reference acquisition. This is the next Stage 2 workspace increment, not delivery of new Sound detectors or remote file acquisition. TASK.MD tracks implementation.

## Doubao text-provider migration — 2026-10-23

The current text provider is Doubao for Stage 1, corpus selection, Mission planning,
Stage 4 analysis/help and Stage 5 assessment. Gemini Live remains the voice provider.
This infrastructure replacement preserves delivery order and product contracts;
see `PROJECT.MD` and `TASK.MD` for configuration and verification boundaries.

## Stage 2 Quick and Review — 2026-10-17

Delivered the approved Quick/Review prototype with Quick as the default and the original Detailed presentation preserved. Added continuous practice, original-duration × 2 recording, early Done, background analysis, segment review/history and learner-only evidence without Reference. Quick now inserts a 2-second preparation countdown after playback; Pause discards unfinished audio and Resume replays the current sentence, without changing Detailed. Recorder/API/decoder/database duration support is implemented; hosted migration `20261017121513_quick_shadowing_duration` is applied. Root test/lint/build and desktop/mobile fixture acceptance pass. Application deployment and real microphone/provider acceptance are separate; pronunciation-effect validation remains outstanding.


## Phase 0: maintain the engineering baseline

Goal: keep every workspace installable and verifiable from the repository root.

Deliver:

- Continuous integration for install, lint, build, and test
- Web unit-test setup
- Stable local environment examples without secrets
- One command or documented pair of commands for web and API development

Exit when a clean checkout passes root verification and both development servers start from documented commands.

## Phase 1: prove the web and API contract

Goal: render Stage 1 from the FastAPI contract instead of component-owned demo data.

Deliver:

- Typed web API client
- Content resolve, job creation, polling, and blueprint query flow
- Loading, ready, failed, unsupported, and retry states
- Contract fixtures shared by web tests and API tests through generated or validated schemas

Exit when the web app renders a deterministic API blueprint and recovers from a simulated failure.

## Phase 2: establish data ownership

Goal: persist public processing results and private learner data with enforceable ownership.

Deliver:

- Accepted auth, database, migration, and anonymous-merge decisions
- Content, processing job, blueprint, corpus, session, turn, and feedback tables
- Repository interfaces behind FastAPI services
- Optional identity for public endpoints and required identity for private endpoints
- Authorization, migration, and cache-key tests

Exit when two test users cannot access each other's private records and anonymous Stage 1 still works.

## Phase 3: create the real YouTube entry

2026-10-03 web entry: the landing page and normalized paste-to-Stage-1 route are implemented alongside the existing extension handoff. Real Clerk modals are connected. Store publication, a completed real-account OAuth round trip and production caption coverage remain separate; see [verification](LANDING_IMPLEMENTATION.md).

Goal: start the product from a supported YouTube watch page.

Deliver:

- Loadable Manifest V3 extension
- YouTube page detection and metadata normalization
- Browser-side caption acquisition for supported videos
- Player-control and toolbar one-click entry; immediate web handoff with asynchronous caption capture
- Video-language detection with an expandable support list, initially English only
- Disabled player entry and explicit toolbar feedback for non-English or unknown-language videos, without an additional extension surface
- Local snapshot restoration
- Explicit unsupported and permission states

Exit when a learner can open a supported video, invoke Libitu, and reach a cached or newly created Stage 1 job without uploading media.

## Phase 4: generate real blueprints

Goal: turn caption text into a versioned, validated blueprint.

Deliver:

- Provider-neutral analysis interface
- Structured output schema for summary, logic, segments, chunks, idioms, structures, and scenarios
- Evidence-grounded corpus candidate scoring and read-time learner-level ranking
- Local punctuation, truecasing, sentence segmentation, and incremental subtitle previews
- Transcript size limits and chunking policy
- Timeout, retry, concurrency, and cost limits
- Cache invalidation through `analysis_version`
- Offline fixtures and optional integration tests

Exit when valid captions produce stable blueprint data and cache hits avoid repeated model calls.

## Phase 5: close the learning loop

2026-10-20 delivery sequence: [expression-led Mission planning](STAGE_THREE_FOUR_MISSION_PLAN.md)
in order: P0 selection/plan/evidence contracts; P1 language-first Loadout, one-button
scene preparation and Mission start with optional scene comparison, bounded
content-error recovery, actionable selection guidance, and recorded Stage 4
opportunities; P2 natural demonstrations and four manually selected support
levels; P3 missed opportunities and linked variants; P4 evidence-based support
recommendations. P0–P4 are implemented; current verification is recorded in `TASK.MD`.
2026-10-24 preparation P0/P1 follows that delivery: single-scene automatic Start
and bounded local repair, then selected-corpus batch reads, source-aware cache
reuse and request-correlated phase timings. Implemented and verified; samples and
remaining model/voice validation boundaries are recorded in `TASK.MD`.

P3 keeps suggested rewrites separate from observations and links changed-role/detail
rounds. P4 requires repeated independent evidence and explicit acceptance of any
support reduction. P2 preserves a distinct
model-then-transfer action, server-owned frames, actual presentation evidence and
versioned support changes; it does not infer mastery or automatically upgrade
support. Keep primary-target
coverage separate from actual AI opportunities and assistance, and preserve legacy
draft/report recovery. `TASK.MD` records verification and deployment status.

2026-10-02: the private personal learning center and unified practice history are implemented against existing corpus, Shadow and speaking records. Activity counts and device-local continuation do not depend on Stage 5 scores. A separate latest-Mission summary now reads compatible Stage 5 reports and history links to Analytics. The simple history page now groups local dates and supports server-side practice-type filtering before pagination. General ability assessment, score trends, full corpus management and cross-device reader position remain separate. See [scope and verification](PROFILE_IMPLEMENTATION.md).

Stages 4 and 5 were implemented locally on 2026-10-01: Gemini Live conversation, durable transcripts/evidence, asynchronous teaching control, then frozen-input four-dimension reports with quoted evidence and retry/adjust actions. Next qualify devices/network/cost, real OAuth and assessment quality. See [Stage 4 boundaries](STAGE_FOUR_IMPLEMENTATION.md) and [Stage 5 implementation and verification](STAGE_FIVE_CONTRACT.md).

2026-09-30 status: speaking loadout, account-bound browser drafts, durable session creation and the recoverable session preparation page are implemented. Full corpus editing, real role-play, turn history, selected-item detection and feedback remain pending. Loadout completion alone does not satisfy the phase exit criterion. See [the contract and validation](LOADOUT_IMPLEMENTATION.md).

2026-10-02 corpus status: independent `/corpus` browsing, filtering, editing/deletion and Loadout handoff are implemented. Decks and usage aggregation remain separate; see [the library contract](CORPUS_LIBRARY_IMPLEMENTATION.md).

Goal: move one extracted item through corpus and speaking feedback.

Deliver:

- Corpus management UI
- Corpus detail modal with persisted source context and on-demand cached analysis
- Speaking loadout with visible limits
- Scenario role-play and turn history
- Selected-item detection with evidence
- Four-dimension feedback linked to actual turns
- End-to-end test for the complete learner path

Exit when a learner saves language from a video, uses it in role-play, and sees that use reflected in feedback after reload.

## Phase 6: broaden input and practice

Goal: add depth without changing the core data model.

Deliver in this order:

1. Pasted-text reading blueprint
2. Reading intensive mode and rewrites
3. YouTube intensive transcript analysis
4. Browser-local shadowing and pitch feedback
5. Article URL extraction for explicitly supported sources

The original Stage 2 milestone sequence is retained below to identify delivered increments, with implementation status tracked in `TASK.MD`. The 2026-09-09 file-reference target changes the next delivery order: F1 source/range-fetch and runtime feasibility → F2 persistent segment assets and jobs → F3 file playback/prefetch and smooth controls → F4 asynchronous private attempts/history → F5 M4b detectors and deeper prosody. See [the detailed architecture](STAGE_TWO_FILE_REFERENCE_ARCHITECTURE.md). File ingestion is no longer postponed until after every Sound detector; ordinary YouTube full-reference capability must not be assumed.

The 2026-09-19 entry decision advances basic owner-scoped attempt/recording persistence and the Shadow login gate ahead of the file-reference foundation. This slice is implemented against the existing source/recorder path, with private upload/replay/delete and durable history. It does not complete F4 cloud acoustic analysis or make F1–F3 available. Follow its [save and operational boundaries](STAGE_TWO_PERSISTENCE.md), including page-local pending saves and remaining production reconciliation work.

1. Milestone 1: stable sentence units, caption-based approximate navigation bounds, sentence directory, independent playback controls, and refresh recovery.
   Follow with shared Stage 1/2 server sentence rows: validate local syntax merging and latency, remove length-based hard cuts, preserve streaming identity, migrate cached display views, and verify both playback surfaces before audio work.
2. Milestone 2: local microphone recording, permission/error handling, cancellation, and replay tied to the selected sentence. Validate recorder races and cleanup with fakes, then exercise actual browser encoding/replay with synthetic microphone input. Keep temporary audio in page memory and ship no detector or score in this increment.
3. Milestone 3: enable one practice audio session through the Chrome extension with an explicit toolbar invocation, then automatically capture missing references during normal sentence listening at 1×. Reuse the session and a bounded feature cache across sentences; pause reference encoding during microphone recording/replay and close the session on exit. Analyze reference and microphone audio locally with pinned, self-hosted Silero V5 / ONNX Runtime Web for speech regions and Pitchy for relative pitch. Compare speaking span and internal pauses, plot both normalized contours, and abstain when evidence is insufficient. This prepares audio while listening; ingestion-time preprocessing is not implemented. Validate actual model inference independently from the simulated player/extension interaction; live YouTube and real-speaker quality require additional evaluation.
4. Milestone 4a: add source-bound Sound rule candidates using a versioned pronunciation dictionary and conservative rules; show exact text spans, alternatives/coverage, conditions, and separate unevaluated reference/user evidence. Milestone 4b: add word/phoneme alignment and individually validated acoustic detectors. Gate every detector on independently aligned audio and labelled evaluation; keep expected phonology separate from observed realization. Rule-test success alone does not complete M4b.
5. Add authenticated practice persistence. Store versioned attempts and derived evidence first; add purpose-specific learner recording upload, replay retention, deletion, and export controls. Keep analysis, long-term retention, and model-training choices separate, with training off by default.
6. Licensed-reference ingestion is promoted into the F1–F3 foundation above. The proposed default prepares the selected practice segment from a permitted file source, shares versioned sentence assets, and does not acquire entire videos automatically. Ordinary YouTube sources retain official-player playback and basic practice when a permitted file source is unavailable.

Do not make sentence navigation depend on future audio models. Keep preparation states and feedback faithful to the integrations actually delivered; player simulation verifies interaction behavior but does not validate live seek precision or detector accuracy.

Rhythm display follow-up (2026-09-22): expose existing dictionary syllable stress and detected pauses against sentence text on both reference paths. This UI increment shares current data and does not advance sentence-emphasis classification or learner word alignment; those remain gated by F5/M4b evidence.

Offline benchmark preparation can run alongside F1–F4: establish licensed samples, strict audio/text/result identity, independent human annotation, split isolation and per-target metrics before detector development. The first 16-clip development seed and tooling are implemented; human gold labels, expansion toward 200–300 recordings, independent test coverage and detector inference remain pending. See [benchmark scope](STAGE_TWO_ACOUSTIC_BENCHMARK.md). This is evidence preparation, not a change to the online delivery order or completion of F5/M4b.

Caption-first follow-up (2026-09-13) precedes additional audio infrastructure for basic practice: retain available source word offsets, share them across Stage 1/2, degrade to block/plain captions when unavailable, and bound acquisition, streaming payload and high-frequency UI updates. This increment does not complete file-reference F1 or word/phoneme-alignment M4b; source-caption starts cannot substitute for actual reference audio in acoustic comparison.

The subsequent supplied capture-flow proposal is implemented first as a bounded local increment: one explicit source-tab grant, Stage 1 PCM coverage, selected-range preparation and cross-stage local analysis reuse. See [its corrected flow](STAGE_ONE_BUFFERED_REFERENCE.md). This does not complete file-source F1–F4, grant third-party media rights, or add MFA/cloud processing. Keep those dependencies explicit rather than calling the whole uploaded diagram delivered.

Close the old-cache acquisition gap in this same increment: render cached analysis first, recover missing timing asynchronously from an already open matching source tab, validate unchanged words through a timing-only endpoint, and apply a new view outside active Stage 2 practice. Recovery must not create another semantic job or make cached listening depend on extension/network success.

Harden that acquisition boundary with an early passive player-response observer rather than rebuilding dynamic signed URLs. Verify real fetch/XHR behavior, source navigation, bounded clones, late installation and absent-caption requests before claiming availability. Keep deterministic/unpacked-extension fixture checks distinct from actual target-video recovery after reloading the local extension and source page.

Exit each increment with accessibility checks, failure-state coverage, and one learner-level test.

The 2026-09-26 local-alignment increment connects captured browser PCM to word/phoneme timing before additional source providers or detectors. It reuses existing capture, dictionary and learner-result components; local reference display and compatible REF/YOU pairing are not gated on file-source registration. This adds caption-conditioned boundaries, not independently verified pronunciation or calibrated cross-engine scoring. See [browser-local alignment](STAGE_TWO_LOCAL_ALIGNMENT.md).

## Phase 7: prepare production operations

Goal: make the validated product observable, recoverable, and deployable.

Deliver:

- Staging and production environments
- Secret and configuration inventory
- Structured logs, error tracking, job metrics, and cost metrics
- Database backup and restore test
- Privacy policy inputs, retention controls, and account deletion flow
- Recording object storage, encryption, signed delivery, deletion propagation, and processor inventory
- Content-rights register and takedown workflow for licensed reference media
- Deployment and incident runbooks

Exit when a failed processing job can be diagnosed, retried safely, and measured without reading private learner content unnecessarily.

## Quality gate for every phase

Run:

```bash
pnpm lint
pnpm build
pnpm test
```

Also verify the changed learner flow manually. Update `TASK.MD`, `PROJECT.MD`, `DECISIONS.MD`, and affected design documents when behavior or architecture changes.

2026-09-22 reference increment: the first operator-registered file/upload source adapters, private reference storage, durable analysis queue and conditional file playback/three-layer measurements now implement a bounded F1–F3 foundation. Remote acquisition providers, production worker hosting and actual source onboarding remain separate. E/M4b detectors and user cloud comparison still require independent evidence. See [implemented scope](STAGE_TWO_SERVER_REFERENCE.md).

2026-09-22 learner increment: F4 now includes consented temporary uploads, durable asynchronous processing, independent content checks, learner word alignment, saved descriptive Rhythm/Melody comparisons and cancellation/deletion. Human-validated assessment, sound/stress detectors, longitudinal grading and recommendations remain pending. See [scope and runtime](STAGE_TWO_PRACTICE_ANALYSIS.md).


## Stage 2 paired comparison increment — implemented 2026-09-23

Sound, Rhythm and Melody now share the prototype’s paired Reference / Your recording layout for one saved take. Sound publishes measured vowel timing and candidate consonant–vowel boundary pauses, with separate experimental resemblance scores; eight unvalidated realization checks stay unscored. Rhythm keeps solid amber dictionary stress dots, word durations and text-positioned pause bars. Melody overlays relative pitch on one word axis, preserving gaps. No actual IPA, observed sentence stress, overall Sound grade or pronunciation correctness is inferred. The right panel shows versioned experimental scores and coverage; missing evidence remains empty. Old results stay readable; new evidence requires a new recording. Revoked references hide nested assessments too. See [formulas, compatibility, verification and pending detectors](STAGE_TWO_SOUND_COMPARISON.md). This completes the initial F5 measurement/UI increment, not the validated detector milestone.

## Stage 2 browser reference and three-layer update — 2026-09-29

The current browser-reference path uploads the captured sentence for private server analysis after explicit purpose-specific opt-in. A registered file source is not required. Reuse independently verified reference word prosody and bind it to the learner's saved take; wait for reference preparation without exhausting learner retries. Sound and Rhythm each show only Reference / Your voice rows. Melody overlays both median-normalized pitch curves on one word axis, with full corresponding words and pointer/keyboard/playback highlighting below. Pending local curves indicate sentence-time normalization; missing or unverified word evidence remains empty. Keep the video and practice controls above the three-layer workspace. Sound retains the prototype’s ten phenomenon filters, inline word badges, linking arcs, hover/focus dictionary IPA and legend; selecting a phenomenon highlights its exact text occurrences. Rule suggestions and learner targets remain distinct from measured vowel duration and pauses. Unsupported realization checks remain unevaluated. Remove duplicate central measurement panels and the score sidebar. This supersedes the earlier local-only default and paired-score presentation, while retaining the registered file adapter and local quick previews. General remote acquisition and validated sound/stress detection remain planned. See [implementation, normalization and verification](STAGE_TWO_BROWSER_REFERENCE_SERVER.md).


2026-09-30 layer guidance correction: restore the right-side Layer focus, Feedback and Tip cards for Sound, Rhythm and Melody. Sound guidance follows the selected phenomenon and uses the current sentence’s rule suggestions; conceal mode also hides word-specific sidebar text. Desktop places guidance beside the layer canvas; narrow screens place it below. The video remains above the workspace. Removing the experimental score sidebar did not authorize removing instructional guidance; no illustrative scores or detected-error claims are restored.

2026-10-11: original-video records and direct Stage 1 navigation are implemented in My learning/history using existing owner-scoped content state; no new schema or assessment dependency. Verification is tracked in [profile implementation](PROFILE_IMPLEMENTATION.md).

2026-10-14 implemented follow-up: Reference uses source-transcript MFA without secondary ASR, explicit evidence provenance and a separate reference cache policy version. Learner ASR/gates and reference acquisition stay unchanged; see STAGE_TWO_REFACTOR_CONTRACT.md for verification.


## 2026-10-16 progressive acoustic results

Implemented: publish coarse Rhythm/Melody after the unchanged >=85% reliable word gate and before MFA. Below 60% stops at word checking; 60–<85% remains matched-word Sound only. Fewer than four words still skip automatic navigation. Reference server signal is published before source-transcript MFA. Both sides use the same server F0/energy implementation and CWT/window aggregation; browser acoustics are not comparison inputs. Coarse omits duration; boundary-sensitive, low-coverage and edge measurements are uncertain. No stress classes or correctness scores. ASR/subtitle/MFA boundary provenance and algorithm/time-basis versions accompany results.

Eligible new Takes store full 10ms frames in a private durable `acoustic_checkpoint` and display signal in `coarse_checkpoint`; `phase=coarse_ready` can appear while state remains `processing`. Reference `SentenceResult.status=coarse_ready` includes saved measurements and coarse signal. Final Sound/Rhythm/Melody replace preliminary panels; fine failures retain available previews. Keep the original final layer styling and give previews an explicit badge. All read paths retain ownership, sentence identity and Reference revocation/expiry checks. Full Take frames survive audio cleanup but are cleared by analysis or parent deletion. No reconstruction of historical missing audio.

Hosted migration: `20261016101306_progressive_acoustic_checkpoints`. New Reference policy: `reference-source-transcript-v3-progressive`; learner snapshot flag: `server-prominence-v1`. Restart workers after updating dependencies; remote application deployment is separate from schema application. Independent worker lanes and local CPU scheduling are implemented in the follow-up below. ASR/extraction concurrency and target-cloud end-to-end benchmarks remain planned. [Local compute evidence and limitations](../benchmarks/progressive-acoustics-20261016/README.md).

## 2026-10-16 independent acoustic workers

Implemented: separate `stage_two_worker --lane fast|fine` processes, started together by `pnpm dev`. Fast handles learner ASR/word gates and server F0/energy/CWT for Takes and References; fine handles MFA and final comparisons. A service-only PostgreSQL lane claim and fenced handoff (`20261016111833_acoustic_worker_lanes`) preserve checkpoints, reset the downstream retry budget and invalidate the fast lease atomically. Each lane prioritizes eligible Takes over References. Fast startup preloads ASR without probing MFA; fine alone verifies MFA. Old combined entrypoints/claim RPCs reject use. Original audio acquisition, quality checks, recognition settings and 60%/85% thresholds are unchanged.

Local macOS scheduling: fine runs at nice 10 with native library threads capped at one; a separate supervisor pauses/resumes the MFA process group when the fast lane holds a shared activity lock. Parent heartbeats continue, locks release on crashes, and the supervisor reaps MFA if its owning worker exits. Active MFA timeout excludes pauses with a bounded additional 900 seconds of wall time. Empty queue polling does not pause MFA. Both workers must share the scheduler directory/account. This prioritizes first results and may extend fine completion under load; it is not hard CPU affinity. Optional disjoint Linux CPU sets and systemd templates are provided but not validated on a cloud host. No production worker deployment is implied.

Validation and timing: see [local lane comparison](../benchmarks/worker-lanes-20261016/README.md). The local benchmark separates controlled CPU/queue timing from real hosted-storage/local-worker polling; browser paint and target-cloud timings are not inferred from either. Existing previews remain visible through fine processing/failure; no frontend redesign or new matching classes.

### 2026-10-17 Stage 2 delivery: submission/checkpoint consolidation

Delivered a single analysis-enabled submission endpoint, transactional Take/job registration and atomic coarse checkpoint plus lane handoff. Preserve cloud durability before queueing and independent playback retention. Benchmark local browser submission through rendered preliminary results before considering Realtime, streaming uploads or asynchronous cloud durability. See [measurement record](../benchmarks/submission-20261017/README.md).

### 2026-10-17 Stage 2 delivery: consolidated status reads

Delivered one coherent status query after submission/checkpoint consolidation. Preserve all ownership, source and expiry checks and the existing polling interval. Compare the old serial read with the new snapshot using the same merged upload and workers; see [measurement record](../benchmarks/result-query-20261017/README.md).


## 2026-10-17 optional Reference for learner analysis

Reference preparation is optional. With server analysis enabled, a learner may record immediately without uploaded Reference audio; the Take freezes a null Reference identity and follows the existing word check, fast signal checkpoint, and fine learner alignment pipeline. It completes with learner measurements and no comparison score, without waiting for Reference. The unchanged below-60%, 60–<85% Sound-only, and >=85% all-layer gates still apply. Existing eligible References can be bound at recording start and use the paired flow. Active original-audio capture still blocks simultaneous microphone recording.

The UI describes optional Reference comparison and promotes completed learner-only fine results beyond the preliminary badge. Learner-only CWT tables omit the empty Reference column and determine uncertainty from learner evidence; absence of a comparison alone does not invalidate that evidence. Reference acquisition, quality checks, server-analysis preference and independent history-retention switch are unchanged. A Reference prepared after a null-reference Take is not retroactively attached in this increment. Existing backend nullable Reference support and worker completion are reused; no schema migration is required.
