# Personal learning center

Implemented locally on 2026-10-02 from `design/prototypes/toneflow_profile_page.html`. The prototype supplies layout and interaction direction; its example identity, scores, recommendations and release promises are not product data.

## Delivered experience

- `/profile`: Clerk identity, separate practice statistics, the latest compatible four-dimension Mission report, five unassessed learning dimensions with keyboard-accessible explanations, activity range/metric controls with accessible data tables, next-step navigation, four shortcuts and recent practice.
- `/profile/history`: a simple history list reached from the profile shortcut and Recent practice → View all. All practice / Shadowing / Missions filters apply on the server before pagination. Rows group by the browser’s local calendar date, show local time, recorded duration or learner-turn count, and distinguish saved takes, in-progress, completed and ended-early Missions. Incremental loading merges date groups; errors retain loaded rows and offer retry. Filter changes reset pagination, abort pending reads and cannot mix late responses into another filter. Empty filters have a relevant practice action.
- Signed-out users see a sign-in invitation and retain the current destination through login/registration. No personal API fetch occurs before identity is ready. Account changes remount private views, cancel old requests and check token ownership before fetching.
- Existing account controls link to My learning. The corpus shortcut opens `/loadout#corpus`, the existing cross-source selection surface. It does not claim to add full corpus editing.
- Desktop uses a restrained two-column card layout; narrow screens stack the same sections. No chart dependency, additional model call or database migration is needed.

## Real data and counting

`GET /api/profile?timezone=<IANA>&range=4w|3m|all` returns overview, date buckets, resumable Mission, last practiced source, latest compatible Mission feedback and five recent history items. `GET /api/profile/history?kind=all|shadowing|speaking&offset=0&limit=20` returns a history page with report states. FastAPI derives ownership from verified Clerk identity; clients cannot select another user.

- Shadowing takes: non-deleted, saved attempts. One recording is one take, not a whole learning session.
- Missions practiced: sessions with at least one finalized, nonempty learner message. Prepared drafts can be resumed but do not increase practice counts or appear in history. AI, unavailable and interrupted messages do not count as learner turns.
- Shadowing recorded: sum of browser-reported saved recording durations. No listening, idle time or Mission wall-clock duration is added.
- Streak: consecutive practice dates in the browser's timezone, beginning today or yesterday. Merely visiting a page or saving corpus does not create a practice day.
- Corpus: currently saved items, structures and additions since Monday in the local calendar. Activity is reconstructed from surviving records, so deleting an item removes it from these counts. Unknown legacy/inline timestamps are `null`, not zero.
- Last 4 weeks means 28 local dates including today; last 3 months means 90 local dates; all time groups by calendar month. No missing activity is interpolated into a proficiency score.

The repository reads explicit owner-filtered projections of existing tables, handles lower-than-requested PostgREST page caps, bounds scans at 50,000 records per table and a 15-second scan budget (each shared HTTP request is also bounded). Invalid/incomplete reads fail as sanitized 503 responses rather than publishing partial totals. History order is deterministic within each read; new/deleted records can shift later offset pages, and the browser deduplicates appended IDs. Refresh retrieves the current view. Large-account SQL aggregation/cursor pagination remains a future optimization.

Only unconfigured inline development uses existing in-memory corpus/speaking stores. Practice storage has no fabricated in-memory success path. Configured persistence failures do not fall back to empty demo records. Successful profile responses and handled storage failures use `Cache-Control: private, no-store`.

## Continuation and assessment boundaries

The browser stores one ready YouTube source per account with title and update timestamp, using a versioned localStorage entry. It allows only a canonical internal reader URL and source/content/segment/sentence identifiers, stripping jobs, handoffs, credentials and unrelated query text. Guest-to-account and account-switch transitions do not silently adopt an already mounted source. Storage failure is nonblocking; this optional position is device-local.

The local destination restores the selected source and Shadow sentence without autoplay. If no device position exists, the page can link to the latest visible source associated with a saved take. Every source link includes the canonical YouTube URL, so older blueprints without their own source URL cannot fall back to the wrong video. Historical attempts lack segment identity, so their action is **View source**, not a promise to open the exact take. Removed/inaccessible sources and missing/invalid source URLs have no clickable action. Active Missions resume the conversation; completed Missions open Analytics with their current report state. Unversioned legacy records link to the read-only conversation because they lack a recoverable report.

Pronunciation, expression, pragmatics and intake are **Not assessed**. Writing is **Not available yet**. The decorative empty radar contains no score polygon. Explanations distinguish descriptive measurements and usage evidence from validated ability. Next-step suggestions only use resumable work or existing corpus, never fabricated weaknesses.

