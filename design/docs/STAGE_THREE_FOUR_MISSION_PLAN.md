# Expression-led Mission planning

P0–P4 implementation, 2026-10-20. Verification is recorded in `TASK.MD`.
This connects Loadout selection, generated scenarios, frozen Mission plans,
recorded teaching opportunities, manual support levels, grounded review suggestions,
linked second rounds and opt-in history-based support recommendations.

## Learner flow

1. Select saved expressions or structures, grouped by communicative function.
2. Choose one to three primary targets and zero to two opportunity targets.
   Structures occupy the same target budget, with the existing maximum of three.
   Recommend starting with two primary targets and zero or one opportunity target.
   Choose language that can serve the same communication task and a compatible
   tone; targets need not share a source or topic. One primary target is sufficient.
   Legacy drafts retain all saved selections
   and ask the learner to reduce or reassign them; no silent truncation.
3. Choose workplace/everyday and optionally describe the preferred situation.
   Choose support independently of difficulty; new drafts start with model plus
   frame. Existing drafts without a support setting retain legacy behavior.
4. Press **Start mission**. The default action generates one matching scene when
   needed, selects it only when every primary target fits, saves the frozen Mission and opens it. Reuse a
   valid selected scene or matching cached plan. Among eligible candidates,
   prefer the most high-fit primary targets; preserve proposal order for ties.
   Every primary target must have high/medium fit before starting.
5. **Choose a scene myself** is optional. Expand it to generate two scenes, compare and
   select roles, setting, outcome and per-target fit before starting. Fit is an
   AI suggestion, not a validated pedagogical measurement. Missing corpus
   metadata stays unknown. Low/unknown primary fit prevents starting that candidate.
   The opened Mission shows the frozen roles and setting; the controller
   schedules learner-directed opportunities.
6. Mark a target not applicable, or undo that decision. The target stays in the
   saved history but is excluded from primary coverage while skipped.

Purple primary actions and the existing responsive workspace conventions remain.
The optional logic template is an advanced setting. The main path starts with
language selection; a scenario-first recommendation path is a later increment.

## API and frozen plan

`POST /api/speaking/plans` requires verified identity and takes
`scenario_type`, an optional `brief`, optional `candidate_count: 1 | 2`
(default 2 for existing callers), and ordered
`targets: [{corpus_item_id, role: primary | opportunity}]`.

The server loads owned corpus records, supplies bounded source text/meaning,
functional tags and available metadata to Doubao Ark, and validates exactly the
requested number of distinct candidates. Automatic Start requests one; manual
comparison and linked practice request two. Saved plans accept one to three for
legacy compatibility. All selected inputs are read in one owner-filtered query. Every candidate must retain the same target IDs, order and
roles. Each target includes a communicative function, fit and reason, a learner
question and a skip condition. Questions must not disclose selected wording.
Each new target also has a `sentence_frame`: a natural, unfilled framework of at
most 500 characters containing the complete expression outside at least one
nonempty `[slot]`. Existing structure frames retain their original anchors and
slots; terminal `. ! ?` punctuation (including full-width forms) may differ.
Changing anchors, slot labels/order or adding other content is rejected.
Nested/empty slots and frames without a usable blank fail validation. The
prompt requests an unfilled scaffold; these checks do not prove grammatical or
pedagogical quality. This explicit
wording field is separate from the three non-disclosing implicit fields.
The model-facing frame template uses exactly one `{{target}}` marker. After
verifying the target identity and role, the server expands it with the unchanged
saved text and applies all existing frame checks. Chunks/idioms require a model-
authored `[slot]` outside the marker; structures already containing slots may
return only the marker. Duplicate/nested markers and expanded frames over 500
characters are rejected. No missing slot or scene is synthesized. The public
and stored frame is always expanded; valid literal frames remain supported.
Old saved plans may have a null/missing frame; the UI states its absence and does
not synthesize one. The planner does not claim the learner used a target.
Provider failure remains a retryable error; no deterministic example is
presented as an AI-generated scenario.
Timeout, provider failure, unusable generated scenes and plan-storage failure
have distinct retry messages. Server diagnostics contain only a request ID,
fixed error category, allowlisted schema locations and timing/status information;
they exclude learner content and credentials. A complete, unique target set with
the correct roles may be reordered deterministically to match the request.
Locatable generated-content failures allow one field-repair call under the same
90-second model budget. The server assigns exact task IDs and allowlisted field
paths; AI returns only their new values. A mismatched target array can be replaced
as one field, but untouched scenes/fields remain unchanged. Collect original
schema, frame, implicit-wording and practice-variation errors before requesting
repair. Reject missing/extra/duplicate patch IDs and revalidate the complete merged
result before persistence. Malformed JSON, unlocatable structure or more than 60
schema errors fails recoverably without another complete generation. No generic
scenario or filled-in learner example is synthesized.
The browser allows 120 seconds for input loading, generation and saving; ordinary
Mission creation retains 20 seconds. New frames remain mandatory, server-derived
metadata is omitted from generation, and target IDs are constrained to selection.
Provider transport/authentication/rate-limit/timeout and storage errors do not
trigger repair; the browser never loops failed requests. These changes do not
relax final validation or assert teaching quality.

