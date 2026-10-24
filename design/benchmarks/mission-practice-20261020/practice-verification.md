# Linked practice planning verification

`apps/api/scripts/verify_speaking_planning.py` now accepts
`--practice-variation details|role_swap`. The option requires an explicit
`--support-level`. Each invocation allows at most two planning API requests and
four model calls, including the existing single content repair per request.
There is no feedback-model request.

The script uses a random synthetic owner and three synthetic language items.
It creates a parent plan and Mission, inserts declared runtime fixtures, ends
the parent, then requests one linked variant. It checks server-derived changes,
unchanged target roles, distinct child item IDs, stable source identities and
parent-item mappings, explicit initial support, and frozen feedback input.
It also checks committed child recovery after source and parent deletion.
The final cleanup deletes only that invocation's synthetic profile and checks
its owner-bound records and known session dependents.

Identity is substituted inside the smoke process. Presentation receipts,
skipping, support changes and assistant turns are fixtures. No reliable learner
turn is inserted, so an external feedback worker has no model-assessment input.
This does not verify authentication, Gemini, actual audio delivery, teaching
quality, learner improvement or the history recommendation threshold.

## Preserved real attempts

[practice-events.json](practice-events.json) records the first invocation:

- The parent planning request succeeded with two candidates, one DeepSeek call,
  4,852.2 ms and 3,016 total tokens.
- Parent session creation, idempotency, metadata, support changes and runtime
  recovery checks passed.
- The script stopped at `feedback_plan_snapshot` before requesting a child plan.
  The assertion compared raw frozen JSON with a public Pydantic response.
  Plain parent targets omit the newly optional `parent_session_item_id`, while
  the public model adds `null`. The script now compares normalized
  `SpeakingSession` snapshots without changing persisted source.
- Cleanup confirmed zero remaining profiles, corpus items, plans, sessions
  and known session dependents.

[practice-final-events.json](practice-final-events.json) records the final
authorized invocation after that script correction:

- Its first exact-owner database read failed with `ConnectError`, before any
  plan or model request.
- Model calls: zero. No child model or hosted child-freeze result was obtained.
- The cleanup connection succeeded and confirmed all recorded residual counts
  were zero.

There was no further automatic retry. These artifacts establish successful
real parent planning and explicit cleanup; they do not establish successful
real linked child generation and persistence.

## Offline script checks

Five process-local fixture chains passed: linked details, linked role swap,
legacy support omitted, explicit P2 support, and linked details with the
optional parent-link field removed from raw frozen JSON. The latter confirms
the normalization correction while preserving the expected semantic plan.
Python compilation, CLI help and `git diff --check` also passed.

These checks validate the probe and contracts with fixture provider output.
They do not count as live model results. Product unit tests and SQL rollback
verification are reported separately in the living project documents.

For a separately authorized future run:

```bash
cd apps/api
.venv/bin/python scripts/verify_speaking_planning.py --run-live --ipv4 \
  --support-level no_hint --practice-variation details \
  --output ../../design/benchmarks/mission-practice-20261020/new-practice-events.json
```
