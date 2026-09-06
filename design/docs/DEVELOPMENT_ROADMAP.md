# Deliver the Libitu MVP

```yaml
meta:
  contentType: How-to
  status: active
  updated: 2026-08-30
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

Exit each increment with accessibility checks, failure-state coverage, and one learner-level test.

## Phase 7: prepare production operations

Goal: make the validated product observable, recoverable, and deployable.

Deliver:

- Staging and production environments
- Secret and configuration inventory
- Structured logs, error tracking, job metrics, and cost metrics
- Database backup and restore test
- Privacy policy inputs, retention controls, and account deletion flow
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
