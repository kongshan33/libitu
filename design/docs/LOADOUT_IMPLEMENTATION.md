# Speaking loadout

Status: implemented local increment, 2026-09-30. The connected Supabase migration is applied; real role-play remains planned.

## Accepted scope and rules

This increment delivers the Stage 3 loadout and a durable, recoverable session preparation page. Real role-play, turn history and feedback remain separate work. Loadout may be opened directly or from Stage 1/2; completing Shadow is not required.

- At least one saved corpus item is required.
- Up to three structures; chunks and idioms share up to five expression slots.
- Logic is optional. Selection order is preserved; duplicate corpus IDs are rejected.
- Scenario: `workplace` or `everyday`; goal: trimmed, nonblank, at most 500 characters.
- Difficulty: `guided`, `standard` (default), `challenging`.
- Feedback level: `light`, `balanced` (default), `detailed`.
- Static logic IDs: `persuasive_pitch`, `technical_troubleshoot`, `stakeholder_alignment`, `status_update`, `disagreement`, `onboarding`. Canonical template content is snapshotted by the server.
- Browser drafts use stable corpus keys, never blueprint candidate IDs. On login, guest draft ownership binds once to the active account. Existing account drafts are not silently overwritten; a guest draft can be explicitly adopted. Account-bound drafts never transfer on logout/account switch. Only confirmed account corpus server IDs can be submitted.
- Creating a session snapshots its selected language. Later source edits/deletions do not rewrite the session.

## API contract

`GET /api/speaking/options` is public static configuration (no model call):

```json
{
  "logic_templates": [{"id": "persuasive_pitch", "title": "Persuasive pitch", "description": "Make a case under pushback", "steps": ["Context", "Tension", "Proposal", "Defend"]}],
  "max_structures": 3,
  "max_expressions": 5,
  "min_items": 1
}
```

`POST /api/speaking/sessions` requires Clerk identity and accepts:

```json
{
  "client_id": "a stable UUID for this submission, retained across retries",
  "scenario_type": "workplace",
  "goal": "Agree on a revised project deadline",
  "difficulty": "standard",
  "feedback_level": "balanced",
  "logic_template_id": null,
  "corpus_item_ids": ["account-owned corpus UUID"]
}
```

`GET /api/speaking/sessions/{session_id}` is owner-scoped. Both return:

```json
{
  "id": "UUID", "user_id": "verified Clerk subject", "client_id": "UUID",
  "scenario_type": "workplace", "goal": "Agree on a revised project deadline",
  "difficulty": "standard", "feedback_level": "balanced",
  "logic_template": null, "status": "draft", "created_at": "ISO timestamp", "turn_count": 0,
  "items": [{"id": "snapshot UUID", "corpus_item_id": "UUID or null after deletion", "ordinal": 0, "kind": "chunk", "text": "to be fair", "meaning": null, "tags": [], "slots": {}, "source_title": null}]
}
```

Validation failures use 422, missing/unowned corpus or session uses 404, same client ID with a different payload uses 409, unavailable persistence uses 503. Error detail is a safe user-facing string. Creation is atomic and idempotent per owner/client ID; replays return the original snapshot even after corpus edits/deletions. No configured database request silently falls back to memory. Inline tests may use the deterministic in-memory adapter.

The session preparation page accurately says role-play is not available yet and displays the saved setup and language, without a fake chat or completion score.

## Verification

- Final root `pnpm lint`, `pnpm test`, and `pnpm build` passed: 494 API, 252 web and 112 extension tests (858 total; unchanged API/extension tasks reused caches).
- `apps/api/tests/test_speaking_loadout.py` covers schema/limits, identity, snapshot stability, safe persistence errors, repository transport and retry behavior.
- Migration `20260930114115_speaking_loadout_sessions.sql` is applied to the connected development project. `apps/api/tests/speaking_loadout.sql` passed in a rolled-back real database transaction, including service-only privileges and immutable snapshots.
- `apps/api/scripts/verify_speaking_loadout.py --run-live` passed against actual Supabase through FastAPI and the REST repository. It exercises concurrent idempotent create, retrieval, settings, idiom support, cross-owner rejection, source edit/deletion and repeated creation after source deletion. All synthetic profiles and dependent rows were removed and cleanup was rechecked. Clerk identity is substituted only inside this opt-in script; it does not verify real OAuth.
- Browser acceptance uses the real UI and media APIs with isolated identity/API fixtures. It covers 1440/768/390 widths, guest refresh/login/server-ID mapping, selection limits, filtering, preview, failed-create retry, session recovery, account switching and explicit guest-draft adoption. Stage 1 save → loadout → session and pending Shadow-save navigation pass; the latter verifies released playback/microphone resources while the save finishes.
- The final browser suite also verifies Space/Enter interaction and 200%-equivalent reflow at 720×525 (not native browser zoom), without horizontal overflow. Two tabs competing for real Web Locks preserve account drafts, continuous edits and uncertain-request UUIDs. Pending writes survive SPA links and history Back/Forward, expose exit protection, and cancel when the owning account changes.
- Security advisors report no new warnings/errors; the existing private-schema RLS-without-public-policy informational notice is unchanged.

## Ownership and runtime notes

- Corpus storage/API/hook code is shared under `features/corpus`, with compatibility exports for Stage 1 callers.
- `PracticePersistence` lives under the shared root layout. Its children stay mounted across authentication updates; account changes fence and dispose the old queues. Completed-take saves continue across client-side routes, while page refresh/exit still requires pending uploads to finish.
- Drafts use a versioned local envelope and Web Locks where available. All mutations share the lock. Input renders optimistically; starting a mission or signing in waits for durable storage. Queued writes survive SPA unmount but cancel on an actual account change, with exit protection until pending writes finish. A prepared submission persists its complete request and UUID before the API call; an uncertain response can replay the same request even if the source corpus subsequently changes.
- No new model call, microphone permission, production deployment, real Clerk/OAuth verification, full corpus editing UI or real role-play is included.