Persistent goals, validated general ability assessment and score trends, full corpus management, cross-device reader positions, permanent activity ledgers and production scale qualification are not delivered by this increment. Stage 5's model judgments still require independent human calibration.

## Stage 5 integration — 2026-10-02

The completed [Stage 5 implementation](STAGE_FIVE_CONTRACT.md) is integrated from its isolated worktree. A separate card shows task fit, language transfer, scenario fit and naturalness, with clickable explanations, AI-assessment/coverage labels and a full-report link. It reports one conversation, not overall English proficiency. The five general learning dimensions remain unassessed.

The server chooses the latest eligible report by the last reliable finalized learner contribution, not the assessment retry/update timestamp. Only completed, participated Missions with ready/partial reports, current rubric/analysis versions and four unique valid dimensions qualify. An older valid report may remain the latest summary while newer practice is unassessed. Real zero scores remain zero; missing scores remain null. Pending/failed reports do not publish retained scores. Missing-version legacy rows, nonnull older versions and malformed results have distinct unavailable reasons.

The profile joins only a minimal report projection through owner-filtered speaking sessions. It returns no frozen transcript, quotations, criteria, worker leases or provider metadata. Opening or refreshing the profile never requests/retries a report. Generation continues through Stage 5's end/request endpoints and feedback worker; opening an existing Analytics report is a read. Its migration was already applied and was not reapplied during integration.

## Verification

Backend unit/integration coverage checks identity, local-calendar/DST streaks, finalized-message participation, deletion, duration, pagination, unavailable storage and unknown dates. A read-only Supabase smoke with a nonexistent synthetic owner verified all three projections and relationship syntax without reading real-user records or writing data.

Initial profile delivery: root lint, build and all 1005 tests passed (617 API, 276 web, 112 extension). Six browser acceptance groups passed with desktop 1440 px and mobile 390 px coverage; eight screenshots were inspected. Checks include range/metric requests, keyboard dimensions, accessible tables, explicit unknown dates, pagination failures/retry, source URL recovery and unavailable sources, empty/error states, delayed-response account isolation, local continuation and signed-out return destinations. A live unauthenticated request returned 401. Browser identity/API fixtures validate UI behavior, not real Clerk OAuth or production database latency. No paid model or user media is invoked by profile verification.

## Corpus navigation update (2026-10-02)

The profile navigation and corpus shortcut now open `/corpus`. The first library increment supplies cross-source browsing, editing/deletion and Loadout handoff; see [the current contract](CORPUS_LIBRARY_IMPLEMENTATION.md). Earlier mentions of `/loadout#corpus` describe the original profile delivery.

Stage 5 integration verification: root lint and tests passed at the integration snapshot (755 API + 294 web + 112 extension = 1,161). Profile report checks cover canonical versions/dimensions, legacy routing, zero/null, ready/partial and pending states, practice-time ordering and read-only ownership. Desktop/mobile feedback cards, status/legacy history, delayed-account isolation and the original six profile groups passed. Analytics passed at 1440/768/390 px, and the continuous save → login/setup → conversation → report → save suggestion → new retry Mission journey passed. The journey uses the actual sign-in draft-save handshake before changing fixture identity. Screenshots were inspected. Real Supabase verified the minimal joined projection and existing migration; a separate read-only readiness check found no report backlog or queued work before launching the local feedback worker. No additional paid assessment was used for verification.

## Simple history refinement — 2026-10-02

The history-specific checks pass at 1440 px and 390 px: navigation from the personal page, local dates/times, merging date groups across pages, failed-load retry without losing rows, each practice filter, late-response isolation on rapid filter changes, completed-Mission report destinations, unavailable sources and filter-specific empty actions. Desktop/mobile screenshots were inspected. Backend tests cover filtering before pagination, unauthorized/invalid filters and owner boundaries; date-group tests cover timezone midnight and the repeated DST hour. These browser runs use synthetic identity and API records.

History refinement root verification: lint, production build and all 1,161 tests passed (755 API, 294 web, 112 extension). Lint reported one unrelated unused-variable warning in the concurrent corpus test changes. The focused history browser suite passed both widths, and the final mobile heading adjustment passed a fresh layout check. Additional full-profile/report regression attempts during this turn timed out in browser navigation or screenshot capture; those attempts are not counted as passing full suites.

Production build also passed in an isolated source snapshot after concurrent tasks invalidated the shared `.next-build` directory. All web app/feature and shared-package source files matched the working checkout at verification; dependencies were reused without altering source configuration. API/extension build steps had already passed. The local profile and API health endpoints returned 200, and the feedback worker process was running.