`GET /api/speaking/plans/{id}` restores an owner-bound plan. The browser fences
generation results by owner and input signature, preserves selection on failure,
and invalidates the cached plan when scenario/brief or selected target order,
roles, wording or source metadata changes. Difficulty, feedback level, optional
logic template and support changes reuse the same scene. Old draft signatures may
require one regeneration; uncertain creation still replays its exact saved request.
The one-button flow shows scene preparation and Mission saving as separate
loading phases within the same action. It saves the chosen plan and creation
request before creating the Mission. An uncertain creation retries its exact
request before any new planning call. No suitable candidate leaves the learner
in Loadout with an explicit explanation and manual choices; it never silently
drops a target or starts without a valid plan.

After the server confirms creation or recovery for the same account and client
request ID, durably clear the matching pending submission before navigation.
Keep the selected language, scene and settings. Returning to Loadout, including
after ending that Mission, can then start a new Mission with a fresh request ID.
Network uncertainty, invalid acknowledgements and storage failures retain the
original retry identity; a late acknowledgement cannot replace another tab's
newer draft. An older stuck request is released by one successful retry, even
when it restores a completed Mission.

## Preparation timing

Backend phase records cover input read, model generation, model repair when used,
validation, plan save, Mission creation and the two existing workspace reads.
Success and failure expose `Server-Timing` and generated `X-Request-ID`. Browser
Performance entries under `libitu:mission:*` add cache hit/miss/retry, request,
navigation-to-ready and click-to-ready measurements. Only latest fixed-label,
bounded timings are retained, without learner/account/session content. Provider
duration means complete JSON response time, not first-token time. No extra
remote calls are made for telemetry; voice startup remains a separate action.

## Selection guidance and recovery

Keep generation errors separate from scene-fit advice. A malformed AI response
does not establish that the learner chose poorly. Show a retry action, retain the
selection, and offer optional selection tips or a way to add scene preferences.
Do not recommend removing a specific target without validated fit evidence.
The trusted web client can read the safe error category and request correlation
headers; credentials and raw diagnostics are not exposed.

When no candidate fits every primary target, explain one concrete candidate:
prefer the current explicit choice, otherwise the fewest low/unknown primary
fits, then the most high primary fits, with stable proposal-order ties.
Display that candidate's title and each affected target's fit reason.
Unknown fit means there is insufficient confidence, not that the phrase is wrong.
Do not merge reasons from different candidates or imply that a target cannot fit
any scene.

The learner can explicitly make an affected target optional, remove it, add a
scene preference, or compare other candidates. A role change must leave at least
one primary and at most two opportunity targets; explain a full opportunity
budget instead of silently changing another item. Each explicit selection change
invalidates the old plan but does not generate or create a Mission until Start
mission is pressed again. Uncertain creation retries retain priority over advice
or replanning.

## Frozen Mission creation

Session creation accepts paired `plan_id` and `candidate_id`. The server verifies
the plan owner, candidate, scenario, goal, ordered items and original corpus
snapshot. It atomically freezes the plan with the language. Edits made during
generation or before creation require regeneration. A committed idempotent retry
returns the original Mission before re-reading a deleted or changed source.

