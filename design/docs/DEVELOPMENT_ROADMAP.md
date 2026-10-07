# Deliver the Libitu MVP

```yaml
meta:
  contentType: How-to
  status: active
  updated: 2026-09-30
```

This roadmap orders implementation by dependency and product risk. Each phase must produce a testable learner outcome before the next phase expands scope.

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

Stages 4 and 5 were implemented locally on 2026-10-01: Gemini Live conversation, durable transcripts/evidence, asynchronous teaching control, then frozen-input four-dimension reports with quoted evidence and retry/adjust actions. Next qualify devices/network/cost, real OAuth and assessment quality. See [Stage 4 boundaries](STAGE_FOUR_IMPLEMENTATION.md) and [Stage 5 implementation and verification](STAGE_FIVE_CONTRACT.md).

2026-09-30 status: speaking loadout, account-bound browser drafts, durable session creation and the recoverable session preparation page are implemented. Full corpus editing, real role-play, turn history, selected-item detection and feedback remain pending. Loadout completion alone does not satisfy the phase exit criterion. See [the contract and validation](LOADOUT_IMPLEMENTATION.md).

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
