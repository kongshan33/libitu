"""Background coaching and diagnostic delivery; never await a model on the audio path."""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import logging
import re
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from fastapi import HTTPException

from app.services import speaking_runtime_state as state_ops
from app.services.speaking_teaching import (
    _exact_spans, _structure_supported, effective_user_turn, hint_target, record_hint_exposure,
)

_logger = logging.getLogger(__name__)
_LEVELS = {"direction": 0, "usage": 1, "example": 2}
# Retain shutdown tasks while bounded background assessments/diagnostics drain.
_drains: set[asyncio.Task] = set()
_diagnostic_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="speaking-diagnostics")


async def drain_diagnostics() -> None:
    if _drains:
        _, pending = await asyncio.wait(list(_drains), timeout=5)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)


def user_turns(document: dict) -> list[dict]:
    return [m for m in document.get("messages", []) if m.get("role") == "user"
            and m.get("status") == "final" and m.get("text", "").strip()]


def policy_invalid_reason(document: dict, policy: dict) -> str | None:
    users = user_turns(document)
    source = next((m for m in users if m["id"] == policy.get("source_message_id")), None)
    if not source or source["revision"] != policy.get("source_revision"):
        return "source_revised"
    if policy.get("expires_at") and not state_ops.is_future(policy["expires_at"]):
        return "time_limit"
    if len(users) > policy.get("eligible_until_turn", len(users)):
        return "turn_limit"
    if any(e.get("session_item_id") == policy.get("target_item_id")
           and e.get("appropriateness") == "appropriate" for e in document.get("evidence", [])):
        return "target_demonstrated"
    controller = document.get("controller", {})
    if policy.get("action") == "implicit_elicitation" and controller.get("automatic_attempts", {}).get(policy.get("target_item_id"), 0) >= 2:
        return "attempt_limit"
    last_automatic = controller.get("last_automatic_turn", -100)
    if (policy.get("action") == "implicit_elicitation" and last_automatic >= 0
            and sum(effective_user_turn(row) for row in users[last_automatic:]) <= 2):
        return "cooldown"
    return None


