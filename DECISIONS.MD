# Track Libitu decisions

```yaml
meta:
  contentType: Reference
  status: active
  updated: 2026-09-30
```

This log records decisions that constrain product behavior or architecture. Add a dated entry when a change affects multiple apps, data ownership, privacy, API contracts, or delivery order.

## Accepted decisions

### 2026-09-30: Include real-time voice in the first Stage 4 delivery

- **Status**: scope accepted by the user; analysis and design only, not implemented.
- **Decision**: Stage 4 includes continuous listening, automatic turn-taking and interrupting the AI. Keep text input available in the same conversation.
- **Supersedes**: the earlier text-only MVP / voice-later scope and voice-role-play exclusion. This does not change the completed Loadout increment or imply that real-time infrastructure already exists.
- **Design proposal**: combine the Stage 4 prototype's scenario, optional logic and training sidebar with the supplied voice-orb and transcript references. Voice/Chat should share session and media state.
- **Still proposed**: provider, transport adapter details, fields/endpoints, retention settings and measured latency/cost limits. The reference images do not select ElevenLabs as the provider.
- **Reference**: [Stage 4 design and implementation plan](design/docs/STAGE_FOUR_IMPLEMENTATION_PLAN.md).

### 2026-09-30: Implement speaking loadout with bounded language and durable snapshots

- **Status**: accepted and implemented; validation recorded in the linked contract.
- **Decision**: chunks and idioms share five expression slots, structures have three slots, and at least one saved corpus item is required in total. Logic is optional. Use the existing scenario, difficulty and feedback enums. Loadout may be entered without completing Shadow.
- **Draft ownership**: keep versioned browser-local drafts keyed by account, bind a guest draft once on login, and preserve an existing account draft until the learner explicitly adopts the incoming draft. Logout/account switches do not transfer account-bound drafts. This resolves the loadout-draft portion of D-006; history/progress merge remains pending.
- **Persistence**: require verified identity and confirmed account corpus IDs at creation. Validate ownership, kind counts and duplicate IDs on the server. Persist session settings and ordered language snapshots atomically with an owner-bound idempotency key. Later corpus edits/deletions cannot rewrite the session.
- **Scope**: implement the loadout and recoverable session preparation page. Real role-play, turn history, detection and feedback remain planned; no new model invocation or voice integration is included. Preserve pending Shadow saves across client-side route navigation.
- **Reference**: [fields, API and acceptance](design/docs/LOADOUT_IMPLEMENTATION.md).

### 2026-09-29: Analyze browser references on the server and unify the workspace

- **Status**: accepted by the user and implemented.
- **Decision**: browser acquisition and server analysis are separate steps. A captured, source-bound sentence can enter the private reference queue with purpose-specific opt-in; it does not need an operator file-source grant. Reuse independently verified reference ASR/MFA/VAD/F0 prosody for matching learner attempts. Pending references hold the learner queue without consuming retries.
- **Presentation**: Sound/Rhythm contain only Reference / Your voice rows. Melody uses a median-relative pitch scale and a shared word axis, with full linked text beneath the chart. Keep video and shared controls above the layers. Retain the prototype’s Sound phenomenon filter strip, inline word badges, linking arcs and legend; highlight exact occurrences and preserve filters/reveal state across layer changes. Display available rule suggestions as possible readings, learner targets as unevaluated and measured vowel/pause timings separately. Remove duplicate central evidence panels and the score sidebar.
- **Supersedes**: local-only browser alignment as the default and the earlier score/filter workspace. Quick local acoustic previews and registered file adapters remain; no pronunciation detector is implied. See [contract and verification](design/docs/STAGE_TWO_BROWSER_REFERENCE_SERVER.md).

### 2026-09-24: Recover saved analyses independently of future-upload consent

- **Status**: accepted and implemented; local regression acceptance passed.
- **Decision**: the choice to analyze new recordings controls future uploads, not access to existing results. Restore the latest take on initial entry or sentence change, preserve manual selection through history refreshes and late saves, and bind new-take selection to its exact save acknowledgement. Refresh a selected same-ID take when its save version changes.
- **Evidence display**: show available learner-only Sound vowel durations and boundary pauses without a comparison score. For file reference plus local learner audio, identify REF/YOU evidence in every layer and present Melody curves on normalized sentence time without claiming word alignment. Saved, aligned paired results retain their existing comparison contract.
- **Boundary**: no new detector, scoring formula, audio upload permission or automatic reanalysis. Root checks and desktop/mobile browser acceptance passed, including actual local inference on synthetic speech. See [the display increment](design/docs/STAGE_TWO_SOUND_COMPARISON.md).

### 2026-09-23: Compare all three layers without fabricating Sound realization

- **Status**: accepted and implemented as an initial measurement increment.
- **Decision**: use paired Reference / Your recording text rows for a selected saved take. Publish versioned, explicitly experimental resemblance for vowel timing, candidate consonant–vowel boundary pauses, word timing and relative pitch; save coverage and abstention states. Do not publish an overall Sound grade or label forced-alignment phones as actual IPA.
- **Consequence**: `practice-comparison-v2` adds phone durations, boundary timing and assessment to existing result JSONB. Old results remain readable, new recordings are required for new evidence. Reference revocation hides nested assessments as well as reference measurements. Weak-form, flap, elision, assimilation, glottal, Drop-D, H-dropping and voicing classification remain pending validation.
- **Details**: [score definitions and evidence limits](design/docs/STAGE_TWO_SOUND_COMPARISON.md).

### 2026-08-30: Use pnpm workspace and Turborepo

- **Status**: accepted
- **Decision**: use pnpm for workspace dependency management and Turborepo for root task orchestration
- **Reason**: the repository contains multiple JavaScript applications and shared packages with independent build tasks
- **Consequence**: use `pnpm-lock.yaml`; root `pnpm lint`, `pnpm build`, and `pnpm test` are the standard verification commands

### 2026-08-30: Organize by deployable app and shared ownership

- **Status**: accepted
- **Decision**: keep web, API, and extension code in `apps`; keep reusable types, pure logic, UI tokens, and config in `packages`
- **Reason**: each deployable surface has different runtime constraints
- **Consequence**: browser-only logic stays out of shared server-safe packages; FastAPI models remain in the API until contract generation is deliberate

### 2026-08-30: Prioritize the input-to-speaking loop

- **Status**: accepted
- **Decision**: the first release prioritizes YouTube blueprint, corpus save, speaking loadout, role-play, and feedback
- **Reason**: this is the smallest flow that tests Libitu's core value
- **Consequence**: reading and intensive listening remain architectural requirements but can ship after the first complete loop

### 2026-08-30: Keep Stage 1 available without login

- **Status**: accepted
- **Decision**: anonymous learners can view Stage 1 and retain eligible local state
- **Reason**: learners should experience product value before account creation
- **Consequence**: private persistence and account merge need explicit rules; public cache data must remain separate from user-owned records

### 2026-08-30: Keep media processing local

