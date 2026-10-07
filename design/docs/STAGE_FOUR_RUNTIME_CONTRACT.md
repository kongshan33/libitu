# Stage 4 runtime contract

Implemented contract, 2026-10-01. See [verification and provider-specific boundaries](STAGE_FOUR_IMPLEMENTATION.md).

## Transport and lifecycle

Browser → authenticated Libitu WebSocket → Gemini Live WebSocket (user-selected default); an optional OpenAI adapter shares the application contract. Browser sends PCM16LE mono 24 kHz, text and allowed controls only. Gemini input is resampled to 16 kHz; native audio output remains 24 kHz. Text mode displays output transcription without playing native audio. Server owns provider instructions, responses, transcript persistence, teaching policy and interruption. Analyzer is asynchronous and never blocks the current response. No raw audio persistence. One leased runtime per session; explicit takeover fences the former runtime. Reconnect hydrates finalized messages; never reopens microphone without an action. Maximum 20 minutes per connection, 100 user utterances per mission, bounded input/output and 60-second lost-lease expiry. Text works without microphone permission.

HTTP prefix `/api/speaking/sessions/{id}` (Clerk bearer auth):

- GET existing session remains compatible.
- GET `/workspace` → `SpeakingWorkspace` below.
- POST `/realtime` `{client_connection_id: UUID, takeover: boolean=false}` → `{runtime_id, ticket, expires_at, websocket_path}`. Ticket opaque, one-use, 30 s; delivered in first WS message, never query string. POST uses existing user authorization to reuse configured credentials.
- WS `/realtime/{runtime_id}`: first message `{type:"authenticate",ticket}` within 5 s, then normalized protocol below. Validate Origin against configured authorized parties. No paid provider until ticket accepted.
- POST `/end` → completed workspace, idempotent; closes/fences runtime, expires pending teaching actions. Final read-only transcript/evidence review, no invented Stage 5 scores.
- DELETE session → 204; cascade private text/evidence/runtime and fence live activity.

## Public snapshot and events

`SpeakingWorkspace = {session: SpeakingSession, version:number, runtime: {id:string,generation:number,state:"connecting"|"connected"|"disconnected",expires_at:string}|null, messages: SpeakingMessage[], evidence: SpeakingEvidence[], learning: LearningItem[], policy: TeachingPolicy|null, analysis_status:"idle"|"pending"|"ready"|"unavailable", hint:string|null}`

`SpeakingMessage = {id:string,ordinal:number,role:"user"|"assistant",text:string,input_source:"voice"|"text",status:"final"|"interrupted"|"unavailable",revision:number,provider_item_id:string|null,response_id:string|null,client_turn_id:string|null,created_at:string}`

`SpeakingEvidence = {id:string,session_item_id:string,message_id:string,transcript_revision:number,start:number,end:number,quote:string,match_type:"exact"|"variant"|"structure",appropriateness:"appropriate"|"uncertain"|"inappropriate",prompted:boolean,reason:string}`. Offsets UTF-16, quote must match actual finalized USER transcript. Analyzer cannot fabricate evidence or mark mastery.

`LearningItem = {session_item_id:string,observed_uses:number,independent_uses:number,prompted_uses:number,last_message_id:string|null}`

`TeachingPolicy = {id:string,source_message_id:string,source_revision:number,learning_version:number,target_item_id:string|null,action:"continue_naturally"|"implicit_elicitation"|"explicit_hint"|"move_on",status:"pending"|"applied"|"expired",response_id:string|null,instruction:string}`. Public snapshot removes `instruction`; it is server-only. At most one target. Pending action binds to a not-yet-started response, includes instruction to skip if current learner utterance already demonstrates target. Do not alter active response. Expire across reconnect/end/takeover; evidence survives. Episode evidence accumulates, no mastery claim.

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
- `{type:"hint"}` explicit side-panel hint (not fabricated AI message).
- `{type:"interrupt"}` cancel generated/playback output.
- `{type:"ping"}` (every10s) → `{type:"pong"}`.

Disconnect releases lease and closes provider. Server checks lease at heartbeat; old connection cannot persist or issue new provider responses after takeover. End/delete HTTP actions fence via DB independently of worker affinity. Browser clears local state/media on owner/session changes and unmount.

## Internal durable adapter interface

New module `app/integrations/speaking_runtime_repository.py` exposes `get_runtime_store()` returning a synchronous adapter; root invokes via `asyncio.to_thread`. Methods:

- `read(owner, session_id) -> dict|None`: envelope `{version:int,document:dict}`. Missing state for an owned existing loadout returns version0/document{}; missing/unowned session returns None.
- `compare_and_swap(owner, session_id, expected_version:int, document:dict, status:str, turn_count:int) -> dict|None`: atomic session row lock; version mismatch raises `RuntimeConflict`; returns updated envelope; missing/unowned returns None. Persists JSON document and session status/turn_count atomically. `RuntimeConflict` defined in this module. No hidden model/provider calls. Document ≤1 MiB; JSON stores finalized data only. Status terminal is irreversible except deletion. Store implementation and RPC enforce this.
- `delete(owner, session_id) -> bool`: owner-scoped cascading session delete.

Document private fields include messages/evidence/learning/policy/analysis_status/hint, runtime `{id,generation,state,expires_at,ticket_hash,ticket_expires_at,ticket_used,client_connection_id}`, `generation`, plus controller counters. Public views strip private fields. Private playback_pending response IDs ensure takeover/end/disconnect cannot restore unheard audio as a fully delivered reply. Gemini response/item IDs are application-generated correlation IDs for observed provider events, since this wire supplies no equivalent item IDs. All runtime decisions read and CAS this single version, retries bounded. Runtime lease updates also increment version. Existing loadout endpoint derives turn_count from durable state after implementation.

Inline adapter only when Supabase unconfigured and PROCESSING_MODE=inline; configured database failures never fallback. New table/RPC server-role-only with RLS. Runtime owns UUID message IDs; provider item IDs are separate; no pending audio deltas persisted.

## Teaching module interface

`app/services/speaking_teaching.py` exports async `analyze_utterance(session: SpeakingSession, message: dict, history:list[dict], previous:dict) -> dict` returning `{evidence:list[dict], learning:list[dict], policy:dict|null, analysis_status:"ready"|"unavailable", hint:str|null}`; root commits only if message revision/runtime/session still current. `previous` includes current evidence/learning/policy and `version`. IDs correspond exactly to contract above. Analyzer HTTP uses own short timeout/output bounds and validates quoted spans. Uses existing DeepSeek key/config (separate bounded budgets) or deterministic exact-match evidence if unavailable; distinguish lexical occurrence from semantic appropriateness. Rule controller never awards mastery or fabricates scores. Export pure helper `explicit_hint(session, state)->str` for user-requested sidebar help. Own tests cover Unicode spans, quoted/negated examples, stale evidence, repeat/cooldown, prompted/spontaneous.
