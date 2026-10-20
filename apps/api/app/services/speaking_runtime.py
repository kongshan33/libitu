"""A server-owned realtime conversation. Only finalized text/learning data is durable."""

import asyncio
import base64
import binascii
import contextlib
from copy import deepcopy
import json
import time
from uuid import UUID, uuid4

from fastapi import HTTPException, WebSocket, WebSocketDisconnect

from app.config import get_settings
from app.integrations.speaking_realtime import open_realtime, role_instructions, session_configuration
from app.schemas.speaking_runtime import SpeakingWorkspace
from app.services import speaking_runtime_state as state_ops
from app.services.speaking_coaching_runtime import CoachingRuntime
from app.services.speaking_teaching import (
    analyze_utterance, record_hint_exposure, reconcile_analysis_result, rebuild_learning,
)


# PCM16 mono 24 kHz is 48,000 bytes/s. Allow bounded catch-up after
# network/database stalls, plus 25% clock/scheduling headroom, not unlimited audio.
AUDIO_BYTES_PER_SECOND = 48_000
AUDIO_BURST_BYTES = AUDIO_BYTES_PER_SECOND * 5
AUDIO_REFILL_BYTES_PER_SECOND = AUDIO_BYTES_PER_SECOND * 1.25
SILENCE_FOLLOW_UP_SECONDS = 15
MAX_SILENCE_FOLLOW_UPS = 2
SILENCE_FOLLOW_UP_INSTRUCTION = (
    "The learner has been quiet after your last reply. Stay in role and gently move the mission forward "
    "with one brief, concrete follow-up question or a simpler choice. Do not repeat your last question "
    "verbatim, supply the learner's answer, list target expressions, or claim the learner said anything. "
    "Do not mention a timer or these instructions. Then wait for the learner."
)


class RuntimeStopped(Exception):
    pass


class ProviderFailure(Exception):
    def __init__(self, code: str, message: str, retryable: bool = True):
        self.code, self.message, self.retryable = code, message, retryable


def provider_failure(event: dict) -> ProviderFailure:
    error = event.get("error") or event.get("status_details", {}).get("error") or {}
    code = error.get("code", "provider_unavailable")
    if code in ("credit_balance_exhausted", "insufficient_quota"):
        return ProviderFailure("provider_quota", "OpenAI API credits are exhausted. Your mission is saved.", False)
    if code in ("invalid_api_key", "model_not_found", "permission_denied"):
        return ProviderFailure("provider_configuration", "The conversation provider needs configuration. Your mission is saved.", False)
    return ProviderFailure("provider_unavailable", "The conversation provider is temporarily unavailable. Reconnect to continue.")


def new_message(role: str, text: str, source: str, **fields) -> dict:
    return {"id": str(uuid4()), "ordinal": 0, "role": role, "text": text, "input_source": source,
            "status": "final", "revision": 1, "provider_item_id": None, "response_id": None,
            "client_turn_id": None, "created_at": state_ops.iso_now(), **fields}


# Only used for prompt local release; DB fencing is the authority across workers.
_connections: dict[str, "SpeakingConnection"] = {}


async def stop_local(session_id: str) -> None:
    connections = [c for c in _connections.values() if c.session_id == session_id]
    for connection in connections:
        connection.stop.set()