- **Status**: accepted
- **Decision**: YouTube audio, video, and microphone recordings never reach Libitu servers
- **Reason**: this reduces privacy, compliance, storage, and platform-policy risk
- **Consequence**: the extension sends accessible transcript text and derived metadata only; unsupported captions produce an explicit failure state

### 2026-08-30: Exclude spaced repetition from MVP

- **Status**: accepted
- **Decision**: do not build review scheduling or calendar-based revision in the MVP
- **Reason**: first validate whether input language transfers into speaking output
- **Consequence**: corpus filters and speaking reuse take priority over review algorithms

### 2026-08-30: Treat integrations as provider boundaries

- **Status**: accepted
- **Decision**: auth, database, captions, and language-model integrations use narrow adapters or dependencies
- **Reason**: provider choices remain unresolved and should not leak through product code
- **Consequence**: documentation must label likely providers as planned until implementation and tests exist

### 2026-09-01: Start the extension with framework-free Manifest V3

- **Status**: accepted
- **Decision**: implement the first Chrome extension increment with native MV3 files and a manifest validation script instead of a bundled React/Vite app
- **Reason**: the immediate milestone needs a loadable YouTube entry and API handoff, not a complex extension UI stack
- **Consequence**: `apps/extension` can be loaded directly as an unpacked extension; introduce build tooling only when browser UI complexity or shared UI reuse justifies it

### 2026-09-01: Use Supabase Postgres for durable data

- **Status**: accepted
- **Decision**: use Supabase Postgres with repository-owned SQL migrations, RLS on exposed tables, and an unexposed `private` schema for source payloads
- **Reason**: Libitu needs relational ownership, versioned public processing data, enforceable private-user isolation, and a managed path to backups and observability
- **Consequence**: `supabase/migrations` is the schema source of truth; public processing data remains distinct from private learning records; hosted deployment still requires a dedicated Libitu Supabase project

### 2026-09-01: Use Clerk as the identity provider

- **Status**: accepted
- **Decision**: use Clerk for sign-in and session issuance; FastAPI verifies Clerk session JWTs and derives ownership from the `sub` claim
- **Reason**: Clerk supports the Next.js and Chrome extension surfaces while keeping password and session management outside Libitu
- **Consequence**: application user IDs are Clerk IDs stored as `text`; clients cannot choose `user_id`; Supabase RLS policies use `auth.jwt()->>'sub'`; anonymous Stage 1 remains available

### 2026-09-01: Use Upstash Redis only for ephemeral coordination

- **Status**: accepted
- **Decision**: use Upstash Redis for rate limits, short-lived processing locks, idempotency hints, and polling acceleration
- **Reason**: these workloads need low-latency expiry but must not become durable product state
- **Consequence**: Postgres remains authoritative for jobs, blueprints, corpus, sessions, turns, and feedback; every Redis-backed flow must recover after cache loss

### 2026-09-01: Separate corpus extraction from learner-level ranking

- **Status**: accepted
- **Decision**: generate one content-level pool of evidenced corpus candidates, label each candidate with CEFR difficulty and quality scores, and personalize the visible subset when the blueprint is read
- **Reason**: language-model analysis is expensive and cacheable by content, while learner level is private and can change; putting level in the generation job would duplicate analysis and mix user concerns into public processing state
- **Consequence**: the `mvp-v2` analysis contract stores up to 24 candidates; blueprint reads return a limited chunk/structure-balanced set ranked for an optional learner level, and later user-profile integration can pass that level without regenerating content

### 2026-09-02: Keep analysis version and queue recovery server-owned

- **Status**: accepted
- **Decision**: FastAPI selects the active analysis version; clients submit only `content_id`, while job IDs, Redis blueprint keys, and Supabase reads are version-specific
- **Reason**: independently versioned extension and web clients created stale jobs and could read a blueprint generated under a different contract
- **Consequence**: pending jobs are re-enqueued idempotently, obsolete queued versions fail without invoking the model, and changing `ANALYSIS_VERSION` invalidates reads without requiring coordinated browser releases

### 2026-09-02: Fail DeepSeek output by cause and salvage safe formatting variance

- **Status**: accepted
- **Decision**: distinguish provider rejection, timeout, truncation, malformed JSON, and schema errors; normalize only bounded formatting differences that retain transcript evidence
- **Reason**: JSON mode guarantees JSON syntax but not the application schema, and one malformed candidate should not be hidden behind an undiagnosable generic error
- **Consequence**: jobs expose actionable safe error messages, worker logs retain field-level diagnostics without model content, and user-triggered retries receive a larger bounded output budget

### 2026-09-02: Use DeepSeek V4 Flash for the mvp-v3 extraction contract

- **Status**: superseded by the compact `mvp-v4` response contract below
- **Decision**: use `deepseek-v4-flash` for Stage 1 and require a mixed pool targeting 8-16 complete chunks plus 4-8 reusable structures
- **Reason**: Stage 1 benefits from lower latency and cost, while extraction quality depends more on full-transcript evidence, explicit selection constraints, and deterministic validation than on using the Pro tier alone
- **Consequence**: `mvp-v3` invalidates earlier blueprint reads, evaluates up to 2,000 caption fragments, filters low-quality chunks, and renders merged sentence-sized transcript lines with conservative punctuation

### 2026-09-02: Keep complete transcript sentences out of the mvp-v4 response

- **Status**: superseded by local transcript formatting in `mvp-v5`
- **Decision**: continue using `deepseek-v4-flash`, but request only short exact sentence-end text anchors and terminal punctuation alongside 12-20 corpus candidates; reconstruct display sentences from the original caption fragments in the API
- **Reason**: repeating a 20,576-character transcript inside the blueprint JSON caused both the 8K and 12K output attempts to end with `finish_reason=length`, while several generated fields were discarded by the application schema
- **Consequence**: `mvp-v4` invalidates the oversized `mvp-v3` contract, guarantees displayed words come from source captions, can split sentences inside a caption row, validates ordered full-transcript coverage, falls back to local merging for bad anchors, and logs completion-token diagnostics for future truncation analysis

### 2026-09-02: Stream validated analysis previews to Stage 1

- **Status**: accepted
- **Decision**: consume DeepSeek Chat Completions as SSE, parse partial JSON server-side, publish only closed Pydantic-valid preview fields through a job SSE endpoint, and retain polling as the browser fallback
- **Reason**: DeepSeek V4 Flash supports a 1M context and 384K maximum output, but streaming changes perceived latency rather than capacity; users should see the video and trustworthy completed sections while the final blueprint is still generating
- **Consequence**: the main request uses `stream: true`; Stage 1 first renders cumulative locally formatted subtitle batches, then progressively renders summary, logic, chapters, and transcript-evidenced candidates. The final blueprint still requires complete JSON and full validation. Input is not silently truncated, the per-job limit is 240,000 characters, and the semantic-only response has a bounded output retry

### 2026-09-03: Format subtitles locally and keep DeepSeek semantic-only

