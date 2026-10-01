# Stage 2 asynchronous learner analysis

Updated 2026-09-23: `practice-comparison-v2` adds paired Sound/Rhythm/Melody UI, phone durations, boundary timing and experimental reference resemblance with coverage. See [the current measurement and score contract](STAGE_TWO_SOUND_COMPARISON.md). Old analyses remain readable without newly invented measurements.

Implemented 2026-09-22. This increment delivers private asynchronous recording analysis, independent content checks, word alignment, descriptive Rhythm/Melody comparison and saved results. It does not classify sound phenomena, sentence emphasis or pronunciation correctness.

## Learner flow

The signed-in learner enables **Analyze new recordings on the server** once. This purpose-specific choice is remembered for that account in this browser and can be disabled for future takes. It is separate from **Keep new recordings**, microphone permission, reference capture permission, training and human review. Training and human review remain off. Turning off future analysis does not cancel an already submitted task; each task has its own Cancel/Delete actions.

Record → immediate local replay → save attempt → upload temporary analysis input → queue → independent content check → MFA alignment → per-word measurements → saved result. Recording and sentence navigation do not wait for server computation. The selected historical take restores its analysis after navigation or refresh. No upload occurs without analysis or retention opt-in.

The page-level outbox freezes the sentence, reference ID, take ID, bytes and choices at recording start. It retries acknowledged steps idempotently and holds at most five pending recordings. Unacknowledged bytes remain page memory: closing/crashing before upload cannot be recovered. After the upload is acknowledged, processing is durable and does not require the browser to remain open. The UI polls the selected task every 2.5 seconds and stops when terminal or unmounted; this increment does not use push notifications.

## Evidence and display

1. Decode bounded browser WebM/Ogg/MP4 into mono 16 kHz PCM. Reject corrupt, oversized or out-of-range input; decoded duration must be 0.15–61 seconds, with the recorder limited to 60 seconds.
2. Silero VAD and Praat measure speech, energy and F0. Insufficient speech, low energy or clipping withhold alignment/comparison.
3. Local `faster-whisper==1.2.1`, CPU int8 `small.en`, independently recognizes audio. Expected text is never supplied as an ASR prompt. Case/punctuation/apostrophe normalization precedes exact token-sequence comparison; missing, extra, repeated or substituted words withhold alignment. Weak or empty recognition is uncertain. These thresholds are conservative defaults, not calibrated confidence or proof of what was spoken. The recognized text is shown so users can spot ASR mistakes.
4. Only a matching content check permits MFA 3.3.9 word/phone alignment against the immutable practice text. Successful forced alignment alone is not content verification. Both recordings pass the same independent gates before paired output.
5. Rhythm shows each word's own measured duration and a detected pause only when its VAD interval has an unambiguous adjacent-word boundary. Melody shows median relative pitch and five within-word bins, in semitones relative to that recording's sentence median. Missing pitch stays null; gaps are never bridged. Miniature curves use a fixed ±12-semitone viewport; numeric medians are not clipped. These are descriptive differences, not stress labels, “correct” contours or grades.

The optional file reference must belong to the same account/content and exact sentence text, ID and bounds. Its source grant must remain valid. Server analysis uses permitted reference files only; ordinary YouTube/local buffered references are not silently uploaded. Without a valid file reference, aligned learner measurements still appear and REF stays empty. Revoking/deleting the reference suppresses its comparison on subsequent reads. Source preparation and learner analysis use independent audio clocks and compatible pinned algorithms. Current-frame local displays remain distinct from selected historical-take results.

## Persistence and API

Migration: `supabase/migrations/20260922122457_practice_acoustic_analysis.sql`. `practice_analyses` has one immutable input per saved attempt, a server sentence/engine snapshot, consent receipt, status, lease, result and cleanup metadata. RLS is enabled with service-role-only access; FastAPI verifies Clerk ownership on every route. The private `practice-analysis-inputs` bucket accepts at most 8 MiB and the three recording containers. Object paths are server-derived attempt/hash identities.

All routes are under `/api/practice/attempts/{id}/analysis`:

| Operation | Behavior |
|---|---|
| POST | Register immutable hash/size/MIME, `practice-analysis-v1` consent and optional reference ID; 202 |
| PUT `/audio` | Verify ownership, size, hash and container; save private bytes and atomically queue |
| GET | Read status/result; null when never requested |
| POST `/retry` | Retry failed/cancelled work only while its original input remains available |
| POST `/cancel` | Fence current worker; retain temporary bytes within the retry window |
| DELETE | Scrub result/text snapshot, fence work and remove temporary bytes |

States: awaiting_upload → queued → processing → completed / needs_review / failed. Cancelled work may retry before expiry; deleted work is a tombstone and cannot be recreated. Completed means learner content/alignment passed, not that a paired reference or pronunciation grade exists. `needs_review` saves the recognition/quality outcome without a fabricated word comparison.

The worker claims with PostgreSQL `SKIP LOCKED`, heartbeats a lease and writes only with the current live lease token. Expired leases recover after crashes; transient reference/storage failures have bounded automatic retries. Deleting a parent attempt scrubs the analysis and fences any late result through a database trigger. Stale or cancelled workers cannot publish.

Temporary input is removed after a completed/review result, and otherwise expires after 24 hours. The worker reconciles expired/deleted input and rechecks previously cleaned rows to catch late uploads. Cleanup requires a running worker/storage service; 24 hours is an operational target, not guaranteed physical deletion during an outage. Result/transcript retention is until analysis/attempt deletion in this increment. Retained playback audio is a separate object governed by the separate retention choice; deleting one purpose does not delete the other. Backup schedules, account closure/export, tombstone expiry, production quotas and operational monitoring remain launch work.

## Runtime setup

Existing Supabase server credentials are reused; no paid speech API key is required. Models run on a CPU worker. API/worker must share model identity and source configuration; requests never download models.

```sh
cd apps/api
uv sync --extra dev --extra acoustics
uv run --extra acoustics python -m scripts.download_practice_asr --output /absolute/private/models/faster-whisper-small.en
# Set the printed PRACTICE_ASR_MODEL_PATH and PRACTICE_ASR_MODEL_SHA256 in the private environment.
# Also provision the existing ACOUSTIC_MFA_*, ACOUSTIC_SILERO_PATH and source settings.
pnpm worker:practice
```

The downloader pins the Hugging Face model revision. MFA dictionary/model and Silero hashes are independently verified; ASR checks all four model files. `pnpm dev` starts the practice worker, while `worker:acoustics` runs reference preparation separately. `deploy/practice-analysis.service` is an example process supervisor configuration, not a deployed production service. Bind worker concurrency to available CPU/RAM; ASR and MFA subprocesses are time-bounded. The first inference may be slower than later analysis and no latency SLA is established.

## Verification and remaining work

Unit/API tests exercise content mismatch and repetition, unreliable recognition, duration/pause/F0 mapping, immutable uploads, consent separation, owner isolation, deletion races, reference revocation and cleanup order. Real PostgreSQL tests cover unique claims, crash recovery, fencing and parent deletion. Desktop/mobile Chromium fixtures cover an actual browser microphone recording with mocked recognition results, asynchronous updates, word cards, switching sentences, refresh and deletion. These fixtures do not prove live Clerk OAuth or acoustic accuracy.

Actual model and hosted storage smoke passed on 2026-09-23: a licensed real utterance passed independent ASR and five-word MFA alignment; synthesized reference/learner audio passed the complete hosted pipeline, and an intentionally wrong expected sentence withheld alignment. Temporary objects and fixture rows were removed. Full verification and limits are recorded in `TASK.MD`. Independent human alignment labels, ASR error evaluation across accents, calibrated stress/sound detection, automatic proficiency scoring and recommendation models remain separate. No accuracy percentage is claimed by this implementation.


Opt-in hosted verification (synthetic test audio only):

```sh
cd apps/api
uv run --extra acoustics python -m scripts.verify_practice_analysis --run-live --audio /absolute/synthetic-speech.wav --text 'The exact synthetic speech text.'
```

This exercises real model inference and the private database/buckets, including a deliberately wrong expected sentence, source revocation, ownership, result recovery, temporary input cleanup and deletion. It retries transient service failures with immutable request identities and removes its own fixtures. Its Clerk identity/source grant are test fixtures. It does not claim hosted OAuth validation or speaker-quality accuracy.
