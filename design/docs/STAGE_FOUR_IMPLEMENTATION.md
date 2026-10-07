# Stage 4: live conversation

Implemented locally, 2026-10-01. The earlier [implementation plan](STAGE_FOUR_IMPLEMENTATION_PLAN.md) is design history; this page and [runtime contract](STAGE_FOUR_RUNTIME_CONTRACT.md) describe current behavior.

## Delivered behavior

`/speaking/[sessionId]` now opens the actual speaking workspace. Voice and Chat share the same authenticated mission, conversation, microphone and playback. The reference-inspired orb, warm surfaces, purple learner messages, language evidence, optional logic guide, responsive sidebar and focus view use the existing visual tokens. The logic guide does not pretend to detect completed argument stages.

Starting voice is an explicit action. Speech is streamed continuously, Gemini detects turn boundaries, and learners can interrupt. Typed messages work without microphone permission; muting or changing the visible view does not create a separate mission. Native Gemini audio generation remains enabled in text mode, but audio is discarded and its output transcription is displayed. Backgrounding, leaving, changing account and ending release browser media and the provider connection. Reconnection is manual and recovers acknowledged text; it does not reopen the microphone automatically.

An asynchronous DeepSeek analyzer checks finalized learner utterances while the live partner responds independently. Exact lexical fallback is explicitly uncertain if semantic analysis fails. Evidence contains a selected snapshot ID, message/revision, exact quote, UTF-16 offsets, match kind, contextual assessment and prompted/independent attribution. A deterministic controller selects one target, observes a two-turn cooldown and limits repeated hints. Usage observations accumulate within the episode without a mastery score. Revision changes invalidate old evidence, and late analysis cannot overwrite a newer hint exposure or applied policy.

End mission saves a read-only transcript and evidence review. The subsequent [Stage 5 increment](STAGE_FIVE_CONTRACT.md) now requests a durable report and navigates to Analytics, with a link back to this transcript. Delete removes the private session, cascading runtime document and report. Stage 4 itself produces no final scores, raw-audio recording archive or pronunciation grading.

## Provider and event details

The user selected Gemini Live on 2026-10-01. The configured model is `gemini-3.8-live`, voice `Kore`, through a fixed Google WebSocket origin with the key in a server-only header. Browser → FastAPI → provider keeps instructions and allowed controls on the server. The browser sends PCM16LE mono24k; a stateful low-pass resampler sends PCM16k to Gemini and output is PCM24k. The older OpenAI adapter remains selectable via configuration, but live OpenAI testing stopped at an exhausted-credit response; it is not the locally selected provider.

Gemini setup is immutable within a connection. Private teaching context is appended at an idle provider `turnComplete` boundary or immediately before a typed request, with generation disabled for that control message. It is applied to an observed subsequent response, never patched into active audio. Slow analysis can miss the immediately following turn; stale actions expire. This is feedback control, not reinforcement learning.

Observed Gemini wire events use `voiceActivity.type` with `ACTIVITY_START`/`ACTIVITY_END`. The current service does not always emit the SDK's optional transcription `finished` flag. Without it, a matching ended VAD segment plus a non-interrupted completed model generation provides the finalization boundary. An interrupted old reply cannot finalize a new learner utterance. Ambiguous overlapping transcription remains unconfirmed and receives no learning credit. Late fragments revise the same utterance rather than incrementing the turn count.

Gemini does not expose OpenAI's exact audio truncation operation. Playback stops immediately in the browser and incomplete deliveries are marked interrupted. Generated text may include words not played; interrupted replies are excluded from reconstructed provider context. Durable pending-playback metadata also protects recovery after a lost connection or takeover. This does not claim word-accurate audio/text alignment or exact deletion from an ongoing Gemini context.

Sources checked during implementation: [Gemini Live protocol](https://ai.google.dev/api/live), [WebSocket setup](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket), [audio and VAD capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities), [OpenAI conversation events](https://developers.openai.com/api/docs/guides/realtime-conversations).

## Storage and operation

Applied migration: `20261001111236_speaking_runtime_state.sql`. A bounded JSON document per mission stores finalized messages, evidence, learning counters, policies and a leased runtime. A server-only, security-invoker RPC atomically compares the document version and updates session status/turn count. RLS and grants prohibit browser roles. It intentionally does not write the legacy `speaking_turns` table or persist audio frames/token deltas.

One active runtime per mission, a one-use 30-second ticket delivered in the first socket message, strict Origin validation, explicit takeover, 60-second lease and approximately two-second remote-owner checks fence old connections. Heartbeats renew the lease; a dead process can be replaced after expiry. HTTP end/delete work independently of worker affinity. Session end preserves finalized/acknowledged content; in-flight unconfirmed fragments can be lost. Client text IDs make retries idempotent. Public snapshots omit provider prompts, ticket hashes, credentials and controller internals.

Defaults: at most 100 learner utterances, 4,000 characters per typed/finalized learner message, 450 provider output tokens, 20-minute application connection ceiling, three-minute idle timeout and 1 MiB persisted document. Gemini can require reconnection sooner. These are per-connection/mission bounds; account-wide rate limits, spend enforcement, production supervision and fleet metrics remain operational follow-ups. This local delivery has not been deployed.

Configuration lives in ignored `apps/api/.env`; safe variable names/defaults are in `.env.example`. Select `SPEAKING_REALTIME_PROVIDER=gemini`, configure `GEMINI_API_KEY`, and reuse `DEEPSEEK_API_KEY` for the separate analyzer. Secrets never enter browser bundles. Libitu retains text and derived observations, not raw audio; provider processing/retention is a separate boundary.

## Verification

- Root lint, production build and 982 automated tests pass (603 API, 267 web, 112 extension); automatic tests explicitly clear paid-provider credentials.
- Real Supabase transaction tests cover ownership, concurrent CAS, terminal state, payload bounds, server-only grants and cascade deletion. Synthetic records are rolled back or removed.
- Real Gemini header authentication, text → audio, and synthetic spoken input → VAD/transcription → audio passed. Full service smokes also ran real DeepSeek analysis, exact language evidence persistence, end and recovery against Supabase. The opt-in script is `apps/api/scripts/smoke_speaking_runtime.py --live [--voice]`; the voice smoke uses locally generated speech, not a person's microphone.
- One bounded live interruption probe confirmed `ACTIVITY_START → interrupted → turnComplete` while AI audio was playing. No subsequent `ACTIVITY_END`, user transcription or reply arrived within its 35-second limit; that complete post-interruption turn remains unverified. The probe was stopped without retry. Regression fixtures ensure the interrupted old `turnComplete` cannot finalize the new learner utterance.
- Browser checks at 1440/768/390 cover real Chrome AudioWorklet capture, PCM payloads and Web Audio playback with synthetic server events, Voice/Chat continuity, text-only/denied-mic paths, interrupt/mute, lost acknowledgements, explicit takeover, hidden-tab pause, account change, end/reload/delete. Orb states, reduced motion and 200% equivalent reflow were inspected.
- Full Loadout/Shadow persistence browser regression passed, including cross-tab locks, identity changes and pending writes across navigation.

This verification does not establish physical-phone audio quality, human accent accuracy, network-wide latency/cost distributions or completed real Clerk/OAuth sign-in. Manual transcript editing, detected logic-stage progression and Stage 5 assessment remain separate work.