- **Status**: accepted
- **Decision**: use the English sherpa-onnx online punctuation INT8 model in bounded overlapping windows before DeepSeek, validate that only punctuation and casing changed, and omit subtitle boundaries from the `mvp-v5` DeepSeek response
- **Reason**: sentence-boundary arrays grew with video duration, delayed the first useful UI, and repeatedly caused otherwise valid semantic blueprints to be truncated; subtitle formatting does not require generative reasoning
- **Consequence**: the worker adds a `formatting_transcript` stage, publishes cumulative sentence previews through the existing job SSE stream, feeds the formatted transcript to DeepSeek for better semantic context, and falls back to deterministic pause/length merging when the local model is absent, unsupported, or fails source-word alignment. The sherpa model files are local deployment assets and are never stored in Git
- **Supersedes**: the `mvp-v4` sentence-end anchor contract

### 2026-09-03: Use the maintained extraction prompt and add idioms

- **Status**: accepted
- **Decision**: load the Stage 1 DeepSeek system prompt from a repository-owned text file and make `idiom` a first-class corpus kind alongside `chunk` and `structure`
- **Reason**: idioms have different canonical-text and evidence rules from verbatim chunks, while prompt-owned usage, register, scenario, phonology, and pattern-family fields need explicit schema support instead of being discarded
- **Consequence**: `mvp-v6` invalidates earlier blueprint caches, accepts 16-32 candidates, preserves the expanded learning metadata, reserves read-time result capacity for all available kinds, and extends personal-corpus validation and storage constraints to idioms
- **Supersedes**: the `mvp-v5` two-kind extraction contract

### 2026-09-03: Explain the learner's exact selection before recommending a save unit

- **Status**: accepted
- **Decision**: treat selected transcript text as the primary explanation target, use adjacent subtitles only as semantic evidence, and preserve the selected boundary unless the model identifies an objectively broken edge whose completion is an exact span of the current subtitle
- **Reason**: a learner often selects a short but valid phrase because its contextual meaning is unclear; expanding every short selection into a sentence hides the answer they asked for and produces noisy corpus entries
- **Consequence**: `/api/corpus/analyze-selection` uses the configured DeepSeek adapter, returns context-specific explanation plus a detailed phrase-or-sentence syntax contract, validates model-proposed expansions against subtitle evidence, and labels provider fallbacks instead of fabricating meaning or IPA

### 2026-09-04: Preserve Stage 1 identity through streamed finalization

- **Status**: accepted
- **Decision**: use content-derived corpus UI identities and consistent logic IDs across previews and final results, apply the same learner-level selection policy to previews, and give each page load one abortable lifecycle shared with Retry
- **Reason**: preview-only IDs forced React to remount cards and logic nodes, unranked previews changed abruptly at completion, and ignoring stale callbacks left fetch/SSE/polling work alive
- **Consequence**: finalization updates existing DOM nodes when evidence is unchanged; selected nodes and local saves survive; duplicate previews are suppressed; aborting a load closes its stream and does not trigger fallback polling. Development Strict Mode and progressive rendering remain enabled. Server-side blueprint IDs and analysis versions are unchanged

### 2026-09-04: Use one timestamped logic navigation

- **Status**: accepted
- **Decision**: remove the separate Chapters region from Stage 1 and keep Logic Flow as the content navigation
- **Reason**: chapters identify topics, while logic nodes explain progression and relationships. Current chapters have labels but no source timestamps, so inferred chapter navigation duplicates logic with weaker evidence
- **Consequence**: delete frontend chapter-time inference and UI. Retain the `chapters` field in the current extraction contract and cache documents for compatibility; this change does not trigger paid reprocessing

### 2026-09-04: Persist and merge personal corpus by verified account

- **Status**: accepted
- **Decision**: save guest corpus locally, persist signed-in corpus through authenticated FastAPI to Supabase, and automatically import guest saves into the first signed-in account
- **Reason**: React state does not survive reload, and private learning data must be separated from shared blueprint candidates
- **Consequence**: claim guest records into an account-specific local outbox before upload, acknowledge entries individually, and deduplicate using account plus source/kind/phrase-derived keys. Existing cloud edits win; failures remain retryable without clearing pending data. Account switches abort stale work and cannot claim another account's pending entries. Saved uses actual current-video records and delete icons; other tabs use plus/check states. Speaking drafts, history, and progress merge rules remain pending

### 2026-09-04: Return authentication to the initiating reader URL

- **Status**: accepted
- **Decision**: capture the current browser URL when opening authentication and supply it as the forced redirect for both login and registration, including transfers between them
- **Reason**: Stage 1 context lives in query parameters; returning to the default home URL loses the active source and job
- **Consequence**: preserve the full same-origin browser URL, including query parameters and fragment, using Clerk's modal options. Do not derive the return target from an arbitrary query-string redirect or read browser state during server rendering

### 2026-09-05: Bound long-video output and preserve retry previews

- **Status**: accepted
- **Decision**: version the compact semantic contract as `mvp-v7`, impose word limits on every generated field, start output at 32K with one 64K retry, and merge streamed retry previews monotonically
- **Reason**: a 54,852-character production transcript fit comfortably within model and application input limits, but both locally bounded output attempts truncated after 230.952 seconds of analysis. The 251.5-second job also exceeded the browser's former 210-second deadline, while a provider retry restarted partial JSON from the beginning and temporarily erased visible fields
- **Consequence**: cached `mvp-v6` blueprints remain immutable while new reads resolve `mvp-v7`; long active jobs may remain connected for up to ten minutes. A provider retry can add preview fields but cannot clear prior summary, logic, chapters, or candidates. Explicit browser Retry retains the latest preview. Inputs above 240,000 characters still fail explicitly until split analysis is implemented

### 2026-09-05: Open Stage 1 from two entries before caption and API work

- **Status**: accepted
- **Decision**: use a button in the YouTube player's lower-right control bar and the browser toolbar action as equivalent one-click entries; open Stage 1 immediately after validating lightweight video metadata, and hand browser captions to the web app asynchronously
- **Reason**: caption polling and sequential content/job requests delayed the entire visible experience; placing the entry with the player controls keeps the action attached to the video and removes the mandatory side-panel interaction
- **Consequence**: the control uses the Libitu icon, follows YouTube's control dimensions, and reattaches after player-control redraws. A random ID references a 15-minute browser-session handoff with origin/source checks. Stage 1 owns content/job creation and replaces the temporary URL with durable IDs for refresh and retry. Missing captions use the existing backend fallback; missing videos never launch processing. YouTube SPA navigation invalidates in-flight caption capture, and repeated entry clicks reuse the open Stage 1 tab. The extension has no side panel; unsupported toolbar clicks use the action badge and title. Faster page visibility does not imply faster model completion

### 2026-09-06: Normalize fillers and shared timestamps before analysis

