# Shadow login and durable practice

Implemented 2026-09-19 for the local web/API setup with the connected Supabase project.

## Learner flow

Stage 1 and segment selection remain available anonymously. Clicking **Start shadowing** preserves the selected content, job, segment, first sentence, learner settings and URL fragment, then opens sign-in if needed. Login and registration use that same return URL. Direct Stage 2 links and refresh show the same sign-in gate; the recording workspace does not mount until Clerk has loaded a signed-in identity. Canceling login leaves a retry action and a route back to Stage 1. Microphone access still requires an explicit Record click after login. Account changes remount the practice workspace.

Each completed microphone take automatically creates a practice record. A checkbox, off by default, allows **new** recordings to be uploaded for private later playback. The choice, playback rate and text-visibility condition are captured when Record is clicked, not when an asynchronous save finishes. Recording retention uses consent version `recording-retention-v1`: keep the audio until the learner deletes it; no model training or human review. The original retention increment did not include acoustic analysis. The [2026-09-22 analysis increment](STAGE_TWO_PRACTICE_ANALYSIS.md) adds a separate analysis choice, temporary upload and saved descriptive results; pronunciation assessment remains pending.

History beneath the recorder lists this account's saved takes for the selected sentence, including duration, playback rate, text condition and server save time. Learners can load/play retained audio, delete only audio while keeping the record, delete the whole record, and load older pages. These are browser-reported task conditions, not validated speaking scores. Source sentence text and bounds come from the server blueprint. Local Sound/Rhythm/Melody analysis still follows its existing lifetime; its browser measurements are not persisted; separately computed server measurements now have their own history and deletion controls.

## Save and failure semantics

- A page-level account-bound outbox takes ownership of a retained Blob before sentence navigation revokes the recorder's object URL. Saves continue across sentence, segment and Stage 1 navigation in the same page.
- A take has one client UUID. The API derives a per-account attempt UUID and fingerprints its immutable request. Retrying an uncertain request cannot duplicate an attempt or change its source or consent.
- Saving the practice record and saving the optional audio are separate acknowledgements. Until both requested operations finish, the page shows saving or retry; it does not claim a completed save.
- At most five pending takes are kept in memory. New recording pauses at that limit. Retained audio has an 8 MiB upload limit and allows browser WebM, Ogg or MP4 containers. The recorder's existing 60-second limit remains.
- The outbox is **page memory**, not an offline database. Failed saves can be retried while the page is open; refresh/close warns if pending. Signing out or switching accounts releases that account's in-page pending data. Only acknowledged records/recordings survive those actions. Persistent offline outboxes and recovery after browser/process crashes remain planned.
- Missing database configuration or a storage outage returns a retryable 503, never a fake in-memory success. The account can still make a temporary local take; its unsaved state stays visible.

## API

All endpoints require a Clerk identity verified by FastAPI. No owner ID, source text, object path, score or training consent is accepted from the client.

| Method | Endpoint | Result |
|---|---|---|
| POST | `/api/practice/attempts` | Idempotent source-validated practice record, with optional declared audio hash/size/MIME and retention consent |
| GET | `/api/practice/attempts?content_id=…&sentence_id=…&offset=…&limit=…` | Owner-scoped history and next offset; sentence filter optional, max 100 per page |
| PUT | `/api/practice/attempts/{id}/recording` | Bounded raw audio upload matching the declared hash, length and container; pending → ready |
| GET | `/api/practice/attempts/{id}/recording` | Owner-checked private audio bytes, `Cache-Control: private, no-store` |
| DELETE | `/api/practice/attempts/{id}/recording` | Remove audio, retain practice history |
| DELETE | `/api/practice/attempts/{id}` | Remove history and audio; retain a retry-prevention tombstone |

`shadow_attempts` is RLS-enabled and accessible only to the server service role. Browser roles have no table grants. FastAPI includes explicit owner filters on all reads and writes. The `shadow-recordings` bucket is private, restricted to 8 MiB and the three audio MIME types, with no browser access policies. Secrets stay server-side. Playback uses the authenticated API rather than a public object URL.

Uploads are immutable at an attempt/hash path. Deletion first marks a tombstone, then removes the object. Conditional upload finalization and a post-upload tombstone check make deletion win over concurrent uploads. A failed storage removal returns 503 and the same delete endpoint can be retried. The original object identifier stays available for cleanup. Full record deletion clears its sentence-text snapshot; minimal ownership/source/request metadata remains to prevent late retries from resurrecting deleted data. Scheduled reconciliation after a worker crash, tombstone expiry, backup deletion, export and account closure are production follow-ups, not implemented guarantees. Container signatures and hash checks do not establish decoded speech duration or pronunciation quality.

## Verification

- API tests cover authentication, ownership on every recording route, private source denial, sentence validation, request conflicts, size/hash/container limits, retryable failures, pagination and deletion/upload races.
- Web tests cover account-switch rejection, immutable retries, no upload without consent, bounded pending data and recorder lifetime.
- Opt-in live smoke: from `apps/api`, run `.venv/bin/python scripts/verify_practice_storage.py --run-live`. It synthesizes sound using ffmpeg, exercises the real database/private bucket through API routes with test identities, and removes only its own fixtures. It does not test real Clerk credentials or OAuth.
- `apps/web/tests/stage-two-persistence.browser.mjs` exercises desktop/mobile with a test-only Clerk resource emitter, mocked API/player and Chromium's synthetic microphone. It verifies login return parameters, the anonymous gate, optional audio saving, retry across sentences, history after reload, playback coordination and deletion. Hosted login completion remains a separate real-account verification.

The migration is `supabase/migrations/20260919100220_shadow_practice_persistence.sql`, aligned with the applied hosted migration version. The live storage smoke passed against the configured project; synthetic records, objects and profile were removed. Permitted file-reference processing and asynchronous descriptive learner analysis are now implemented separately; validated pronunciation assessment remains planned.
