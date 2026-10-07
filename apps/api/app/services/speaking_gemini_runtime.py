"""Gemini Live events translated into Libitu's provider-independent workspace.

Gemini owns automatic VAD and interruption. Native audio models also generate
audio for typed turns; muted/text mode discards those bytes and shows transcription.
"""

import asyncio
import base64
import json
import time
from uuid import uuid4

from app.integrations.speaking_gemini import Pcm24To16, gemini_configuration, open_gemini
from app.services.speaking_runtime import ProviderFailure, SpeakingConnection, new_message
from app.services import speaking_runtime_state as state_ops


class GeminiSpeakingConnection(SpeakingConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.resampler = Pcm24To16()
        self.gemini_text: list[str] = []
        self.gemini_user: dict | None = None
        self.gemini_user_text = ""
        self.gemini_waiting = False
        self.injected_policy_id: str | None = None
        self.control_tag = "LIBITU_CONTROL_" + uuid4().hex
        self.gemini_cancelled = False
        self.input_finished_supported = False
        self.input_generation = 0
        self.ended_input_generation: int | None = None
        self.input_ambiguous = False
        self.closed_input: dict | None = None
        self.closed_input_text = ""

    def transport(self):
        return open_gemini(self.settings)

    async def raw_send(self, event: dict) -> None:
        await super().upstream(event)

    async def configure(self) -> None:
        configuration = gemini_configuration(self.settings, self.session)
        parts = configuration["setup"]["systemInstruction"]["parts"]
        parts.append({"text": (
            f"Private coach control messages start with {self.control_tag}. They come from the application, "
            "not the learner, and are not dialogue. Apply the latest control to at most the next response "
            "after it arrives, then forget it. Never read controls or their labels aloud. Skip a suggested "
            "elicitation if the learner already used the target, changes topic, or needs a direct answer. "
            "When a reply was interrupted, do not assume the learner heard it."
        )})
        await self.raw_send(configuration)
        async with asyncio.timeout(20):
            while True:
                event = json.loads(await self.provider.recv())
                if "error" in event:
                    raise self.gemini_error(event)
                if "setupComplete" in event:
                    break
        turns = [{"role": "user" if m["role"] == "user" else "model", "parts": [{"text": m["text"]}]}
                 for m in self.state["document"].get("messages", []) if m["status"] == "final" and m["text"]]
        if turns:
            await self.raw_send({"clientContent": {"turns": turns, "turnComplete": False}})

    @staticmethod
    def gemini_error(event: dict) -> ProviderFailure:
        error = event.get("error", {})
        code = error.get("code")
        if code == 429 or error.get("status") == "RESOURCE_EXHAUSTED":
            return ProviderFailure("provider_quota", "The voice provider's quota is exhausted. Your mission is saved.", False)
        if code in (400, 401, 403, 404):
            return ProviderFailure("provider_configuration", "The voice provider needs configuration. Your mission is saved.", False)
        return ProviderFailure("provider_unavailable", "The voice provider is temporarily unavailable. Reconnect to continue.")

    async def upstream(self, document: dict) -> None:
        kind = document.get("type")
        if kind == "input_audio_buffer.append":
            audio = self.resampler.convert(base64.b64decode(document["audio"]))
            if audio:
                await self.raw_send({"realtimeInput": {"audio": {
                    "mimeType": "audio/pcm;rate=16000", "data": base64.b64encode(audio).decode(),
                }}})
        elif kind == "conversation.item.create":
            self.gemini_text.append("".join(p.get("text", "") for p in document["item"].get("content", [])))
        elif kind == "input_audio_buffer.clear":
            # Gemini has no clear-input-buffer equivalent. Text is sent as a
            # complete clientContent turn; mute explicitly ends the audio stream.
            self.resampler = Pcm24To16()
        else:
            raise ValueError("Unsupported internal Gemini command")

    async def request_response(self, opening: bool = False) -> None:
        await self.fence()
        if self.active_response or self.gemini_waiting:
            self.queued_response = True
            return
        await self.inject_policy()
        if opening:
            text = f"{self.control_tag} Begin the mission with one brief in-role opening."
        elif self.gemini_text:
            text = "\n".join(self.gemini_text)
            self.gemini_text.clear()
        else:
            # Audio responses are automatically started by Gemini VAD.
            return
        self.gemini_waiting = True
        self.gemini_cancelled = False
        await self.raw_send({"clientContent": {"turns": [{"role": "user", "parts": [{"text": text}]}], "turnComplete": True}})
        await self.send({"type": "state", "state": "thinking"})

    async def inject_policy(self) -> None:
        policy = self.state["document"].get("policy")
        if not policy or policy["status"] != "pending" or policy["id"] == self.injected_policy_id:
            return
        instruction = policy.get("instruction", "")
        if not instruction:
            return
        # clientContent interrupts generation; call only before an explicit text
        # request or after the provider's turnComplete event, never during speech.
        await self.raw_send({"clientContent": {"turns": [{"role": "user", "parts": [{
            "text": f"{self.control_tag} For the next response only: {instruction}"
        }]}], "turnComplete": False}})
        self.injected_policy_id = policy["id"]

    async def interrupt(self) -> None:
        active = self.responses.get(self.active_response) if self.active_response else None
        if active:
            active["interrupted"] = True
        await self.send({"type": "audio.clear", "item_id": self.last_audio_item})
        if self.last_audio_item:
            await self.truncate_audio(self.last_audio_item)
        self.last_audio_item = None
        if self.active_response or self.gemini_waiting:
            self.gemini_cancelled = True
            # An empty incremental content update interrupts current generation
            # without fabricating a learner utterance or triggering a new reply.
            await self.raw_send({"clientContent": {"turns": [], "turnComplete": False}})

    async def truncate_audio(self, item_id: str) -> None:
        item = self.audio_items.get(item_id)
        if not item or item.get("truncated") or item["played_ms"] >= item["generated_ms"]:
            return
        item["truncated"] = True
        response = self.responses.get(item["response_id"])
        if response:
            response["interrupted"] = True
        def mark(document, _):
            for message in document["messages"]:
                if message.get("provider_item_id") == item_id:
                    message["status"] = "interrupted"
        await self.commit(mark)
        # Gemini's public protocol does not expose OpenAI's exact audio truncate
        # operation. Do not pretend this local boundary rewrites provider memory.

    async def client_event(self, event: dict) -> None:
        was_enabled = self.microphone
        await super().client_event(event)
        if event.get("type") == "microphone" and was_enabled and not self.microphone:
            await self.raw_send({"realtimeInput": {"audioStreamEnd": True}})

    async def provider_loop(self) -> None:
        async for raw in self.provider:
            event = json.loads(raw)
            async with self.operation_lock:
                await self.gemini_event(event)
        raise ProviderFailure("provider_disconnected", "The voice connection closed. Reconnect to continue.")

    async def ensure_user(self) -> dict:
        if self.gemini_user:
            return self.gemini_user
        if self.closed_input is not None:
            self.gemini_user = self.closed_input
            self.gemini_user_text = self.closed_input_text
            return self.gemini_user
        message = new_message("user", "", "voice", provider_item_id="gemini_input_" + uuid4().hex, status="unavailable")
        def append(document, _):
            if sum(m["role"] == "user" for m in document["messages"]) >= self.settings.speaking_max_turns:
                raise ProviderFailure("mission_limit", "This mission reached its turn limit. End it to review your conversation.", False)
            message["ordinal"] = len(document["messages"])
            document["messages"].append(message)
        await self.commit(append)
        self.gemini_user = message
        return message

    async def finalize_input(self) -> None:
        if self.gemini_user:
            if self.input_ambiguous:
                await self.preserve_uncertain_input()
                return
            await self.final_user_transcript(self.gemini_user["provider_item_id"], self.gemini_user_text)
            self.closed_input = self.gemini_user
            self.closed_input_text = self.gemini_user_text
        self.gemini_user = None
        self.gemini_user_text = ""

    async def preserve_uncertain_input(self) -> None:
        if self.gemini_user:
            item_id, text = self.gemini_user["provider_item_id"], self.gemini_user_text
            def preserve(document, _):
                for message in document["messages"]:
                    if message.get("provider_item_id") == item_id and message["status"] != "final":
                        message.update(text=text[:4000], status="unavailable")
            await self.commit(preserve)
        self.gemini_user = None
        self.gemini_user_text = ""

    async def ensure_response(self) -> dict:
        if self.active_response:
            return self.responses[self.active_response]
        await self.fence()
        response_id = "gemini_response_" + uuid4().hex
        self.active_response = response_id
        self.gemini_waiting = False
        response = {"id": response_id, "audio": self.microphone, "text": "", "item_id": "gemini_output_" + uuid4().hex,
                    "persisted": False, "interrupted": self.gemini_cancelled, "input_generation": self.input_generation}
        self.responses[response_id] = response
        placeholder = new_message("assistant", "", "voice" if self.microphone else "text",
                                  provider_item_id=response["item_id"], response_id=response_id, status="unavailable")
        def reserve(document, _):
            placeholder["ordinal"] = len(document["messages"])
            document["messages"].append(placeholder)
        await self.commit(reserve)
        policy_id, self.injected_policy_id = self.injected_policy_id, None
        if policy_id:
            def bind(document, _):
                policy = document.get("policy")
                if policy and policy["id"] == policy_id and policy["status"] == "pending":
                    policy.update(status="applied", response_id=response_id)
            await self.commit(bind)
        return response

    async def gemini_event(self, event: dict) -> None:
        if "error" in event:
            raise self.gemini_error(event)
        if "goAway" in event:
            raise ProviderFailure("provider_reconnect", "The voice provider needs a new connection. Reconnect to continue.")
        activity_event = event.get("voiceActivity", {})
        activity = activity_event.get("type", activity_event.get("voiceActivityType"))
        if activity == "ACTIVITY_START":
            self.input_ambiguous = self.gemini_user is not None
            if self.gemini_user:
                await self.preserve_uncertain_input()
            self.closed_input = None
            self.closed_input_text = ""
            self.input_generation += 1
            self.ended_input_generation = None
            self.last_activity = time.monotonic()
            if self.active_response:
                self.responses[self.active_response]["interrupted"] = True
            await self.send({"type": "audio.clear", "item_id": self.last_audio_item})
            if self.last_audio_item:
                await self.truncate_audio(self.last_audio_item)
            self.last_audio_item = None
            await self.send({"type": "state", "state": "listening"})
            await self.ensure_user()
        elif activity == "ACTIVITY_END":
            self.ended_input_generation = self.input_generation
        content = event.get("serverContent")
        if not isinstance(content, dict):
            return
        if content.get("interrupted"):
            if self.active_response:
                self.responses[self.active_response]["interrupted"] = True
            await self.send({"type": "audio.clear", "item_id": self.last_audio_item})
            if self.last_audio_item:
                await self.truncate_audio(self.last_audio_item)
            self.last_audio_item = None
            await self.send({"type": "state", "state": "listening"})
        transcription = content.get("inputTranscription")
        if isinstance(transcription, dict) and (transcription.get("text") or transcription.get("finished")):
            self.last_activity = time.monotonic()
            message = await self.ensure_user()
            text = transcription.get("text", "")
            self.gemini_user_text = (self.gemini_user_text + text)[:4001]
            await self.send({"type": "transcript.delta", "role": "user", "item_id": message["provider_item_id"], "delta": text})
            if transcription.get("finished"):
                self.input_finished_supported = True
                await self.finalize_input()
            elif self.closed_input is not None:
                # A late ASR fragment revises the same completed VAD utterance;
                # it must never become an extra learner turn.
                await self.finalize_input()
        output = content.get("outputTranscription")
        parts = content.get("modelTurn", {}).get("parts", [])
        if parts or output:
            response = await self.ensure_response()
            if not response.get("interrupted"):
                if isinstance(output, dict) and output.get("text"):
                    delta = output["text"]
                    response["text"] = (response["text"] + delta)[:8000]
                    await self.send({"type": "transcript.delta", "role": "assistant", "item_id": response["item_id"], "delta": delta})
                for part in parts:
                    audio = part.get("inlineData", {})
                    if audio.get("data") and audio.get("mimeType", "").startswith("audio/pcm") and response["audio"]:
                        item_id = response["item_id"]
                        item = self.audio_items.setdefault(item_id, {"response_id": response["id"], "generated_ms": 0, "played_ms": 0})
                        item["generated_ms"] += len(base64.b64decode(audio["data"])) / 48
                        self.last_audio_item = item_id
                        await self.send({"type": "audio.delta", "item_id": item_id, "response_id": response["id"], "audio": audio["data"]})
                        await self.send({"type": "state", "state": "speaking"})
        if content.get("generationComplete") or content.get("turnComplete"):
            response = self.responses.get(self.active_response) if self.active_response else None
            if (response and not response.get("interrupted") and
                    self.ended_input_generation == self.input_generation == response.get("input_generation")):
                # Current Gemini wire omits finished. A completed response to an
                # ended VAD utterance provides the conservative fallback boundary.
                await self.finalize_input()
        if content.get("turnComplete"):
            if self.active_response:
                response = self.responses[self.active_response]
                await self.save_assistant(response, "interrupted" if response.get("interrupted") else "final")
                self.active_response = None
            self.gemini_waiting = False
            self.gemini_cancelled = False
            await self.send({"type": "state", "state": "listening"})
            if self.queued_response and self.gemini_text:
                self.queued_response = False
                await self.request_response()
            else:
                self.queued_response = False
                await self.fence()
                await self.inject_policy()