- **Status**: accepted
- **Decision**: after parsing English captions, deterministically remove only standalone `um`, `uh`, `er`, and `ah` tokens, merge caption continuations, and group consecutive formatted lines that share a source timestamp. Use the normalized transcript for punctuation, DeepSeek, Stage 1 display, and corpus evidence validation while retaining the raw caption payload.
- **Reason**: filler-free display text is easier to read, and one downstream transcript keeps generated `source_text` evidence identical to what learners can see and select. Token equality prevents false removals inside words such as `umbrella`.
- **Consequence**: `mvp-v8` invalidates `mvp-v7` blueprint caches. Punctuation alignment preserves all remaining source words, same-timestamp sentences share one playback row, and filler-only inputs fail explicitly instead of reverting to the raw transcript.

### 2026-09-06: Make subtitle punctuation source-aware

- **Status**: accepted
- **Decision**: treat captions with consistent sentence-ending punctuation as authoritative and skip sherpa-onnx. For captions that need punctuation, remove external sentence marks from the model input, reuse the original source words and casing, and apply only normalized model punctuation. Normalize duplicate or conflicting marks and a small set of high-confidence opening discourse markers on every path.
- **Reason**: YouTube can supply either manually punctuated or automatic unpunctuated tracks. Sending both through the same punctuation pass can duplicate marks, accept incorrect model casing, and produce errors such as `ON, the other hand,,`.
- **Consequence**: `mvp-v9` invalidates `mvp-v8` blueprint caches. Reliable source sentence boundaries are preserved, model alignment still rejects changed word sequences, and DeepSeek, evidence validation, and Stage 1 display continue to share the same finalized transcript.

### 2026-09-06: Gate extension launch on verified video language

- **Status**: accepted
- **Decision**: classify the active YouTube video from its own audio/video and caption-track metadata against an explicit supported-language list, initially English (`en`) only. Do not use browser UI language or title text as evidence.
- **Reason**: the current formatter, analysis prompt, and learning experience are English-specific. Rejecting unsupported input before Stage 1 avoids misleading results while keeping the entry ready for additional languages later.
- **Consequence**: the player button is disabled while language is being checked and whenever the language is non-English or unknown, with a hover explanation. The toolbar action applies the same gate and reports failure through its badge/title plus an in-player message. Language detection runs in parallel with lightweight metadata validation, normalized English codes are passed to Stage 1, and captions/API work remain deferred until after launch.

### 2026-09-06: Persist corpus detail and hydrate legacy saves on demand

- **Status**: accepted
- **Decision**: store the complete explanation, syntax analysis, and captured subtitle context with saved corpus items; request and persist this detail only when an existing saved item lacks it
- **Reason**: a summary card is sufficient for scanning but not for later study, while eagerly analyzing every extracted candidate spends model time on language the learner may never inspect or save
- **Consequence**: corpus card bodies open a full detail modal and save/delete icons remain independent actions. Unsaved candidates use a page-session cache and are not added by viewing. New saves carry cached detail into localStorage or Supabase; owner-authenticated legacy hydration uses `POST /api/corpus/{item_id}/analysis-detail`, and the nullable `analysis_detail` JSONB column preserves backward compatibility. Repeated opens are cache hits

### 2026-09-08: Deliver Stage 2 sentence navigation before audio analysis

- **Status**: accepted
- **Decision**: implement Stage 2 Milestone 1 against the existing completed transcript/segment contract. Derive sentence units in the browser, preserve source token ranges, and use versioned source/timing fingerprints for sentence identity. Mark caption-interpolated sentence times as approximate. Keep microphone and reference-media processing in the browser under the existing media boundary.
- **Reason**: sentence switching and controllable playback can be delivered without a new model, audio pipeline, database migration, or an unverified claim that captions provide word alignment. Existing displayed captions may merge rows and remove fillers; their token positions are not raw acoustic token positions.
- **Consequence**: selecting a sentence or playback scope pauses and seeks. One controller owns the active sentence or segment range; loop on/off cannot start paused playback. `seekTo` is paused by default, while Stage 1 timestamp actions explicitly request autoplay to preserve their behavior. Supported speeds come from the player, and the displayed speed follows its actual rate event. The existing URL stores the segment/sentence selection for refresh recovery. Preparation shows real sentence availability; microphone recording and Sound/Rhythm/Melody results are not simulated. General American remains the initial planned phonology target, and LLM output can propose rule candidates only; actual sound realization and any scoring require separately validated acoustic evidence in later milestones.

### 2026-09-09: Share one sentence boundary between Stage 1 and Stage 2

- **Status**: accepted
- **Decision**: use the pinned CPU spaCy `en_core_web_sm` pipeline after punctuation restoration to conservatively merge broken model candidates. Keep one sentence layer, preserve complete long sentences across processing windows, and publish confirmed rows with source token ranges, stable IDs, boundary provenance, and approximate caption-derived times. Stage 2 consumes these rows directly.
- **Reason**: display-length guards and repeated frontend punctuation splitting turned formatting choices into false practice boundaries. A shared source-preserving contract simplifies both stages without an audio upload or another generative-model call.
- **Consequence**: replace 30/35-word forced sentence endings with bounded inference windows and a provisional tail. Preserve emitted SSE prefixes even if a later model window fails. Retain source punctuation conservatively and mark unfinished tails unresolved. Keep `segmentation_version` separate from semantic `analysis_version`; legacy blueprints receive bounded in-process cached derived views, retaining stored semantic results and personal corpus snapshots. Cold legacy reads still incur local processing. Syntax evidence does not guarantee semantic completeness or improve acoustic timing. Deployment requires the pinned Python model package, with explicit local fallback when unavailable.
- **Supersedes**: same-timestamp output grouping in the 2026-09-06 normalization decision and browser-owned sentence boundaries in Stage 2 Milestone 1; other playback/media constraints remain in effect.

### 2026-09-09: Keep Stage 2 recording temporary and tied to one sentence

- **Status**: accepted
- **Decision**: deliver Milestone 2 with the browser's MediaRecorder and explicit microphone permission, keeping one temporary take for the currently selected shared sentence ID. Use supported MIME formats or the browser default, cap each take at 60 seconds, and keep audio in page memory without upload or persistence.
- **Reason**: learners need a complete record/replay loop before acoustic comparison. A single current take gives an explicit resource lifetime and avoids introducing retention, history, or server processing into this milestone.
- **Consequence**: start pauses reference audio and replay; Stop finalizes the recording asynchronously before exposing replay. Re-recording preserves the previous successful take until replacement succeeds. Cancel, permission rejection, or recorder failure must not erase that previous take. Sentence changes invalidate pending permissions and recorder callbacks and remove the old take. Range changes and hidden tabs cancel unfinished capture but retain a completed take for the same sentence. Page exit, Stage 1 navigation, and refresh release all tracks and temporary playback resources. Native YouTube playback events are also guarded during capture; replay and reference playback cannot run together through the app controls. Capability, permission, device, encoding, and replay errors remain visible and recoverable. No sound phenomenon, prosody, or pronunciation quality is inferred from recording success.

