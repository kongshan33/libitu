# Complete the next Libitu milestone

```yaml
meta:
  contentType: How-to
  status: active
  updated: 2026-10-12
```

This is the living task queue for coding agents. Work from the first unblocked milestone. Update checkboxes, verification notes, and affected decisions in the same change.

## Reference sentence identity — 2026-10-12

- [x] Reproduce saved-capture recovery returning `Sentence not found` when a raw cached caption sentence ID differs from the public derived blueprint view; confirm the mismatch on the reported video with read-only source checks.
- [x] Snapshot the same normalized sentence/segment view for reference recovery, capability and preparation; preserve exact bounds and source/owner validation, without rewriting semantic caches.
- [x] Hide the idle playback instruction when reference recovery or upload has an error; retain the alert and retry action.
- Verification: targeted API tests pass (50). The new regression previously failed with 404; it now covers empty recovery, prepare/recovery reuse, wrong-bound rejection, unknown-sentence rejection and cache immutability. Root lint/build/test pass (820 API, 338 Web, 114 extension; 1,272 total). Production-build `browser-reference-server.browser.mjs` passes at 1440/390 px, including error-state copy, read-only retry before capture, WAV upload, bound learner/reference analysis, refresh recovery and deletion. Auth, playback and server-analysis results are fixtures with synthetic audio. A read-only snapshot against the reported public video now finds its displayed sentence and exact 1,839–10,080 ms range. No live toolbar capture/upload, database write/migration or deployment was performed.

## Original video history — 2026-10-11

- [x] Record authenticated ready-video visits in existing owner-scoped content state, preserving progress and surfacing save failure/retry.
- [x] Add deduplicated Original videos to the personal page and Videos filtering to practice history; include existing owned Shadow/corpus video sources.
- [x] Open every original-video record at its canonical Stage 1 route; preserve account isolation and existing practice counts.
- [x] Complete desktop/mobile browser acceptance and record verification in the profile contract.

## Cross-page loading ownership — 2026-10-11

- [x] Remove the overlapping root and generic Corpus, Loadout and profile route skeletons; keep page-owned auth/data loading states and dedicated practice/speaking boundaries.
- [x] Verify cold Landing, Corpus, profile and Loadout entries show no unrelated generic loading shell; preserve the existing practice cold-entry skeletons.
- Verification: root lint/build/test pass (336 Web tests; other workspaces cached). A local-browser cold-entry check sees no generic loading shell on Landing, Corpus, profile or Loadout; client navigation to profile/Corpus/Loadout likewise shows only page-owned placeholders, and returning to Landing shows its hero without a skeleton. The production-build `workspace-loading.browser.mjs` passes Reader, segments, Shadow and import cold entries at 1440/390 px, including server first frame and delayed content. No backend or extension loading behavior changes.

## Stage 2 sentence-switch audio ownership — 2026-10-11

- [x] Keep the v4 extension session on URL-less `tabs.onUpdated` loading notifications and same-content sentence query changes. Release on verified document replacement or source exit.
- [x] Cover status-only loading in extension unit tests and sentence replacement plus real reload in the unpacked Chrome fixture.
- Verification: root lint/build/test pass (114 extension tests; unchanged API/Web tasks may use cache). The unpacked Chrome fixture retains the armed session after sentence `replaceState` and releases it after reload. That fixture does not invoke the real toolbar/tabCapture grant; live authorized sentence switching still needs manual acceptance after reloading the local extension and page.

## Routing and responsibility migration — 2026-10-10

The [architecture plan](design/docs/ROUTING_AND_RESPONSIBILITY_ARCHITECTURE.md) records target contracts and acceptance scenarios. R0–R5 are implemented; the user rejected compatibility in R3 and required R4 entry changes were included there. Real toolbar capture qualification remains separate.

- [x] Define business identities, routes, navigation/history rules, resource lifetimes, API changes, extension compatibility and rollback boundaries.
- [x] R0: implement shared URL parsing/building, distinct origin/auth return rules and complete Mission/report return links against legacy fixtures. Job-only entries recover their content without demo fallback; mismatched job/blueprint identities fail explicitly.
- [x] R1: add read-only content context and explicit failed-job retry intent; move analysis controls and speaking end/delete orchestration into service use cases with failure/concurrency checks. Add shared Web contracts; adopt them in the workspace controller during R2.
- [x] R2: extract the content controller and stable media host under existing URLs; prove playback, reference buffers, account isolation and root outbox lifetimes.
- [x] R3: directly enable canonical routes and extension v4; remove active legacy entry/protocol branches. Local route/resource and protocol validation recorded below; live toolbar capture still needs manual qualification.
- [x] R4 (folded into R3 by the direct-update instruction): switch link producers, use continuation v2 without v1 migration, launch extension import and reuse canonical content tabs.
- [x] R3 presentation follow-up: reuse the Reader skeleton at the import route boundary and during caption handoff/content resolution; show recoverable errors separately and use a neutral content-layout skeleton. Root lint/build/test pass (five existing lint warnings; 1305 tests, unchanged workspaces may use cache). `content-import.browser.mjs` passes at 1440/390 px with delayed handoff/resolve, reduced motion, no early player creation, failed-request retry and transient URL removal; loading/error screenshots inspected. `canonical-routes.browser.mjs` also passes at both sizes, including cold Shadow/auth, refresh and invalid-link isolation. Fixtures do not qualify live extension/YouTube timing.
- [x] R5: remove the retired v2 capture runtime and Web fallback, legacy entry loader/demo fallback and duplicate view/sentence controls; narrow the content controller to resolved IDs and update active browser fixtures/documentation. Validation is recorded below.

Acceptance: use canonical cold entries, matching import/handoff before media creation, failed-job refresh without retry, explicit generation retries, Shadow auth, browser history, stable media ownership, returnTo round trips, owner isolation, new-document release and obsolete-protocol rejection. Legacy job links and mixed-version compatibility were explicitly removed from scope. Deterministic fixtures do not establish real OAuth or live YouTube acceptance.

R3 verification (direct update, 2026-10-10): root lint/build/test pass (810 API, 362 Web, 133 extension tests; unchanged tasks may use Turbo cache; five existing Web lint warnings). Shared Web/extension JSON fixtures cover canonical content scope, wrong origins/ports/paths and display-only navigation; extension tests verify source API checks, sender/document/nonce isolation, obsolete-version rejection, new-document cleanup and canonical tab reuse after handoff expiry. Browser fixtures against the production build pass:

- `canonical-routes.browser.mjs`, 1440/390 px: direct Shadow auth, signed-in refresh, cold preparation, recoverable content failures on the picker, import with/without v4 handoff, transient input removal, malformed-link request isolation and root-query retirement.
- `content-workspace.browser.mjs`, 1440/390 px: failed-generation retry/recovery, actual back/forward between routes, stable iframe, owner-change microphone cleanup and root outbox completion after Mission navigation.
- `stage-two-navigation.browser.mjs`, 1440/768/390 px: shared iframe across Reader/picker/prepare/Shadow, sentence replacement, copied Mission origin, refresh/stale selections, controls and geometry. Desktop/mobile screenshots inspected.
- `caption-timing-recovery.browser.mjs`, 1440/390 px: paused application, active Shadow snapshot, missing extension, stale responses and nine observer failures; no semantic reanalysis.
- `stage-two-recording.browser.mjs`, 1440/390 px: real local MediaRecorder with synthetic microphone, pending/late grants, navigation/visibility cleanup and replay.
- `stage-two-buffered-reference.browser.mjs`, 1440/390 px: v4 fixture messages, source-owned buffer and local inference; actual AudioContext/AudioWorklet/PCM/WAV excludes pause/rate/generation gaps.
- `apps/extension/tests/workspace-v4.browser.mjs`: real unpacked Chrome scripts and sender metadata reject v2/v3, keep one armed session across content paths, and clear the session on reload. Content API responses are fixtures. Automated toolbar shortcuts did not produce the real Chrome capture grant in either headless or headful runs, so live toolbar/tabCapture qualification remains open. The default browser script explicitly tests only arm/navigation/reload; `LIBITU_V4_CAPTURE=1` requires a real working action gesture and additionally checks oscillator audio capture.

No hosted OAuth, live YouTube, paid provider, database migration or deployment was exercised. R5 has removed the unreachable v2/legacy loaders and reconciled active browser fixtures/documents; historical R0–R3 records describe their respective implementation stages. Web and extension 0.2.0 must update together, with the extension and existing documents reloaded.

R5 validation (2026-10-10): root lint/build/test pass for the cleanup (810 API, 334 Web, 106 extension tests; zero lint warnings). Removed test cases exclusively exercised deleted v2 or obsolete entry behavior; retained SSE, caption, cancellation and identity assertions now call current transport adapters. Production-browser checks pass for canonical routes, import skeleton/error/retry, Mission return links, workspace retry/account/outbox ownership, stage navigation, real MediaRecorder, caption recovery, and buffered local inference/AudioWorklet/PCM/WAV at desktop and 390 px. The final production build also passes invalid-client-URL → Retry (no public request) → Back recovery. Profile/history/continuation and browser-reference server upload/comparison/refresh/delete pass at 1440/390 px. The final Loadout suite passes with its 390 px primary flow plus multi-account, empty-corpus, Reader→Mission and pending Shadow save cases; earlier primary-flow runs also pass at 1440/768 px. Its fixture now uses current select controls/navigation labels and waits for completed guest-draft writes before ordinary login, while explicit pending-write/account-change tests remain intact. Unpacked v4 rejects old versions, retains same-content sessions and releases them on reload; this remains arm/navigation validation, not a real toolbar audio grant. Real unpacked extension entry/handoff/canonical-tab reuse and passive-caption observer browser fixtures pass; their Web/API/YouTube content is synthetic. The extension source verifier now reads `content.content_id`, matching the backend-shared JSON contract rather than the erroneous `content.id` fixture; shared-contract regression and both v4 browser checks pass. Other historical browser entries have been migrated to canonical URLs and syntax-checked; only the explicitly listed suites were run.

R0 verification: root lint/build/test pass (763 API, 345 web, 118 extension tests; unchanged tasks may use Turbo cache; five existing lint warnings). `navigation.browser.mjs` covers report/review/loadout links, refresh/back, retry/adjustment, exact auth return at 1440/390 px, plus job-only recovery, copied links in another tab and duplicate-parameter rejection without analysis requests. `analytics.browser.mjs` passes existing report flows at 1440/768/390 px and queued/partial/failed/insufficient-data states. Its reduced-motion assertion now accepts the existing global 0.01ms duration. Backend services, failed-job retry semantics, media persistence, extension v4 and new routes are not part of R0 acceptance.


R1 verification: root lint/build/test pass (810 API, 348 web, 118 extension tests; unchanged tasks may use Turbo cache). Shared DTO fixtures cover Web/API agreement; API regressions cover public projection, unavailable dependencies, inline/queue modes, retry races, fast second failures, queue-publication gaps, worker terminal-state rechecks and lifecycle failure ordering. `scripts/verify_processing_contract.py` passed 32-way creation/retry checks using isolated local PostgreSQL with a REST test adapter and Redis Lua executed in fakeredis/lupa. These are local storage/contract checks, not a hosted Supabase/Upstash, live-provider or OAuth qualification. No new page flow was activated in R1; the R2 follow-up below connects the Reader and verifies browser loading/history/media behavior. Lint retains five existing Web warnings; API tests retain the existing Starlette deprecation warning. One isolated Web run under concurrent build load hit the existing 20ms polling-test timing assumption; the subsequent full root suite passed, and no analytics behavior was changed in R1.

R2 verification: root lint/build/test pass (810 API, 360 Web, 118 extension tests; unchanged tasks may use Turbo cache; five existing Web lint warnings). Twelve controller tests cover read/ensure/retry intent, lost responses, source/job conflicts, bounded ready/404 reads, caption input reuse and cancellation. Production-build browser fixtures pass:

