# Libitu API

FastAPI backend workspace for content resolution, processing jobs, blueprints, corpus, and speaking sessions.

Current state:

- API contracts mirror `design/docs/MVP_SYSTEM_DESIGN.md`.
- `PROCESSING_MODE=queue` persists content and jobs in Supabase, dispatches work through Upstash, and extracts blueprints with DeepSeek.
- `PROCESSING_MODE=inline` keeps the deterministic local path for tests and dependency-free development.
- The backend owns `ANALYSIS_VERSION`; clients only submit a `content_id`.
- `/health/ready` verifies that the queue worker heartbeat is live and loaded with the API's current analysis version and DeepSeek model.

Run locally:

```bash
pnpm --filter @libitu/api dev
```

This starts both the API server and queue worker. To run them separately, use
`dev:server` and `worker` in two terminals.

Python dependencies are declared in `pyproject.toml`.

## Restore old-cache word timing

`POST /api/content/{content_id}/caption-timing` accepts `{ "caption_track": ... }`
and the optional `learner_level` query used by blueprint reads. A successful typed
response is `{ "status": "updated" | "unchanged", "blueprint": Blueprint }`.
This is an explicit timing-only action, not content resolve, a processing job,
Retry analysis or an ASR request. It runs no semantic model.

The existing English YouTube content and current completed blueprint must match
the submitted video's normalized full spoken sequence, including repeated words
and the existing filler-cleanup policy. Truncated or different captions fail
closed. JSON3 alone is not a timing capability: at least one exact-token word
interval must pass the same maximum two-second estimate gate as highlighting.
Only a strict superset of currently usable token coverage replaces existing
timing; alternate timestamps or less coverage do not overwrite valid evidence.

Recovery preserves the original transcript string, public content metadata,
stored semantic blueprint, jobs and personal corpus. It preflights an uncached
derived sentence view, updates only the existing private source-payload RPC,
then publishes the source to Redis and process memory. Normal blueprint reads
reuse the caption fingerprint and bounded derived-view cache. Old active Stage 2
sentence IDs remain usable by Sound only when they resolve to an exact original
or old derived sentence in the same verified semantic source; arbitrary client
text or decoded sentence coordinates are never accepted.

Errors have `detail: { "code": ..., "message": ... }`: 404
`content_not_found`; 409 `caption_source_mismatch`, `caption_text_mismatch`,
`caption_blueprint_unavailable` or `caption_timing_unavailable`; 503
`caption_processing_unavailable` or `caption_storage_unavailable`. Invalid input
uses standard 422 validation. Storage timeout/publication failure is not reported
as success: the private write may already have committed. Retrying reads durable
state first, is idempotent, and repairs Redis without reanalysis. A coarse Redis
record can fall back to a durable rich source on subsequent blueprint reads.
Queue-mode recovery requires durable storage; only unconfigured inline local
development uses memory. Locks are bounded and process-local; the existing
private RPC does not provide cross-instance compare-and-swap, and Redis/Postgres
publication is not a distributed transaction. No migration or live database
write is required to run the regression tests.

## Stage 2 Sound rule candidates

`GET /api/blueprints/{content_id}/sentences/{sentence_id}/sound` reads the same
server sentence view as the blueprint endpoint and returns versioned text-only
US English candidates. It takes no submitted transcript or media and invokes no
paid provider. The full pinned CMU dictionary and original license are vendored
under `app/data/cmudict`; deploy that directory with the API. No extra API key,
package installation, model download, or database migration is required.

The first request verifies and loads the dictionary once. A process-local LRU
retains at most 128 responses, keyed by rule version, dictionary version, content,
sentence ID and text hash. Responses keep at most 300 tokens, four pronunciations
per token and 80 candidates, with explicit truncation warnings. Sentences over
6000 characters return 422 rather than silently changing source text. Unknown
content/sentence returns 404; missing or corrupted dictionary data returns 503.

The baseline proposes consonant-to-vowel linking, conditional whitelisted weak
forms, internal stressed-vowel + T/D + unstressed-vowel tapping, pronoun /j/
coalescence, and optional T/D cluster elision. Multiple dictionary pronunciations
make a token ambiguous and abstain from phone rules; unknown words and numbers
receive no guessed IPA. Weak forms remain conditional on grammatical use and
absence of emphasis, neither of which the dictionary proves. `can` is excluded.

Token offsets use UTF-16 code units for browser `String.slice`; candidate token
ranges have exclusive ends. IPA is a broad segment-symbol rendering without
syllabification/stress marks; numbered ARPABET vowels retain dictionary lexical
stress. Every result is a `candidate`, never an acoustic detection, accuracy
claim, pronunciation requirement or learner score. Multi-letter all-uppercase
forms (such as SAT or IT) and uppercase A remain unknown because the baseline has
no validated acronym or letter-name policy; ordinary single-letter I is retained.
M3 measurements remain
independent. See `app/data/cmudict/README.md` for the upstream source and checksum.

