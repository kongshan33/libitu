# Mission planning integration smoke — 2026-10-20

`live-ipv4-03.json` passed one real DeepSeek planning request and the hosted Supabase persistence chain. The model returned three confirmable scenarios in 7.84 seconds; planning plus persistence/recovery took 10.87 seconds. Both primary targets were rated `high` in each generated scenario. These are the model's suitability suggestions, not validated learning scores.

The smoke uses FastAPI's `TestClient` with a synthetic identity dependency and an isolated random profile. Runtime reflection, presentation, skip, and exposure records are explicit fixtures. It does **not** verify Clerk login, browser interaction, Gemini Live, microphone/audio behavior, model teaching quality, or learning effects. It freezes a feedback job without invoking paid feedback assessment. No reliable learner turns are inserted, so an independently running feedback worker also takes the existing no-model insufficient-data path.

The successful chain verifies:

- Two primary targets and one opportunity target, persisted plan retrieval, and ordered target roles.
- Atomic session creation, metadata snapshots, stable session-item target IDs, and idempotent retry.
- New-session rejection after a source edit; existing session recovery after source edits and deletion.
- Frozen plan, reflected/presented attempt, skip history, and exposure in feedback input; private provider instructions excluded.
- Exact-owner cleanup, followed by zero-row reads for profiles, corpus, plans, sessions, and known session dependents. Independent Supabase MCP queries also confirmed all four smoke owners and the successful session's dependent rows were removed.

## Diagnosis and bounded retries

The initial run encountered intermittent TLS connection errors before corpus creation. Configuration was present; read requests could succeed, and certificate validation was not the issue. Local DNS returned proxy fake-IP addresses. The script's opt-in `--ipv4` changes only its Supabase HTTP transport, preserves TLS validation, and permits one connection retry before delivery. Application clients and persistent environment files are unchanged.

`live-ipv4-01.json` reached planning and returned a safe 503. `live-ipv4-02.json` captured an allowlisted provider trace: generation completed normally, but primary targets' `skip_when` values were not strings. The prompt had described a skip condition only for opportunity targets. The fix explicitly requires every primary and opportunity target to provide a nonempty string, supplies the complete aliased JSON Schema inside the bounded context, and retains strict rejection of invalid model output. `live-ipv4-03.json` then passed.

After the initial successful live run, the planner's disclosure validator was aligned with runtime: `communicative_function`, `trigger_question`, and `skip_when` must all exclude every selected expression. Offline regressions cover intent/skip disclosure and malformed primary skip conditions. This expansion initially had offline coverage only: the successful run had already cleaned its records and logged only scenario summaries, so its three implicit fields cannot be retrospectively checked. The script now records those safe generated fields, and the later reliability investigation below verifies the expanded validator with a real provider call.

Logs contain only synthetic identifiers, generated scenario summaries, provider token counts/timing, fixed error classifications, and validation locations. They contain no credentials, request headers, raw provider response, or real-user content.

## Follow-up reliability investigation

The later user-reported generic generation error cannot be retrospectively classified: the original implementation did not record a safe failure reason. The running API had started after the latest planner source change, so a stale process was not supported by the observed process timestamps.

`reliability-live-01.json` preserves a new, separate synthetic failure. DeepSeek completed normally in 6.87 seconds and the response passed schema validation, but the API subsequently returned 503. It did not emit the newly added generation-rejection diagnostic. This points toward persistence, but the run predates the persistence diagnostic and does **not** establish a specific network or SQL cause.

`reliability-fixture-summary.json` records a successful hosted persistence probe with a fixed synthetic provider and **zero paid model calls**. `reliability-live-02.json` then records a successful real DeepSeek call and the entire persistence/freeze chain: two valid scenarios, 6.10 seconds of provider time, and 9.98 seconds for planning plus persistence/recovery. This later run includes the strict checks on all three implicit fields (`communicative_function`, `trigger_question`, and `skip_when`), and retains typed synthetic candidate previews for offline inspection. The final persisted metadata is checked separately from the provider preview.

That diagnostic increment added correlated, allowlisted diagnostics for provider failures, schema/target/disclosure failures, and persistence failures. HTTP errors distinguish generation timeout, unavailable provider, unusable generated scenes, and a generated plan that could not be saved. Logs record fixed categories, safe schema locations, elapsed time, and fixed database error codes; they exclude owner IDs, selected expressions, raw model/user content, provider error bodies, and headers. It did not add an automatic model retry, fabricated scene fallback, schema migration, or environment change. The later content-recovery increment below supersedes that single-attempt behavior.

`reliability-cleanup.json` contains a separate exact-owner/session-ID REST recheck of all three follow-up synthetic owners and both created sessions' dependent rows; all were zero. A requested MCP recheck encountered a connector transport error, so this follow-up evidence is explicitly labeled REST rather than MCP. The original cleanup evidence remains separately labeled in `cleanup-mcp.json`.

Planner tests passed **52 tests**, including safe log correlation, exclusion of sensitive diagnostic inputs, error categories, strict contract rejection, and preservation of a single provider call on failure. This investigation verifies the successful synthetic path and improves diagnosis of any recurrence; it does not claim the historical user failure's root cause was proven.

## Bounded content recovery

The later `speaking-plan-v2` increment permits one corrective generation after
local content validation fails. Both attempts share a 45-second model budget.
The correction includes the failed rule and safe field locations while preserving
every target and role. Network, authentication, rate-limit, timeout, provider
envelope and storage errors do not trigger this retry. Complete target IDs and
roles may be reordered without another model call; invalid targets remain rejected.

`recovery-controlled-01.json` verifies the correction with one real DeepSeek call.
The first response was deliberately modified to contain an array instead of a
string at one target's `skip_when`. The second attempt used the actual corrective
prompt and returned two strictly valid candidates in 9.01 seconds of provider
time (9.03 seconds for both validation attempts). Both candidates were eligible
under the primary-fit rule. The record includes correlated retry/accepted
diagnostics and the generated candidate previews.

This is a controlled initial failure using the five ordinary English phrases
visible in the reported selection, synthetic target IDs and simplified metadata.
It does not reproduce the original failed response or establish a recovery rate.
No database records, user Missions, browser authentication or Gemini sessions
were created in this probe; candidate fit remains an AI estimate.

## Repeat

From the repository root, with the existing API `.env` configured and current migrations applied:

```sh
apps/api/.venv/bin/python apps/api/scripts/verify_speaking_planning.py \
  --run-live --ipv4 \
  --output /tmp/libitu-planning-smoke.json
```

The command makes one planning API request per run. The current planner permits
at most two paid model calls within a shared 45-second model budget when the first
response fails content validation; it does not automatically repeat provider or
storage failures. The script always attempts precise cleanup. A nonzero exit or
`cleanup_failed` event must be investigated before treating the run as passing.