- `content-workspace.browser.mjs` at 1440/390 px: failed activation has no POST; lost retry uses counts 4 → 4 → 5; real back/forward and account switches release microphone tracks, retain the iframe and avoid public reanalysis; one pending save completes after navigation to Loadout, while the player is destroyed.
- `stage-two-navigation.browser.mjs` at 1440/768/390 px: Reader/picker/preparation/Shadow and sentence/layer changes retain the same iframe, range/speed/loop behavior and responsive geometry; reload and invalid selections recover safely. Desktop/mobile screenshots inspected.
- `caption-timing-recovery.browser.mjs` at 1440/390 px: paused Reader applies recovered timing, active Shadow keeps its old sentence/recorder, missing/stale extension and observer failures remain recoverable without semantic jobs.
- `stage-two-recording.browser.mjs` at 1440/390 px: actual MediaRecorder with a synthetic microphone covers hide/leave, pending permission and late grants, local replay and resource release.
- `stage-two-buffered-reference.browser.mjs` at 1440/390 px: one player and one authorization session across views; analyzed references are reused without new extraction, late extraction cannot change selection, layer changes retain DOM and avoid extra inference. Actual local inference produces both pitch curves; AudioContext → AudioWorklet → PCM → WAV checks pass. Its obsolete acoustic-panel wording assertions now target the existing word-row/pitch-overlay UI; source/cache/media assertions remain in place.

These runs use synthetic YouTube, auth, API and extension messages; they do not qualify live YouTube/OAuth or a deployed extension. No paid provider, database migration or deployment was invoked. Old URLs and local picker/preparation steps remain until R3; root save/upload ownership remains unchanged.

## Import-to-content extension identity correction — 2026-10-10

- [x] Reproduce `Invalid buffered audio request.` with the real unpacked extension after `/practice/import` → `history.replaceState` → canonical content. Chrome preserves the initial content-script `sender.url` while `sender.tab.url` changes; the former equality check rejected this valid flow.
- [x] Validate the sender origin and current tab identity, then verify the current top-level frame's URL, active lifecycle and `documentId` via `webNavigation.getFrame` before arming/probing or reading fresh captions. Replaced documents cannot initiate work. Public content/video verification and toolbar-only capture remain required.
- [x] Root tests: 1,253 pass (810 API, 334 Web, 109 extension; unchanged API task cached); extension lint/build pass. Real unpacked browser fixtures pass import→arm, same-content navigation, release on reload, cold-content re-arm, and passive fresh-caption reads after import navigation. Fixtures preserve real sender metadata but use synthetic content/API responses; no real toolbar audio stream was granted in these runs.

## Simplify Stage 2 skeletons — 2026-10-10

- [x] Keep only broad heading/sidebar/video/analysis regions, with simple selection/preparation blocks. Remove individual sentence rows, imitation controls, nested analysis panels and history placeholders; retain responsive ordering and reduced-motion support.
- Verification: root lint/build/test pass (1,265 tests; unchanged tasks may use cache). Existing `workspace-loading.browser.mjs` passes at 1440/390 px for Reader/segments/Shadow/import, including first frame, delayed content, reduced motion and responsive ordering. Simplified desktop/mobile Shadow screenshots inspected.

## Reference audio setup latency — 2026-10-10

- [x] Make v4 capability ping local; keep passive verified tab registration separate. Use one metadata-only identity read for explicit arm and share concurrent requests from the same owner/session.
- [x] Expose checking → preparing → armed → enabled; prompt the toolbar action only after acknowledgement. Preserve same-document/source ownership and actual toolbar-only authorization.
- [x] Reserve pending ownership before verification; cancel/reload/source/document changes fence late arming, and failed validation never shows ON?.
- Verification: root lint/build/test pass (816 API, 336 Web, 113 extension; 1,265 total). API tests prove one public metadata read, no blueprint/job reads, visibility/source conflict handling and no private fallback. Extension tests cover local ping, pending-arm deduplication, failed validation and cancellation/source/document/reload/tab-close fencing. Real unpacked `workspace-v4.browser.mjs` holds the identity response: ping returns without any fetch, initial arm issues one identity request, ON? appears only after validation, and document/path/reload ownership remains correct; no actual toolbar audio grant was exercised. `reference-setup.browser.mjs` passes delayed acknowledgement, cancel/late reply/retry at 1440/390 px. The existing buffered reference browser suite passes Stage 1 → preparation → Shadow at both sizes with actual local inference and AudioContext/AudioWorklet/PCM/WAV; extension entry/tab reuse and passive fresh-caption browser checks also pass. Synthetic media/auth/content fixtures apply to browser checks; a separate real local identity endpoint read returned 200 with only public metadata. No deployment or migration. Reload the extension and refresh the Web page to use the coordinated update.

## Content route loading boundary correction — 2026-10-10

- [x] Replace the shared layout's hard-coded practice skeleton with a pathname-aware fallback and reuse it at the content route loading boundary. Import→Reader keeps the Reader shell; segments/Shadow keep the practice shell.
- [x] Preserve the shared controller/media owner and the existing extension caption preflight; launch latency work is deferred at the user's request.
- Verification: root lint/build/test pass (810 API, 334 Web, 109 extension; unchanged API/extension test tasks cached). `workspace-loading.browser.mjs` passes at 1440/390 px for Reader, segments, Shadow and import, holding JavaScript before hydration and content/resolve responses afterward; painted skeletons never switch to the wrong stage. `content-import.browser.mjs` passes handoff/resolve, error/retry, reduced-motion and no-media-before-resolution checks. `content-workspace.browser.mjs` passes retry generations, stable iframe across navigation, account/microphone isolation and pending-save completion. Screenshots inspected. These checks use synthetic API/auth/media fixtures; no deployment or extension preflight change.

## Navigation prefetch and Stage 2 loading geometry — 2026-10-10

- [x] Audit internal links and imperative navigation. Add shared intent prefetch while retaining Next viewport behavior; warm Reader → selection → preparation → exact Shadow destinations, plus Shadow code during preparation. Cover known video-form, corpus/loadout, Mission/report and return destinations. Newly created content/session IDs remain dependent on successful business responses.
- [x] Remove the nested content-route loading boundary added in the preceding correction; retain pathname-aware shared-layout cold fallback. Ready Reader stays visible while the next route responds, with the existing iframe retained.
- [x] Replace generic practice placeholders with selection/preparation/Shadow structures, including responsive sentence navigation, media/operations, analysis and history. Preserve decorative-only loading and reduced-motion support.
- Verification: root lint/build/test pass (810 API, 334 Web, 109 extension; unchanged test tasks may use cache). Production-build `navigation-prefetch.browser.mjs` passes at 1440/390 px: requests precede clicks, delayed route responses preserve Reader and its iframe, and prefetch causes no import/session/recording effects. `workspace-loading.browser.mjs` passes Reader/segments/Shadow/import server-first-frame and delayed-content checks at both sizes, including decorative-only skeletons, responsive ordering, reduced motion and no horizontal overflow; screenshots inspected. `navigation.browser.mjs` and `content-workspace.browser.mjs` pass desktop/mobile return/history/auth, retry, persistent-media, account and outbox regressions. `stage-two-navigation.browser.mjs` also passes at 1440/768/390 px for selection/preparation/Shadow, sentence navigation, refresh and stable media. These checks use synthetic API/auth/media fixtures. Extension caption preflight and toolbar grant remain outside this change; no backend or extension behavior changed and no deployment was performed.

## Loading boundary correction — 2026-10-08

- [x] Make the inherited root route fallback stage-neutral instead of rendering ReaderLoadingShell for every destination.
- [x] Initialize valid Shadow deep links from server query parameters and show the practice skeleton through blueprint/auth loading; invalid segment IDs return to the reader.
- [x] Delayed API browser checks confirm no Stage 1 reader skeleton/content during Shadow loading and successful resolution for Shadow, Corpus and profile.

## Page loading skeletons — 2026-10-08

- [x] Replace Stage 2 dynamic-import text with a practice-shaped skeleton.
- [x] Add shared rows/cards skeletons and route loading shells; migrate main page/data fetch placeholders while retaining errors, empty results and operation progress.
- [x] Provide screen-reader loading status, decorative hidden shapes and reduced-motion support.
- Verification: root lint/build/test pass; delayed-response skeleton-to-content and reduced-motion checks pass for Corpus, Loadout, profile/history, Mission and analytics at 1440/390 px. Stage 2 ready-state mobile rendering passes; its dynamic-import fallback is wired to the practice skeleton.

## Stage navigation states — 2026-10-08

- [x] Stage 1/2 use shared secondary Button appearance like Stage 3/Corpus, retaining stage selection colors and existing handlers/disabled conditions.
- [x] Fixture browser checks at 1148/390 px verify matching idle/hover paint, disabled hover stability and persistent selected styling.

## Saved Shadow practice styling — 2026-10-08

- [x] Group saved-take metadata/actions in cards; use small shared buttons and outlined destructive actions, including reference deletion.
- [x] Clip shared button backgrounds inside transparent borders to remove exterior white halos.
- Verification: root lint/build/test pass; desktop/mobile production-preview fixture checks cover small button height, destructive variant/background clipping and save/load/retry/delete flows. Local dev preview was restarted after missing generated vendor chunks.

## Audio save notifications — 2026-10-08

- [x] Use a responsive fixed notification stack with blue processing and warm error states, icons and retry actions.
- [x] Distinguish read-only reference recovery from pending uploads, avoiding false entry notices/unload warnings.
- [x] Regression covers recovery versus upload counts; desktop/mobile fixture browser checks cover empty entry, failure notice, retry, save/history and logout.

## Stage 2 compact audio settings — 2026-10-08

- [x] Give sentence preparation a white outlined secondary button.
- [x] Consolidate three audio preferences and their explanations in a keyboard-accessible disclosure, preserving defaults, handlers and visible processing feedback.
- Verification: root lint/build/test pass (1,192 tests; five existing unused-symbol lint warnings). Fixture browser checks pass at 1440/827/390 px, including keyboard disclosure, unchanged initial checkbox states and no horizontal overflow. Real extension capture/upload is not exercised.

## Stage 1 loading feedback — 2026-10-08

- [x] Add route and region skeletons without delaying streamed content or changing acquisition/playback.
- [x] Preserve errors/retry and Saved states; respect reduced motion.
- Verification: root lint/build/test pass (1,192 tests; five existing lint warnings). Live extension latency and browser visual checks were not performed for this change.

## Stage 1 highlight/card correspondence — 2026-10-08

- [x] Derive highlights from the same merged list as sidebar cards and attach card identities.
- [x] Remove fragment fallback and reject inside-word matches.
- [x] Click a highlight to select the matching category and focus/scroll the corresponding card without seeking.
- Verification: root lint/build/test pass (311 Web tests, five existing lint warnings). Focused browser checks pass at 1440/390 px for saving, reload, deletion, Chunks/Idioms navigation, Saved retention, focused matching cards and unchanged playback position. Exact-source and false-fragment/inside-word regressions pass.

## Stage 1 saved-card highlighting — 2026-10-08

- [x] Include current-source saved items in memoized transcript annotation, updating after save, restoration and removal.
- [x] Add source-wording/metadata regression coverage and desktop/mobile save–reload–remove browser assertions.
- Verification: root lint/build/test pass (five existing unused-variable/import warnings); final Web rerun passes 310 tests. Focused browser save/reload/remove coverage passes at 1440/390 px. The full desktop fixture passes; the full mobile fixture stops at its separate active-logic-node assertion before reaching the new flow. An unrelated analytics polling timing test failed once under concurrent checks and passed on rerun.

## Loadout style follow-up — 2026-10-04

- [x] Keep draft feedback layout stable, use neutral textarea focus and outlined directional links without changing copy.
- [x] Verified unchanged form coordinates/dimensions across select opening, queued selection saves, typing and save completion at 1440/743/390 px. Neutral textarea focus and secondary 40 px return links pass. Root lint (two existing warnings), build and all 1,190 tests pass.

## Caption marker cleanup — 2026-10-04

