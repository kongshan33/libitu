# Stage 2 private reference processing

Implemented 2026-09-22 for the local web/API and connected Supabase project, following the [confirmed review](STAGE_TWO_ACOUSTIC_PIPELINE_REVIEW.md). This delivers reference-file preparation and measurements. It does not deliver phenomenon detection or pronunciation scores. The subsequent [learner analysis increment](STAGE_TWO_PRACTICE_ANALYSIS.md) adds content-gated word alignment and saved descriptive comparisons.

## Learner behavior

On entering a selected Shadow segment, the signed-in app checks server source capability. When an operator has registered an allowed file for this account/content/range, preparation starts automatically. It never starts playback. The current sentence becomes playable as soon as normalized audio is ready, and the browser prefetches the next sentence. Sentence and segment playback use private file audio, with the existing Play, Loop, Speed and Record controls. Switching sentence/scope pauses audio; recording, history playback and native video playback interrupt it. No Chrome reference-capture grant or preparatory 1× playback is required on this file path.

Without a registered file source, the existing local-buffer/YouTube flow remains available. This implementation does not download arbitrary YouTube media, infer a license from a URL, scrape media URLs, or make every YouTube segment eligible for server analysis. A source configured as an upload grant accepts only the exact bytes registered by the operator; it is an alternate ingestion path, not the normal learner acquisition flow.

Three layers retain separate roles:

- Sound: existing canonical/rule suggestions plus measured word durations when alignment succeeds. Alignment does not independently verify spoken content or prove a sound phenomenon.
- Rhythm: dictionary syllable-stress dots above the sentence text; detected pauses of at least 200 ms appear as vertical bars and durations between phrases when MFA word positions support the boundary. Unplaceable gaps retain sentence-relative times. Local caption anchors are marked approximate; learner pauses remain recording-relative without guessed word anchors. Reference speech intervals/durations and learner measurements remain separately identified.
- Melody: reference F0 curve with missing frames left as gaps; local learner pitch remains separately identified.

Server and browser algorithm versions differ. No new cross-version similarity score, actual IPA, observed sentence-stress label or “detected” phenomenon is generated. Dictionary dots describe lexical syllable stress only, with unknown patterns left blank. Partial alignment failure can coexist with usable audio and measurements.

## Source registration and runtime

The server-owned JSON manifest is configured by `ACOUSTIC_SOURCES_PATH`. It must be outside public assets and writable only by operators. Entries bind an immutable source ID, content UUID, explicit allowed Clerk account IDs, rights reference, expiry, source-file hash/size and video timeline coverage. Local file paths must be absolute and visible to the acoustic worker. Upload entries have no path and are restricted to a registered exact segment/hash. No client API can add grants. Editing/revoking a grant changes its fingerprint or makes existing assets inaccessible; operators should revoke a grant before replacing a file.

Generate a manifest entry from a file that the operator has already established may be processed:

```sh
cd apps/api
uv run python -m scripts.reference_source /absolute/path/allowed.wav \
  --id permitted-source-v1 --content-id CONTENT_UUID --owner CLERK_USER_ID \
  --rights-reference 'Operator record of permitted processing' --origin-ms 0
```

Redirect this output to an ignored/private manifest and configure its absolute path. Supply `--duration-ms` for non-WAV containers. `--upload` creates an exact-byte upload grant instead of a server file grant. Registration records the operator's decision; it cannot independently establish copyright or platform permission. Sources containing multiple tracks, overlapping speakers or music require appropriate quality review; no universal accuracy is claimed.

API and CPU worker share the same manifest, Supabase settings and acoustic model configuration. Start the worker separately:

```sh
cd apps/api
uv sync --extra dev --extra acoustics
uv run --extra acoustics python -m app.workers.acoustic_worker
# Bounded operational check:
uv run --extra acoustics python -m app.workers.acoustic_worker --once
```

Pinned worker extras are NumPy 2.2.6, praat-parselmouth 0.4.7 and onnxruntime 1.22.1. API routers import no heavy acoustic runtime. MFA runs as a subprocess in a separate Python 3.11 environment with MFA 3.3.9. Configure:

