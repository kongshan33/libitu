# Corpus library — first usable increment

Implemented locally on 2026-10-02. Route: `/corpus`.

## Delivered behavior

- Shared cross-source collection through `useSavedCorpus`, with existing browser-local guest saves, account-bound import outboxes and authenticated FastAPI persistence.
- Search over expression, meaning, note, tags and source title. Multi-select type/tag/level/scenario/register/source facets use OR within a dimension and AND between dimensions. Defaults include all difficulties and unknown metadata.
- Real total/type/source counts, current-result count, recency/learning-value/transferability/alphabetical sorting, grid/list layouts and a mobile filter panel. Unknown creation dates sort after known dates with stable legacy order. Unknown scores are not zero; high value includes only scores at least 4/5.
- Selection uses the stable saved key, survives filters/sorting, and reports selected items hidden by filters. Account changes remount the management workspace and clear open dialogs and selection.
- Card bodies open native modal details; checkboxes and edit buttons are independent. Full original analysis reuses the Stage 1 explanation/syntax panels. Cached detail is reused. Legacy items with stored source text can hydrate their original analysis through the existing API. Items lacking evidence remain browsable/editable without inventing source context or analysis.
- Edit expression/template, meaning, usage note, functional tags and structure slots. Guest edits survive reload; account edits call the existing owner-scoped PATCH and require a confirmed cloud ID. The saved identity, original evidence/analysis and creation date remain unchanged. Analysis is explicitly labelled as original; editing an expression does not silently reanalyze it. Historical speaking snapshots remain unchanged.
- Delete requires confirmation inside the detail modal; failed writes/deletes remain visible and retryable. Deleting an item does not delete its source or historical mission snapshots.
- Add selected items to Loadout under the same browser lock as ordinary draft writes. Read current settings inside the lock, deduplicate keys, preserve scenario/goal/difficulty/feedback/logic and guest/account adoption semantics. Reject missing items, a pending idempotent mission start, more than 3 structures or more than 5 shared chunk/idiom expressions. Never truncate or automatically replace an existing draft. Navigate only after the draft write succeeds.
- Navigation from Stage 1, Loadout and My learning points to the new page.

## Contracts and storage

`GET /api/corpus` now exposes existing database `created_at` and `updated_at` fields; inline records receive server timestamps, and new guest records receive local creation timestamps. Historical guest records retain unknown dates. PATCH rejects null/blank expression text, null tags/slots and expressions over 2,000 characters. No schema migration, new table, authentication provider or AI provider integration is required.

`CorpusStorage.update` preserves the key used by imports and Loadout. Legacy cloud items without an import key derive identity from their immutable original snapshot, or from the server ID when no snapshot exists; editing text never regenerates that identity. Cloud edit errors keep the open editor draft rather than putting edits into the import-only outbox. A late response after an account change cannot publish into the new account. The original source locator and analysis are not included in the management PATCH.

The first version loads the existing complete collection and filters locally. It does not promise arbitrary-library scalability. Future server-side pagination should separate list summaries from full analysis payloads. Concurrent edits to the same cloud item currently use the existing last-write-wins contract; field-level conflict resolution and an offline edit queue are not delivered.

## Deliberately separate

Decks, corpus usage aggregation, “unused” classification, spaced repetition/review scheduling, manual creation, metadata/quality-score editing and server-side search/pagination are not delivered here. Existing Stage 1 save actions remain the entry into the collection. No illustrative prototype usage counts or fake review states are shown.

## Verification

- Root lint, production build (including `/corpus`), and test suites passed. After the final legacy-identity fix, all 18 focused corpus/storage regressions and the production build passed again.
- Unit regressions cover AND/OR filtering, unknown metadata, ordering, stable identity/source preservation after edit/reload, failed edits, delayed account responses, atomic Loadout merge, settings retention, deduplication, overflow rejection and guest/account adoption.
- Backend regressions cover source/identity/timestamp preservation, idempotent re-import after edits, owner denial and invalid PATCH fields.
- A read-only smoke query against configured Supabase returned an empty owner-scoped collection for a nonexistent synthetic owner; no data was changed.
- Browser acceptance passed at 1440×1000 and 390×844: search/selection isolation, hidden selections, cached explanation/syntax, edit/reload, list reflow, type filtering, Loadout handoff, signed-in PATCH failure/retry/reload, confirmed delete/reload and account-switch clearing. Desktop/mobile library and detail screenshots were visually inspected.
- Browser tests use synthetic Clerk identities and intercepted API responses, not real OAuth or production load qualification. No paid analysis request is made by the browser fixture.