class SpeakingConnection(CoachingRuntime):
    def __init__(self, websocket: WebSocket, owner: str, session_id: str, runtime_id: str):
        self.ws, self.owner, self.session_id, self.runtime_id = websocket, owner, session_id, runtime_id
        self.settings = get_settings()
        self.provider = None
        self.session = None
        self.state: dict = {}
        self.send_lock = asyncio.Lock()
        self.provider_lock = asyncio.Lock()
        self.operation_lock = asyncio.Lock()
        self.stop = asyncio.Event()
        self.analysis_tasks: set[asyncio.Task] = set()
        self.analysis_lock = asyncio.Lock()
        self.microphone = False
        self.started = time.monotonic()
        self.last_activity = self.started
        self.last_ping = self.started
        self.active_response: str | None = None
        self.response_requested = False
        self.pending_request: dict | None = None
        self.queued_response = False
        self.responses: dict[str, dict] = {}
        self.audio_items: dict[str, dict] = {}
        self.playback_confirmations: set[str] = set()
        self.last_audio_item: str | None = None
        self.user_items: dict[str, str] = {}
        self.sent_text: set[str] = set()
        self.audio_refilled_at = self.started
        self.audio_budget = float(AUDIO_BURST_BYTES)
        self.conversation_started = False
        self.user_speaking = False
        self.silence_since: float | None = None
        self.silence_follow_ups = 0
        self.control_window = self.started
        self.control_count = 0
        self.init_coaching()

    async def send(self, document: dict) -> None:
        async with self.send_lock:
            await asyncio.wait_for(self.ws.send_json(document), timeout=5)

    async def upstream(self, document: dict) -> None:
        async with self.provider_lock:
            await asyncio.wait_for(self.provider.send(json.dumps(document)), timeout=5)

    def workspace(self) -> dict:
        session = self.session.model_copy(update={"status": self.state["status"], "turn_count": self.state["turn_count"]})
        document = self.state["document"]
        return SpeakingWorkspace.model_validate({
            "session": session, "version": self.state["version"],
            **{k: document[k] for k in ("runtime", "messages", "evidence", "learning", "policy", "analysis_status", "hint", "help")
               if k in document},
        }).model_dump(mode="json")

    async def commit(self, operation, publish: bool = True) -> None:
        result = await asyncio.to_thread(state_ops.mutate, self.owner, self.session_id, operation, self.runtime_id)
        if result["version"] >= self.state.get("version", -1):
            self.state = result
        if publish:
            await self.send({"type": "snapshot", "workspace": self.workspace()})

    async def fence(self) -> None:
        state = await asyncio.to_thread(state_ops.read_state, self.owner, self.session_id)
        runtime = state["document"].get("runtime") or {}
        if (state["status"] != "active" or runtime.get("id") != self.runtime_id
                or runtime.get("state") == "disconnected" or not state_ops.is_future(runtime.get("expires_at"))):
            self.state = state
            raise RuntimeStopped
        if state["version"] > self.state.get("version", -1):
            self.state = state

    async def run(self) -> None:
        tasks: list[asyncio.Task] = []
        try:
            self.session = await asyncio.to_thread(state_ops.require_session, self.owner, self.session_id)
            self.state = await asyncio.to_thread(state_ops.read_state, self.owner, self.session_id)
            await self.fence()
            _connections[self.runtime_id] = self
            async with self.transport() as provider:
                self.provider = provider
                await self.configure()
                await self.commit(lambda d, _: d["runtime"].update(state="connected", expires_at=state_ops.future(self.settings.speaking_lease_seconds)), False)
                await self.send({"type": "ready", "workspace": self.workspace()})
                await self.send({"type": "state", "state": "listening"})
                tasks = [asyncio.create_task(self.provider_loop()), asyncio.create_task(self.client_loop()),
                         asyncio.create_task(self.heartbeat()), asyncio.create_task(self.stop.wait())]
                # The first microphone control acknowledges browser readiness.
                # Requesting an opening before it arrives can discard/cancel audio.
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
        except ProviderFailure as error:
            with contextlib.suppress(Exception):
                await self.send({"type": "error", "code": error.code, "message": error.message, "retryable": error.retryable})
        except (RuntimeStopped, HTTPException) as error:
            with contextlib.suppress(Exception):
                if isinstance(error, HTTPException) and error.status_code not in (404, 409):
                    await self.send({"type": "error", "code": f"runtime_{error.status_code}",
                                     "message": str(error.detail)[:300], "retryable": error.status_code >= 500})
                workspace = await asyncio.to_thread(state_ops.public_workspace, self.owner, self.session_id)
                if workspace.session.status in ("completed", "abandoned"):
                    await self.send({"type": "ended", "workspace": workspace.model_dump(mode="json")})
                else:
                    await self.send({"type": "error", "code": "connection_replaced",
                                     "message": str(error.detail)[:300] if isinstance(error, HTTPException) else
                                     "This connection ended or was replaced. Reconnect to continue.", "retryable": True})
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        except Exception:
            with contextlib.suppress(Exception):
                await self.send({"type": "error", "code": "connection_lost",
                                 "message": "The connection was interrupted. Your saved conversation is kept.", "retryable": True})
        finally:
            for task in tasks + list(self.analysis_tasks):
                task.cancel()
            await asyncio.gather(*tasks, *self.analysis_tasks, return_exceptions=True)
            _connections.pop(self.runtime_id, None)
            with contextlib.suppress(Exception):
                await self.persist_interrupted()
            await self.close_coaching()
            with contextlib.suppress(Exception):
                await asyncio.to_thread(state_ops.disconnect_runtime, self.owner, self.session_id, self.runtime_id)
            with contextlib.suppress(Exception):
                await self.ws.close()

    def transport(self):
        return open_realtime(self.settings)

    async def configure(self) -> None:
        event = json.loads(await asyncio.wait_for(self.provider.recv(), 15))
        if event.get("type") == "error":
            raise provider_failure(event)
        if event.get("type") != "session.created":
            raise ProviderFailure("provider_protocol", "The voice provider could not start this session.")
        await self.upstream(session_configuration(self.settings, self.session))
        async with asyncio.timeout(15):
            while True:
                event = json.loads(await self.provider.recv())
                if event.get("type") == "error":
                    raise provider_failure(event)
                if event.get("type") == "session.updated":
                    break
        # A reconnect only hydrates acknowledged text. Interrupted assistant
        # generations may contain unplayed words and are deliberately excluded.
        for message in self.state["document"].get("messages", []):
            if message["status"] != "final" or not message["text"]:
                continue
            await self.upstream({"type": "conversation.item.create", "item": {
                "type": "message", "role": message["role"],
                "content": [{"type": "input_text" if message["role"] == "user" else "output_text", "text": message["text"]}],
            }})

    async def heartbeat(self) -> None:
        last_renew = time.monotonic()
        while True:
            await asyncio.sleep(2)
            await self.fence()
            current = time.monotonic()
            if current - self.started >= self.settings.speaking_max_connection_seconds:
                raise ProviderFailure("connection_limit", "This connection reached its time limit. Reconnect to continue.")
            if current - self.last_activity >= self.settings.speaking_idle_seconds or current - self.last_ping > 35:
                raise ProviderFailure("connection_idle", "The idle connection was closed. Reconnect when you are ready.")
            if current - last_renew >= 10:
                await self.commit(lambda d, _: d["runtime"].update(expires_at=state_ops.future(self.settings.speaking_lease_seconds)), False)
                last_renew = current

            async with self.operation_lock:
                await self.advance_silence(time.monotonic())

    def response_busy(self) -> bool:
        return bool(self.active_response or self.response_requested or self.queued_response)

    def note_user_text(self, text: str) -> None:
        if text.strip():
            self.last_activity = time.monotonic()
            self.silence_since = None
            self.silence_follow_ups = 0

    async def advance_silence(self, current: float) -> None:
        playback_pending = any(not item.get("truncated") and
                               item["played_ms"] < item["generated_ms"] - 1
                               for item in self.audio_items.values())
        if (not self.conversation_started or not self.microphone or self.user_speaking
                or self.response_busy() or playback_pending or self.stop.is_set()):
            self.silence_since = None
            return
        if self.silence_follow_ups >= MAX_SILENCE_FOLLOW_UPS:
            return
        if self.silence_since is None:
            self.silence_since = current
            return
        if current - self.silence_since < SILENCE_FOLLOW_UP_SECONDS:
            return
        # Called under operation_lock; request_response fences ownership before
        # any provider request. Controls never fabricate a saved learner turn.
        await self.request_response(follow_up=True)
        self.silence_follow_ups += 1
        self.silence_since = None

    def consume_audio_budget(self, size: int, current: float) -> None:
        elapsed = max(0.0, current - self.audio_refilled_at)
        self.audio_budget = min(AUDIO_BURST_BYTES, self.audio_budget + elapsed * AUDIO_REFILL_BYTES_PER_SECOND)
        self.audio_refilled_at = current
        if size > self.audio_budget:
            raise ProviderFailure("audio_rate", "Audio input exceeded the supported streaming rate. Reconnect to continue.", False)
        self.audio_budget -= size

    async def request_response(self, opening: bool = False, follow_up: bool = False) -> None:
        await self.fence()
        if self.active_response or self.response_requested:
            self.queued_response = True
            return
        request_id = str(uuid4())
        policy = await self.eligible_policy()
        instruction = role_instructions(self.session)
        policy_id = None
        if policy and policy.get("status") == "pending":
            source = next((m for m in self.state["document"].get("messages", [])
                           if m["id"] == policy["source_message_id"] and m["revision"] == policy["source_revision"]), None)
            if source:
                policy_id = policy["id"]
                instruction += ("\nFor this response only: " + policy.get("instruction", "") +
                                " Skip this teaching action if the current learner utterance already uses the target, "
                                "changes topic, or asks a direct question that needs an answer. Keep the role-play natural.")
        if opening:
            instruction += "\nBegin now with one brief in-role opening. Do not list training objectives."
        elif follow_up:
            instruction += "\n" + SILENCE_FOLLOW_UP_INSTRUCTION
        self.silence_since = None
        attempt = self.new_attempt(policy) if policy_id else None
        self.pending_request = {"request_id": request_id, "policy_id": policy_id, "audio": self.microphone,
                                "policy_attempt": attempt}
        self.response_requested = True
        await self.upstream({"type": "response.create", "response": {
            "instructions": instruction, "output_modalities": ["audio"] if self.microphone else ["text"],
            "max_output_tokens": self.settings.speaking_max_output_tokens,
            "metadata": {"request_id": request_id},
        }})
        if attempt:
            self.diagnostic("policy.sent", {"attempt": attempt})
        await self.send({"type": "state", "state": "thinking"})

    async def interrupt(self) -> None:
        if self.active_response:
            self.responses[self.active_response]["interrupted"] = True
            await self.upstream({"type": "response.cancel", "response_id": self.active_response})
        if self.response_requested and self.pending_request:
            self.pending_request["interrupted"] = True
        item_id = self.last_audio_item
        await self.send({"type": "audio.clear", "item_id": item_id})
        if item_id:
            await self.truncate_audio(item_id)
        self.last_audio_item = None

    async def truncate_audio(self, item_id: str) -> None:
        item = self.audio_items.get(item_id)
        if not item or item.get("truncated"):
            return
        heard = min(item["played_ms"], item["generated_ms"])
        if heard >= item["generated_ms"]:
            return
        item["truncated"] = True
        response = self.responses.get(item["response_id"])
        if response:
            response["interrupted"] = True
        await self.upstream({"type": "conversation.item.truncate", "item_id": item_id,
                             "content_index": 0, "audio_end_ms": int(heard)})
        # If generation already finished but playback did not, revoke its final
        # status so recovery cannot re-inject unheard words into provider context.
        def mark(document, _):
            for message in document["messages"]:
                if message.get("provider_item_id") == item_id and message["role"] == "assistant":
                    message["status"] = "interrupted"
        await self.commit(mark)
        self.playback_logged(item_id)

    async def persist_interrupted(self) -> None:
        def revoke_unheard(document, _):
            pending = {item["response_id"] for item in self.audio_items.values()
                       if item["played_ms"] < item["generated_ms"] - 1 or item.get("truncated")}
            acknowledged = {item["response_id"] for item in self.audio_items.values()
                            if item["played_ms"] >= item["generated_ms"] - 1
                            and not item.get("truncated")
                            and self.responses.get(item["response_id"], {}).get("persisted")}
            # Receipt precedes its background CAS. Shutdown persists this known
            # completion itself instead of treating a still-pending write as
            # unheard audio; unknown responses retain the conservative behavior.
            pending.update(set(document.get("playback_pending", [])) - (acknowledged - pending))
            for message in document["messages"]:
                if message.get("response_id") in pending:
                    message["status"] = "interrupted"
            document["playback_pending"] = []
        if self.audio_items:
            await self.commit(revoke_unheard, False)
        for response in self.responses.values():
            if response.get("persisted") or not response.get("item_id"):
                continue
            await self.save_assistant(response, "interrupted")

    async def save_assistant(self, response: dict, status: str) -> None:
        message = new_message("assistant", response.get("text", "")[:8000], "voice" if response["audio"] else "text",
                              status=status, provider_item_id=response.get("item_id"), response_id=response["id"])
        def save(document, _):
            existing = next((m for m in document["messages"] if m.get("response_id") == response["id"]), None)
            if existing:
                if existing["status"] != "unavailable":
                    return
                existing.update({k: v for k, v in message.items() if k not in ("id", "ordinal")})
            else:
                message["ordinal"] = len(document["messages"])
                document["messages"].append(message)
            audio = self.audio_items.get(response.get("item_id"))
            if status == "final" and audio and audio["played_ms"] < audio["generated_ms"]:
                document.setdefault("playback_pending", []).append(response["id"])
        await self.commit(save)
        response["persisted"] = True
        self.response_saved(response, status)
        if response.get("item_id"):
            # A playback ACK can arrive while this final transcript is saving.
            # Reconcile it after the save even if the browser sends no more ACKs.
            self.confirm_playback(response["item_id"])
            self.playback_logged(response["item_id"])

    def confirm_playback(self, item_id: str) -> None:
        """Persist a completed playback ACK without blocking subsequent PCM."""
        item = self.audio_items.get(item_id)
        if (not item or item["played_ms"] < item["generated_ms"] - 1
                or item["response_id"] in self.playback_confirmations
                or item["response_id"] not in self.state["document"].get("playback_pending", [])):
            return
        response_id = item["response_id"]
        self.playback_confirmations.add(response_id)

        async def persist():
            try:
                def delivered(document, _):
                    # Provider output can grow between receipt and the CAS retry.
                    if item["played_ms"] >= item["generated_ms"] - 1:
                        document["playback_pending"] = [value for value in document.get("playback_pending", [])
                                                        if value != response_id]
                await self.commit(delivered, False)
            except asyncio.CancelledError:
                self.diagnostic("response.playback_commit_unknown", {
                    "response_id": response_id, "reason": "shutdown_timeout"})
                raise
            except Exception:
                self.diagnostic("response.playback_uncommitted", {
                    "response_id": response_id, "reason": "connection_fenced_or_storage"})
            finally:
                self.playback_confirmations.discard(response_id)

        # The existing bounded exposure drain covers already-received playback.
        self.background(persist(), exposure=True)

    async def provider_loop(self) -> None:
        async for raw in self.provider:
            event = json.loads(raw)
            async with self.operation_lock:
                await self.provider_event(event)
        raise ProviderFailure("provider_disconnected", "The voice connection closed. Reconnect to continue.")

    async def provider_event(self, event: dict) -> None:
        kind = event.get("type")
        if kind == "error":
            # Cancellation can race response.done; it is safe and expected.
            if event.get("error", {}).get("code") in ("response_cancel_not_active",):
                return
            raise provider_failure(event)
        if kind == "input_audio_buffer.speech_started":
            self.user_speaking = True
            self.user_activity_at = state_ops.iso_now()
            await self.send({"type": "user.activity", "speaking": True})
            self.silence_since = None
            self.last_activity = time.monotonic()
            await self.interrupt()
            await self.send({"type": "state", "state": "listening"})
        elif kind == "input_audio_buffer.speech_stopped":
            self.user_speaking = False
            await self.send({"type": "user.activity", "speaking": False})
            self.silence_since = None
        elif kind == "input_audio_buffer.committed":
            self.user_speaking = False
            item_id = event["item_id"]
            message = new_message("user", "", "voice", provider_item_id=item_id, status="unavailable",
                                  started_at=self.user_activity_at or state_ops.iso_now())
            def append(document, _):
                existing = next((m for m in document["messages"] if m.get("provider_item_id") == item_id), None)
                if existing:
                    message["id"] = existing["id"]
                    return
                if sum(m["role"] == "user" for m in document["messages"]) >= self.settings.speaking_max_turns:
                    raise HTTPException(409, "Mission turn limit reached. End this mission to review it.")
                message["ordinal"] = len(document["messages"])
                document["messages"].append(message)
            await self.commit(append)
            self.user_items[item_id] = message["id"]
            await self.request_response()
        elif kind == "conversation.item.input_audio_transcription.delta":
            self.note_user_text(event.get("delta", ""))
            await self.send({"type": "transcript.delta", "role": "user", "item_id": event["item_id"], "delta": event.get("delta", "")[:4000]})
        elif kind == "conversation.item.input_audio_transcription.completed":
            await self.final_user_transcript(event["item_id"], event.get("transcript", ""))
        elif kind == "conversation.item.input_audio_transcription.failed":
            await self.send({"type": "error", "code": "transcription_failed",
                             "message": "That utterance could not be transcribed. You can repeat it or type it.", "retryable": True})
        elif kind == "response.created":
            response = event["response"]
            pending = self.pending_request
            if not pending or response.get("metadata", {}).get("request_id") != pending["request_id"]:
                raise ProviderFailure("provider_protocol", "An unexpected response was stopped. Reconnect to continue.")
            self.response_requested = False
            self.pending_request = None
            self.active_response = response["id"]
            self.responses[response["id"]] = {**pending, "id": response["id"], "text": "", "item_id": None, "persisted": False}
            if pending.get("policy_attempt"):
                def apply(document, _):
                    self.bind_attempt(document, self.responses[response["id"]], pending["policy_attempt"])
                await self.commit(apply)
                self.response_bound(self.responses[response["id"]])
            if pending.get("interrupted"):
                await self.upstream({"type": "response.cancel", "response_id": response["id"]})
        elif kind in ("response.output_item.added", "response.output_item.done"):
            response = self.responses.get(event.get("response_id"))
            item = event.get("item", {})
            if response and item.get("role") == "assistant":
                response["item_id"] = item.get("id")
        elif kind in ("response.output_text.delta", "response.output_audio_transcript.delta"):
            response = self.responses.get(event.get("response_id"))
            if response and not response.get("interrupted"):
                delta = event.get("delta", "")
                response["text"] = (response["text"] + delta)[:8000]
                response["item_id"] = event.get("item_id")
                await self.send({"type": "transcript.delta", "role": "assistant", "item_id": event["item_id"], "delta": delta})
        elif kind == "response.output_audio.delta":
            response = self.responses.get(event.get("response_id"))
            if response and not response.get("interrupted"):
                item_id = event["item_id"]
                response["item_id"] = item_id
                item = self.audio_items.setdefault(item_id, {"response_id": response["id"], "generated_ms": 0, "played_ms": 0})
                item["generated_ms"] += len(base64.b64decode(event["delta"])) / 48
                self.last_audio_item = item_id
                await self.send({"type": "audio.delta", "item_id": item_id, "response_id": response["id"], "audio": event["delta"]})
                self.audio_forwarded(response)
                await self.send({"type": "state", "state": "speaking"})
        elif kind == "response.done":
            response_event = event["response"]
            response = self.responses.get(response_event["id"])
            if not response:
                return
            if response_event.get("status") == "failed":
                raise provider_failure(response_event)
            if not response.get("interrupted"):
                for item in response_event.get("output", []):
                    if item.get("role") == "assistant":
                        response["item_id"] = item.get("id")
                        response["text"] = "".join(c.get("transcript", c.get("text", "")) for c in item.get("content", []))[:8000]
            status = "interrupted" if response.get("interrupted") or response_event.get("status") != "completed" else "final"
            await self.save_assistant(response, status)
            if self.active_response == response["id"]:
                self.active_response = None
            await self.send({"type": "state", "state": "listening"})
            if self.queued_response:
                self.queued_response = False
                await self.request_response()

    async def final_user_transcript(self, item_id: str, text: str) -> None:
        text = text.strip()
        self.note_user_text(text)
        selected = None
        def save(document, _):
            nonlocal selected
            message = next((m for m in document["messages"] if m.get("provider_item_id") == item_id and m["role"] == "user"), None)
            if message is None or (message["status"] == "final" and message["text"] == text):
                return
            if not text or len(text) > 4000:
                return
            if message["status"] == "final":
                message["revision"] += 1
                document["evidence"] = [row for row in document.get("evidence", []) if row["message_id"] != message["id"]]
                document["learning"] = rebuild_learning(self.session, document["evidence"])
                policy = document.get("policy")
                if policy and policy.get("status") == "pending" and policy.get("source_message_id") == message["id"]:
                    policy["status"] = "expired"
            message.update(text=text, status="final", finalized_at=state_ops.iso_now())
            if (document.get("help") or {}).get("source") == "automatic":
                document["help"] = None
            document["analysis_status"] = "pending"
            selected = dict(message)
        await self.commit(save)
        if selected:
            self.schedule_analysis(selected)

    def schedule_analysis(self, message: dict) -> None:
        key = (message["id"], message["revision"])
        if key in self.analysis_keys:
            return
        self.analysis_keys.add(key)
        history = deepcopy([m for m in self.state["document"].get("messages", [])
                            if m.get("ordinal", 0) <= message.get("ordinal", 0)])
        queued_message = {**deepcopy(message), "analysis_enqueued_at": time.monotonic(),
                          "context_version_at_queue": self.state["version"]}
        self.analysis_queue[key] = (queued_message, history)
        self.diagnostic("analysis.scheduled", {"message_id": message["id"], "revision": message["revision"],
            "source_text": message["text"], "context_version": self.state["version"],
            "context": [{k: m.get(k) for k in ("id", "revision", "role", "text")} for m in history[-7:]]})
        if self.analysis_worker and not self.analysis_worker.done():
            return
        async def drain():
            try:
                while self.analysis_queue:
                    # Latest context gets the next slot; older evidence still receives analysis.
                    next_key = max(self.analysis_queue, key=lambda k: (self.analysis_queue[k][0].get("ordinal", 0), k[1]))
                    selected, frozen = self.analysis_queue.pop(next_key)
                    await self.analyze(selected, frozen)
            finally:
                for pending, _ in self.analysis_queue.values():
                    self.diagnostic("analysis.cancelled", {"message_id": pending["id"], "revision": pending["revision"],
                                                            "reason": "connection_closed_before_start"})
                self.analysis_queue.clear()
        task = asyncio.create_task(drain())
        self.analysis_worker = task
        self.analysis_tasks.add(task)
        task.add_done_callback(self.analysis_tasks.discard)

    async def analyze(self, message: dict, history: list[dict] | None = None) -> None:
        run_id = str(uuid4())
        queued = message.get("analysis_enqueued_at", time.monotonic())
        context = deepcopy(history if history is not None else [m for m in self.state["document"].get("messages", [])
                           if m.get("ordinal", 0) <= message.get("ordinal", 0)])
        identity = {"run_id": run_id, "message_id": message["id"], "revision": message["revision"]}
        self.diagnostic("analysis.queued", {**identity, "context": [{"id": m["id"], "revision": m["revision"]}
                                                                    for m in context]})
        try:
            # Serialized analyzer work avoids losing episode evidence while the
            # independent realtime path continues without waiting for analysis.
            async with self.analysis_lock:
                await self.fence()
                previous = deepcopy({**self.state["document"], "version": self.state["version"]})
                for exposure in list(self.pending_exposures.values()):
                    previous["controller"] = record_hint_exposure(self.session, previous, exposure)
                self.diagnostic("analysis.started", {**identity, "queue_ms": round((time.monotonic() - queued) * 1000),
                                                       "context_version": previous["version"]})
                result = await analyze_utterance(self.session, message, context, previous)
                self.diagnostic("analysis.completed", {**identity, "trace": result.get("analysis_trace"),
                                                         "status": result.get("analysis_status"),
                                                         "policy": result.get("policy")})
                outcome = {}
                def apply(document, state):
                    current = next((m for m in document["messages"] if m["id"] == message["id"]), None)
                    if not current or current["revision"] != message["revision"]:
                        outcome["reason"] = "source_revised"
                        return
                    patch = reconcile_analysis_result(self.session, document, result, previous)
                    document.update(patch)
                    outcome.update(policy=deepcopy(patch.get("policy")), reason="committed")
                await self.commit(apply)
                self.diagnostic("analysis.reconciled", {**identity, **outcome})
                # Wakes a safe-boundary check even if turnComplete preceded the model result.
                self.schedule_coaching()
                if result.get("analysis_trace", {}).get("needs_help"):
                    latest = next((m for m in reversed(self.state["document"].get("messages", []))
                                   if m["role"] == "user"), None)
                    if latest and latest["id"] == message["id"] and latest["revision"] == message["revision"]:
                        self.request_help({"level": result["analysis_trace"].get("help_level") or "usage"})
        except asyncio.CancelledError:
            self.diagnostic("analysis.cancelled", identity)
            raise
        except (HTTPException, RuntimeStopped):
            self.diagnostic("analysis.discarded", {**identity, "reason": "connection_fenced"})
            return
        except Exception:
            self.diagnostic("analysis.failed", {**identity, "reason": "internal_error"})
            with contextlib.suppress(Exception):
                await self.commit(lambda d, _: d.update(analysis_status="unavailable"))

    async def client_loop(self) -> None:
        while True:
            raw = await self.ws.receive_text()
            if len(raw) > 50000:
                raise ProviderFailure("invalid_input", "That input is too large. Reconnect to continue.", False)
            try:
                event = json.loads(raw)
                if not isinstance(event, dict):
                    raise ValueError
                # PCM and presentation receipts only touch client-owned or
                # monotonic local state. Waiting for provider transcript storage
                # here turns real-time PCM into an artificial catch-up burst.
                if event.get("type") in {"audio.append", "ping", "playback", "message.shown", "hint.shown"}:
                    await self.client_event(event)
                else:
                    # One reader preserves FIFO with microphone/text controls;
                    # resampler resets cannot overtake preceding PCM frames.
                    async with self.operation_lock:
                        await self.client_event(event)
            except (ValueError, TypeError, KeyError, binascii.Error):
                await self.send({"type": "error", "code": "invalid_input", "message": "That input could not be accepted.", "retryable": False})

    async def client_event(self, event: dict) -> None:
        kind = event.get("type")
        current = time.monotonic()
        if kind == "ping":
            self.last_ping = current
            await self.send({"type": "pong"})
            return
        if kind == "audio.append":
            if not self.microphone:
                return
            audio = event["audio"]
            if not isinstance(audio, str) or len(audio) > 44000:
                raise ValueError
            decoded = base64.b64decode(audio, validate=True)
            if not decoded or len(decoded) > 32768 or len(decoded) % 2:
                raise ValueError
            try:
                self.consume_audio_budget(len(decoded), current)
            except ProviderFailure:
                self.diagnostic("input.audio_rate_exceeded", {
                    "frame_bytes": len(decoded), "remaining_budget_bytes": round(self.audio_budget),
                    "burst_limit_bytes": AUDIO_BURST_BYTES,
                    "refill_bytes_per_second": AUDIO_REFILL_BYTES_PER_SECOND})
                raise
            await self.upstream({"type": "input_audio_buffer.append", "audio": audio})
            return
        if kind == "playback":
            item = self.audio_items.get(event.get("item_id"))
            played = event.get("played_ms")
            if item and isinstance(played, (int, float)) and not isinstance(played, bool) and 0 <= played <= 120000:
                item["played_ms"] = max(item["played_ms"], min(played, item["generated_ms"]))
                self.confirm_playback(event["item_id"])
                self.playback_logged(event["item_id"])
            return
        if kind == "message.shown":
            self.message_shown(event)
            return
        if kind == "hint.shown":
            await self.hint_shown(event)  # Capture receipt now; persistence runs outside the audio lock.
            return
        if current - self.control_window > 10:
            self.control_window, self.control_count = current, 0
        self.control_count += 1
        if self.control_count > 25:
            raise ProviderFailure("control_rate", "Too many requests. Reconnect in a moment.", False)
        await self.fence()
        if kind == "microphone":
            if not isinstance(event.get("enabled"), bool):
                raise ValueError
            enabled = event["enabled"]
            self.silence_since = None
            if enabled != self.microphone:
                await self.interrupt()
                await self.upstream({"type": "input_audio_buffer.clear"})
                self.microphone = enabled
                self.user_speaking = False
                await self.send({"type": "user.activity", "speaking": False})
            await self.send({"type": "state", "state": "listening"})
            if not self.conversation_started:
                self.conversation_started = True
                if not any(message["text"].strip() for message in self.state["document"].get("messages", [])):
                    await self.request_response(opening=True)
        elif kind == "interrupt":
            self.silence_since = None
            await self.interrupt()
        elif kind == "text.submit":
            await self.submit_text(event)
        elif kind == "hint":
            self.request_help(event)
        else:
            raise ValueError

    async def submit_text(self, event: dict) -> None:
        text = event["text"]
        client_id = str(UUID(event["client_turn_id"]))
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 4000:
            raise ValueError
        text = text.strip()
        existing = next((m for m in self.state["document"].get("messages", []) if m.get("client_turn_id") == client_id), None)
        if existing:
            if existing["text"] != text:
                await self.send({"type": "error", "code": "idempotency_conflict", "message": "This message ID was already used for different text.", "retryable": False})
            else:
                await self.send({"type": "snapshot", "workspace": self.workspace()})
            return
        self.conversation_started = True
        self.user_speaking = False
        self.note_user_text(text)
        await self.interrupt()
        await self.upstream({"type": "input_audio_buffer.clear"})
        item_id = "item_" + uuid4().hex[:24]
        message = new_message("user", text, "text", client_turn_id=client_id, provider_item_id=item_id,
                              finalized_at=state_ops.iso_now())
        def save(document, _):
            if any(m.get("client_turn_id") == client_id for m in document["messages"]):
                raise HTTPException(409, "This message was already sent.")
            if sum(m["role"] == "user" for m in document["messages"]) >= self.settings.speaking_max_turns:
                raise HTTPException(409, "Mission turn limit reached. End the mission to review it.")
            message["ordinal"] = len(document["messages"])
            document["messages"].append(message)
            if (document.get("help") or {}).get("source") == "automatic":
                document["help"] = None
            document["analysis_status"] = "pending"
        await self.commit(save)
        await self.upstream({"type": "conversation.item.create", "item": {
            "id": item_id, "type": "message", "role": "user", "content": [{"type": "input_text", "text": text}],
        }})
        await self.request_response()
        self.schedule_analysis(message)


async def accept_connection(websocket: WebSocket, session_id: str, runtime_id: str) -> None:
    origin = websocket.headers.get("origin")
    if origin not in get_settings().authorized_parties:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), 5)
        if len(raw) > 3000:
            raise ValueError
        event = json.loads(raw)
        if not isinstance(event, dict) or event.get("type") != "authenticate" or not isinstance(event.get("ticket"), str):
            raise ValueError
        owner = await asyncio.to_thread(state_ops.consume_ticket, session_id, runtime_id, event["ticket"])
    except (HTTPException, ValueError, TypeError, asyncio.TimeoutError, WebSocketDisconnect):
        with contextlib.suppress(Exception):
            await websocket.close(code=1008)
        return
    if get_settings().speaking_realtime_provider == "gemini":
        from app.services.speaking_gemini_runtime import GeminiSpeakingConnection
        await GeminiSpeakingConnection(websocket, owner, session_id, runtime_id).run()
    else:
        await SpeakingConnection(websocket, owner, session_id, runtime_id).run()