Each frozen target has a stable `session_item_id`; deleting the original corpus
record cannot break its runtime/report association. Snapshot metadata includes
usage note, register, scenario tags and structure pattern family. Source
`daily_life` and Mission `everyday` have an explicit semantic mapping.
`pattern_family` remains specific to structures.

Legacy sessions and previously prepared uncertain creation requests retain their
original contract. New Loadout UI requires a validated chosen plan, selected
automatically by the main action or explicitly through scene comparison. Retrying an existing
planned Mission retains its plan; adjusting language requires a new plan.

Initial `support_level` is optional: `model_frame`, `model_label`, `label_only`,
`no_hint`, or null for legacy. An explicit setting is included in the session's
idempotency payload and frozen atomically with the original plan/language through
`create_supported_speaking_loadout`. Existing legacy/planned RPC signatures and
absent-field payloads remain unchanged. A different initial level requires a new
submission ID. Changing support before creation reuses a still-valid scene;
uncertain creation always retries the already-saved exact request first.

## Manual support and demonstrations

| Level | AI teaching action | Proactive wording on screen |
|---|---|---|
| `model_frame` | One natural model, then a different-content invitation | Target label and server-owned sentence frame |
| `model_label` | One natural model, then a different-content invitation | Target label |
| `label_only` | Implicit elicitation without a target answer | Target label |
| `no_hint` | Implicit elicitation without a target answer | No target wording, frames or demonstration highlight |

The learner selects and changes levels manually; P2 does not infer familiarity
or automatically advance a stage. All explicit levels disable automatic help
cards. Requested usage/examples remain available and count as assistance.
Historical conversation text remains a record of what was said.

`model_then_transfer` is separate from `implicit_elicitation`. It permits one
target use in the AI's own in-role point, followed by one question inviting the
learner's own reason, choice or circumstances. It must not request imitation,
repeat the target in the question, supply the learner's answer or announce the
teaching technique. Among automatic policies, only this explicit action provides
selected wording to the live partner; base scene context and implicit controls
omit it. Requested wording help remains a separate explicit action.

Completed-response assessment records `model_quote` and
`transfer_question_quote`. Local checks require unique, non-overlapping, ordered
exact substrings and one grounded target use; structure slots must be filled.
The model judges whether the second question invites different content.
These checks do not prove naturalness or learning. Missing/invalid evidence
stays unconfirmed. Public `demonstrations` contain target/message IDs, transcript
revision, a quoted target and server-derived UTF-16 offsets, only for a reflected,
presented attempt with a final assistant message. `no_hint` suppresses that
highlight projection.

The socket command `support.set` carries `request_id`, `level` and
`expected_version`. The frozen initial setting is version 0; accepted changes
advance the support version through runtime CAS and append bounded history. Speech, active replies,
pending playback and already-sent controls return `support_busy`; a stale version
returns `support_changed`. Changing levels expires unsent policy/help and fences
late results. It never rewrites an immutable sent attempt or clears exposure
history. Legacy null sessions keep their existing behavior until the learner
explicitly selects a level.

## Teaching opportunity control

Gemini remains the real-time role-play partner; DeepSeek observes finalized
learner text asynchronously. Current audio does not wait for analysis.

P1's implicit path and P2's reduced levels ask the learner to perform the
communicative act without supplying the target expression. Modeling levels use
the separate action above. The first two substantive
utterances remain observational. From the third, unused primary targets receive
priority. Plans supply context to the observer and a conservative fallback when
the current turn still relates to the scenario. A model's explicit insufficient
context or closing judgment suppresses fallback.

Fallback is bounded per target and still obeys the existing one-candidate,
two-turn cooldown, maximum-two-bound-attempts, source-revision, expiry and safe
provider-boundary rules. Noise, greetings and silence do not establish struggle.
An elapsed turn count alone is not proof that an opportunity is appropriate.

Track different facts:

- **Sent:** the controller sent an instruction.
- **Bound:** a response was associated with that immutable attempt.
- **Reflected:** the completed response was assessed as satisfying its specific
  implicit or model-then-transfer action, with valid response quotations.