## Shared Stage 1 / Stage 2 sentences

`uv sync --extra dev` installs pinned CPU `spacy==3.8.16` and the official
`en_core_web_sm==3.8.0` model wheel. The worker preloads the model once; GPU and
runtime model downloads are unnecessary. Source punctuation is preserved, and
local syntax evidence conservatively joins incomplete model candidates. Inference
windows never force a long sentence into smaller practice units.

Rows carry a separate `segmentation_version`, source token range, stable ID,
boundary provenance, and approximate caption times. Missing/failed syntax models
fall back to source/punctuation candidates. An unfinished source tail remains
unresolved instead of receiving an invented sentence ending. Existing cached
blueprints receive a bounded local derived view without new DeepSeek analysis or
database writes. See `design/docs/SENTENCE_SEGMENTATION.md` at the repository root.

Run the offline timing benchmark from `apps/api`:

```bash
uv run python scripts/benchmark_sentences.py --transcript /path/to/captions.txt --runs 3
```

The benchmark reports first-preview latency, complete formatting, cold model
loading, and process memory. Synthetic timing inputs are not boundary-quality
evaluations. Ordinary unit tests use injected syntax decisions and do not require
model inference or paid providers.

## Local subtitle punctuation

English subtitle punctuation and casing use the sherpa-onnx online INT8 model. Install
the ignored local model assets once from the API workspace:

```bash
pnpm --filter @libitu/api setup:punctuation
```

The default files live under `apps/api/.models/`. Deployments may instead set
`PUNCTUATION_MODEL_PATH` and `PUNCTUATION_BPE_VOCAB_PATH`. When the model is absent or
its output changes source words, processing preserves the finalized prefix and
uses existing source marks for the remaining candidates. Unpunctuated text can
remain an unresolved span; no length-based sentence cuts are introduced.
`sherpa-onnx-core` is declared explicitly because uv can otherwise omit its shared ONNX
runtime dependency when resolving sherpa-onnx from source metadata on macOS.
## Shadow practice persistence

Authenticated `/api/practice/attempts` routes now save private practice records, optional consented recordings and history. Apply `supabase/migrations/20260919100220_shadow_practice_persistence.sql` and configure the existing server-only Supabase URL/secret. The private `shadow-recordings` bucket is restricted to 8 MiB WebM/Ogg/MP4 audio. No additional provider or browser storage secret is needed. Missing configuration returns 503 instead of temporary in-memory success.

Contract, consent, retry and deletion limits: [Stage 2 persistence](../../design/docs/STAGE_TWO_PERSISTENCE.md). From `apps/api`, `.venv/bin/python scripts/verify_practice_storage.py --run-live` verifies the configured database and storage with synthesized sound and removes its own test fixtures. It requires ffmpeg and does not verify a real Clerk login.

## Private reference analysis

See [server reference setup and API](../../design/docs/STAGE_TWO_SERVER_REFERENCE.md). `uv sync --extra acoustics` installs pinned CPU measurement dependencies. Run `pnpm worker:acoustics` as a separate process with server-owned source grants and explicit MFA model/hash configuration. No arbitrary YouTube media fetch or paid acoustic API is used. The worker's PostgreSQL leases, results and private WAV assets survive API restarts; learner cloud comparison is not yet implemented.

## Asynchronous Shadow recording analysis

See [the implementation and setup](../../design/docs/STAGE_TWO_PRACTICE_ANALYSIS.md). Provision the pinned ASR model with `uv run --extra acoustics python -m scripts.download_practice_asr --output /absolute/model/path`, configure its printed path/hash and the existing MFA/Silero models, then run `pnpm worker:practice`. This uses existing Supabase credentials and local CPU inference; no paid speech API key is needed. `pnpm dev` includes the learner worker. The systemd example in `deploy/practice-analysis.service` still requires production provisioning.

### Browser-captured reference input (2026-09-29)

`POST /api/references/captures` registers a current sentence snapshot, WAV hash/size,
original source bounds and `reference-analysis-v1` consent. This adapter accepts
browser capture without a registered file-source manifest entry. Upload through
`PUT /api/references/{id}/audio`; recover a matching saved capture using
`GET /api/references/captures/latest?content_id=…&segment_id=…&sentence_id=…`.
The existing owner-checked status, audio, retry and delete routes apply.

Run both `worker:acoustics` and `worker:practice` with the same ASR/MFA model
identities. The reference worker verifies spoken words before alignment and caches
sentence-relative prosody. The practice worker waits for pending references,
then reuses compatible cached results. `pnpm dev` now starts both workers.
Apply `20260929101849_browser_reference_analysis.sql` before running this flow.
See [the complete contract](../../design/docs/STAGE_TWO_BROWSER_REFERENCE_SERVER.md).