- [x] Remove bracketed cues and repeated angle markers from new caption processing and cached transcript display.
- [x] Cover cue-only rows, spoken punctuation and multi-segment cues with source word offsets.
- Verification: root lint/build/test pass; final web rerun passes all 309 tests (1,190 total across API/web/extension). Lint retains two existing reader unused-import warnings. Cached-display regression covers split cue parts, sentence identity/time and withholding stale word indices.

## Select and directional controls — 2026-10-04

- [x] Migrate native selects, refine menu/trigger appearance and preserve the empty All sources choice.
- [x] Remove reader bottom gap and standardize directional action dimensions.
- [x] Nine screens pass at 1440/390 px; reader/shadow/loadout also pass at 743 px. Verified select keyboard/open/choose/Escape behavior, source reset, sorting, borderless options, bottom-edge geometry and 40 px directional buttons with 16 px icons/8 px gaps. Root lint (two existing unused-import warnings), build and all 1,186 tests pass.

## Shared application header — 2026-10-04

- [x] Unify main application headers and account actions; preserve mission controls.
- [x] Six application screens pass header alignment/navigation checks at 1440 and 390 px; Corpus/Profile also pass at 743 px. Root lint (two existing reader unused-import warnings), build and all 1,186 tests pass. Browser verification uses fixture identity/data.

## White page canvas — 2026-10-04

- [x] Make global and framed-page outer backgrounds white; preserve inner surfaces and spacing.
- [x] Extend the reader Stage 2 entry bar across the viewport without horizontal outer gutters.
- [x] Root lint/build and all 1,186 tests pass. Nine screens pass white-canvas and responsive checks at 1440/390 px; the reader footer reaches both viewport edges at 1440/743/390 px without horizontal overflow.

## Reader browser annotations — 2026-10-04

- [x] Match Corpus to stage navigation and make reference-audio activation clearly actionable.
- [x] Remove the reader reference frame, apply responsive outer gutters without a page border, balance the footer and standardize the saved-language button.
- [x] Shorten transcript labels to minute:second without changing playback precision; reserve timestamp/text spacing.
- [x] Verify the seven adjustments at 743, 390 and 1440 px with fixture rendering and measured spacing; timestamp regression, root lint/build and all 1,186 tests pass.

## Typography and control consistency — 2026-10-04

- [x] Load local Inter normal/italic variable fonts with license, swap and fallback support.
- [x] Share text-field/native/Radix select appearance while retaining existing geometry and semantics.
- [x] Consolidate generic purple selection tokens without replacing learning colors.
- [x] Add auxiliary pending-action feedback and remove redundant button-only paint.
- [x] Root lint/build and 1,185 tests pass; nine screens pass desktop/mobile actual-font, local-font-request and layout checks (18 combinations). Field validation/search/edit/native-select interactions pass.
- Verification and usage: [visual system](design/docs/VISUAL_SYSTEM.md).

## Shared button system — 2026-10-04

- [x] Introduce shared action variants and real-link navigation; preserve purple branding and existing dimensions.
- [x] Migrate web actions, retain separate selection controls, and share focus/pressed/disabled/reduced-motion states.
- [x] Add stable loading progress to key asynchronous submissions.
- [x] Root lint/build and 1,185 tests pass.
- [x] Desktop/mobile fixture acceptance at 1440/390 px: submit/link semantics, hover/focus, stable loading size, duplicate prevention, reduced motion, deletion confirmation and recording colors.
- Browser acceptance and usage: [button system](design/docs/BUTTON_SYSTEM.md).

## Visual consistency pass — 2026-10-03

- [x] Share the landing wordmark across existing web brand links, including mission/report gates.
- [x] Preserve purple primary buttons, semantic learning colors and existing layouts.
- [x] Consolidate warm surfaces, radii, elevation, focus and disabled appearance; respect reduced motion.
- [x] Root lint/build and 1,185 existing tests pass. Desktop/mobile fixture checks cover Landing, Blueprint, Shadow, Loadout, Speaking, Analytics, Corpus, Profile and History; the corpus interaction suite and profile regression assertions pass. Test-only local request forwarding avoids Clerk development-handshake redirects; no production authentication behavior changed.

## Landing page — implemented locally 2026-10-03

- [x] Implement the supplied prototype's visual direction as new React components and scoped CSS, without reusing prototype source.
- [x] Keep a source-free root as the landing page and preserve existing Stage 1 source/content/job/handoff links.
- [x] Validate and normalize pasted YouTube URLs; use the existing analysis lifecycle and omit unknown video titles/language.
- [x] Reuse real Clerk login/register/account controls and forced return URLs; retain same-tab video drafts through refresh/auth.
- [x] Verify responsive layout, keyboard/error states, real login/register modal switching and fixture-backed Stage 1 entry/reload.
- [x] Make Stage 1 anonymous access explicit and restore the prominent centered “or / Add to Chrome” entry from the prototype.
- [ ] Complete a real account login/OAuth round trip and authenticated account-menu acceptance.
- [ ] Configure the published Chrome Web Store listing when available; current page shows extension guidance.

Verification: root lint/build/test passed (761 API + 306 web + 118 extension tests; unchanged tasks may use Turbo cache). Six new entry regressions cover routing, URL normalization/rejection, external-store validation and resolve/job/blueprint integration. Browser checks cover 320/390/768/1440 px without horizontal overflow, actual Clerk forms, draft refresh, inline errors/Enter, footer focus, fixture-backed ready content and durable reload. Provider analysis and completed OAuth are not claimed. See [details](design/docs/LANDING_IMPLEMENTATION.md).

## Corpus library — implemented locally 2026-10-02

- [x] Add `/corpus`, real cross-source browsing, search, combined filters, sorting and grid/list views.
- [x] Persist guest/account edits with stable record keys; retain original source analysis and past session snapshots.
- [x] Add separate detail, selection, edit and confirmed delete actions, plus visible storage/network failures.
- [x] Merge selections into the latest account-bound Loadout draft atomically; preserve settings, reject overflow and uncertain session submissions.
- [x] Link the library from input, Loadout and the personal learning center.
- [ ] Separately implement Decks, evidence-based corpus usage aggregation and server-side list pagination.

Verification: root lint/tests, final production build and 18 focused corpus/storage regressions passed; full browser acceptance passed at 1440/390 px, covering selection, detail, edit/reload, failed PATCH retry, delete/reload, Loadout handoff and account isolation. Browser identity/API data were synthetic. A real owner-scoped Supabase read-only smoke passed. See [scope and verification](design/docs/CORPUS_LIBRARY_IMPLEMENTATION.md). Review scheduling remains excluded from MVP.

## Personal learning center — 2026-10-02

- [x] Add `/profile`, signed-in navigation, Clerk identity, responsive prototype-based layout and explicit signed-out/loading/error/empty states.
- [x] Aggregate real owner-scoped Shadow takes, participated Missions, saved corpus, recording duration, local-calendar streaks and 28-day/90-day/monthly activity.
- [x] Add unified paginated history, recoverable Mission links, safe source links and account-bound device-local learning continuation.
- [x] Design the simple history page with profile entry points, local-date groups, per-record time/status and server-side All / Shadowing / Missions filters before pagination; reset and fence pending reads on filter changes.
- [x] Keep ability dimensions unassessed and distinguish surviving saved-item additions from a permanent activity event log.
- [x] Integrate compatible Stage 5 reports as a separate latest-Mission summary and history report links; preserve null/zero, report lifecycle, version checks and read-only profile behavior.
- [x] Complete root checks and desktop/mobile browser acceptance for this increment.
- [ ] Separately implement validated ability assessment/trends, persistent learning goals, Decks/usage aggregation and cross-device reader position.

See [implementation and test boundaries](design/docs/PROFILE_IMPLEMENTATION.md).

Verification: root lint, production build and tests passed (617 API + 276 web + 112 extension = 1005 tests). All six profile browser acceptance groups passed at 1440/390 px: range/metric changes, accessible tables, keyboard dimensions, safe source navigation, missing-source abstention, history pagination/retry, empty/error/unknown-date states, delayed-response account isolation and signed-out return URLs. Eight screenshots were inspected. A read-only Supabase smoke verified the real projections with a nonexistent owner; a live unauthenticated request returned 401. Browser identity/API responses are synthetic fixtures, not real OAuth or production performance qualification.

Stage 5/profile integration (2026-10-02): production build passed using an isolated source snapshot to avoid concurrent build output collisions; root lint and 1,161 tests passed (755 API, 294 web, 112 extension). New feedback summary/state/legacy/ownership browser checks, all six existing profile groups, Analytics at three widths and the complete learner journey passed. The real profile-to-feedback join was checked read-only; the existing migration was not reapplied. The local feedback worker was started after confirming no backlog or queued jobs. No new paid-model verification was run.

## Stage 5 evidence-backed report — implemented locally 2026-10-01

The user accepted the [four-dimension report contract](design/docs/STAGE_FIVE_CONTRACT.md).

- [x] Freeze nullable scores, rubric, transfer denominator, final-user references and report lifecycle.
- [x] Persist immutable assessment input and leased, bounded report jobs with recovery and deletion fencing.
- [x] Evaluate the full final transcript with validated quotations and deterministic score aggregation.
- [x] Deliver responsive Analytics, source evidence, real suggestion saves and retry/adjust mission actions.
- [x] Verify API/worker/database and browser end → report → review/retry recovery; distinguish fixture identity from real OAuth.
- [ ] Independently calibrate model judgments with human-reviewed conversations before claiming assessment accuracy.

Verification: root lint/build/test passed (711 API + 282 web + 112 extension = 1,105 passing tests; two optional acoustic tests skipped). The feedback migration and real Supabase rollback tests passed. A real bounded DeepSeek assessment produced all four dimensions with 18/18 exact quotations validated; synthetic records were removed. Analytics and Stage 4 browser checks passed at 1440/768/390 px. See the linked contract for provider, fixture-identity and human-calibration boundaries.

## Stage 4 real-time conversation — implemented locally 2026-10-01

[Current implementation and verification](design/docs/STAGE_FOUR_IMPLEMENTATION.md) supersede the earlier proposal. The user selected Gemini Live for the current provider.

- [x] S4-00: Validate real Gemini Live text/audio and freeze normalized runtime/message/evidence contracts.
- [x] S4-F1/F2: Shared Voice/Chat workspace, continuous media controller, responsive controls and reduced motion.
- [x] S4-B1/B2: Durable versioned session documents, owner/lease fencing, real provider and role prompt.
- [x] S4-F3/B3: Text with voice, VAD/transcript boundaries, interrupt, manual reconnect, refresh recovery and explicit takeover.
- [x] S4-F4/B4: Traceable language observations, bounded hints and next-response policy, end/read-only review/delete. Provider transcript revisions are supported; manual editing and automatic logic-stage detection are not delivered.
- [x] S4-Q1-local: Root checks; real Gemini/DeepSeek/Supabase synthetic text and voice smoke; responsive Chrome capture/playback and complete Loadout/Shadow regression.
- [ ] S4-Q1-release: Physical-device/network/latency/cost qualification, complete live post-interruption turn acceptance, account-wide budgets, production supervision and real OAuth end-to-end acceptance.
- [ ] S4-follow-up: User transcript correction and evidence re-evaluation, if included in the next increment.

Verification: root lint/build/test passed (603 API + 267 web + 112 extension = 982 tests). Real Gemini interruption was observed; the bounded interruption probe did not verify the subsequent complete user/reply turn. See the implementation document for browser/provider test boundaries.

Stage 5 final assessment is delivered in the increment above. Stage 4 observations remain separate from its final report; no mastery score is fabricated.

## Sound prototype and workspace-order correction — 2026-09-29

- [x] Keep video and practice controls above the three-layer workspace.
- [x] Restore the ten Sound phenomenon filters, exact-occurrence inline badges/linking arcs, dictionary IPA on hover/focus and the color legend.
- [x] Preserve Reference / Your voice, measured vowel/boundary-pause data, tab state and hide/individual reveal.
- [x] Distinguish conditional rule targets and unavailable detectors from measured audio evidence.
- [x] Verify desktop/mobile interaction, exact-token safeguards and root quality checks.

