# Stage 4 teaching control and diagnostics

Implemented locally, 2026-10-18. This document supplements the [runtime contract](STAGE_FOUR_RUNTIME_CONTRACT.md) and [implementation boundaries](STAGE_FOUR_IMPLEMENTATION.md). Gemini remains the live conversation partner. DeepSeek observes finalized learner text, proposes contextual teaching opportunities, provides requested wording help and assesses completed replies in background tasks. No model analysis is awaited to release the current voice response.

The diagnostic migration is applied to hosted Supabase. One bounded real-provider browser probe is recorded below; application deployment and physical-microphone qualification remain separate. The diagnostic reader is an authenticated HTTP endpoint; a diagnostic timeline UI is not implemented.

## Observation and teaching timing

1. A nonempty learner utterance becomes final. Gemini's optional transcription `finished` flag is used when available; the existing conservative generation/VAD boundary remains the fallback. Partial transcripts, noise placeholders and AI follow-ups are not new learner turns.
2. The runtime schedules analysis once per message ID and transcript revision, freezing history through that utterance. DeepSeek receives the current text, mission/selected expressions and up to six earlier finalized or interrupted messages. Later turns cannot silently become that analysis's historical context.
3. One background analysis worker prioritizes the newest queued context, then processes older evidence. Queued work and work cancelled at connection closure have separate diagnostic events. The audio path does not wait for this queue.
4. Every eligible utterance can produce evidence. Automatic teaching stays in observation mode for the first two substantive learner utterances. Standalone greetings and acknowledgments do not advance that gate; short substantive answers such as “Next Friday” can. Explicit wording help is available immediately.
5. From the third substantive utterance, an automatic candidate requires a selected target, a sufficiently grounded communicative intent and a relevant opportunity. An unused expression alone is insufficient. Closing the conversation, already demonstrating the target, cooldown and attempt limits suppress automatic teaching.

DeepSeek returns bounded evidence and optional `recommendation` data: `target_item_id`, `intent`, `opportunity`, `skip_when`, `context_sufficient` and `closing`. Server rules decide whether to create a policy. The analyzer cannot assign mastery, scores or arbitrary provider instructions. Exact lexical fallback remains available when the model fails, with semantic appropriateness marked uncertain.

Observation prompt `speaking-analysis-v3` requests exact quotes rather than requiring the model to count characters. For a quote appearing exactly once in the frozen current learner text, the server derives UTF-16 `[start,end)` offsets. A valid supplied range can disambiguate a repeated quote; without one, repetitions are rejected. An incorrect supplied range may be repaired only for a unique exact quote. No case normalization, fuzzy matching or text rewriting is used to anchor quotes. Persisted evidence and Stage 5 keep strict range validation. `accepted[].quote_anchor` records `model_validated`, `server_derived` or `server_repaired`, with original and resolved offsets.

Implicit teaching prompt `speaking-elicitation-v2` assigns the communicative act to the learner. Gemini's initial mission context omits the selected-language list, and an implicit control sends only `learner_intent`, `elicitation_question` and `skip_when`; selected wording and meaning are withheld from this control. Recommendations containing a detected selected expression are rejected as `elicitation_contains_target`. The partner asks one contextual question and leaves the comparison, judgment and wording to the learner. Private immutable policies retain `target_text` and `target_kind` for subsequent compliance checks, outside the public policy view. Explicit help cards retain their separate expression/example path.

| Default | Current behavior |
|---|---|
| Observation phase | First two substantive learner utterances |
| Automatic target | At most one pending candidate |
| Candidate time limit | 45 seconds from source finalization, falling back to source creation time |
| Candidate turn limit | Through source user turn + 2; this clock uses nonempty finalized user turns |
| Automatic cooldown | Two substantive learner utterances between automatic teaching attempts |
| Automatic target budget | At most two bound automatic attempts per selected target |
| Model request bound | 12 seconds for one observation, detailed-help or effect-assessment request |
| Provider response bound | 64 KiB per model response; observation output budget 2,000 tokens |
| Detailed help/effect budgets | 1,200 / 800 output tokens |

The time and turn limits both apply; a delayed analysis does not receive a fresh 45-second lifetime. Explicit help cards have a separate request path and do not depend on passing the automatic teaching gate. Repeated user requests are bounded to 100 distinct requests per connection, with request IDs preventing duplicate handling.