- **Presented:** visible text or acknowledged complete audio was presented.
- **Offered:** the same attempt was both reflected and presented.
- **Used:** final learner evidence supports appropriate use.

Sending an instruction is not a guarantee that the model follows it. Missing
compliance/delivery evidence leaves the opportunity unconfirmed.

`target.skip` and `target.restore` are owner/runtime-fenced socket commands.
Target state has its own revision and history outside replaceable analysis
results. A late analysis cannot undo a skip or resurrect a policy prepared before
a skip/restore. An already sent provider instruction cannot be retracted; its
actual response remains observable.

The workspace exposes primary/opportunity roles and truthful target states.
Visible wording in a target card is session-scoped usage assistance, just like
visible Usage help. Presentation ACKs record visibility rather than comprehension.

## Report attribution and coverage

New feedback uses `speaking-rubric-v2` / `speaking-feedback-v3`. Freeze utterance
start/finalization, assistance provenance, actual exposure level/scope/time,
allowlisted attempt outcomes and target-state history. Private provider
instructions and runtime credentials stay outside the assessment source.
The frozen scene's roles, setting and register inform scenario-fit assessment;
planned questions and fit opinions are not learner-use evidence.

Before ending, the local runtime captures already-received display receipts and
allows a bounded background drain. The same completion CAS merges outstanding
exposure/presentation facts only for the matching active runtime, preventing
takeover or already-completed sessions from accepting stale evidence. This
protects a same-worker end/write race; cross-worker receipt barriers and browser
ACKs that never reached the server are outside this increment's guarantee.

Stage 5 uses the same assistance timing as Stage 4:

- Presented expression/example wording remains assisted for the Mission.
- Legacy unscoped exposures retain their historical two-user-turn window.
- Overlapping or unknown presentation is not credited as independent.
- A late ACK does not retroactively convert an already completed utterance.
- Partial model audio records `certainty: possible` and session-scoped unknown
  assistance. It does not confirm which words or the transfer question were heard.
- Moving to reduced/no support does not reset earlier example/wording assistance.

Stage 4 and Stage 5 share a conservative normalized contraction/inflection rule
for variants. Unrelated paraphrases or a model's `variant` label alone are
insufficient; structures still require their literal anchors and slots.
`pattern_family` metadata does not widen this into unrestricted semantic matching.
The existing transfer dimension remains selected-item coverage, not a measured
score for novel-content transfer after a demonstration.

Feedback freezing preserves initial/current support, change history, attempt
support level/version, both model/transfer quotations and exposure certainty.
Migration `20261020090509_speaking_support_and_demonstrations` adds initial session
storage and the allowlisted SQL freeze; the inline adapter mirrors it.
Existing v1/v2 sources and results are not recomputed when read.

For planned Missions, transfer concerns primary targets. Opportunity targets are
reported separately and do not lower coverage. Skipped targets are excluded.
A primary target needs a confirmed offered opportunity or an appropriate
spontaneous use to become assessable. Do not display a complete percentage until
every remaining primary target is assessable and relevant transcript/use evidence
is resolved. An empty denominator stays unscored.

Report AI opportunity coverage separately from learner use. A missing
opportunity is not a failed learner attempt; spontaneous use does not fabricate
an AI opportunity. Repetition does not increase item coverage. Skipped uses remain
available as transcript evidence but are excluded from production counts. Planned
reports show primary use, optional use and skipped counts separately, without the
legacy all-selected sidebar ratio.

Saved v1 reports remain readable with their original versions and results.
Compatible old jobs can finish; neither report reads nor Profile silently
reassess existing history. Scores still describe this conversation, not mastery.

## Delivery boundaries

P0 establishes selection/plan/skip contracts and consistent evidence attribution.
P1 implements generation, automatic or manual scene choice, persistence, runtime opportunity
dispatch, visible target states and basic report exclusions.

P2 implements explicit `model_then_transfer` behavior and four manually selected
support levels. Full wording labels and sentence frames count as assistance.
There is no automatic progression based on a single successful use or an inferred
mastery state.

P3 implements separately validated missed-opportunity rewrites and linked practice
variants. P4 offers support recommendations based on repeated, reliable practice
history. No automatic comfort/focus/stretch mastery model is introduced.

## Missed opportunities and linked practice