Verification: root lint/build/test passed (240 web + 453 API + 112 extension = 805 tests). Registered-reference and browser-capture suites passed at 1440/390 px; Sound screenshots were inspected. Checks cover video-before-layers order, all phenomenon filters, exact highlighted word ranges, inline/link marks, unknown detectors, tab persistence, conceal/reveal/IPA, saved and learner-only evidence, and unchanged capture/server analysis and history recovery. Browser fixtures exercise display/state, not detector accuracy.

## Browser reference server analysis and compact workspace — 2026-09-29

- [x] Accept source-bound browser WAV references without an operator file grant; preserve private ownership, consent, retry and deletion.
- [x] Independently verify reference content, cache word prosody, bind each learner take and wait without exhausting retries.
- [x] Unify Sound/Rhythm to Reference / Your voice rows and Melody to normalized dual curves with word-linked pointer, keyboard and playback highlights.
- [x] Keep local acoustic previews; stop automatically loading the local alignment model.
- [x] Apply and verify the queue migration; document the superseded local-only default.
- [x] Complete final root, real-model/storage and desktop/mobile acceptance for this increment.

Verification: root lint/build/test passed (238 web + 453 API + 112 extension = 803 tests). Capture-server and registered-reference desktop/mobile regressions passed at 1440 and 390 px; screenshots were inspected. Local PostgreSQL queue/lease/ownership/deletion/wait tests passed, and the wait migration is applied. Actual synthetic speech ran through real reference ASR/MFA/VAD/F0, cached pairing, learner analysis, mismatch abstention, private Supabase storage, cleanup and deletion without a file-source grant. All synthetic rows/assets were removed. This does not establish live YouTube capture or acoustic detector accuracy.

See [implementation and test boundaries](design/docs/STAGE_TWO_BROWSER_REFERENCE_SERVER.md). The following September 26 section records the earlier local-only implementation; it is no longer the default flow.

## Browser reference word/phoneme alignment — 2026-09-26

- [x] Preserve capture identity and bind local VAD/F0 and alignment to one bounded raw clip and exact source sentence.
- [x] Publish basic measurements independently; retain bounded alignment retry and fence cancellation/late results.
- [x] Connect reference-only and local-reference/saved-learner word displays without requiring a registered server file source.
- [x] Verify the pinned browser phoneme model on actual audio input, privacy boundary, desktop/mobile interactions and root checks.

This follows the user's choice to align browser-captured references locally. Audio is not uploaded for this operation; only a source-bound dictionary request and static model downloads are needed. Alignment is conditioned on caption/lexicon targets, not independent content or pronunciation verification. Cross-engine scores and unvalidated sound detectors stay unavailable. See [implementation and verification](design/docs/STAGE_TWO_LOCAL_ALIGNMENT.md).

Verification completed 2026-09-26: root lint/build/test passed (230 web + 447 API + 112 extension = 789 tests; unchanged API/extension tasks reused caches). Actual Chrome Silero/Pitchy/Charsiu inference on synthetic speech passed at 1440 and 390 px, including nine reference words/30 phone intervals, reference-only display, compatible saved learner pairing, all three layers, cache reuse, sentence isolation and no reference upload. The existing file-reference desktop/mobile regression also passed. Screenshots were inspected. Player, extension transport, identity and saved learner analysis were fixtures; these checks do not establish live YouTube capture, physical-phone performance or human alignment accuracy. Separate real-model smoke checks covered repeated words, dictionary alternatives, silence abstention and 19.159-second input. An unrelated transcript still obtained a forced path, confirming why local content remains explicitly unverified.

## Stage 2 result recovery and partial evidence — 2026-09-24

- [x] Read saved analyses independently of the choice to upload/analyze future recordings.
- [x] Restore the latest take on initial entry and sentence changes; preserve manual selection through history refreshes and late saves.
- [x] Select new recordings by their exact acknowledged take ID and refresh a selected same-ID take when its save version changes.
- [x] Show learner-only Sound vowel-duration and boundary-pause measurements while leaving comparison scores empty.
- [x] Make REF/YOU evidence explicit across Sound/Rhythm/Melody for file reference plus local learner audio; label normalized Melody curves as not aligned word by word.
- [x] Complete regression, desktop/mobile browser and root lint/build/test acceptance for this increment.

Verification: root lint/build/test passed (447 API + 197 web + 112 extension = 756 tests; API/extension reused unchanged task caches). Desktop/mobile browser regressions passed for result recovery with consent off, same-ID invalidation, cancellation/manual-selection preservation, learner-only measurements, sentence isolation, content mismatch, deletion, existing Sound controls and persistence. Synthetic speech through Chrome microphone encoding and actual local Silero/Pitchy inference verified both local learner and file-reference displays before server completion; desktop/mobile screenshots were inspected. Server results/auth were fixtures, not new hosted or detector-accuracy checks. This increment changes result recovery and evidence display; it adds no acoustic detector, scoring formula or upload authorization. See [scope and evidence boundaries](design/docs/STAGE_TWO_SOUND_COMPARISON.md).

## Stage 2 paired layers and first Sound measurements — 2026-09-23

- [x] Match the prototype's paired text rows and per-layer feedback using one selected saved take.
- [x] Persist aligned phone timing and known/unknown boundary pauses in versioned results.
- [x] Add vowel timing and candidate linking-boundary timing comparisons, with experimental resemblance scores and coverage.
- [x] Add experimental Rhythm/Melody resemblance; retain solid dictionary stress dots and textual pause markers.
- [x] Keep unsupported realization checks unscored, old results readable and revoked-reference assessments hidden.
- [x] Verify real ASR/MFA, hosted result persistence/revocation/cleanup and desktop/mobile browser interactions.
- [ ] Validate actual weak-form, flap, elision, assimilation, glottal, Drop-D, H-dropping and voicing detectors against independent labels before releasing realization verdicts.

Verification: root lint/build/test passed (447 API + 197 web + 112 extension = 756 tests), paired-comparison and existing Sound-guide desktop/mobile browser suites passed, and hosted synthetic test rows/objects are zero after cleanup. See [scope and score definitions](design/docs/STAGE_TWO_SOUND_COMPARISON.md). This increment does not complete all M4b detectors.

## Stage 2 learner analysis — 2026-09-22

- [x] Separate remembered analysis opt-in from long-term recording retention; freeze purpose/sentence/reference at recording start.
- [x] Add private temporary uploads and persistent queue, leases, status/retry/cancel/delete APIs and cleanup reconciliation.
- [x] Gate MFA on independent ASR content matching; save reviewable mismatch/uncertain outcomes without invented alignment.
- [x] Add saved Rhythm/Melody word comparisons and history recovery, keeping measurements separate from scores.
- [x] Apply migration to the connected Supabase project; exercise actual PostgreSQL claim/reclaim/fencing/deletion and run API/web/worker tests.
- [x] Verify desktop/mobile recording, asynchronous completion, sentence isolation, refresh, mismatch and deletion with browser fixtures; inspect the mobile word display.
- [x] Verify actual ASR/MFA on licensed speech and the complete hosted round trip with synthesized speech, including both matched and mismatched content; remove fixture rows/objects.
- [ ] Provision production worker supervision/monitoring and evaluate real accents/alignments against independent human labels before any accuracy or assessment claim.

See [implemented pipeline and operational limits](design/docs/STAGE_TWO_PRACTICE_ANALYSIS.md). Browser fixtures use mocked API recognition results and do not replace actual acoustic checks.

Verification completed 2026-09-23: root lint/build/test passed (432 API + 197 web + 112 extension = 741 tests), and the final API/worker subset passed 24 tests. Both desktop/mobile browser suites passed for new analysis and existing recording history. Actual small.en → MFA → VAD/Praat processing matched and aligned all five words of the licensed CMU ARCTIC sentence “Will we ever forget it”; no human boundary-accuracy claim follows. The hosted synthetic-speech smoke passed real upload, independent recognition/alignment for both voices, saved paired results, mismatched-content abstention, ownership, revoked-reference masking, cleanup and deletion. Earlier runs encountered transient transport interruptions and a lost lease; the final bounded retry/recovery verification passed. PostgreSQL claim/reclaim/stale-write/cancel/delete tests passed; the disposable local database was stopped. Migration is applied; the private 8 MiB bucket and restricted grants were checked. Supabase advisors reported no warning/error, only pre-existing informational policy/index notices.

The pinned ASR revision and model content hash are verified and configured in the ignored local API environment. This establishes local functionality, not production worker hosting, live Clerk OAuth or calibrated pronunciation accuracy. Temporary input cleanup depends on an operational worker/storage service.


## Stage 2 server reference increment — 2026-09-22

- [x] Make Rhythm readable against sentence text: dictionary syllable-stress dots, phrase/pause bars and measured durations on both reference paths; expose approximate caption positions and retain unplaceable/learner pauses as audio times. Actual sentence-emphasis detection remains separate.
- [x] Simplify Rhythm styling per follow-up: three solid amber stress-dot sizes/shades, no gray/hollow dot category, compact prototype-style pause rows, and removal of the duplicate speech/pause chart.
- [x] Implement the confirmed A–D reference foundation: operator-owned source grants, private normalized assets, durable PostgreSQL queue/leases, full-sentence MFA adapter, VAD/F0/energy/duration measurements, authenticated result recovery and conditional three-layer file playback.
- [x] Verify real PostgreSQL lease/cancellation/deletion semantics, synthetic hosted storage round trip, desktop/mobile file playback/SSE recovery and existing practice persistence compatibility. Run actual VAD/F0 on 16 licensed clips and MFA on two nonzero-origin sentence cases; do not equate these with human-gold accuracy.
- [ ] Register actual permitted product sources and provision a production acoustic worker host; ordinary YouTube file acquisition is not enabled by this increment.
- [ ] Independently annotate/evaluate alignment and sound detectors before user pronunciation comparison or scores (E remains separate).

See [implementation, setup and verification](design/docs/STAGE_TWO_SERVER_REFERENCE.md). No placeholder comparison endpoint or completed detector claim.

Rhythm display verification: eight mapping/stress regressions cover clock origins, unknown/variant dictionary stress, wrong sentence/labels, sparse/non-monotonic caption timing, ambiguous pauses and quality gates. File-reference desktop/mobile browser checks cover text markers, sentence switching and shared dictionary loading. Local desktop/mobile checks exercise actual Silero/Pitchy inference, microphone replay and preserved layers; the real AudioWorklet/PCM/WAV regression passes. Synthetic fixtures verify rendering and timing plumbing, not linguistic accuracy.

## Shadow login and persistence (2026-09-19)

- [x] Gate Start shadowing, direct Stage 2 links and refresh on loaded Clerk identity; retain source, segment, sentence, settings and fragment through sign-in/sign-up.
- [x] Add owner-scoped durable attempts with idempotent create, source validation, paged history and deletion.
- [x] Add consented private learner recording upload, authenticated playback, byte/hash/container checks and recording-only deletion.
- [x] Save completed takes automatically with an optional retention checkbox and an account-bound bounded retry queue above stage navigation.
- [x] Apply the Supabase table/private bucket migration and verify real synthetic audio create/upload/read/retry/owner isolation/delete; remove synthetic fixtures.
- [x] Add API and web tests covering auth, consent, owner separation, retries, limits and deletion races.
- [x] Verify desktop/mobile login gating, return URL, save/retry across sentences, history after refresh, playback coordination and deletion with synthetic browser fixtures; inspect history screenshots.
- [ ] Verify hosted Clerk sign-in/registration completion with real credentials; test resource emitters are not real OAuth verification.
- [ ] Add durable offline pending-data recovery; cloud analysis and persisted descriptive evidence are now delivered by the 2026-09-22 increment above.
- [ ] Add scheduled interrupted-upload/deletion reconciliation, tombstone/backup retention, export and account-closure handling before production.

See [persistence contract](design/docs/STAGE_TWO_PERSISTENCE.md). This advances basic private attempt/history storage ahead of file references without completing the rest of F4.

