# Stage 4 runtime contract

Implemented contract, updated 2026-10-18. See [verification and provider-specific boundaries](STAGE_FOUR_IMPLEMENTATION.md) and [teaching control/diagnostic details](STAGE_FOUR_TEACHING_CONTROL.md).

## Transport and lifecycle

Browser → authenticated Libitu WebSocket → Gemini Live WebSocket (user-selected default); an optional OpenAI adapter shares the application contract. Browser sends PCM16LE mono 24 kHz, text and allowed controls only. Gemini input is resampled to 16 kHz; native audio output remains 24 kHz. Text mode displays output transcription without playing native audio. Server owns provider instructions, responses, transcript persistence, teaching policy and interruption. Analyzer is asynchronous and never blocks the current response. No raw audio persistence. One leased runtime per session; explicit takeover fences the former runtime. Reconnect hydrates finalized messages; never reopens microphone without an action. Maximum 20 minutes per connection, 100 user utterances per mission, bounded input/output and 60-second lost-lease expiry. Text works without microphone permission.

HTTP prefix `/api/speaking/sessions/{id}` (Clerk bearer auth):

- GET existing session remains compatible.
- GET `/workspace` → `SpeakingWorkspace` below.
- GET `/diagnostics?limit=200&before=<event UUID>` → `{events,limit,next_before}`. Owner-authorized private journal, newest first; limit 1–200 and exclusive event-ID cursor. Not part of the public workspace snapshot. Reads omit expired events after 30 days from insertion; see [retention and completeness limits](STAGE_FOUR_TEACHING_CONTROL.md).
- POST `/realtime` `{client_connection_id: UUID, takeover: boolean=false}` → `{runtime_id, ticket, expires_at, websocket_path}`. Ticket opaque, one-use, 30 s; delivered in first WS message, never query string. POST uses existing user authorization to reuse configured credentials.
- WS `/realtime/{runtime_id}`: first message `{type:"authenticate",ticket}` within 5 s, then normalized protocol below. Validate Origin against configured authorized parties. No paid provider until ticket accepted.
- POST `/end` → completed workspace, idempotent; closes/fences runtime, expires pending teaching actions. Final read-only transcript/evidence review, no invented Stage 5 scores.
- DELETE session → 204; cascade private text/evidence/runtime and fence live activity.

## Public snapshot and events

`SpeakingWorkspace = {session: SpeakingSession, version:number, runtime: {id:string,generation:number,state:"connecting"|"connected"|"disconnected",expires_at:string}|null, messages: SpeakingMessage[], evidence: SpeakingEvidence[], learning: LearningItem[], policy: TeachingPolicy|null, analysis_status:"idle"|"pending"|"ready"|"unavailable", hint:string|null, help:SpeakingHelpCard|null}`

`SpeakingMessage = {id:string,ordinal:number,role:"user"|"assistant",text:string,input_source:"voice"|"text",status:"final"|"interrupted"|"unavailable",revision:number,provider_item_id:string|null,response_id:string|null,client_turn_id:string|null,created_at:string}`

`SpeakingEvidence = {id:string,session_item_id:string,message_id:string,transcript_revision:number,start:number,end:number,quote:string,match_type:"exact"|"variant"|"structure",appropriateness:"appropriate"|"uncertain"|"inappropriate",prompted:boolean,assistance:"independent"|"direction"|"usage"|"example"|"overlap"|"unknown"|null,reason:string}`. Offsets UTF-16, quote must match actual finalized USER transcript. Analyzer cannot fabricate evidence or mark mastery. `prompted` remains a compatibility flag for usage/example help. Overlap/unknown does not contribute to `independent_uses`; actual usage/example exposure with session scope remains assisted throughout the current Mission.

`LearningItem = {session_item_id:string,observed_uses:number,independent_uses:number,prompted_uses:number,last_message_id:string|null}`

`TeachingPolicy = {id:string,source_message_id:string,source_revision:number,learning_version:number,target_item_id:string|null,action:"continue_naturally"|"implicit_elicitation"|"explicit_hint"|"move_on",status:"pending"|"applied"|"expired",response_id:string|null,instruction:string}`. Public snapshot removes `instruction`; it is server-only. At most one target. Pending action binds to a not-yet-started response, includes instruction to skip if current learner utterance already demonstrates target. Do not alter active response. Expire across reconnect/end/takeover; evidence survives. Episode evidence accumulates, no mastery claim.

`SpeakingHelpCard = {id:UUID,version:number,target_item_id:string|null,level:"direction"|"usage"|"example",status:"loading"|"ready"|"unavailable",direction:string,expression:string|null,meaning:string|null,pattern:string|null,example:string|null,substitution:string|null,source:"automatic"|"requested",source_message_id:string|null,error:string|null}`. Explicit request IDs and card versions fence superseded results. An automatic direction card follows a `reflected` assessment of an actual completed reply. Examples are generated only on explicit request. Visible-level acknowledgments establish presentation; merely generating or persisting a card does not.