```text
ACOUSTIC_SOURCES_PATH=/absolute/private/source-grants.json
ACOUSTIC_MFA_BINARY=/absolute/mfa-environment/bin/mfa
ACOUSTIC_MFA_DICTIONARY=/absolute/models/compatible.dict
ACOUSTIC_MFA_MODEL=/absolute/models/acoustic-model.zip
ACOUSTIC_MFA_DICTIONARY_SHA256=<verified file digest>
ACOUSTIC_MFA_MODEL_SHA256=<verified file digest>
ACOUSTIC_SILERO_PATH=/absolute/models/silero_vad_v5.onnx
ACOUSTIC_LEASE_SECONDS=120
ACOUSTIC_POLL_SECONDS=3
```

The tested model URLs and hashes are recorded in `apps/api/deploy/acoustic-models.json`; provision them explicitly with `python -m scripts.download_acoustic_models`. MFA models/dictionaries are loaded from explicit local files, validated against configured hashes and recorded in the immutable engine identity. No request downloads models. Missing MFA configuration produces `unavailable`, not equally divided fake phoneme intervals. A changed engine configuration creates a new analysis identity. Silero uses the existing vendored V5 model hash; in the repository its default path resolves to the web acoustic assets. Standalone deployments must explicitly provision that file and FFmpeg.

No Whisper, DeepSeek or other commercial acoustic API key is needed. Existing server Supabase credentials and Clerk identity verification are reused. Hosting, storage and compute still have costs. This change does not choose or deploy a production worker host.

## Contract and timing

The server resolves segment and sentence text, identity and bounds from the current blueprint. It snapshots those values rather than trusting client text, account IDs or caption hints. The selected range is bounded to ten minutes, normalized to 16 kHz mono PCM WAV, and checked against decoded duration. Uploads are limited to 32 MiB and must match the source grant hash and byte count. Input bytes are temporary; the private object is normalized WAV.

Video times remain absolute milliseconds. Measurement and alignment times are seconds relative to the selected segment. Each full sentence is cropped once without implicit padding; MFA output receives the actual sampled crop origin exactly once. Repeated words must match the expected token sequence in order. OOV/unmatched, malformed or out-of-range results fail explicitly. MFA uses its model/dictionary labels; no unverified phone-set-to-IPA conversion is performed.

VAD and frame features are computed once per segment. Praat autocorrelation F0 uses 75–500 Hz and a 10 ms step. RMS energy uses a local 40 ms window. Silero uses state plus 64-sample context, 512-sample frames, 0.5/0.35 hysteresis, 250 ms minimum speech and 200 ms minimum silence. These are versioned measurement settings, not learned pronunciation thresholds. Low speech, low energy or clipping prevents production alignment; low pitch coverage is reported separately.

The reference record binds owner, source fingerprint, source hash, blueprint/sentence snapshot and engine identity. It stores normalized audio hash and versioned per-sentence results. Rule candidates remain in the existing Sound service. There are no detector probabilities, user scores or `actual_ipa` fields in this result contract.

## Storage and job lifecycle

`acoustic_references` combines an immutable reference asset identity and its durable work item. This avoids a database/message-queue dual-write gap. An independent worker polls PostgreSQL and atomically claims work with `FOR UPDATE SKIP LOCKED`. Supabase REST RPC functions use security invoker, explicit service-role execution grants, and no browser grants. The table has RLS; the `reference-audio` bucket is private and has no browser access policies.

States: `awaiting_upload → queued → processing → completed | partially_completed | failed`; explicit cancellation and deletion are separate states. Worker claims carry unique lease tokens, expire and heartbeat. Every worker write checks the token, state and expiry. Expired claims are recoverable, with at most three attempts before failure. Storage failures get bounded retry delays. Cancellation fences writes immediately; an in-flight bounded decoder/alignment subprocess may finish before the next worker checkpoint. Explicit Retry can resume cancelled/failed/partial work; successful sentence results for the same input identity are reused.

Partial results commit before SSE notification. The authenticated stream reads durable state; interruption falls back to status polling. A refresh repeats the idempotent preparation request and retrieves the same non-expired result. No long-lived cache contains a signed URL. Playback uses the authenticated API and private browser Blob URLs.