Validation: root lint/build/test passed (393 API, 184 web and 112 extension tests). Supabase verification confirmed a private 8 MiB bucket, enabled table RLS and no remaining synthetic fixtures; security advisors returned no warning/error for the new objects. Browser fixture identity is intentionally separate from real Clerk/OAuth verification.

Existing Stage 2/caption browser suites now use a shared signed-in fixture and record-only API stubs. The navigation suite passed at 1440, 768 and 390 px; its loop assertion waits for the actual seek event rather than assuming a fixed browser-timer delay.

## Active Stage 2 architecture follow-up: file references

### Offline acoustic benchmark foundation (2026-09-13)

- [x] Define strict versioned offline sample/result contracts, independent evidence gates, provenance, units, uncertainty and synthetic/human separation; export JSON Schemas.
- [x] Acquire and checksum 16 licensed public adult speech clips (8 reference / 8 learner, 4 speakers, 49.107 seconds), retain source/permission records and a bounded reproducible downloader.
- [x] Add offline WAV integrity, speaker/source/recording split validation, exact result binding and target-level measurement/classification reports with missing-prediction denominators.
- [x] Add double-review/adjudication instructions and a separate, unexecuted 256-recording collection plan; leave all 64 seed annotation tasks pending.
- [ ] Expand the real corpus toward the proposed 200–300 recordings and complete independent human target selection, annotation and adjudication; freeze a versioned benchmark.
- [ ] Add a sufficiently sized speaker/source-disjoint test set, annotation agreement and confidence intervals; establish detector release thresholds.
- [ ] Connect a real offline alignment/feature engine and evaluate its output; this tool does not invoke MFA, ASR or acoustic detectors.

See [the executable benchmark](apps/api/benchmarks/acoustics/v1/README.md). Public source transcripts are unverified, existing source pronunciation scores are not imported as phenomenon labels, and the two source corpora have no paired reference/user text. Schema/synthetic regression success is not speech accuracy. Online file-reference F1–F4 and M4b remain pending.

Verification: all 16 original WAVs passed checksum, format and payload checks. The unrun result template and evaluation command reported 64 `not_evaluated` targets, zero eligible annotations and `release_ready=false`. The 115 new offline contract/integrity/metric regressions passed; root `pnpm lint`, `pnpm build`, and `pnpm test` passed with 382 API, 179 web and 110 extension tests (671 total). The API suite emitted an upstream Starlette/httpx deprecation warning. No paid provider, detector inference or learner UI test was needed for this offline-only increment; schema regeneration is checked against the committed exports.

### Stage 1 buffered-reference increment (2026-09-13)

- [x] Review `toneflow_audio_acquisition_flow.html` against the current JSON3 contract and actual Chrome/MFA capabilities; document unsupported claims and open questions.
- [x] Implement an explicitly enabled v3 source session across Stage 1, picker, preparation and Shadow; keep v2/v3 media ownership mutually exclusive.
- [x] Keep bounded PCM and actual audio/video-time coverage, rejecting seek/pause/buffer/rate/generation gaps and stale/evicted data; extract a real WAV from one complete run.
- [x] Show separate text, reference coverage and analysis readiness; prepare missing ranges through visible, cancellable 1× listening, while retaining basic practice access.
- [x] Reuse bounded reference analysis across stages and demand current/next sentences without whole-video preprocessing or invented Sound results.
- [ ] Verify actual Chrome toolbar authorization and target YouTube audio/boundary quality; synthetic browser playback cannot establish this.
- [ ] Resolve source permission for cloud upload/sharing, then implement the media API/storage/worker path and separately validated alignment/detectors. No such API was added in this local increment.

See [implementation and review](design/docs/STAGE_ONE_BUFFERED_REFERENCE.md). Product decisions now accept one explicit Chrome toolbar grant per same-document, same-source practice session and authenticated learner-data persistence. Third-party YouTube reference media may enter the server path only when the source rights permit it; the implemented local path still requires explicit activation and uploads no media.

Verification: root `pnpm lint`, `pnpm build`, and `pnpm test` passed, with 267
API, 175 web and 84 extension tests (526 total). The v3 browser suite passed
at 1440/390 px, including actual Silero/Pitchy inference, microphone recording
and replay, dual-speaker Rhythm/Melody, Sound abstention, shared analysis,
cross-stage session reuse, explicit missing-range preparation and no uploads.
A separate real AudioContext → AudioWorklet → PCM → WAV check passed with a
synthetic source, including pause/rate rejection and generation-gap handling.
Navigation passed at 1440/768/390 px; caption-timing availability states passed
at 1440/390 px. The dedicated Sound suite also passed at 1440/390 px, including
source selection, dictionary states, retry/cancellation, caching, keyboard
navigation and overflow. Earlier browser navigation attempts timed out; the
local development server was found unavailable during diagnosis. After
restarting it, the unchanged navigation timeout and functional assertions
passed. Failure-only request diagnostics were added without assuming all earlier
timeouts had the same cause. Updated preparation and Shadow screenshots were inspected.
The browser suites intercept player/API/extension boundaries; these checks do
not establish live YouTube capture or acoustic timestamp accuracy.

### Caption-first increment (2026-09-13)

Passive-player-response follow-up:

- [x] Replace independent `baseUrl + fmt=json3` fetching with a static `document_start` MAIN observer for the player's own fetch/XHR JSON3 responses, without exporting credentials or replaying requests.
- [x] Preserve bounded, source-bound handoff/recovery and distinguish observer missing, no observed response, network/empty/invalid/oversized response, response-read timeout and extension communication failure.
- [x] Complete observer/bridge regression and real-unpacked-extension fixture verification; record exact results below.
- [ ] Reload the updated extension and source page, then verify actual target-video JSON3 recovery and usable highlighting. Fixture success is not live YouTube validation.

The learner's `g2A6-5_EY7w` player request returned HTTP 200 JSON (53,031 compressed bytes) and the learner confirmed `tOffsetMs`. Read-only browser resource inspection found a matching base-parameter fetch without the player's added `pot`/client parameters. This establishes a working player source and a request-context mismatch, not a controlled proof that any single omitted parameter caused the other request to fail. The new path consumes player responses instead of guessing that context.

Passive-observer verification: root lint and production build passed; a forced, uncached full test rerun passed 556 tests (267 API, 179 web, 110 extension), including 23 observer cases. Actual unpacked-extension tests against intercepted fixtures passed with a background source tab, fetch/XHR text/JSON bodies preserved, home-to-watch navigation, late installation, stale responses, TTL and old-handoff independence. All eight subtitle requests across two isolated profiles came from explicit player-fixture requests; cache reads added none. The browser test exposed background-page timer throttling, so the reader now takes one immediate snapshot instead of polling. Web recovery checks passed eight desktop/mobile scenarios, including nine safe status messages at both widths; screenshots were inspected. These checks do not establish live YouTube recovery, and no live API/database/media request was made by the browser fixtures.

- [x] Capture the current video's bounded, sanitized JSON3 track before opening Stage 1 when the player has already returned it; wait briefly for the observer event, then preserve milliseconds and use the block-level fallback without delaying indefinitely.
- [x] When an English automatic track is advertised and captions are off, make a bounded best-effort CC/settings selection through YouTube's visible controls, restore the prior captions-off state after the read, and retain a safe fallback when private controls or trusted gestures reject it.
- [x] Carry structured captions through handoff, content resolution, queue/private source storage, worker previews and completed blueprints.
- [x] Share one sentence/word mapping between stages; distinguish provider word starts, estimated ends and legacy/block navigation.
- [x] Add local word highlighting with pause/seek/hidden-state cleanup, no missing-word interpolation and no page-level 50 ms state updates.
- [x] Show unavailable/partial word-timing notices in both stages; distinguish disabled/hidden highlights, preserve ordinary listening, and compute status locally from usable timing evidence.
- [x] Reuse semantic analysis for timing-only upgrades; keep source/video/language and sentence identity checks.
- [x] Recover old ready caches through a bounded fresh-caption bridge and timing-only API; show cached content first, reject changed source text without reanalysis, and preserve active Stage 2 practice until the learner returns to Stage 1.
- [x] Bound repeated network payload using opt-in SSE word deduplication, complete reconnect/poll/final snapshots and compressed final JSON; load Stage 2 code on demand.
- [x] Verify desktop/mobile Stage 1/2 rendering, word-clock seek/pause behavior and Sound hidden-text isolation with mocked browser/API boundaries; pass root lint, unit tests and production build.
- [ ] Validate actual JSON3 availability and sentence endpoints on the learner's target YouTube videos, including the `think about` example. Provider timestamps do not establish acoustic word ends.

No ASR, forced aligner, audio download or media-storage migration is added. The existing source-permission launch gate and file-reference F1–F5 work below remain pending. Regression and synthetic performance details are recorded in `design/docs/SENTENCE_SEGMENTATION.md`.

Availability-notice follow-up: root lint/build/test passed (241 API, 151 web,
49 extension; 441 tests). Dedicated mocked-browser checks at 1440/390 px passed
for both stages, including partial/unavailable timing, off/hidden text, sentence
switching, usable playback and no new requests; screenshots were inspected.

Old-cache recovery follow-up: root lint/build/test passed with 267 API, 161 web
and 61 extension tests (489 total). The API preserves all 14 starts in the user's
complete JSON3 excerpt and abstains on its final overlong estimated interval.
An actual unpacked-extension smoke with intercepted fixtures passed old-handoff
recovery, duplicate entry, block-only captions, timeout/retry, source isolation
and no matching tab. Existing timing-status and synthetic-microphone recording
browser regressions passed at 1440/390 px. A check of the real local Lisa Su
cache showed the new retry UI but an extension-response timeout; live JSON3
recovery still requires reloading the unpacked extension and the Web page.
Dedicated recovery browser checks passed all six 1440/390 px scenarios with
exit 0: cached content before the extension reply, deferred application until
Stage 1 is paused, Stage 2 microphone/recorder/player/selection preservation,
explicit exit to apply, absent-extension retry, and stale-source rejection.
Desktop/mobile pending-recovery screenshots were inspected. Parallel audio-buffer
work briefly invalidated shared interfaces/test stubs; it was preserved rather
than overwritten, and final type/lint/build checks were repeated after it settled.
The final shared-workspace test rerun passed 509 tests (267 API, 174 web,
68 extension), including additional tests from that parallel work.

The file-based target architecture is accepted but remains planned. The proposed acquisition default is selected-segment preparation, not whole-video downloading. Existing M1–M4a implementation and verification below remain valid for the local prototype. The caption-first increment above improves its basic playback path without implementing media ingestion. See [the architecture and acceptance criteria](design/docs/STAGE_TWO_FILE_REFERENCE_ARCHITECTURE.md).

- [x] Document the target, source limitations, selected-segment acquisition, learner flow, data/queue boundaries, and migration order.
- [ ] F1: validate an available authorized file source, actual range-fetch behavior/bytes, source time mapping, server acoustic parity, and latency on representative samples.
- [ ] F2: implement versioned segment/sentence assets, private media storage, persistent jobs, quality gates, and recovery.
- [ ] F3: use file references in Shadow, prefetch current/next sentences, remove reference-capture authorization from the normal flow, and apply the planned operation-button styling.
- [ ] F4: implement authenticated asynchronous learner analysis, attempt-bound navigation, optional retained recordings/history, and deletion controls.
- [ ] F5 / M4b: add independently checked word/phoneme alignment and individually evaluated detectors; keep unsupported observations unevaluated.

No media ingestion endpoint, storage migration, source download, server acoustic worker, or new button implementation was added by this documentation update. First-source availability and launch region remain open; do not assume arbitrary YouTube links provide authorized, range-readable audio.

## Milestone 0: keep the foundation green

- [x] Configure pnpm workspace and Turborepo
- [x] Restructure apps and shared packages
- [x] Initialize FastAPI routes and smoke tests
- [x] Add agent and product documentation
- [ ] Add a continuous integration workflow for install, lint, build, and test
- [x] Add web unit-test tooling and one feature-level test

Acceptance criteria:

- `pnpm lint`, `pnpm build`, and `pnpm test` pass from the repository root
- Generated files, dependencies, local environments, and secrets remain ignored