Private policies additionally store source turn, creation/expiration time, eligible-until turn, intent, opportunity and skip conditions. Source-plus-two-user-turn/45-second eligibility allows cross-turn use; a newer utterance alone does not expire the candidate. Sent attempt snapshots and response association remain immutable even if the current candidate changes. Automatic teaching begins after two substantive observation utterances and uses a two-substantive-turn cooldown/maximum two attempts per target. Private model traces remain in the separate diagnostic journal. See [the complete sequence](STAGE_FOUR_TEACHING_CONTROL.md).

After `ready`, the browser sends its initial `microphone` control once media permission has settled (or immediately for text-only startup). The server requests an opening only after that control and only if no nonblank conversation text exists. Text submission remains available while permission is pending and suppresses an unrelated later opening.

Audio input uses a token bucket: 240,000 decoded bytes of maximum burst credit (five seconds of PCM24k), refilled at 60,000 bytes/s to allow scheduling/clock headroom. Short catch-up batches are tolerated; oversized frames and sustained excess remain rejected. This is application receive-rate protection, not microphone loudness detection.

PCM, ping and playback/message/hint presentation receipts bypass the provider/state operation lock so transcript persistence cannot accumulate those frames behind it. One client reader retains FIFO with microphone/text controls; provider writes remain serialized and resampler convert/reset ordering is unchanged. Completed-playback ACK persistence is deduplicated in the bounded background exposure drain. Storage failure retains pending state and records `response.playback_uncommitted`; cancellation records unknown commit status. Shutdown reconciles complete locally received ACKs while partial or unknown playback remains interrupted. `input.audio_rate_exceeded` records rejected byte count and remaining budget, without audio content. This does not relax input bounds or guarantee progress through every provider, database or host stall.

While the microphone is enabled, a server timer waits at least 15 seconds after generation and acknowledged playback have both finished before requesting one brief in-role follow-up. Idle detection and triggering both use the approximately two-second heartbeat, so the observed delay can be a few seconds longer. User speech, pending Gemini transcription, provider generation/request, incomplete playback, mute, stop and lifecycle fencing prevent a follow-up. At most two follow-ups per silent stretch in a connection; nonblank user text/transcription resets the count, VAD noise alone does not. These are private provider controls, never fabricated user messages/evidence. No silent follow-ups run in microphone-off text mode. Reconnect starts a new timer/budget; the existing idle and connection ceilings remain.

Server WS events:
- `{type:"ready",workspace}` after provider configured/hydrated.
- `{type:"snapshot",workspace}` authoritative monotonic version after durable changes.
- `{type:"state",state:"listening"|"thinking"|"speaking"}` transient.
- `{type:"transcript.delta",role:"user"|"assistant",item_id,delta}` transient, no learning credit.
- `{type:"audio.delta",item_id,response_id,audio}` PCM24k output.
- `{type:"audio.clear",item_id:string|null}` immediately stop playback; send playback boundary below.
- `{type:"error",code,message,retryable}` sanitized, no provider raw payloads.
- `{type:"ended",workspace}` stop tracks/playback/socket.

Allowed client WS events after authentication:
- `{type:"audio.append",audio}` bounded base64 PCM24k (≤32 KB decoded per frame).
- `{type:"text.submit",client_turn_id:UUID,text}` trimmed 1..4000 chars; idempotent identical repeats; mismatched repeats fail409. No client assistant messages allowed.
- `{type:"playback",item_id,played_ms:number}` actual played duration, every 250 ms and immediately on audio.clear; server clamps to generated audio. Used to identify interrupted delivery and exclude unplayed generations on recovery. The OpenAI adapter can truncate provider context; Gemini has no equivalent exact truncate operation.
- `{type:"microphone",enabled:boolean}` handles clear buffer + output modality; UI view switch does not reconnect/mute.
- `{type:"hint",request_id?:UUID,level?:"usage"|"example",target_item_id?:string}` requests side-panel help; omitted level defaults to usage. Duplicate request IDs are ignored. It does not create an AI/user conversation message.
- `{type:"hint.shown",hint_id:UUID,version:number,level:"direction"|"usage"|"example"}` acknowledges an actually visible level of a known card/version. Invalid deeper levels or absent examples cannot establish exposure; repeat acknowledgments are deduplicated.
- `{type:"message.shown",message_id:string,revision:number}` acknowledges visible saved assistant text; this is presentation evidence, not proof the learner read it.
- `{type:"interrupt"}` cancel generated/playback output.
- `{type:"ping"}` (every10s) → `{type:"pong"}`.