References expire after the earlier of 30 days or grant expiry. Unfinished uploads are abandoned after one day. The worker reconciles expired assets and deletion tombstones, removes objects, and clears text/results. Deleted objects are rechecked periodically to catch a late upload followed by a process crash. Tombstones retain minimal source/ownership identity and block accidental resurrection by repeated preparation. A renewed source grant is needed after a deleted/expired identity. This does not implement a complete account-closure/export or backup-deletion policy.

Source revocation blocks new authenticated reads and worker progress; already downloaded browser bytes cannot be retroactively recalled. All account changes/remounts release in-page Blob URLs. User recording retention, practice history and learner audio permissions are unchanged.

## API

All routes below require a verified Clerk identity. No `user_id`, storage path or arbitrary source URL is accepted.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/references/capability?content_id=…&segment_id=…` | Check allowed input adapter for the shared segment |
| POST | `/api/references` | Idempotently prepare `{content_id, segment_id}`, return 202 and reference/job ID |
| PUT | `/api/references/{id}/audio` | Exact-byte registered upload; decode and finalize before queuing |
| GET | `/api/references/{id}` | Owner-scoped persisted status and sentence measurements |
| GET | `/api/references/{id}/events` | Authenticated SSE updates from committed state |
| GET | `/api/references/{id}/audio?sentence_id=…` | Private sentence WAV; omit sentence for the selected segment |
| POST | `/api/references/{id}/cancel` | Cancel queued/running work and fence old worker writes |
| POST | `/api/references/{id}/retry` | Explicit bounded retry |
| DELETE | `/api/references/{id}` | Tombstone first, clear derived text/results, remove audio |

No success-shaped `/compare` stub is added. User cloud processing and descriptive word comparison are now implemented through the [attempt analysis endpoints](STAGE_TWO_PRACTICE_ANALYSIS.md). Independently validated pronunciation assessment remains a later delivery.

## Verification and limits

- Unit/API tests cover account isolation, source revocation, immutable input identity, upload hash and decoded duration, delete/upload races, expired assets, repeated-word alignment validation, nonzero time origins, missing models, partial results and SSE authorization.
- Real FFmpeg, Parselmouth and Silero execution validates decoding, tone F0 and finite measurements. All 16 existing licensed development clips produced speech intervals and valid F0 frames in a real offline run. These checks do not validate sound-phenomenon accuracy; human annotations remain pending.
- `tests/reference_queue.sql` exercises real PostgreSQL claims, lease recovery, stale writes, cancellation, retry limits, deletion and privilege boundaries in a rollback transaction on a disposable migrated database.
- `uv run --extra acoustics python -m scripts.verify_reference_storage --run-live` uses synthetic audio against the connected database/bucket, verifies persistence/replay/deletion and removes only its own fixtures. It does not verify a real Clerk/OAuth session.
- `tests/server-reference.browser.mjs` covers desktop/mobile file playback, sentence switching, layers, refresh, deletion and no capture prompt using mocked source/auth responses and real browser audio playback. The existing persistence browser check verifies local fallback remains usable.
- Two licensed CMU ARCTIC development clips also passed real MFA 3.3.9 execution using the pinned English US ARPA v3.0.0 pair: 11 words/38 phones and 5 words/15 phones. Both used a 120-second video origin and returned valid segment-relative intervals. This is toolchain/contract verification, not manually measured alignment accuracy.
- Offline real speech can be run with `python -m scripts.analyze_reference --audio … --sentences … --origin-ms … --output …`; it uses the same adapters and reports exact engine identity. Human-gold accuracy and eight-phenomenon detection remain unverified.

The migration is `supabase/migrations/20260922071740_acoustic_reference_pipeline.sql`, matching its applied hosted version. No user recordings or third-party YouTube media were uploaded for the live storage check.

Verification result on 2026-09-22: root `pnpm lint`, `pnpm test` and `pnpm build` passed (408 API + 187 web + 112 extension tests). Desktop/mobile file-reference and existing persistence browser checks passed, including SSE fallback and keeping the file playback clock independent of the paused video. The real worker completed a database claim/reconciliation pass; synthetic live fixtures were removed. Local MFA/model paths and hashes are configured in the ignored API environment; no permitted product source manifest or production worker host was invented.