## Milestone 1: connect the web prototype to the API

- [x] Add a typed API client boundary in `apps/web`
- [x] Add development environment configuration for the API base URL
- [x] Replace direct demo rendering with loading, ready, failed, and unsupported states
- [x] Keep demo fixtures available for tests and local story states
- [x] Add contract tests for content resolve, job creation, job SSE/polling, and blueprint retrieval

Acceptance criteria:

- The Stage 1 page can resolve content, create or resume a job, and render its blueprint
- API failures produce a recoverable user-facing state
- Components do not import FastAPI implementation details

Verification notes:

- Stage 1 uses `apps/web/features/stage-one/api/stage-one-api.ts` for content resolve, job creation, SSE progress with polling fallback, and blueprint fetch.
- Stage 1 transcript lines and logic nodes seek the embedded YouTube player. Transcript clicks and playback time updates also activate the latest logic node at or before the current subtitle timestamp. The redundant Chapters UI and estimated chapter timestamps have been removed; the API field remains compatible with existing blueprints. Chunk and structure annotations remain usable when an extracted phrase spans adjacent caption lines.
- Contract coverage lives in `apps/api/tests/test_smoke.py`; web regression tests run through the root test command.

## Milestone 2: implement persistence and identity

- [x] Record the database and auth decisions in `DECISIONS.MD`
- [x] Add the initial relational schema and repository migration directory
- [x] Apply the schema to the hosted Supabase project and clear advisor warnings
- [ ] Replace in-memory repositories behind service interfaces
- [x] Add optional and required authenticated-user dependencies to FastAPI
- [x] Define anonymous local corpus keys and account-merge behavior
- [ ] Add authorization tests for corpus and speaking records

Acceptance criteria:

- Public processing cache data is separate from private learning data
- A learner cannot read or mutate another learner's corpus or sessions
- Anonymous Stage 1 remains usable
- Migrations can create a clean local database deterministically

Verification notes:

- Supabase, Clerk, and Upstash boundaries are defined in `design/docs/DATA_ARCHITECTURE.md`.
- Supabase project `ulrdykwhggcaspylines` has initial, Clerk RLS, processing-document, observability, and idiom-kind migrations applied. Prior advisor warnings were cleared by optimizing Clerk JWT policy expressions; the latest advisor recheck encountered a transport failure.
- Hosted Clerk Third-Party Auth still needs its final Supabase dashboard confirmation for direct Data API access. The corpus path instead verifies Clerk in FastAPI and uses a server-only repository with explicit owner filters. Real-token browser login integration remains unverified.
- Corpus persistence is connected; speaking repository replacement remains pending. New corpus tests cover owner-scoped queries, retry idempotency, cloud-edit preservation, private-source denial, and database failure without memory fallback.
- Auth return targets are explicitly set for login, registration, and cross-flow transfers using the full URL captured on click. Browser regression checks intercept both Clerk modal calls to verify their targets and check Create account hover colors; this does not replace a real credential/OAuth completion test.

## Milestone 3: build the YouTube extension entry

- [x] Correct multilingual ASR language detection using the explicit default audio index and audio language; cover reordered captions, non-English audio, ambiguous defaults and legacy single-language metadata.
- [ ] Verify the updated extension's entry and caption handoff on `-sKAMB10eh0` after manually reloading Libitu and refreshing YouTube. Local regression/manifest checks pass; browser automation cannot open Chrome's extension management page.

- [x] Choose extension build tooling and record the decision
- [x] Add Manifest V3 configuration and a direct toolbar action
- [x] Detect supported YouTube watch pages
- [x] Read video metadata and visible transcript text in the browser
- [x] Open or hand off to the Stage 1 experience
- [x] Add local cache restoration and unsupported-page behavior
- [x] Add player-control and toolbar one-click entry with SPA video detection
- [x] Open Stage 1 before captions/API work and recover the caption handoff on reload
- [x] Gate both extension entries on verified English video metadata

Acceptance criteria:

- The unpacked extension loads without manifest errors
- A verified English video reaches Stage 1 with no media upload
- Non-English or unknown-language videos, unsupported pages, and missing/mismatched video players show a specific reason and do not create a processing job. Missing browser captions on an English video may use the existing backend caption provider; unavailable captions ultimately produce an explicit unsupported state.

Verification notes:

- The first extension version is framework-free and validates `manifest.json` plus referenced files with `apps/extension/scripts/validate-extension.mjs`.
- Both entry points validate the current watch URL/player/title and video language, then open Stage 1 and acquire timestamped browser captions while the web page loads. The current supported-language list contains only `en`. The in-player entry stays disabled while checking and for non-English/unknown languages, exposes a hover reason, uses the existing Libitu icon in YouTube's lower-right control group, and reattaches when the player redraws its controls. Metadata/caption content-script messages are separate, and a missing receiver is injected once before retrying. Unsupported toolbar clicks show a badge/title and in-player message without opening another UI surface.
- Browser captions use a 15-minute `chrome.storage.session` handoff, a same-origin message bridge, and bounded waits. The web app creates the content/job after handoff, replaces its URL with durable IDs, and reuses them on Retry/reload. No media or transcript text is embedded in the launch URL.
- Six extension tests and four additional web tests cover language gating, launch ordering, duplicate clicks, missing receivers, source checks, worker restart, bridge cancellation, and bounded fallback. The real-unpacked-extension Playwright check uses a mocked YouTube SPA/API with YouTube's nested left/right control groups and verifies English enablement, non-English disablement and hover feedback, player-control mounting, page visibility before captions/API completion, navigation invalidation, reader reuse, caption delivery, failed-job Retry without re-resolving the source, durable URL restoration, and narrow-screen overflow. Observed development runs showed the player container and loading state between roughly three and eight seconds under varying development load; these are environment-dependent observations, not a live YouTube playback or model-completion benchmark or a latency guarantee.
- The broader pre-existing Stage 1 browser suite encountered timeouts around corpus restoration and navigation while the local Clerk integration logged session-refresh redirect loops. Real login/corpus browser verification remains environment-dependent; no Clerk credentials were changed as part of this entry optimization.

## Milestone 4: replace blueprint placeholders

- [x] Define the versioned blueprint structured-output schema
- [x] Add a deterministic caption-text processing baseline
- [x] Add a language-model adapter with timeout, retry, and bounded input/output
- [x] Cache jobs by normalized content key and analysis version
- [x] Persist job failure details that are safe to show to learners
- [x] Extract an evidence-checked corpus candidate pool and rank it by learner CEFR level
- [x] Recover pending queue jobs, isolate blueprint caches by analysis version, and reject obsolete work
- [x] Add worker readiness, processing stages, timestamps, timings, and bounded external requests
- [x] Move English subtitle punctuation and sentence segmentation to a local streaming formatter
- [x] Keep the YouTube player mounted while streamed transcript state changes
- [x] Preserve preview-to-final node identity and cancel disposed Stage 1 loading chains
- [ ] Add fixtures for malformed, short, long, and multilingual transcripts

Acceptance criteria:

- Reprocessing the same content and version returns the cached result
- A schema-invalid model response fails safely or retries within policy
- Tests do not require a paid model call

Verification notes:

- Different content IDs now produce source-specific titles, transcript lines, timestamps, and corpus candidates.
- DeepSeek JSON output is validated with Pydantic and retried at most twice for retryable provider or schema failures; automated tests inject a fake analyzer and make no paid calls.
- DeepSeek responses stream into a partial JSON parser and are still checked for truncation and schema errors before completion. Evidence-backed formatting variance is normalized, individually invalid corpus candidates are dropped when valid candidates remain, output budgets start at 32K and remain bounded at 64K, and provider diagnostics include completion-token usage without response or transcript content.
- The `mvp-v9` contract uses the repository-owned Stage 1 system prompt and extracts 16-32 bounded chunks, idioms, and structures with exact source evidence, usage/register/scenario/phonology metadata, CEFR level, and three quality scores. It omits subtitle text and sentence-boundary metadata; duplicate, low-quality, or transcript-unsupported candidates are discarded, while `GET /api/blueprints/{content_id}` applies read-time learner-level ranking and a three-kind-balanced result limit.
- All caption fragments within the explicit 240,000-character job limit remain eligible for evidence. Before punctuation, deterministic token cleanup removes standalone `um`, `uh`, `er`, and `ah`, merges caption continuations, and groups consecutive lines with the same timestamp. The resulting transcript is shared by sherpa-onnx, DeepSeek, Stage 1 display, and evidence checks; the raw caption payload remains stored.
- Reliably punctuated English captions bypass sherpa-onnx. Other captions reach the local model with external punctuation removed, then reuse source words and casing with only the model's normalized punctuation. Duplicate/conflicting marks and high-confidence opening discourse markers are normalized on every path; timestamps and non-filler words remain source-grounded, and invalid or unavailable model output falls back to conservative local merging.
- The backend owns `ANALYSIS_VERSION`; browser clients cannot submit it. Versioned Redis/Supabase reads prevent stale blueprints from crossing analysis versions.
- `pnpm dev` starts API and worker processes together. `/health/ready`, job stage fields, per-stage timings, and structured worker logs make stalled work diagnosable.
- Worker heartbeats include the loaded analysis version and model; readiness reports `stale` when API and worker processes are not running the same extraction contract.
- The Stage 1 web client shows the video immediately after a bounded passive caption preflight, consumes validated summary/logic/corpus and sentence-sized transcript previews over job SSE, and falls back to bounded polling after a stream disconnect. Source URL and YouTube origin state are initialized after hydration so the server and first client render remain identical. The YouTube API owns an imperative iframe inside a React-owned stable container, so transcript callback updates cannot remove the player. The extension never reconstructs or replays the subtitle request.
- Stage 1 subtitle auto-scroll runs only during active video playback. Paused or ended playback suspends alignment while keeping its control interactive; manual transcript scrolling creates a short alignment pause, and the auto-scroll control always toggles the setting, with alignment resuming when it is turned back on during active playback.
- Eight web regression tests cover cancellation, polling fallback, stale/duplicate previews, stable identities, and learner-level ranking. A mocked-API Playwright check at 1440px and 390px verified one job read, one SSE connection, one blueprint read, and preservation of corpus-card, logic-node, transcript-row, and player-iframe DOM identities across finalization; no real provider requests were made.
- Stage 1 recovers old shared URLs whose job or blueprint belongs to an obsolete analysis version by resolving the current server-owned job before retrying the blueprint read.
- A local benchmark on the 50,385-character Peter Thiel transcript formatted 475 caption rows into 645 timestamped sentences in 4.122 seconds on the development machine without calling DeepSeek.
- Production metadata on 2026-09-05 showed a 54,852-character transcript formatting in 12.491 seconds, then spending 230.952 seconds in DeepSeek and failing after repeated output truncation. The old 210-second browser deadline was shorter than the 251.5-second job. `mvp-v7` adds hard output-field limits, uses 32K then 64K, preserves earlier preview fields across provider attempts, waits up to ten minutes, and retains the preview during Retry. A regression test covers non-regressing previews; a paid live `mvp-v7` long-video run remains pending.
- A failed Stage 1 job remains read-only on initial page load; the visible Retry command explicitly resets and re-enqueues it instead of repeatedly reading the same failed job.
- The job-observability migration was applied to Supabase project `ulrdykwhggcaspylines`; post-migration advisors returned only expected informational notices.
- A consented live test completed `pending -> processing -> ready` in one attempt and persisted the result to Supabase.
- The YouTube transcript fallback was verified against a public captioned video without logging transcript content.

## Milestone 5: complete corpus and speaking

Loadout increment (2026-09-30): implements the [fixed contract](design/docs/LOADOUT_IMPLEMENTATION.md), independent setup/preview page, shared real corpus selection, account-bound local drafts, 3 structure / 5 shared chunk+idiom limits with at least one item, authenticated idempotent session creation and refresh recovery. Pending Shadow saves survive client-side navigation. The 2026-10-01 Stage 4 increment above adds real AI role-play, turn persistence and traceable usage observations.