Feedback v3 adds `missed_opportunities` separately from general refactors and actual
uses. It uses the existing assessment call and deadline, with no additional model
call. The optional proposal branch is parsed and validated independently: an invalid
suggestion does not invalidate otherwise valid scores or make a ready report partial.
Old v1/v2 jobs keep their original analysis path and saved results.

A suggestion needs a non-skipped primary target whose opportunity was both reflected
and fully presented, whose final use judgment is not observed or inappropriate, and
the immediately following reliable final learner reply. Presentation must precede
the learner's start; absent timestamps, interrupted replies, intervening turns and
uncertain use cannot establish a missed opportunity. The original quote must match
the final learner transcript revision and UTF-16 range. A conservative content check
preserves content words, numbers, polarity and commitments while inserting target
framing; unverified rewrites are omitted. Communicative fit remains an AI suggestion,
not a proof of semantic equivalence. Suggestions never count as learner uses.

Analytics retains exact retry and adds linked practice with different details or
swapped roles. `POST /sessions/{parent_id}/practice-plans` accepts only `variation:
details | role_swap`; the server loads the owned completed parent and current corpus.
Details variants retain both role strings and change setting or goal. Role variants
swap distinct role strings exactly. Candidates retain target identity, order and
primary/opportunity roles. The same bounded 90-second generation budget and one
content repair apply. The server computes before/after changes for review.

The learner explicitly chooses support; the suggested second-round default is
`label_only`, or `no_hint` if the earlier round finished at that level. This is a
learner-led practice default, not inferred mastery. Preparing/importing a variant
retains the earlier draft; no plan or Mission is created merely by reading a report.
The normal create endpoint freezes the selected variant and lineage atomically.
Linked creation requires explicit support. Already committed retries recover before
checking the parent, plan or current corpus, including after source deletion.

Frozen `practice` records parent/root IDs, variation and changes. Each target records
its earlier session item ID. Current language content (`kind`, `text`, `meaning`,
`slots`) must match the parent; metadata changes may be incorporated into a freshly
planned variant. Deleting the parent removes its live link without breaking the
child or rewriting an existing report's frozen source.

`GET /sessions/{child_id}/practice-comparison` only reads two existing reports.
It returns factual per-target independent, prompted and unknown counts, exclusions,
opportunities and final support levels when both reports are ready and language/roles
align. Pending, unavailable and incompatible reports remain explicit states.
It does not enqueue feedback, infer missing values or calculate a learning-gain score.

## History-based support recommendations

`POST /support-recommendations` is a read-only request for the selected owned targets
and current support level. The rule `support-history-v1` requires every primary target
to have appropriate independent evidence in at least three distinct completed Missions,
on at least two UTC practice dates, across at least two scene families. Dates use the frozen timestamp of each target's first qualifying independent learner
utterance in that Mission. Missing or timezone-free timestamps do not qualify; early
Mission creation and delayed report requests/retries cannot manufacture practice days.
Linked rounds share their root; exact repetitions of the same setting, goal and roles
also count as one scene family. Repeated uses within one Mission count once.
Opportunity targets may show history but do not gate the recommendation.

Only ready feedback v3 reports from new sessions explicitly marked
`speaking-evidence-v3` can contribute. Each item freezes `source_corpus_item_id`
independently of the nullable live corpus link. The language-content identity must
still match the currently selected card. The assessment records
`qualifying_independent_evidence` only for appropriate accepted uses whose assistance
is exactly independent; mixed evidence lists, aggregate scores, direction-only hints,
unknown attribution, skipped targets and old contracts cannot substitute for this.
The recommendation revalidates final-user revision and exact quoted ranges.
Existing sessions are never retrospectively stamped as reliable practice.

The server reads at most 100 recent matching owner-bound reports, projects only
selected targets and referenced messages, and returns a truncation flag and up to five
source-report links per target. It performs no model calls or writes. A qualified
selection yields at most one level less support; the user must apply it explicitly.
No-hint and legacy/null settings are not automatically advanced. Missing evidence
keeps the current choice available, and history service failures do not block Mission
start. Recommendation responses are fenced by account, selection and current level;
uncertain Mission creation retains its exact earlier payload.
