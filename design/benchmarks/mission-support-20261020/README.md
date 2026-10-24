# Mission support smoke — 2026-10-20

This run uses synthetic corpus cards and an isolated random owner. The live request
calls the existing DeepSeek planner and hosted Supabase repositories. Runtime
receipts are explicit fixtures; this is not a Gemini, microphone, playback,
Clerk sign-in, or learning-effect evaluation.

## Verification

- Script syntax and `--help` passed.
- The complete script chain passed offline with mocked planning and inline storage
  for all five inputs: omitted support level, `model_frame`, `model_label`,
  `label_only`, and `no_hint`.
- The initial live planning request made two provider calls, including the
  permitted content repair, and returned HTTP 503. Their durations were
  7,649.31 ms and 9,138.95 ms; both completed normally. Rejection was local
  `plan_invalid_frame` validation, not a provider or storage failure.
- After the terminal-punctuation fix, the unchanged saved candidates passed the
  complete offline chain, followed by the hosted Supabase chain. The hosted
  replay made **zero model calls**; only its random synthetic target IDs changed.
- A final live planning request after the fix passed with one model call:
  6,748.07 ms provider duration, 3,024 total tokens, and 9.35 seconds for plan
  creation plus recovery. No content repair was needed.
- All three hosted runs verified cleanup: synthetic profiles, corpus, plans,
  sessions, and known session dependents were absent after cleanup.

## Commands

```sh
apps/api/.venv/bin/python apps/api/scripts/verify_speaking_planning.py \
  --run-live --ipv4 --support-level model_frame \
  --output design/benchmarks/mission-support-20261020/final-live-events.json
```

The intermediate hosted replay used no new provider request:

```sh
apps/api/.venv/bin/python apps/api/scripts/verify_speaking_planning.py \
  --run-live --ipv4 --support-level model_frame \
  --replay-events design/benchmarks/mission-support-20261020/safeevents.json \
  --output design/benchmarks/mission-support-20261020/replay-hosted-events.json
```

## Failure reproduced and fixed

The fixture structure was `Given [premise], we should [action]`. Both model
responses returned `Given [premise], we should [action].` as its sentence frame.
The validation compared the entire whitespace-normalized, case-folded strings,
so the added final period caused rejection. The source anchors and slot names
were unchanged.

[Initial failure](./safeevents.json),
[hosted replay](./replay-hosted-events.json), and
[final live verification](./final-live-events.json) contain synthetic candidate
previews, fixed diagnostic codes, token usage, and verified cleanup. They contain
no credentials or learner records.

The initial live run stopped before plan persistence and session creation. Consequently,
the new hosted support transition and feedback-freeze assertions were **not
reached** in the initial run. The minimal fix ignores terminal sentence
punctuation while retaining literal anchors, slot names, order, and other content
checks. The saved response was replayed successfully before the final paid run.

## Verified hosted contracts

Both the replay and final live run passed these checks:

- Every target has a valid sentence frame, frozen unchanged with stable session
  item IDs; source edits or deletion do not change the frozen plan.
- Initial `model_frame` support is stored and recovered. Repeating the same
  session request is idempotent; changing its support under the same client ID
  conflicts.
- Runtime support changes from `model_frame` version 0 to `no_hint` version 1.
  Repeated same-setting changes preserve history; stale versions are rejected.
  The original session support stays unchanged.
- The feedback source retains initial/current support, history, policy support
  version, separate model/transfer quotes, and session-scoped possible audio
  exposure. Private probe fields are excluded.
- Owner isolation and feedback request idempotency hold. No reliable learner
  turns were inserted, and no feedback model was called.

Runtime state changes used the real hosted CAS repository with synthetic fixture
receipts. They do not verify the WebSocket support selector, Gemini modeling,
actual audio playback, model assessment quality, or learner transfer.

## Separate software checks

Root lint/build/test pass: 1,384 API, 423 Web and 114 extension tests. Dedicated
support browser fixtures pass at 1440/390 px, including confirmed four-level
changes, cached scene reuse, anonymous no-hint targets, actual visibility receipts,
legacy opt-in, skip/undo, requested help and busy recovery. Menu exit animations
now trigger a fresh visibility check without requiring another user interaction.
Desktop/mobile screenshots were inspected. Shared Help browser checks also pass
after the visibility change. These checks use synthetic auth/API/provider events.