- [x] Connect Stage 1 corpus list, create, and delete with local/account persistence
- [x] Open corpus cards with full source context and persist on-demand analysis details
- [x] Add the cross-content corpus library and saved-item editing interface
- [x] Build speaking loadout selection limits
- [x] Persist owner-checked, ordered loadout snapshots atomically with idempotent creation and authenticated recovery
- [x] Implement the role-play adapter and turn persistence
- [x] Detect selected-item use with transparent evidence
- [x] Generate four-dimension session feedback with supporting turns
- [x] Add end-to-end browser coverage for save, loadout, role-play and feedback (fixture source/auth/provider; real OAuth remains separate)

Acceptance criteria:

- A saved input item can be selected and detected in a speaking session
- Feedback references actual turns and distinguishes measurements from model judgments
- Reloading preserves signed-in state

Partial verification notes:

- Final Loadout root lint/build/test passed (494 API + 252 web + 112 extension = 858 tests; unchanged API/extension tasks reused caches). The frozen-code browser suite passed at 1440/768/390 px, including keyboard interaction, 200%-equivalent reflow, selection limits, guest/account draft recovery, failed-create retry, session recovery, Stage 1 save → loadout → session, and pending Shadow saves across navigation. Two-tab tests exercise real Web Lock contention, continuous typing, stable submission UUIDs, queued writes across SPA links and history Back/Forward, exit protection, and cancellation on account change. Screenshots were inspected. Browser auth/API fixtures do not establish real Clerk/OAuth integration.

- Loadout migration `20260930114115_speaking_loadout_sessions.sql` is applied. Transactional SQL assertions and `scripts/verify_speaking_loadout.py --run-live` passed against real Supabase, including service-only RPC privileges, shared idiom/chunk limits, concurrent retries, owner rejection, and snapshots surviving source edits/deletion. Synthetic fixtures were removed. Browser identity fixtures remain distinct from real Clerk/OAuth verification.

- Selection-card lifecycle is covered by the desktop/mobile browser check: outside dismissal, internal interactions, pin/unpin, replacement of a pinned card, and rejection of late responses for repeated text. New cards start unpinned with a fresh note and explanation tab.

- Corpus cards open a native modal with the original subtitle context and complete explanation/syntax tabs. Unsaved candidates use a page-session cache; new saves include that detail, while legacy saved items call AI only when detail is absent and persist the result to localStorage or the owner-scoped Supabase record. Desktop/mobile browser checks cover dialog bounds, source highlighting, tab switching, save-button isolation, cache reuse, and legacy hydration.

- Stage 1 supports manual transcript selection into a corpus analysis card. The backend exposes `/api/corpus/analyze-selection`, uses maintained explanation and seven-module syntax prompt sections, preserves short phrase boundaries by default, and accepts a completion only when it is an exact span of the current subtitle. The card omits boundary commentary for complete selections and shows a suggestion only when expansion is needed. Provider failures are explicit rather than disguised as generated analysis. Accepted expressions and structure templates use the same durable save path as extracted candidates, including learning metadata and slots.
- Anonymous saves survive reload in localStorage. Login claims guest records into an account-bound outbox and uploads them idempotently; acknowledged items are removed individually, existing cloud edits win, and failures keep unsynced data with a Retry action. Saved is scoped to the current video and uses delete icons, not add icons.
- Twelve corpus-storage web tests cover guest reload/removal, detail hydration, partial merge, account isolation, late-response cancellation, storage failure, uncertain saves, remote deletion failure, corrupt data, token ownership, and cross-tab write-loop prevention. Backend coverage verifies owner-scoped detail generation is persisted and generated only once.
- On 2026-09-04, all 19 web tests and 46 backend tests passed. Desktop/mobile browser checks verified guest save/reload/delete and trash icons even after a saved item's text changed; the four-tab layout was constrained to avoid scrolling/clipping the entire right panel. A live Supabase test verified idiom insert/list/update/delete, edit-preserving duplicate writes, and cross-owner rejection through the server repository. Synthetic data was cleaned up; real Clerk login/logout in the browser remains a separate unverified integration.

## Later milestones

- [ ] Intensive listening and local shadowing
  - [x] Define the backward-compatible Stage 1 to Stage 2 segment data contract
  - [x] Generate source-grounded segments with bounded durations and transcript fallbacks
  - [x] Wire completed blueprint segments through the web API adapter with legacy compatibility
  - [x] Add the Stage 1 bottom CTA entry point for segment selection
  - [x] Implement the Stage 2 segment picker with timeline and selection state
  - [x] Show Stage 2 readiness from actual segment/sentence availability
  - [x] Launch the selected segment into the Stage 2 shadow view
  - [x] Stage 2 Milestone 1: derive versioned sentence units and explicitly approximate caption bounds
  - [x] Stage 2 Milestone 1: sentence directory, previous/next, keyboard navigation, and URL selection recovery
  - [x] Stage 2 Milestone 1: independent play/pause/seek, one sentence-or-segment range, loop toggle, and supported playback speeds
  - [x] Share source-preserving server sentence rows between Stage 1 and Stage 2; merge broken candidates with local spaCy and keep complete long sentences intact
  - [x] Preserve append-only transcript previews, independent same-timestamp rows, and caption-based approximate timings
  - [x] Upgrade legacy blueprint display boundaries in a bounded local cache without paid semantic reanalysis
  - [ ] Expand the real-video boundary evaluation set across speakers and caption providers
  - [x] Stage 2 Milestone 2: browser-local microphone recording and recording lifecycle
  - [x] Stage 2 Milestone 3: one authorized Chrome practice audio session, automatic sentence reference capture, cache and playback continuity guards
  - [x] Stage 2 Milestone 3: local Silero/Pitchy analysis, quality gates, and Rhythm/Melody measurements and curves
  - [ ] Validate live YouTube capture and real-speaker acoustic quality across devices
  - [x] Stage 2 Milestone 4a: source-bound Sound rule candidates, dictionary coverage and expected/observed separation
  - [x] Stage 2 three-layer UI: persistent Sound/Rhythm/Melody tabs, layer shortcuts, word cards and central canvas/right focus layout
  - [ ] Stage 2 Milestone 4b: word/phoneme alignment and individually validated Sound detectors
- [ ] Reading workspace, starting with pasted text
- [ ] Article URL extraction after supported-source rules are defined
- [ ] Product analytics and privacy-reviewed event tracking
- [ ] Deployment, observability, backups, and production runbooks

Do not add spaced repetition or social features unless a new accepted decision changes MVP scope. Real-time voice role-play was accepted under the 2026-09-30 decision and is implemented locally in Stage 4 above. Server-side practice media follows the file-reference and learner-persistence decisions; it does not authorize unrestricted YouTube downloading.

Stage 2 Milestone 1 acceptance and verification:

- A learner can select any available sentence, navigate with Previous/Next or the directory keyboard controls, and hear either that sentence or the enclosing segment. First/last controls are disabled appropriately; empty sentence data retains segment playback.
- Entering, changing sentence/range, or refreshing stays paused. Play starts only through a playback action. Turning repeat off stops at the active range end; a paused player never restarts itself, and only one range owns looping.
- Sentence IDs survive reload with unchanged source data. Refresh restores valid segment/sentence selection without creating another analysis job. Obsolete selections recover safely while preserving source/job/level query parameters and the URL fragment.
- Unit coverage exercises caption continuations, shared timestamps, repeated sentences, source changes, URL preservation, pre-ready playback commands, rapid seeks, stale time samples, range completion, and recoverable seek failure. Browser coverage uses mock API/player fixtures at 1440, 768, and 390 px; live YouTube boundary accuracy and microphone processing are outside this milestone.
- On 2026-09-08, root `pnpm lint`, `pnpm build`, and `pnpm test` passed (46 web, 63 API, and 6 extension tests). Stage 1 browser regression passed at 1440/390 px; Stage 2 navigation and player geometry passed at 1440/768/390 px. Desktop/mobile screenshots were inspected, and `git diff --check` passed.

Shared sentence delivery (2026-09-09): implementation and measured verification are recorded in `design/docs/SENTENCE_SEGMENTATION.md`. New formatters preserve sentence boundaries and timing metadata through preview/final/personalization; regression coverage includes long windows, incomplete tails, repeated source words, local-provider failures, old-cache immutability, and segment containment. Verification passed: 98 API tests, 51 Web tests, 6 extension tests, lint/build, Stage 1 browser checks at 1440/390 px, and Stage 2 at 1440/768/390 px. One real public caption sample and its punctuation-stripped variant were measured without a paid analysis call. Multi-video human-labelled quality evaluation remains an ongoing task, not a claimed accuracy percentage.

Stage 2 Milestone 2 acceptance and verification:

- Record sentence requests audio-only microphone access on an explicit click and binds the take to the selected shared sentence ID. Requesting, recording, finishing, ready, and error states are visible; the learner can Stop, Cancel, Replay/Pause, Record again, and Delete.
- A 60-second auto-stop and a 5-second finalization deadline bound recording work. The final Blob is exposed only after the recorder's final data/stop events. Same-sentence cancellation or failure preserves the previous take; successful replacement revokes it once.
- Switching sentence, Back to segments, the Stage 1 header, page exit, and refresh discard temporary recordings. Range changes and hidden tabs cancel unfinished capture while retaining a finished same-sentence take. Late permission grants release their tracks immediately and cannot restore an abandoned recording.
- Reference playback, microphone capture, and replay are coordinated, including native YouTube play events. Recording and replay never resume automatically. Microphone streams, timers, listeners, and object URLs have explicit cleanup paths, including React Strict Mode remounts.
- Audio stays in page memory without server upload or browser-storage persistence. No acoustic result or score is attached to recording success. Permissions, missing/busy/disconnected devices, unsupported encoders, empty data, failed finalization, and replay failures remain recoverable.
- Twenty focused recorder tests cover races, final chunks, MIME fallback, elapsed timing, timeout, interruption, and resource release. `apps/web/tests/stage-two-recording.browser.mjs` passed at 1440/390 px using real Chrome MediaRecorder with synthetic microphone input and mocked reference/API data. It verified actual Blob encoding, decoding, playback and cancellation/retention behavior, and caught a Strict Mode audio source cleanup issue that was fixed. Screenshots were inspected. Physical microphones, Safari, and live YouTube interaction remain unverified.
- Final verification on 2026-09-09 passed root `pnpm lint`, `pnpm build`, and `pnpm test`: 71 web, 98 API, and 6 extension tests. Stage 2 sentence navigation passed at 1440/768/390 px after a retry of an initial page-load timeout during concurrent verification. Recording browser checks passed at 1440/390 px, and `git diff --check` passed.

Stage 2 Milestone 3 acceptance and verification:

- Enable practice audio plus one same-tab Chrome toolbar invocation opens the current practice session without autoplay or idle encoding. Normal sentence listening at 1× prepares each missing reference automatically. The extension checks origin, top frame, document/tab/session/clip identity and its private capture token, retains one authorized tab stream and audible monitor, and creates one bounded recorder per requested sentence. Sentence/hash changes retain the session; source/content/segment changes, document exit, lease expiration, disconnected tracks and worker restart close it. Metadata-only session recovery never persists audio.
- The web waits for the recorder before playback. Initial-position and elapsed/media-clock checks reject seeks, stalled playback, mid-capture buffering, rate changes, early pauses, missing samples and late results. Native play caused by a paused seek cannot start capture. Microphone Record/Replay cancels reference encoding before it starts; normal Pause, hidden tabs and sentence selection cancel only the clip. Range/loop/speed controls are temporarily disabled during capture. A completed capture continues the learner's requested loop without recapture. A healthy session survives clip failure/cancellation.
- A per-practice LRU cache holds up to 20 results keyed by content/source/shared sentence/bounds/analysis version. Switching sentences reuses features and lets already accepted work finish for its original key. One reference worker and a two-clip/12 MiB analysis queue bound work; raw reference bytes release on completion, while model-error retry may retain them for at most 60 seconds. Explicit Play can retry failed/insufficient references; ordinary loops do not repeatedly analyze. Exit/refresh clears cache and pending work. The microphone remains one temporary current-sentence take.
- Silero V5 / ONNX Runtime Web and Pitchy run locally in an abortable Worker with pinned, verified, same-origin assets. A source-bound panel shows loading/error/retry, quality-gated speaking span, internal pause counts/duration, pitch range, normalized relative contours and speech regions. Missing reference permits user-only analysis. Insufficient speech or pitch produces explicit abstention, never an invented score or silent fallback detector. This milestone adds no ASR, Sound detector, paid speech key, media upload or feature persistence.
- Initial M3 verification on 2026-09-09, before the session workflow revision: root lint/build/test passed with 102 web, 98 API and 25 extension tests (225 total). Web additions included 14 reference lifecycle tests and 17 signal/worker/client tests; the extension added 19 bridge/background/offscreen tests. Model/runtime asset preparation and actual ONNX inference passed. An actual unpacked-extension smoke verified the original arming/cancellation flow, metadata removal and no active stream/offscreen context, and caught an unbound service-worker timer error, which was fixed. In this environment CDP keyboard input did not invoke the browser's toolbar action in either headless or headed Chrome, so full `getMediaStreamId` → offscreen capture remains a manual-toolbar verification boundary.
- Initial M3 `stage-two-acoustics.browser.mjs` passed at 1440/390 px with actual Silero/Pitchy workers, same-origin model/WASM fetching, real Chrome microphone encoding and a generated artificial English voice. Extension messages and YouTube playback are simulated in that test. It checked absent extension, buffered playback, native rate/state events with stale getters, cancellation, late responses, sentence cleanup, measurements/charts and no media/feature API writes. Screenshots were inspected, including narrow-screen layout. Synthetic speech does not establish detector quality for learners.
- Regression browser checks passed: Stage 1 at 1440/390 px, M1 navigation at 1440/768/390 px, and M2 actual MediaRecorder with synthetic microphone at 1440/390 px. Live YouTube timing/ads, a physical microphone, real-speaker quality, Safari and production extension origins remain unverified. Setup and the exact shipped/planned boundaries are documented in `design/docs/STAGE_TWO_ACOUSTICS.md`.
- Initial M3 production smoke also passed at 1440/390 px against `next start` on an isolated local port, after the final build. It verified the bundled Worker and same-origin model/WASM path with actual Silero/Pitchy results, rather than relying solely on development-mode behavior. The temporary production server was stopped afterward. Source cleanup drops previous Blob/features when the analysis source is cleared; memoized charts avoid rebuilding on each playback clock tick.
- Session revision verification on 2026-09-09: root `pnpm lint`, `pnpm build` and `pnpm test` passed with 122 web, 98 API and 33 extension tests (253 total). Focused coverage includes 21 reference lifecycle cases, 11 reference-cache cases and 13 player-controller cases, alongside extension stream reuse, no idle encoder, clip cancellation ordering, stale identity, page lease and navigation checks. The actual unpacked v2 bridge passed `armed → closed`, metadata removal and no active offscreen document. The full toolbar-authorized two-clip capture remains the manual check described above.

- The revised v2 acoustic browser flow passed at 1440/390 px on the dev server: one grant without autoplay, automatic Play capture, failure/retry preserving the session, microphone/replay interlocks, first-capture loop continuation, same-session next sentence, cached return without another worker, paused-seek transient Play rejection, disable retaining features and exit clearing them. It runs actual local Silero/Pitchy and Chrome microphone encoding against generated speech, with simulated extension/YouTube boundaries and no media/feature API writes. M1 navigation passed at 1440/768/390 px, M2 recording at 1440/390 px and Stage 1 browser regression at 1440/390 px.
- The final v2 production build passed the same acoustic browser flow at 1440/390 px on an isolated `next start` server. The fixture now waits for asynchronous close-message delivery before asserting cleanup. Enabled-session controls and computed measurement/curve screenshots were inspected at both widths with no horizontal overflow. Content/segment/source URL key the practice component, so a changed source cannot inherit an old capture. The isolated server logged Clerk session-refresh redirect warnings; this anonymous fixture does not verify signed-in authentication. The temporary production server was stopped, and final `git diff --check` passed.

- Same-document handoff fix (2026-09-15): `StageOneReader` now owns the single `BufferedReferenceSession` and provides it through `BufferedReferenceProvider`; the dynamically mounted Stage 2 consumes that context as its canonical session, so it cannot fall back to the legacy `Practice audio` panel after the Stage 1 → Stage 2 transition. The extension keeps the same tab lease when a same-source URL update also reports a transient `loading` status, preserving the REC badge and one-time toolbar grant. Root lint, build and test passed with 382 API, 179 web and 110 extension tests; the buffered Stage 1 → Stage 2 browser flow passed at 1440/390 px.

Stage 2 Milestone 4 acceptance and verification:

- M4a adds the Sound guide for the selected shared sentence. The API obtains its text from the current server blueprint and returns versioned dictionary pronunciations, UTF-16 occurrence offsets and conditional rule candidates. It receives source identifiers only, never audio or arbitrary transcript text. Unknown or ambiguous words are labelled, punctuation blocks cross-word rules, and exceeded processing limits are explicit. All-uppercase abbreviations are not silently treated as ordinary words (`SAT` versus `sat`).
- The panel offers five phenomenon filters, source-span highlighting, a possible phone change, its conditions, and separate Reference/Your voice states. Missing, loading, failed and usable M3 audio never produce a detected Sound or pronunciation score. Switching sentences cancels stale requests; returning to a cached sentence reuses its guide. A dictionary/API failure keeps listening and recording usable and offers Retry sound guide.
- The prototype-aligned UI exposes Sound, Rhythm and Melody as separate accessible tabs and synchronized left-side shortcuts. Each layer has its own central canvas and right-side focus. Panels remain mounted when hidden, so tab changes preserve sentence selection, playing/recording state, Sound filters/selection/revealed hints, and cached results. Left/Right wrap between tabs; Home/End select the first/last tab. Tab changes do not seek, play, record or invoke another analysis.
- Sound word cards show dictionary IPA and conditional phenomenon badges; selecting a card or source occurrence updates its explanation and conditions. Hide text covers words, IPA and source-revealing detail, including the current Sound practice prompt and selected directory entry. Covered cards reveal individually; Reveal all restores the sentence. Rhythm contains speaking span and separate speech/pause timelines, while Melody contains relative pitch contours and pitch range. Both use the same existing analysis results and retain quality gates; empty plots do not fabricate measurements. Word stress and nuclear stress remain explicitly unevaluated. Video, playback, recording and practice-audio controls stay mounted together above the layer workspace. The video is followed by one neutral operation bar ordered as Play reference, Record/Stop, Replay mine, then Range/Loop/Speed; a compact reference-connection row and collapsed How It Works help follow it. Desktop uses a wrapping horizontal layout and mobile stacks the same groups without horizontal overflow. Long setup copy stays collapsed while errors remain directly visible.
- The first candidate baseline is deterministic dictionary/rule inference. It introduces no paid LLM call, additional API key, database migration or audio persistence. Backend and browser caches are bounded and version/source-specific. See `design/docs/STAGE_TWO_SOUND.md` for rules, licensing, limits and the detector release gate.
- M4b is still pending: no word/phoneme aligner, content-consistency check or validated allophone detector is connected. Require independently aligned reference/user audio and human-labelled, speaker-disjoint evaluation before reporting realized linking, weak forms, flaps, assimilation or elision. Text-rule test success is not an acoustic accuracy result.
- Verification on 2026-09-09: root lint/build/test passed; 130 web, 185 API and 34 extension tests passed (349 total). New coverage includes 87 Sound API/rule cases and eight web contract/cache/abstention cases. A read against an existing real-video blueprint returned source-matching flap/weak-form candidates and passed the actual frontend parser without reprocessing the video or uploading media.
- Sound browser checks exited successfully at 1440/390 px for filters, repeated occurrences, keyboard focus, empty/ambiguous/unknown states, retry, stale responses, cached return and overflow. Screenshots were inspected. Navigation passed at 1440/768/390 px and recording at 1440/390 px. The acoustic regression completed both viewport assertions, including real Silero/Pitchy results staying unevaluated for Sound, but its Node process retained a socket after Chrome exited and required termination (143). Treat that run as assertions passed with an unresolved test-teardown issue, not a clean full-suite exit. Browser API/player fixtures do not establish phonology or real-speaker detector accuracy.
- Three-layer UI verification on 2026-09-09: the initial root lint/build/test run passed with the unchanged 130 web, 185 API and 34 extension tests (349 total). Sound browser checks and the actual local Silero/Pitchy acoustic suite passed at 1440/390 px and both Node processes exited naturally with code 0. Desktop Sound/Rhythm and mobile Sound/hidden-text screenshots were inspected, along with all mobile layers and measured acoustic views. The checks cover presentation, shared state and local integration; they do not establish real-speaker acoustic accuracy.
- Navigation assertions passed at 1440/768/390 px and recording assertions passed at 1440/390 px. After their browser contexts closed, six identified helpers spawned by the test Chrome/GoogleUpdater processes retained inherited stderr sockets. Stopping only those test-owned helpers let both Node test processes exit with code 0; no forced Node exit or application lifecycle change was used. This demonstrates one source of test-process lingering in the current run; the exact cause of the earlier M4a acoustic teardown symptom was not established.
- UI review found that left-side shortcuts changed the layer without bringing its workspace into view. The shortcut handler now selects the layer and scrolls that workspace into view without controlling audio. Follow-up root lint and build passed after this correction. The updated Sound suite passed at 1440/390 px and exited naturally with code 0, including full tab-list visibility after a shortcut, unchanged guide/worker/player counts and retained DOM identities.
- Media layout follow-up: grouped the video and Play/Range/Loop/Speed controls beside Enable practice audio and microphone recording above all three analysis layers. Mobile stacks video/playback, reference setup and recording before the tabs. Root lint/build/test passed (349 tests); Sound/layout and actual MediaRecorder browser suites passed at 1440/390 px with exit 0. Screenshots were inspected, and the updated layout assertions verify media-before-analysis ordering, desktop adjacency, mobile stacking and preserved layer/player state.

Post-M3 production data and content-rights work (planned, not implemented):

- [ ] Define authenticated practice-attempt, assessment-evidence, learner-profile, recommendation-event, recording-object, purpose/consent, and deletion-state contracts. Keep self-reported and assessed levels separate; retain task conditions, evidence quality, reference/model versions, and uncertainty.
- [ ] Add optional learner recording upload for current cloud analysis and a separate long-term replay/history choice. Add access, export, deletion, retention, processor, and account-closure behavior. Keep model training or human review as a separate opt-in that defaults off.
- [ ] Add a licensed-content registry and ingestion path for rights-holder-supplied media/captions. Store one versioned reference clip/feature set per licensed sentence and reference it from learner attempts rather than duplicating it.
- [ ] Restrict ordinary YouTube persistence to approved locators, permitted metadata, sentence identities/bounds, and learner-owned attempts/results. Resolve D-003 before production; browser-local tab capture and DOM caption acquisition are not treated as proof of platform permission.
- [ ] Select the first concrete overseas countries and complete their privacy, copyright, consumer, child-safety, transfer, and platform checks. Mainland-China launch remains outside the current scope.


2026-09-30 layer guidance correction: restore the right-side Layer focus, Feedback and Tip cards for Sound, Rhythm and Melody. Sound guidance follows the selected phenomenon and uses the current sentence’s rule suggestions; conceal mode also hides word-specific sidebar text. Desktop places guidance beside the layer canvas; narrow screens place it below. The video remains above the workspace. Removing the experimental score sidebar did not authorize removing instructional guidance; no illustrative scores or detected-error claims are restored.

Verification for the September 30 correction: root lint/build/test passed (805 tests). Desktop 1440 px and mobile 390 px browser regression passed, including focus-card positioning, Sound filter synchronization, concealed-text protection, all three layer tips and saved-take recovery. Screenshots were inspected. The upload test now waits for observable state instead of assuming hashing completes within 10 ms.