Disconnect releases lease and closes provider. Server checks lease at heartbeat; old connection cannot persist or issue new provider responses after takeover. End/delete HTTP actions fence via DB independently of worker affinity. Browser clears local state/media on owner/session changes and unmount.

## Internal durable adapter interface

New module `app/integrations/speaking_runtime_repository.py` exposes `get_runtime_store()` returning a synchronous adapter; root invokes via `asyncio.to_thread`. Methods:

- `read(owner, session_id) -> dict|None`: envelope `{version:int,document:dict}`. Missing state for an owned existing loadout returns version0/document{}; missing/unowned session returns None.
- `compare_and_swap(owner, session_id, expected_version:int, document:dict, status:str, turn_count:int) -> dict|None`: atomic session row lock; version mismatch raises `RuntimeConflict`; returns updated envelope; missing/unowned returns None. Persists JSON document and session status/turn_count atomically. `RuntimeConflict` defined in this module. No hidden model/provider calls. Document ≤1 MiB; JSON stores finalized data only. Status terminal is irreversible except deletion. Store implementation and RPC enforce this.
- `delete(owner, session_id) -> bool`: owner-scoped cascading session delete.

Document private fields include messages/evidence/learning/policy/analysis_status/hint/help, bounded `teaching_attempts`, runtime `{id,generation,state,expires_at,ticket_hash,ticket_expires_at,ticket_used,client_connection_id}`, `generation`, plus controller counters. Public views strip private fields. Private playback_pending response IDs ensure takeover/end/disconnect cannot restore unheard audio as a fully delivered reply. Gemini response/item IDs are application-generated correlation IDs for observed provider events, since this wire supplies no equivalent item IDs. All runtime decisions read and CAS this single version, retries bounded. Runtime lease updates also increment version. Existing loadout endpoint derives turn_count from durable state after implementation.

Inline adapter only when Supabase unconfigured and PROCESSING_MODE=inline; configured database failures never fallback. New table/RPC server-role-only with RLS. Runtime owns UUID message IDs; provider item IDs are separate; no pending audio deltas persisted.

## Teaching module interface

`app/services/speaking_teaching.py` exports async `analyze_utterance(session: SpeakingSession, message: dict, history:list[dict], previous:dict) -> dict` returning evidence, learning, policy, analysis status, hint, private controller and `analysis_trace`. Runtime scheduling freezes history through the source message/revision. Reconciliation merges only against the authoritative current revision/runtime/session; its returned patch excludes `analysis_trace`. The private trace is recorded separately and includes raw bounded provider content, prompt/model version, usage, finish reason, candidate validation reasons, queue/model timing and policy decision.

The analyzer uses a 12-second whole-request timeout, a 64 KiB response bound and exact quote/UTF-16 validation. In `speaking-analysis-v3`, unique exact quotes receive server-derived UTF-16 offsets; wrong model offsets are repaired only for an unambiguous exact quote in the frozen current text. Repeated quotes require a valid supplied range. Original/resolved ranges and anchor source are logged, while stored evidence remains strictly validated. Optional model recommendations provide intent/opportunity/skip context; server rules own automatic eligibility. Failure retains explicitly uncertain lexical evidence. Neither analysis nor diagnostics waits in the current voice-response path.

For Gemini, initial setup omits selected wording. Implicit controls send a learner task and question, with no target text/meaning or model answer. Private policy metadata retains `target_text`, `target_kind` and `prompt_version` for immutable execution auditing; the public policy projection is unchanged. After a completed response, detected target disclosure forces `not_reflected`; otherwise advisory assessment checks whether the learner was invited to perform the act. Both checks remain outside the audio path.

`app/services/speaking_help.py` exports:

- `generate_help(session,target_item_id,message,history,level) -> dict`: direction/basic fallback, requested usage or one explicitly requested example, plus private analysis trace. Failed detailed generation preserves basic information and returns unavailable.
- `assess_policy_response(policy,response_text) -> dict`: `reflected|not_reflected|appropriate_skip|unknown`, a validated exact quote where required, reason and private assessment trace. This assesses text behavior separately from delivery.

`app/services/speaking_coaching_runtime.py` schedules safe-boundary dispatch, immutable attempt binding, help generation/presentation and the bounded background journal writer. `record_hint_exposure` records actual presentation with target, level, time, overlap and optional `scope: session`; generation alone is insufficient. Automatic attempt counters remain distinct from help exposures. The [diagnostic contract](STAGE_FOUR_TEACHING_CONTROL.md) defines endpoint paging, event families, permissions, retention and best-effort completeness limits.