## A candidate and an execution attempt are different records

A candidate belongs to the evidence that motivated it. An execution attempt records the immutable policy version actually sent to a provider and the subsequent response to which it binds.

```text
Learner text becomes final ──→ DeepSeek observation ──→ validated candidate
          │                                                │
          └──→ Gemini answers immediately                  │
                                                           ↓
             Analysis completion or provider turn boundary wakes dispatch
                                                           ↓
             Safe local boundary + valid candidate → send one control
                                                           ↓
             New response begins → bind immutable attempt to response ID
                                                           ↓
             Response ends → background effect assessment + delivery records
```

Analysis completion actively wakes dispatch, including when the provider's `turnComplete` event arrived first. Provider completion also wakes dispatch, covering the opposite order. Explicit responses such as typed input and the existing silence follow-up can use a candidate already available at their boundary.

Gemini injection requires an observed boundary, no current user speech, no unfinished input transcription, no active/requested response and no already injected attempt. It uses a private `clientContent` control with `turnComplete: false`. If the window is unavailable, the candidate waits rather than delaying the user's audio. Before sending, source revision, expiration, current evidence, cooldown, attempt budget and runtime ownership are checked.

Local serialization cannot prove that a remote automatic VAD has not already acted on in-flight audio. The architecture adds no wait for DeepSeek; absolute zero extra latency or zero accidental interruption still requires real provider/network measurement. Sending an instruction is also not proof that Gemini followed it. A send failure can be uncertain, so that attempt is not blindly resent. Updating a database candidate cannot retract an instruction already received by Gemini.

A later utterance alone does not expire a candidate. A newer candidate, changed source revision, demonstrated target, exhausted budget, elapsed lifetime or lifecycle change can prevent its use. Reconciliation preserves newer evidence and candidates and cannot rewrite an already sent attempt. The runtime retains a bounded recent-attempt list for coordination; detailed history belongs in the diagnostic journal.

The existing voice-only silence behavior remains: at least 15 seconds after generation and acknowledged playback, at most two follow-ups until learner input. A follow-up can carry an eligible teaching opportunity, but teaching does not create additional follow-ups or fabricated learner evidence.

The Gemini setup distinguishes a teaching Attempt control from opening/silence controls: the latter trigger a reply without replacing a pending teaching attempt. No additional model call or audio buffering is introduced before a voice response.

The follow-up live probe also exposed a capture backlog risk: the client reader previously waited for the provider/state operation lock on every PCM frame and playback/display receipt. These high-frequency events now bypass that lock while retaining the single-reader order, microphone gating, frame validation, token bucket and serialized provider writes. Completed-playback persistence runs as a tracked, deduplicated background task with the existing bounded exposure drain. Stateful microphone/text/interrupt controls still serialize through the operation lock. This removes that database-lock dependency; it does not promise immunity to operating-system scheduling or provider/network stalls.

## Help, examples and visible assistance

Voice and Chat share one help card. Its content has three levels:

- **Direction:** the communicative point to express, without revealing the selected expression.
- **Usage:** the selected expression, meaning and an optional reusable pattern.
- **Example:** one contextual example and a substitution tip, generated only after an explicit example request.

Automatic direction cards are produced only after an actual completed response is assessed as `reflected`. They are discarded when a newer learner turn or relevant explicit help request makes them stale; the browser also suppresses automatic cards during speech or a typed draft. No automatic complete example is generated.

Explicit requests work through the hint control, card actions or wording-help intent grounded in the current finalized utterance. They can start during the observation phase. The initial card can show available expression/meaning while detailed content loads. A newer request supersedes an older completion. Model failure preserves available basic help, displays an unavailable state and allows retry. Asking for usage does not authorize generating an example.

Examples must contain the selected expression or fill the selected structure's anchors and slots. These checks establish grounding, not human-validated grammatical or pedagogical quality. Suggested sentences are practice examples, not a claim about what the learner agreed to or believes.

A generated card is not an exposure. The browser acknowledges an actually visible card level with `hint.shown`, and visible assistant text with `message.shown`. The runtime also records coarse playback progress. A fully played, non-interrupted final reply can establish audio exposure; partial playback has no word-accurate text alignment. A visibility acknowledgment establishes presentation, not eye tracking or comprehension.

Evidence carries an `assistance` value in addition to the compatibility `prompted` flag:

| Assistance | Meaning |
|---|---|
| `independent` | No applicable recorded assistance |
| `direction` | A communicative cue, without revealing the target expression |
| `usage` | The expression or usage was presented before the utterance |
| `example` | A complete example was presented before the utterance |
| `overlap` | Presentation overlaps an already-started utterance |
| `unknown` | Available timing cannot establish attribution |

Actual expression/example exposure uses `scope: session`. Later use in the same Mission remains assisted even after more than two turns; a card staying visible cannot silently become “independent” again. Legacy exposures without that scope retain the older two-turn window. Direction cues retain their bounded window and do not count as phrase/example exposure.

`visible_at` is the server receipt time of the visibility acknowledgment. Compare it with the recorded utterance start/finalization boundary; a late acknowledgment must not retroactively classify a whole earlier sentence as assisted. Conversely, a later utterance starting after a previously overlapping exposure can count as assisted. `overlap` and `unknown` observations do not increase `independent_uses`. This remains presentation-based provenance, not a causal learning measurement.

## What “the strategy worked” means

Read three facts separately:

1. **Sent/bound:** an immutable attempt was sent and associated with a particular response.
2. **Reflected in the reply:** a background assessment found a matching communicative opportunity in the actual response text. `reflected` and `appropriate_skip` require a contiguous exact quote. Other outcomes are `not_reflected` and `unknown`.
3. **Presented:** assistant text became visible or audio playback was acknowledged. Partial or interrupted playback does not establish that the quoted teaching content was heard.

An interrupted/empty response is `unknown`; assessment failure does not become a positive result. Automatic card presentation depends on reflection, while delivery is recorded separately. Later learner use is another observation; it does not prove that the strategy caused learning or independent mastery.

For an implicit attempt, a deterministic post-response check first looks for the target phrase or filled structure in the actual reply. A detected disclosure forces `not_reflected` with its exact quote, skips the model assessment, and prevents an automatic direction card. A legacy attempt without valid target metadata remains `unknown`. Otherwise `speaking-effect-v2` asks DeepSeek whether the reply invites the learner to perform the communicative act; demonstrating that act and appending a related question does not qualify. `analysis_trace.constraint_check` and `assessment_source` distinguish the deterministic constraint from the advisory model judgment. This is a background compliance check, not an audio filter or a guarantee that a streaming model can never violate instructions.

## Read the diagnostic journal

Use the session owner's existing Clerk-authenticated API client:

```http
GET /api/speaking/sessions/<session UUID>/diagnostics?limit=200
Authorization: Bearer <Clerk session token>
```

The response contains `{events, limit, next_before}`. Each event is `{id, kind, created_at, payload}`. Events are newest first by `(created_at, id)`. To read older events, pass the returned cursor unchanged:

```http
GET /api/speaking/sessions/<session UUID>/diagnostics?limit=200&before=<next_before UUID>
```

`limit` is 1–200, default 200. `before` is an exclusive event-ID cursor, not a timestamp. Stop when `next_before` is null. A cursor from another session or one no longer retained is invalid; restart from the first page if an expired cursor returns 422. Missing/unowned sessions return 404, missing authentication returns the normal authentication error, and storage failure returns 503 without falling back to a different database.

Correlate by `runtime_id`, then `message_id + revision` and `run_id`; follow the resulting `policy_id`, immutable attempt ID and `response_id`. One journal event is not one model call. For example, `analysis.scheduled` and `analysis.started` belong to the same planned analysis, while a skipped or cancelled run may never call DeepSeek.