### 2026-09-09: Keep Stage 2 acoustic comparison local and descriptive

- **Status**: accepted
- **Decision**: implement Stage 2 Milestone 3 with Chrome tabCapture/offscreen reference recording, Silero V5 on ONNX Runtime Web, and the MIT-licensed Pitchy 4.1.0 release. Fetch pinned model/runtime assets from the app origin; keep both recordings and derived features in transient browser memory. Use no mandatory Whisper or speech API key.
- **Reason**: the embedded YouTube player exposes control and timing but no PCM stream. Capturing the active Stage 2 tab through an explicit extension invocation obtains local reference audio while retaining the existing no-media-upload boundary. A rule-inference LLM does not establish actual sound realization or learner pronunciation quality.
- **Consequence**: require Chrome 116+ and the updated extension for reference capture, with explicit same-tab toolbar invocation and one bounded capture at a time. Validate playback continuity at 1×; trim approximate setup offsets before analysis. Session authorization, cache lifetime and automatic clip capture follow the subsequent practice-session decision below. Local asynchronous workers measure speech span, internal pauses and speaker-relative pitch with separate rhythm/pitch quality gates. Equal normalized positions do not imply word alignment. Do not generate an overall score, identify Sound phenomena, or claim content consistency or validated detector accuracy. First-use model/runtime download is approximately 13 MiB; deploy generated public assets alongside the app. New model versions or cloud services require a deliberate subsequent decision.

### 2026-09-09: Prepare reference audio automatically within one practice session

- **Status**: accepted
- **Decision**: replace per-sentence Capture reference with Enable practice audio and one explicit Chrome toolbar authorization for the current Stage 2 practice. Retain the tab stream and audible monitor between sentences; create a fresh MediaRecorder only while an eligible uncached sentence plays. Use protocol v2 with separate session and clip identities.
- **Reason**: the application should prepare references as part of listening. Requiring a toolbar action for every sentence interrupts practice, while Chrome's initial extension invocation remains necessary. The browser-local media boundary still rules out assuming that the server already owns reference audio.
- **Consequence**: enabling alone never plays or records. Sentence selection reuses the session; source/content/segment changes and document exit close it. Microphone/replay, Pause and hidden tabs cancel only the active clip. No idle audio chunks or PCM accumulate. A 45-second web heartbeat lease and independent 30-minute maximum bound the session; extension worker restart closes the old stream. Up to 20 reference results are cached in page memory, with one analysis worker and at most two queued/active raw clips totaling 12 MiB in the analysis cache. Successful analysis drops raw bytes; failed-analysis retry holds them for at most 60 seconds and may evict them earlier. Cache keys include source, shared sentence ID, bounds and analysis version. Explicit Play retries unusable references, while ordinary loops reuse cached results. Leaving/refreshing clears all references. The microphone still keeps only the current sentence's temporary take. No ingestion-time audio preparation, media upload, new API key or database persistence is introduced.
- **Supersedes**: the initial M3 per-sentence toolbar workflow and reference-feature clearing on every sentence change.

### 2026-09-09: Persist learner practice data and separate licensed reference media