class CoachingRuntime:
    """Mixin used by both realtime transports. Model and journal I/O run in tasks."""

    def init_coaching(self) -> None:
        self.coaching_tasks: set[asyncio.Task] = set()
        self.assessment_tasks: set[asyncio.Task] = set()
        self.exposure_tasks: set[asyncio.Task] = set()
        self.diagnostic_queue: asyncio.Queue = asyncio.Queue(maxsize=256)
        self.diagnostic_writer: asyncio.Task | None = None
        self.diagnostic_gaps = 0
        self.total_diagnostic_gaps = 0
        self.analysis_keys: set[tuple[str, int]] = set()
        self.analysis_queue: dict[tuple[str, int], tuple[dict, list[dict]]] = {}
        self.analysis_worker: asyncio.Task | None = None
        self.coaching_dispatch: asyncio.Task | None = None
        self.injected_attempt: dict | None = None
        self.help_request_id: str | None = None
        self.help_requests: set[str] = set()
        self.help_cards: dict[tuple[str, int], dict] = {}
        self.help_acks: set[tuple[str, int, str]] = set()
        self.message_acks: set[tuple[str, int]] = set()
        self.user_activity_at: str | None = None
        self.coaching_closed = False
        self.pending_exposures: dict[str, dict] = {}
        self.expiring_policies: set[str] = set()

    async def _append_diagnostic(self, event: dict) -> None:
        from app.services.speaking_diagnostics import append_event
        await asyncio.get_running_loop().run_in_executor(
            _diagnostic_pool, append_event, self.owner, self.session_id, event)

    def diagnostic(self, kind: str, payload: dict, *, event_id: str | None = None) -> None:
        """Bounded enqueue only. Never hold audio delivery on database availability."""
        event = {"id": event_id or str(uuid4()), "kind": kind, "created_at": state_ops.iso_now(),
                 "payload": {"runtime_id": self.runtime_id, **deepcopy(payload)}}
        try:
            self.diagnostic_queue.put_nowait(event)
        except asyncio.QueueFull:
            self.diagnostic_gaps += 1
            self.total_diagnostic_gaps += 1
            _logger.warning("speaking_diagnostic_queue_full session_id=%s", self.session_id)
            return
        if self.diagnostic_writer is None or self.diagnostic_writer.done():
            self.diagnostic_writer = asyncio.create_task(self._write_diagnostics())

    async def _write_diagnostics(self) -> None:
        while True:
            if self.diagnostic_queue.empty():
                if self.diagnostic_gaps:
                    try:
                        gap = self.diagnostic_gaps
                        await self._append_diagnostic({"id": str(uuid4()), "kind": "diagnostics.gap",
                            "created_at": state_ops.iso_now(),
                            "payload": {"runtime_id": self.runtime_id, "missing_events": gap}})
                        self.diagnostic_gaps = max(0, self.diagnostic_gaps - gap)
                    except Exception:
                        _logger.warning("speaking_diagnostics_incomplete session_id=%s missing=%s", self.session_id, self.diagnostic_gaps)
                # Enqueue can happen while the gap write is awaiting storage.
                if self.diagnostic_queue.empty():
                    return
            event = self.diagnostic_queue.get_nowait()
            try:
                for attempt in range(3):
                    try:
                        await self._append_diagnostic(event)
                        break
                    except HTTPException as error:
                        if error.status_code == 404:
                            break  # Deleted sessions must never be recreated by a late writer.
                        if error.status_code < 500 or attempt == 2:
                            raise
                        await asyncio.sleep(0.1 * (attempt + 1))
            except Exception:
                self.diagnostic_gaps += 1
                self.total_diagnostic_gaps += 1
                _logger.warning("speaking_diagnostic_write_failed session_id=%s", self.session_id)
            finally:
                self.diagnostic_queue.task_done()

    def background(self, coroutine, *, assessment: bool = False, exposure: bool = False) -> asyncio.Task:
        task = asyncio.create_task(coroutine)
        group = self.exposure_tasks if exposure else self.assessment_tasks if assessment else self.coaching_tasks
        group.add(task)
        task.add_done_callback(group.discard)
        return task

    async def close_coaching(self) -> None:
        self.coaching_closed = True
        for task in list(self.coaching_tasks):
            task.cancel()
        await asyncio.gather(*self.coaching_tasks, return_exceptions=True)
        # The audio loop has ended. Give already-visible hints a bounded chance
        # to persist attribution before disconnect fences this runtime.
        if self.exposure_tasks:
            _, pending = await asyncio.wait(list(self.exposure_tasks), timeout=2)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        if self.injected_attempt:
            self.diagnostic("policy.unbound", {"attempt": self.injected_attempt, "reason": "connection_closed"})
        async def drain():
            try:
                async with asyncio.timeout(20):
                    if self.assessment_tasks:
                        await asyncio.gather(*self.assessment_tasks, return_exceptions=True)
                    if self.diagnostic_writer:
                        await self.diagnostic_writer
                    self.diagnostic("diagnostics.closed", {"missing_events": self.total_diagnostic_gaps,
                        "unreported_missing_events": self.diagnostic_gaps,
                        "status": "incomplete" if self.total_diagnostic_gaps else "drained"})
                    await self.diagnostic_writer
            except (TimeoutError, asyncio.CancelledError):
                _logger.warning("speaking_diagnostics_drain_incomplete session_id=%s", self.session_id)
        task = asyncio.create_task(drain())
        _drains.add(task)
        task.add_done_callback(_drains.discard)

    def schedule_coaching(self) -> None:
        if self.coaching_closed or (self.coaching_dispatch and not self.coaching_dispatch.done()):
            return
        async def dispatch():
            try:
                # Database fencing must not acquire the audio/event-processing lock.
                await self.fence()
                async with self.operation_lock:
                    await self.dispatch_coaching()
            except asyncio.CancelledError:
                raise
            except Exception:
                self.diagnostic("policy.dispatch_failed", {"reason": "connection_or_provider_unavailable"})
        self.coaching_dispatch = self.background(dispatch())

    async def dispatch_coaching(self) -> None:
        """OpenAI binds policies on explicit response.create; Gemini overrides this."""

    async def eligible_policy(self) -> dict | None:
        policy = self.state["document"].get("policy")
        if not policy or policy.get("status") != "pending" or policy.get("action") not in {
            "implicit_elicitation", "explicit_hint",
        }:
            return None
        reason = policy_invalid_reason(self.state["document"], policy)
        if reason:
            if policy["id"] in self.expiring_policies:
                return None
            self.expiring_policies.add(policy["id"])
            def expire(document, _):
                current = document.get("policy")
                if current and current["id"] == policy["id"] and current["status"] == "pending":
                    current.update(status="expired", expiry_reason=reason)
            self.diagnostic("policy.expired", {"policy_id": policy["id"], "reason": reason})
            async def persist_expiry():
                try:
                    await self.commit(expire, False)
                except Exception:
                    self.diagnostic("policy.expiry_uncommitted", {"policy_id": policy["id"]})
            self.background(persist_expiry())
            return None
        return deepcopy(policy)

    def new_attempt(self, policy: dict) -> dict:
        return {"id": str(uuid4()), "policy": deepcopy(policy), "runtime_id": self.runtime_id,
                "sent_at": state_ops.iso_now(), "response_id": None}

    def bind_attempt(self, document: dict, response: dict, attempt: dict | None) -> None:
        if not attempt:
            return
        bound = {**deepcopy(attempt), "response_id": response["id"], "bound_at": state_ops.iso_now()}
        bound["validity_at_bind"] = policy_invalid_reason(document, bound["policy"]) or "eligible"
        response["teaching_attempt"] = bound
        records = document.setdefault("teaching_attempts", [])
        if any(row["id"] == bound["id"] for row in records):
            return
        records.append(bound)
        del records[:-40]
        policy = bound["policy"]
        current = document.get("policy")
        if current and current["id"] == policy["id"]:
            current.update(status="applied", response_id=response["id"])
        if policy["action"] == "implicit_elicitation":
            controller = document.setdefault("controller", {})
            attempts = controller.setdefault("automatic_attempts", {})
            target = policy.get("target_item_id")
            attempts[target] = attempts.get(target, 0) + 1
            controller["last_automatic_turn"] = len(user_turns(document))

    def response_bound(self, response: dict) -> None:
        if response.get("teaching_attempt"):
            self.diagnostic("policy.bound", {"attempt": response["teaching_attempt"]})

    def response_saved(self, response: dict, status: str) -> None:
        self.diagnostic("response.completed", {"response_id": response["id"], "status": status,
                                               "text": response.get("text", "")[:8000]})
        if response.get("teaching_attempt") and not response.get("assessment_started"):
            response["assessment_started"] = True
            self.background(self.assess_response(deepcopy(response), status), assessment=True)

    def audio_forwarded(self, response: dict) -> None:
        if response.get("first_audio_logged"):
            return
        response["first_audio_logged"] = True
        self.diagnostic("response.first_audio", {"response_id": response["id"],
            "input_generation": response.get("input_generation"),
            "measurement": "server_forwarded_first_audio_not_browser_playback"})

    async def assess_response(self, response: dict, status: str) -> None:
        from app.services.speaking_help import assess_policy_response
        attempt = response["teaching_attempt"]
        assessed = False
        try:
            if status != "final" or not response.get("text", "").strip():
                result = {"outcome": "unknown", "reason": "interrupted_or_empty", "quote": None}
            else:
                result = await assess_policy_response(attempt["policy"], response["text"])
            self.diagnostic("policy.assessed", {"attempt_id": attempt["id"], "response_id": response["id"],
                                                 "assessment": result, "delivery": "see_presentation_events"})
            assessed = True
            if result.get("outcome") != "reflected" or self.coaching_closed or self.stop.is_set():
                return
            await self.fence()
            # Never display an old automatic card over a newer user request/turn.
            latest = self.state["document"].get("messages", [])
            output = next((m for m in latest if m.get("response_id") == response["id"]), None)
            if not output or any(m["role"] == "user" and m["ordinal"] > output["ordinal"] for m in latest):
                return
            existing = self.state["document"].get("help")
            latest_user = next(iter(reversed(user_turns(self.state["document"]))), {})
            if (existing and existing.get("source") == "requested"
                    and existing.get("source_message_id") == latest_user.get("id")):
                return
            policy = attempt["policy"]
            card = self.help_base(str(uuid4()), policy.get("target_item_id"), "direction", "automatic")
            card.update(status="ready", direction=policy.get("intent") or "Try expressing your next idea in your own words.")
            card["response_id"] = response["id"]
            self.help_cards[(card["id"], card["version"])] = deepcopy(card)
            def show(document, _):
                current = document.get("help")
                latest_current = next(iter(reversed(user_turns(document))), {})
                if (current and current.get("source") == "requested"
                        and current.get("source_message_id") == latest_current.get("id")):
                    return
                if any(m["role"] == "user" and m["ordinal"] > output["ordinal"]
                       for m in document.get("messages", [])):
                    return
                document["help"] = card
            await self.commit(show)
            self.diagnostic("hint.generated", {"card": card, "attempt_id": attempt["id"]})
        except asyncio.CancelledError:
            self.diagnostic("hint.discarded" if assessed else "policy.assessed", {
                "attempt_id": attempt["id"], "response_id": response["id"], "reason": "cancelled",
                **({} if assessed else {"assessment": {"outcome": "unknown", "reason": "cancelled"}})})
            raise
        except Exception:
            self.diagnostic("hint.discarded" if assessed else "policy.assessment_failed",
                            {"attempt_id": attempt["id"], "reason": "unavailable_or_connection_fenced"})

    def help_base(self, request_id: str, target: str | None, level: str, source: str) -> dict:
        item = next((i for i in self.session.items if str(i.id) == target), None)
        latest = next(iter(reversed(user_turns(self.state["document"]))), None)
        return {"id": request_id, "version": 1, "target_item_id": target, "level": level, "status": "loading",
                "direction": "Express your next idea in your own words.", "expression": item.text if item else None,
                "meaning": item.meaning if item else None, "pattern": None, "example": None, "substitution": None,
                "source": source, "source_message_id": latest["id"] if latest else None, "error": None}

    def request_help(self, event: dict) -> None:
        level = event.get("level", "usage")
        if level not in {"usage", "example"}:
            raise ValueError
        request_id = str(UUID(event["request_id"])) if event.get("request_id") else str(uuid4())
        if request_id in self.help_requests:
            return
        if len(self.help_requests) >= 100:
            raise ValueError
        policy = self.state["document"].get("policy") or {}
        suggested = policy.get("target_item_id") if policy.get("status") in {"pending", "applied"} else None
        target = event.get("target_item_id") or suggested or hint_target(self.session, self.state["document"])
        if target is None and self.session.items:
            target = str(self.session.items[0].id)
        if target not in {str(item.id) for item in self.session.items}:
            raise ValueError
        self.help_requests.add(request_id)
        self.help_request_id = request_id
        self.diagnostic("hint.requested", {"request_id": request_id, "level": level, "target_item_id": target})
        self.background(self.build_help(request_id, target, level))

    async def build_help(self, request_id: str, target: str, level: str) -> None:
        from app.services.speaking_help import generate_help
        try:
            card = self.help_base(request_id, target, level, "requested")
            if request_id != self.help_request_id:
                self.diagnostic("hint.discarded", {"request_id": request_id, "reason": "superseded_before_start"})
                return
            self.help_cards[(request_id, 1)] = deepcopy(card)
            await self.commit(lambda d, _: d.update(help=card, hint=None)
                              if request_id == self.help_request_id else None)
            history = deepcopy(self.state["document"].get("messages", []))
            message = next((m for m in reversed(history) if m["role"] == "user"), {})
            result = await generate_help(self.session, target, message, history, level=level)
            trace = result.pop("analysis_trace", None)
            self.diagnostic("hint.analyzed", {"request_id": request_id, "trace": trace, "result": result})
            if request_id != self.help_request_id or self.coaching_closed:
                self.diagnostic("hint.discarded", {"request_id": request_id, "reason": "superseded"})
                return
            card.update({k: v for k, v in result.items() if k in {
                "direction", "pattern", "example", "substitution", "error", "status", "meaning",
            }})
            card["version"] = 2
            if card["status"] == "loading":
                card["status"] = "ready"
            if card["status"] == "unavailable":
                card["error"] = "Detailed help is unavailable. You can use the expression above or retry."
            self.help_cards[(request_id, 2)] = deepcopy(card)
            await self.commit(lambda d, _: d.update(help=card) if request_id == self.help_request_id else None)
            self.diagnostic("hint.generated", {"card": card})
        except asyncio.CancelledError:
            self.diagnostic("hint.cancelled", {"request_id": request_id})
            raise
        except Exception:
            self.diagnostic("hint.failed", {"request_id": request_id, "reason": "unavailable"})
            if not self.coaching_closed and request_id == self.help_request_id:
                try:
                    card = self.help_base(request_id, target, level, "requested")
                    card.update(version=2, status="unavailable", error="Help is unavailable. Please retry.")
                    self.help_cards[(request_id, 2)] = deepcopy(card)
                    await self.commit(lambda d, _: d.update(help=card) if request_id == self.help_request_id else None)
                except Exception:
                    pass  # A revoked connection cannot publish late help.

    async def hint_shown(self, event: dict) -> None:
        hint_id, version, level = str(UUID(event["hint_id"])), event["version"], event["level"]
        if type(version) is not int or level not in _LEVELS:
            raise ValueError
        key = (hint_id, version, level)
        if key in self.help_acks:
            return
        card = self.help_cards.get((hint_id, version))
        if card is None:
            saved = self.state["document"].get("help")
            if saved and saved["id"] == hint_id and saved["version"] == version:
                card = saved
        if not card or _LEVELS[level] > _LEVELS[card["level"]]:
            return
        if level == "example" and not card.get("example"):
            return
        visible_at = state_ops.iso_now()
        overlap = self.user_speaking or bool(getattr(self, "gemini_user_text", ""))
        actual_level = level
        item = next((item for item in self.session.items if str(item.id) == card["target_item_id"]), None)
        if level == "direction" and item and (_exact_spans(card.get("direction", ""), item.text)
                                             or (item.kind == "structure" and _structure_supported(item.text, card.get("direction", "")))):
            actual_level = "usage"  # A model's direction must not hide a real target exposure.
        exposure = {"id": str(uuid5(NAMESPACE_URL, f"libitu:hint:{self.session_id}:{hint_id}:{version}:{level}")),
                    "kind": "visual_hint", "level": actual_level, "target_item_id": card["target_item_id"],
                    "visible_at": visible_at, "overlap": overlap, "scope": "session"}
        latest = next(iter(reversed(user_turns(self.state["document"]))), None)
        exposure.update(source_message_id=latest["id"] if latest else None,
                        source_revision=latest["revision"] if latest else 0)
        self.help_acks.add(key)
        self.diagnostic("hint.shown", {"hint_id": hint_id, "version": version, "level": level,
                                        "exposure": exposure, "attribution": "overlap" if overlap else "subsequent_turns"},
                        event_id=exposure["id"])
        self.persist_exposure(exposure)

    def persist_exposure(self, exposure: dict) -> None:
        self.pending_exposures[exposure["id"]] = exposure
        async def persist():
            try:
                def save(document, _):
                    document["controller"] = record_hint_exposure(self.session, document, exposure)
                await self.commit(save, False)
                self.pending_exposures.pop(exposure["id"], None)
            except asyncio.CancelledError:
                # Cancelling to_thread cannot retract a CAS already running.
                self.diagnostic("hint.exposure_commit_unknown", {"exposure_id": exposure["id"], "reason": "shutdown_timeout"})
                raise
            except Exception:
                self.diagnostic("hint.exposure_uncommitted", {"exposure_id": exposure["id"], "reason": "connection_fenced_or_storage"})
        self.background(persist(), exposure=True)

    def assistant_exposures(self, message: dict, channel: str) -> None:
        """Only acknowledged full text/audio can reveal an expression to the learner."""
        latest = next(iter(reversed(user_turns(self.state["document"]))), {})
        for item in self.session.items:
            text = message.get("text", "")
            matches = (any(_structure_supported(item.text, sentence.strip()) for sentence in re.split(r"[.!?]", text))
                       if item.kind == "structure" else bool(_exact_spans(text, item.text)))
            if not matches:
                continue
            exposure = {"id": str(uuid5(NAMESPACE_URL,
                f"libitu:assistant-exposure:{self.session_id}:{message['id']}:{message['revision']}:{item.id}:{channel}")),
                "kind": "assistant_" + channel, "level": "usage", "scope": "session",
                "target_item_id": str(item.id), "visible_at": state_ops.iso_now(),
                "overlap": self.user_speaking or bool(getattr(self, "gemini_user_text", "")),
                "source_message_id": latest.get("id"), "source_revision": latest.get("revision", 0)}
            self.persist_exposure(exposure)
            self.diagnostic("response.expression_exposed", {"message_id": message["id"],
                "response_id": message.get("response_id"), "exposure": exposure}, event_id=exposure["id"])

    def message_shown(self, event: dict) -> None:
        key = (str(event["message_id"]), event["revision"])
        if type(key[1]) is not int or key in self.message_acks:
            return
        message = next((m for m in self.state["document"].get("messages", []) if m["id"] == key[0]
                        and m["revision"] == key[1] and m["role"] == "assistant" and m.get("text")), None)
        if not message:
            return
        self.message_acks.add(key)
        self.diagnostic("response.shown", {"message_id": key[0], "revision": key[1],
                                            "response_id": message.get("response_id"), "channel": "text"})
        self.assistant_exposures(message, "text")

    def playback_logged(self, item_id: str) -> None:
        item = self.audio_items.get(item_id)
        if not item:
            return
        # Log coarse progress, completion and interruption, not every audio frame.
        bucket = int(item["played_ms"] / 1000)
        complete = item["played_ms"] >= item["generated_ms"] - 1
        response = self.responses.get(item["response_id"], {})
        final = complete and bool(response.get("persisted"))
        marker = (bucket, final, bool(item.get("truncated")))
        if item.get("diagnostic_marker") == marker:
            return
        item["diagnostic_marker"] = marker
        self.diagnostic("response.playback", {"response_id": item["response_id"], "item_id": item_id,
            "played_ms": item["played_ms"], "generated_ms": item["generated_ms"], "complete": final,
            "interrupted": bool(item.get("truncated")), "text_alignment": "unknown"})
        if final and not item.get("truncated") and not item.get("exposures_recorded"):
            item["exposures_recorded"] = True
            message = next((m for m in self.state["document"].get("messages", [])
                            if m.get("response_id") == item["response_id"] and m.get("status") == "final"), None)
            if message:
                self.assistant_exposures(message, "audio")