| Event family | Main records and how to interpret them |
|---|---|
| Analysis queue | `analysis.scheduled`, `analysis.queued`, `analysis.started`: frozen source/context and queue delay |
| Analysis result | `analysis.completed`: raw model content, model/prompt version, usage, finish reason, bounded timing, accepted/rejected evidence, fallback and policy decision |
| Analysis merge | `analysis.reconciled`: what survived runtime reconciliation; `analysis.cancelled`, `analysis.discarded`, `analysis.failed` explain missing commits |
| Policy execution | `policy.sending`, `policy.sent`, `policy.send_uncertain`, `policy.bound`, `policy.unbound`: transport attempt and response association |
| Policy validity | `policy.expired`, `policy.expiry_uncommitted`, `policy.dispatch_failed`: reason a candidate was not used or its terminal state was not persisted |
| Policy assessment | `policy.assessed`, `policy.assessment_failed`: advisory result and exact response quote, separate from delivery |
| Response delivery | `response.first_audio`, `response.completed`, `response.shown`, `response.playback`, `response.expression_exposed`: first audio forwarded by the server, generated text, presentation acknowledgments and expression exposure; forwarding is not browser playback latency |
| Playback persistence | `response.playback_uncommitted`, `response.playback_commit_unknown`: failed storage or shutdown cancellation after a real playback receipt, distinct from whether audio was heard |
| Input protection | `input.audio_rate_exceeded`: rejected frame size, remaining budget and unchanged burst/refill limits, without PCM content |
| Help | `hint.requested`, `hint.analyzed`, `hint.generated`, `hint.shown`: requested content, raw help analysis, card version and actual visible level |
| Help exceptions | `hint.discarded`, `hint.cancelled`, `hint.failed`, `hint.exposure_uncommitted`, `hint.exposure_commit_unknown`: supersession, cancellation, failure or uncertain provenance persistence |
| Journal health | `diagnostics.gap`, `diagnostics.closed`: known missing events and bounded shutdown drain result |

To print a model reply, inspect `analysis.completed.payload.trace.raw_content`, or `hint.analyzed.payload.trace.raw_content` for requested help. A validated evidence row or server policy is not the original model response. Historical conversations before this journal was implemented cannot be reconstructed retroactively.

To investigate weak teaching influence, first check `trace.policy_reason`, then candidate expiry and attempt binding, then assessment and presentation. Count valid analyzed utterances, eligible candidates, sent attempts, assessable responses and delivered responses separately. Do not divide every signal by the total user-turn count and label the result an effect rate.

## Storage, permissions and retention

Migration `20261018111206_speaking_teaching_diagnostics.sql` creates `speaking_diagnostic_events` and server-only append/read/purge RPCs. FastAPI obtains the owner from Clerk and checks session ownership through the repository. Browser `anon`/`authenticated` roles have no table/RPC grant. Service-role event records can be inserted/read and deleted for retention or session deletion; ordinary updates are not granted. Reusing the same `(session_id, event_id)` is idempotent.

Detailed traces are separate from the 1 MiB runtime document and do not increment its CAS version. The journal can contain private utterance/context text, provider content and internal policy instructions. It does not store raw audio, authorization headers, API keys, tickets or credential error bodies. Normal workspace snapshots still exclude those diagnostic/provider fields.

The current readable retention window is **30 days from insertion**. Reads always exclude expired events. Appending to a session physically removes that session's expired events. A server-only `purge_expired_speaking_diagnostics()` function exists, but no global periodic cleanup job has been scheduled by this change; therefore a 30-day physical-deletion guarantee for inactive sessions is not yet provided. Deleting a session cascades its diagnostic rows immediately with the session transaction. Provider-side retention remains a separate boundary.

## Reliability and verification boundaries

The per-connection journal queue is bounded to 256 events; writes use a separate two-worker executor. Eligible server failures receive up to three append attempts with the same event ID. Payloads are bounded to 128 KiB. Queue overflow or failed writes increase a gap counter; the runtime tries to append `diagnostics.gap` and a closing `diagnostics.closed` status while draining in the background. After the audio loop ends, already-visible exposure writes have up to two seconds to finish before the runtime disconnects; cancelling a waiting task does not retract an in-flight database CAS and therefore records an unknown commit outcome. Disconnect diagnostic drain has a 20-second bound, and application shutdown has its own shorter wait.

This is best-effort diagnostic delivery with idempotent append, not an exactly-once durable event bus. A process crash, full queue, database outage or interrupted drain can lose events. Missing `diagnostics.closed` is not proof of success; the closing record retains the total known missing count even after a gap summary was saved. Read the complete retained runtime journal before making completeness claims. No raw model logging is added to ordinary application console output.

Verification recorded for this increment:

- Final post-fix root lint/build/test ran sequentially after all live sessions closed: 1,179 API and 390 Web tests pass; 114 extension tests use the cache. The existing Starlette test-client warning remains. Quote, disclosure and audio-ingress regressions cover the new behavior without paid models. An earlier concurrent full check hit three unrelated acoustic subprocess timing failures; those passed in isolation and in this final full run, with no changes to acoustic behavior.
- Post-fix [run-04/run-05](../benchmarks/teaching-live-20261018/README.md) separate voice transport from controlled strategy coverage. Run-04 has three finalized voice turns with first audio 2.80–5.45 seconds ahead of analysis completion and nine Usage/Example visibility ACKs; four unconfirmed ASR fragments are excluded, and no policy was forced. No `audio_rate` occurred. Run-05 has one eligible turn 3→4 attempt: Gemini asks the learner to frame the compromise, supplies no target wording or answer, passes the deterministic constraint and receives `reflected` with an exact response quote. A direction card has a real visibility ACK. The first text analysis overlaps 20 incoming Gemini audio packets and WebAudio playback. Fifth-turn target evidence uses a verified server-derived UTF-16 `[0,16)` range; model-offset repair remains offline-test coverage. The scripted fifth answer is not causal learning evidence. A later persistence 503 closes the connection before fifth-reply audio is observed; it does not invalidate previously committed strategy/quote evidence and does not qualify the whole session as successful. Both journals report `drained` and zero known gaps; temporary records are deleted.
- Focused observation/help/effect and assessment regressions pass with fake providers; no paid model is used by those tests.
- Hosted migration is applied. Transactional rollback checks cover ownership, idempotency, paging, retention filtering, role grants and session deletion without preserving synthetic records.
- The hosted security advisor has only the pre-existing informational [`private.content_payloads` RLS-without-policy finding](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy); no new diagnostic warning/error was reported.
- Root `pnpm lint`, `pnpm build` and `pnpm test` pass: 1,111 API and 390 Web tests ran successfully; 114 extension tests reused the Turbo cache. One existing Starlette test-client deprecation warning remains. The runtime regressions cover both completion orders, slow analysis/help/storage, immutable sent attempts, cross-turn eligibility, acknowledgment attribution, uncertain sends, final-response assessment and diagnostic gap races.
- The performance advisor reports only three [unused indexes](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) on existing, unrelated tables; no index was removed as part of this change.
- `speaking-help.browser.mjs` passes at 1440/390 px with synthetic auth/API/provider events. Real Chrome rendering covers usage/example loading and visibility ACKs, hidden/occluded suppression, stale-request rejection, automatic-card retirement and no horizontal overflow. Desktop/mobile example screenshots were inspected; this does not test a physical phone or real model teaching quality.
- The existing `speaking.browser.mjs` also passes at 1440/768/390 px: text/voice continuity, actual browser AudioWorklet PCM and playback, interruption/mute, lost-ack recovery, end/reload/account isolation, background/resume, denied microphone, takeover and deletion. API/auth/provider events and input audio are synthetic. Updated browser scripts/fixtures pass targeted ESLint.
- One [live Gemini/DeepSeek/Supabase browser run](../benchmarks/teaching-live-20261018/run-01/README.md) records seven canonical learner turns (six voice, one typed), seven observation calls, two help calls and one effect assessment. Each voice first reply began before its observation started and 2.03–3.36 seconds before it completed. Five analysis windows overlap valid running WebAudio intervals; no new audio packets arrived inside these analysis windows. This demonstrates the observed voice-first behavior and playback overlap, not arbitrary network/slow-analysis latency guarantees.
- In that run, the policy created from turn 5 bound to turn 6 while eligible. Gemini nevertheless named the target expression, violating the implicit-teaching constraint; the effect assessment returned `not_reflected`. Cross-turn delivery passed, but content compliance did not. No automatic direction card was displayed for that failed assessment.
- Two explicit help requests produced Usage/Example cards with nine matching per-level/version browser visibility ACKs. Subsequent example reuse retained `prompted=true` and `assistance=example`. DeepSeek's quote end offset was one UTF-16 unit short; strict validation rejected the semantic result, leaving uncertain lexical fallback. The complete journal contains 221 events and a `drained` closure with zero reported missing events. Synthetic session/corpus records were removed after export.
- The live probe used fixture identity and synthesized WAV input through the real product microphone/worklet path. One utterance was split by provider VAD and part of its transcription was lost. Playback measurements exclude timer callbacks arriving after their audio node had ended; the harness was corrected for future runs without modifying the raw record. Real sign-in, physical microphone/speaker behavior, remote-VAD race rates, general contextual teaching quality and human learning outcomes remain unqualified.