- **Status**: accepted
- **Decision**: permit authenticated server storage of learner recordings, versioned assessment evidence, feedback, progress, level estimates, and recommendation inputs. Treat current cloud analysis, long-term recording retention, and model training or human review as separate purposes and controls; model training and human review are opt-in and off by default. Retain third-party YouTube reference audio on the server only when Libitu has sufficient content and platform rights. Build a separate licensed-content ingestion path from rights-holder-supplied source files and captions.
- **Reason**: longitudinal comparison, cross-device history, level estimation, and recommendation need durable learner evidence. They do not require copying the same reference audio into every user record. A local-only rule blocks useful account features, while local browser capture does not itself grant permission to store or process YouTube media. YouTube permits official embedded playback but its current policies restrict unapproved audiovisual downloading/caching, audio-video separation, scraping, and some derived uses; official caption download requires permission to edit the video.
- **Consequence**: ordinary YouTube practice stores the video/source locator, sentence identity/bounds, permitted metadata, and private learner attempts/results. It uses the official embedded player and does not promote a captured reference clip into durable storage. Licensed sources are ingested once; reference clips/features belong to the content version and user attempts reference them by ID. Private learner audio uses encrypted object storage, verified ownership, bounded signed delivery, purpose and consent records, processor restrictions, retention/deletion jobs, export, and account-deletion handling. Assessments retain task conditions, evidence quality, model/reference versions, and uncertainty; current Silero/Pitchy results cannot determine CEFR. Self-reported and assessed levels stay separate. Deleting optional audio preserves valid derived history where possible. See [YouTube Terms](https://www.youtube.com/static?template=terms), [Developer Policies](https://developers.google.com/youtube/terms/developer-policies), and [caption download authorization](https://developers.google.com/youtube/v3/docs/captions/download).
- **Supersedes**: the permanent product interpretation of “never upload microphone recordings” and “all microphone processing stays local.” It does not change the currently implemented local M2/M3 flow or authorize existing YouTube tab capture for production.

### 2026-09-09: Target overseas markets first

- **Status**: accepted
- **Decision**: treat overseas markets as the provisional first launch scope and defer mainland-China-specific deployment and compliance work.
- **Reason**: the current YouTube-centred product and content strategy are better evaluated against the actual initial overseas markets before adding a separate mainland content, hosting, and regulatory plan.
- **Consequence**: do not claim global compliance. Before launch, select concrete target countries and complete their privacy, consumer, copyright, child-safety, tax, and platform reviews. Use a strong baseline for purpose limitation, access/export/correction/deletion, retention, recommendation controls, processor contracts, security, and international transfers. Mainland launch requires a separate decision and workstream.

### 2026-09-09: Separate Stage 2 Sound suggestions from acoustic detection

- **Status**: accepted
- **Decision**: deliver M4a with the pinned full CMUdict data and conservative deterministic text/phoneme rules for General American. Resolve selected sentence text on the server; return dictionary variants, exact occurrence anchors and conditional candidates. Keep reference/user Sound realization explicitly unevaluated until M4b has alignment and validated detectors.
- **Reason**: existing Silero/Pitchy results have no word or phoneme correspondence. LLM reasoning and dictionary stress cannot prove sentence prominence or actual allophones, and there is no labelled detector evaluation set in the repository. A reproducible rule baseline makes the annotation UI and counterexamples testable without a new paid service.
- **Consequence**: add a read-only sentence Sound endpoint and per-practice guide cache. Vendor the permissively licensed dictionary data with its license, upstream commit and checksum; do not ship the GPL Python wrapper. Unknown and ambiguous dictionary readings abstain from phone-dependent rules. Do not claim a 95% annotation/detector accuracy or turn absent acoustic evidence into incorrect pronunciation. An LLM may later refine rule candidates through a separate versioned, validated text-only adapter; it is not implemented in this increment. User-data persistence and licensed reference ingestion remain subsequent milestones.

### 2026-09-09: Present Stage 2 as three persistent practice layers

- **Status**: accepted
- **Decision**: follow the three-layer prototype's Sound, Rhythm and Melody organization with independently accessible tabs, synchronized left shortcuts, a central canvas and a right-side layer focus. Reuse current dictionary/rule and acoustic results; preserve the existing media controls. The subsequent media-layout decision places them together above the layer workspace.
- **Reason**: the combined Timing & pitch panel obscured Rhythm and Melody as distinct practice goals. Separating the views makes the prototype's learning flow available with the evidence the application already has.
- **Consequence**: keep panels mounted during tab changes and share the existing per-recording analysis and reference cache. Preserve sentence, playback, recording, guide filters, selection and revealed hints; tab keyboard controls use Left/Right, Home and End without invoking media actions. Sound adds dictionary-IPA word cards, conditional badges and Hide text/individual reveal/Reveal all. Rhythm displays timing/pauses and Melody displays relative pitch/range. Prototype example scores, stress labels and detected errors are not copied into live results; word stress, nuclear stress and M4b Sound detectors remain unevaluated. This is a presentation increment with no new model, endpoint, media persistence or API key.

### 2026-09-09: Target file-based reference preparation for smooth Shadow practice

- **Status**: accepted target architecture; implementation is planned, not delivered by this documentation change.
- **Decision**: replace real-time tab capture as the target reference path with authorized media files, versioned sentence assets, and precomputed features. In response to the segment-download discussion, the proposed default checks source/cache availability at content entry and acquires only the selected practice segment plus bounded context when the learner confirms that segment. Whole-video acquisition is not the default; actual partial transfer depends on source/container capabilities.
- **Reason**: reference preparation should not require an extension authorization, a mandatory 1× listening pass, or repeated work for each learner. Segment-first preparation reduces unused acquisition and processing while preserving the existing YouTube entry and basic practice flow.
- **Consequence**: prioritize source feasibility, persistent media jobs/assets, and file-based frontend playback before additional M4b detectors. Keep recording immediately replayable locally and cloud results asynchronous. Reference and learner computations use pinned compatible versions and independent evidence gates. Text-only LLM rule inference remains separate from acoustic observation. Missing source permission or range capability is explicit; no hidden tab-capture or unlimited full-download fallback. Ordinary YouTube sources retain official playback/basic practice when file reference capability is unavailable.
- **Boundary**: rights-holder source files and authorized provider interfaces are preferred. This decision does not grant permission to download arbitrary YouTube media, create infrastructure, or treat file availability as validated pronunciation detection. Microphone permission remains browser-controlled. Long-term user audio and training choices remain separate under the earlier persistence decision.
- **Supersedes**: the browser-only restriction and Enable practice audio/real-time listening requirement as the future production default. The local M3 implementation and its recorded verification remain implementation truth until migration. See [the detailed proposal](design/docs/STAGE_TWO_FILE_REFERENCE_ARCHITECTURE.md) for defaults, open questions and F1–F5 acceptance.

### 2026-09-13: Prefer available source-caption timing before acoustic alignment

- **Status**: accepted and implemented for the caption/basic-practice path.
- **Decision**: prefer a bounded current-video JSON3 caption request in the extension, retain millisecond event and text-segment offsets, and share one source-preserving sentence/word mapping between Stage 1 and Stage 2. JSON3 is a format, not proof of word granularity. Missing/ambiguous offsets retain block/plain-caption fallback; no ASR or forced alignment is a prerequisite for basic listening or caption highlighting.
- **Reason**: the old browser/string path lost subsecond and duration information and then interpolated word positions. Existing provider offsets can improve navigation/highlighting without acquiring reference audio.
- **Consequence**: distinguish provider starts from estimated ends; never interpret a start-to-start delta as measured silence. Unknown ends and estimated intervals over two seconds do not produce continuous word highlighting. Text/word index, video and language checks prevent unrelated timing from being attached. Source display duration cannot extend an estimated sentence across a following event. Source timing is not Sound realization, phoneme alignment or a guaranteed no-clipping boundary.
- **Cache and delivery**: preserve the semantic analysis version. Rich `sentence-v3`/caption fingerprints and an eight-entry derived-view cache permit timing-only updates without another model call; changed spoken text requires its own analysis. Store a versioned YouTube-only JSON envelope in the existing private `source_text` field, never public metadata or signed request URLs. New blueprint documents retain words. Use optional per-connection SSE word deduplication (legacy clients retain full snapshots), gzip for non-SSE JSON and a local word clock with lazy Stage 2 code.
- **Availability UX**: local development Stage 1/2 explicitly label unavailable or partial word timing using the same eligibility checks as actual highlighting. Turning highlighting off and concealing practice text are separate display states, not evidence of missing timing. Notices never trigger fetching/reanalysis, promise recovery, expose concealed words, or gate normal playback.
- **Boundary**: no audio acquisition/upload, token-generation workaround, database migration, or production caption-rights approval is introduced. ASR/alignment and authorized file references remain separate capability-dependent work. Existing pending source/retention decisions still apply.

### 2026-09-13: Recover missing timing without blocking cached practice

- **Status**: accepted
- **Decision**: keep ready-cache rendering independent from a fresh-caption recovery request. For a ready YouTube blueprint without usable word timing, ask the installed extension once per source to read the matching, already open video tab. Send sanitized JSON3 to a dedicated timing-only endpoint; never route recovery through content resolution, job creation or semantic reanalysis.
- **Reason**: a ready `contentId` URL and a reused extension handoff could bypass caption acquisition indefinitely. A video can have genuine JSON3 word offsets while Libitu's old source and blueprint still contain no word timing.
- **Consequence**: require matching video/language and the same normalized spoken sequence in the stored source and blueprint before a timing update. Preserve stored source text, public metadata, semantic documents and personal corpus. Persist the private caption envelope and refresh source caches without changing the analysis version. Missing tabs, unavailable tracks, mismatched words and persistence failures retain the visible cache, with bounded work and explicit retry rather than automatic retry loops.
- **Practice safety**: apply a recovered blueprint only in the paused Stage 1 reader. An active Stage 2 retains its original sentence IDs, bounds, recorder and reference session; show that timing is ready and ask the learner to return to Stage 1 to apply it. No automatic refresh or hidden recording deletion. Source-bound Sound requests must remain compatible with that old sentence snapshot after the timing update.
- **Boundary**: no new media acquisition, ASR, model API charge, database schema, extension permission, production deployment or guarantee of YouTube endpoint availability. The informational timing notice itself still computes local evidence; recovery has a separate lifecycle and status.

### 2026-09-13: Implement the corrected Stage 1 capture flow locally

- **Status**: implemented local increment responding to the supplied flow; cloud acquisition/sharing remains pending.
- **Decision**: use one explicit same-tab extension grant, an offscreen AudioWorklet PCM buffer and verified continuous 1× playback intervals. Keep the session and local reference feature cache above Stage 1/picker/preparing/Shadow branches. Let the learner inspect coverage, visibly prepare missing ranges, and enter practice without waiting for every analysis layer.
- **Reason**: JSON3 starts already support shared sentence positioning, but the supplied HTML incorrectly assumes unprompted capture, service-worker recording, precise word ends, a `--use_word_timestamps` MFA flag, and reusable alignments across different captures. It also equates video time with recording offsets and proposes accelerated silent capture.
- **Consequence**: retain actual PCM-to-video mappings, per-capture identity, bounded data and one media owner. Extract one fully covered continuous run and prefer the latest complete capture when relistening. Preserve local Silero/Pitchy measurements and Sound abstention. No new media upload, server storage, Realtime integration or aligner is included. First-grant UX and rights for cloud/shared media were raised for clarification; while unanswered, only explicit local activation is implemented.
- **Relationship**: changes the current local prototype, not the availability of permission-cleared source files. The file target remains planned and is still required for a flow without tab-capture authorization or real-time capture waits. See [implementation and limits](design/docs/STAGE_ONE_BUFFERED_REFERENCE.md).

### 2026-09-13: Read player subtitle responses instead of rebuilding dynamic requests

- **Status**: accepted; local implementation, live post-change verification pending.
- **Decision**: install a top-frame, `document_start` MAIN observer on YouTube pages, including non-watch SPA entry pages. Passively copy only current-video, English, non-translated JSON3 fetch/XHR responses. Let the original player create request parameters and consume its own response; never synthesize, export, persist or replay signed URLs/tokens.
- **Reason**: a target video's player returned word-timed JSON3 while the independent base-URL fetch lacked parameters present in the player request. The old path also collapsed unrelated acquisition and bridge failures into one unavailable notice.
- **Consequence**: cache sanitized bounded caption tracks in current-page memory with video/language/track and navigation-generation isolation, finite size/concurrency/time/retention limits, and stale-response rejection. Read response clones or independent XHR completion listeners without aborting the player's request. MAIN wrappers are best-effort and must coexist with page/extension wrappers, not freeze platform APIs. A late installation cannot recover historical response bodies; ask for a source-page refresh. No observed request asks the learner to enable English captions, not to wait indefinitely or trigger automatic caption toggling.
- **Delivery**: retain current content/job/handoff and timing-only API contracts, non-blocking cached Stage 1 and deferred Stage 2 application. Errors are safe cause enums, never signed network errors. No new extension permission, audio/ASR pipeline, model invocation, database schema or deployment is introduced; production source authorization remains pending under D-003.
- **Launch timing**: the initial extension click may wait up to six seconds for the observer cache/event, then uses the existing DOM/provider fallback and opens Stage 1. This is a bounded wait for a player-owned response, not a `pot` extraction or subtitle-request replay.
- **Caption control**: before that wait, the extension may best-effort select an advertised English automatic track through visible YouTube controls; if it changes an active user-selected track, it records the selected label and attempts to restore it after the read. If captions were off, the changed captions-off state is restored. Menu changes, trusted-gesture requirements and missing controls remain expected failure modes.
- **Verified implementation detail**: read one immediate page-memory snapshot. A real unpacked-extension fixture with the YouTube source tab in the background exposed throttling of a proposed 200 ms polling loop; removing that wait avoids misclassifying an unobserved response as an injection timeout. Deterministic and isolated-browser checks pass; live target-video verification remains separate.
- **Supersedes**: the independent advertised `baseUrl + fmt=json3` acquisition mechanism, not the shared timing contract or its acoustic limitations.

### 2026-09-13: Establish offline acoustic evidence before detector scoring

- **Status**: accepted; initial tooling and licensed development seed implemented, human annotation and quality evaluation pending.
- **Decision**: keep an offline Pydantic/JSON Schema manifest and result contract with exact audio/text identity, independent reference/learner records, separate rule candidates and human annotations, per-sample quality/content/alignment gates, and explicit measurement/detection/abstention states. Use public speech with verified source licenses for the first local seed, not Glossika content without project-specific permission.
- **Reason**: a continuous signal or forced alignment does not prove a realized phenomenon, a rule score is not a calibrated probability, and synthetic regression tests cannot validate real-speaker accuracy.
- **Consequence**: bootstrap with 16 adult clips from CMU ARCTIC and SpeechOcean762, all development-only and unpaired, with hashes/attribution and pending annotations. Keep raw media in ignored local cache. Train/dev/test cannot share speakers, source groups, source records or identical audio; missing predictions remain in coverage denominators. Only adjudicated human annotations enter human metrics. Confidence requires recorded calibration provenance, while empty/small/development/synthetic reports never approve product release. A separate 256-recording plan is not completed collection. Drop-D is an Elision subtype; no cross-phenomenon total score is generated.
- **Boundary**: no model training, acoustic inference, online API/media persistence, new provider or F1–F5 completion. This independent baseline work can proceed alongside the accepted file-reference delivery order. See [benchmark scope](design/docs/STAGE_TWO_ACOUSTIC_BENCHMARK.md).

### 2026-09-19: Require login at Shadow entry and persist learner attempts

- **Status**: accepted and implemented for basic records and optional recording retention.
- **Decision**: keep Stage 1/segment selection anonymous; require sign-in when the learner clicks Start shadowing and on direct Shadow URLs. Preserve the same-origin source/segment/sentence URL for both login and registration. Mount recording only for a loaded signed-in identity and request microphone permission only on Record.
- **Persistence**: automatically save each completed take's source snapshot and browser-reported conditions through owner-verified FastAPI. Offer an off-by-default checkbox to retain new recordings privately until deletion, with versioned consent captured at recording start. This does not enable training/human review or cloud acoustic analysis. Authenticated history supports playback and separate audio/record deletion.
- **Reliability**: use immutable account-bound attempt IDs, a private bucket and bounded uploads; retries do not duplicate records. A page-level outbox continues across sentence/stage navigation, surfaces failures and warns before unload. Pending data is not durable offline and is released on account change. Tombstones prevent deleted attempts/audio from being resurrected by late retries; scheduled reconciliation and production retention/account closure remain follow-ups.
- **Delivery order**: basic attempt/recording persistence and this login gate proceed now on the existing source path, before F1–F3 completion. File acquisition and server assessment remain planned.
- **Supersedes**: anonymous entry into the Shadow recording workspace and the permanent interpretation of the earlier M2/M3 temporary-learner-audio rule. Anonymous Stage 1 and local reference-media boundaries remain in place. See [contract](design/docs/STAGE_TWO_PERSISTENCE.md).

### 2026-09-22: Execute the revised server reference pipeline

- User confirmed the acoustic pipeline review and authorized implementation of its A–D reference foundation.
- Keep shared sentence identity; source permission and media availability remain independent of caption availability and learner recording retention.
- Use operator-managed file/hash grants, private normalized reference assets, existing Clerk identity and a durable PostgreSQL queue with fenced worker writes. PostgreSQL polling avoids adding a second queue write; SSE carries committed results and status queries recover interruptions.
- Default references expire within 30 days or earlier grant expiry; unfinished uploads expire after one day. Keep grant/analysis cache identities private by account, with no cross-user sharing in this increment.
- Preserve measured data, rule candidates and independently verified observations as separate concepts. No inferred actual IPA, uncalibrated confidence or pronunciation scoring. User cloud comparison remains stage E.
- Implementation and known operational limits: [server reference pipeline](design/docs/STAGE_TWO_SERVER_REFERENCE.md).

### 2026-09-22: Anchor Rhythm marks to text without inventing acoustic stress

- **Status**: accepted implementation of the requested Rhythm display update.
- **Decision**: use three sizes of solid amber dots, dark to light for dictionary primary/secondary/unstressed syllables, including single-syllable words; retain unknown marks for conflicting/missing patterns. The user's follow-up removes gray/hollow dots and the redundant speech/pause chart. Pause rows use the prototype's compact REF label, phrase blocks, thin vertical bars and durations. Label this as word stress, not observed sentence emphasis. Place detected ≥200 ms pauses between phrases only when the reference timing supports a unique adjacent-word boundary.
- **Consequence**: convert segment-relative alignment to sentence time; local caption positions remain approximate. Estimated word ends never establish silence. Unmapped reference pauses and all learner pauses remain timed entries without guessed text positions or correctness colors. Share Sound's dictionary request/cache; no new classifier, upload or score.


### 2026-09-22: Analyze learner recordings asynchronously under a separate purpose

- **Status**: accepted and implemented following the user's request to deliver asynchronous learner analysis, content/word alignment and saved Rhythm/Melody comparisons.
- **Decision**: remember an account/browser analysis choice separately from optional playback retention. Upload only completed consented takes, use durable PostgreSQL jobs, and keep temporary inputs for completion/review cleanup or a maximum 24-hour retry window subject to worker availability. Retain derived results until user deletion; no training/human review.
- **Evidence**: independent local small.en ASR receives no expected-text hint; exact normalized content matching gates MFA. Compare only independently measured compatible reference/learner words. Weak recognition, mismatches and unavailable references remain explicit. Durations, pauses and relative pitch are descriptions, not observed stress or pronunciation grades.
- **Reliability**: immutable attempt/input/reference identities, owner-scoped private storage, lease fencing, parent deletion triggers and retryable cleanup. Pending browser uploads remain page-local; server jobs survive navigation and refresh after upload acknowledgement.
- **Boundary**: no new paid speech API key, arbitrary YouTube media upload, acoustic detector accuracy claim, production deployment or automatic level/recommendation model. Production operations and human evaluation remain pending. See [implementation](design/docs/STAGE_TWO_PRACTICE_ANALYSIS.md).
- **Supersedes**: earlier status statements that all cloud learner analysis remains planned; their historical validation scope is unchanged.

### 2026-09-26: Align browser-captured reference audio on the learner's device

- **Status**: accepted and implemented; functional verification recorded in `TASK.MD`, independent accuracy evaluation remains pending.
- **Decision**: connect the already captured reference PCM to a browser-local acoustic word/phoneme aligner. Do not require server file-source registration for local reference measurements or source-compatible word-by-word display. Keep source-processing grants distinct from Chrome tab-capture permission.
- **Data flow**: use the same bounded clip for Silero/Pitchy and phoneme alignment, retain capture/source/text/model identity, release raw bytes after completion, and keep results only in the page cache. Fetch dictionary targets and pinned static model assets without sending reference audio or alignment results to a server.
- **Evidence**: forced alignment locates dictionary targets under the expected caption text; it is not independent ASR or observed phoneme recognition. Display local boundaries and measurements with this provenance. Pair with a saved learner result only for an exact compatible word sequence and verified learner alignment. Do not reuse server scores for the new local reference or infer realized speech phenomena from target labels.
- **Supersedes**: wording that three-layer comparison inherently requires file-based original audio. Registered files remain a condition of the current server reference ingestion path, not of local alignment/display. Existing learner upload consent and source rights boundaries are unchanged.
- **Reference**: [browser-local alignment](design/docs/STAGE_TWO_LOCAL_ALIGNMENT.md).

## Pending decisions

| ID | Decision | Needed before | Required evidence |
|---|---|---|---|
| D-003 | Approved YouTube caption/metadata acquisition and retention path | Production YouTube launch | YouTube approval or documented API/rightsholder route, retention limits, takedown behavior |
| D-004 | Language-model provider and output contract | Real processing milestone | Structured output, latency, cost, data policy |
| D-005 | API contract sharing method | Web integration milestone | OpenAPI generation versus maintained TypeScript contracts |
| D-006 | Remaining anonymous history/progress merge rules (corpus and loadout drafts accepted above) | Speaking/history milestones | Progress conflicts, consent, retention |
| D-007 | Exact learner recording, transcript, assessment, log, and backup retention schedules | Production practice persistence | Target-country review, user research, deletion behavior, operating cost |
| D-008 | Initial overseas launch countries and regional infrastructure | Production launch | Market priority, content availability, privacy/consumer rules, latency and cost |
| D-009 | First authorized file source and scope of full YouTube reference support | File-reference F1 and production coverage commitment | Available source files/API, content and platform rights, tested partial-transfer behavior and costs |
| D-010 | Stage 4 real-time voice provider and operating contract | Real-time adapter implementation | Trusted transcript/control events, interruption/context alignment, reconnection, device latency, cost and provider retention settings |

### 2026-09-09: Keep Stage 2 media actions together above analysis

- **Status**: accepted
- **Decision**: place video, playback, reference-audio setup and microphone recording in one shared operation area above Sound/Rhythm/Melody. Use video and playback on the left and reference setup/recording on the right on desktop; stack them in the same order on mobile.
- **Reason**: the learner repeatedly listens and records while watching the source; these actions need to remain close to the video rather than separated by the analysis panels.
- **Consequence**: change layout and document order only. Keep one player, recorder and reference-capture session mounted across layer switches; preserve all existing media safeguards and analysis state.

## Decision entry template

```markdown
### YYYY-MM-DD: Decision title

- **Status**: proposed, accepted, superseded, or rejected
- **Decision**: one concrete choice
- **Reason**: evidence and tradeoff that led to the choice
- **Consequence**: code, data, product, and operational effects
- **Supersedes**: optional earlier decision
```


2026-09-30 layer guidance correction: restore the right-side Layer focus, Feedback and Tip cards for Sound, Rhythm and Melody. Sound guidance follows the selected phenomenon and uses the current sentence’s rule suggestions; conceal mode also hides word-specific sidebar text. Desktop places guidance beside the layer canvas; narrow screens place it below. The video remains above the workspace. Removing the experimental score sidebar did not authorize removing instructional guidance; no illustrative scores or detected-error claims are restored.
