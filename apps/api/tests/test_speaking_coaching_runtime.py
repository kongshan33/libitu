"""Race-order regressions: coaching/model/database work cannot stall native audio."""
import asyncio
import base64
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import threading
from uuid import uuid4

import pytest

from app.services import speaking_runtime as runtime, speaking_runtime_state as state_ops
from app.services import speaking_diagnostics, speaking_help
from app.services.speaking_coaching_runtime import policy_invalid_reason
from test_speaking_gemini_runtime import connection, response, activity  # noqa: F401


async def seed(client):
    users = [runtime.new_message("user", text, "text", ordinal=index, finalized_at=state_ops.iso_now())
             for index, text in enumerate(["We need to agree on a deadline.", "Testing takes another week.",
                                           "We want to discuss the extra time."])]
    await client.commit(lambda d, _: d.update(messages=users))
    return users


def policy_for(client, message, *, tag=None):
    return {"id": tag or str(uuid4()), "source_message_id": message["id"], "source_revision": message["revision"],
            "source_turn": 3, "eligible_until_turn": 5, "learning_version": 3,
            "target_item_id": str(client.session.items[0].id), "action": "implicit_elicitation",
            "status": "pending", "response_id": None, "instruction": "Ask one relevant brief question.",
            "intent": "Discuss the next meeting", "opportunity": "Ask when to meet", "skip_when": "Closing",
            "created_at": state_ops.iso_now(), "expires_at": state_ops.future(45)}


def result_for(message, policy):
    return {"evidence": [], "learning": [], "policy": policy, "analysis_status": "ready", "hint": None,
            "controller": {"processed": {message["id"]: message["revision"]}},
            "analysis_trace": {"source_message_id": message["id"], "source_revision": message["revision"],
                               "raw_content": '{"evidence":[]}', "needs_help": False}}


async def settle(client):
    if client.exposure_tasks:
        await asyncio.gather(*list(client.exposure_tasks))
    await asyncio.gather(*list(client.coaching_tasks), *list(client.assessment_tasks), return_exceptions=True)
    if client.diagnostic_writer:
        await client.diagnostic_writer


@pytest.mark.parametrize("analysis_first", [True, False])
def test_both_completion_orders_inject_once_without_waiting_for_analysis(connection, monkeypatch, analysis_first):
    client, browser, _ = connection

    async def flow():
        users = await seed(client)
        started, release = asyncio.Event(), asyncio.Event()
        async def analyze(*args):
            started.set()
            await release.wait()
            return result_for(users[-1], policy_for(client, users[-1]))
        monkeypatch.setattr(runtime, "analyze_utterance", analyze)
        client.microphone = True
        task = asyncio.create_task(client.analyze(users[-1]))
        await started.wait()
        # First audio is delivered while the analyzer is still blocked.
        await asyncio.wait_for(client.gemini_event(response("When should we meet?")), timeout=1)
        assert any(e["type"] == "audio.delta" for e in browser.sent)
        assert not task.done()
        if analysis_first:
            release.set()
            await task
            await settle(client)
            assert not client.provider.sent  # Never inject into the active generation.
            await client.gemini_event({"serverContent": {"turnComplete": True}})
        else:
            await client.gemini_event({"serverContent": {"turnComplete": True}})
            assert not client.provider.sent
            release.set()
            await task
        await settle(client)
        controls = [e for e in client.provider.sent if "clientContent" in e]
        assert len(controls) == 1 and controls[0]["clientContent"]["turnComplete"] is False
        await client.inject_policy()
        assert len(client.provider.sent) == 1
        events = speaking_diagnostics.read_events(client.owner, client.session_id)["events"]
        assert any(e["kind"] == "analysis.completed" and e["payload"]["trace"]["raw_content"] for e in events)
        assert len([e for e in events if e["kind"] == "response.first_audio"]) == 1
        assert "analysis_trace" not in client.workspace()
        assert "raw_content" not in str(client.workspace())
    asyncio.run(flow())


def test_newer_candidate_cannot_relabel_already_sent_attempt(connection, monkeypatch):
    client, _, _ = connection
    async def assess(*args):
        return {"outcome": "unknown", "reason": "fixture"}
    monkeypatch.setattr(speaking_help, "assess_policy_response", assess)

    async def flow():
        users = await seed(client)
        first = policy_for(client, users[-1])
        await client.commit(lambda d, _: d.update(policy=first))
        await client.inject_policy()
        sent = deepcopy(client.injected_attempt)
        second = policy_for(client, users[-1])
        await client.commit(lambda d, _: d.update(policy=second))
        await client.inject_policy()
        assert client.injected_attempt == sent
        await client.gemini_event(response())
        bound = client.responses[client.active_response]["teaching_attempt"]
        assert bound["policy"]["id"] == first["id"]
        assert client.state["document"]["policy"]["id"] == second["id"]
        assert client.state["document"]["controller"]["automatic_attempts"][first["target_item_id"]] == 1
        await client.gemini_event({"serverContent": {"turnComplete": True}})
        await settle(client)
        events = speaking_diagnostics.read_events(client.owner, client.session_id)["events"]
        assert any(e["kind"] == "policy.assessed" for e in events)  # Last reply needs no next user turn.
    asyncio.run(flow())


@pytest.mark.parametrize("reason", ["time_limit", "turn_limit", "source_revised", "user_speaking"])
def test_ineligible_or_unsafe_policy_is_not_sent(connection, reason):
    client, _, _ = connection
    async def flow():
        users = await seed(client)
        policy = policy_for(client, users[-1])
        if reason == "time_limit":
            policy["expires_at"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        if reason == "turn_limit":
            policy["eligible_until_turn"] = 2
        if reason == "source_revised":
            policy["source_revision"] = 0
        await client.commit(lambda d, _: d.update(policy=policy))
        if reason == "user_speaking":
            await client.gemini_event(activity("ACTIVITY_START"))
        await client.inject_policy()
        assert not client.provider.sent
        await settle(client)
        if reason != "user_speaking":
            assert client.state["document"]["policy"]["expiry_reason"] == reason
    asyncio.run(flow())


def test_cross_turn_candidate_survives_one_new_utterance(connection):
    client, _, _ = connection
    async def flow():
        users = await seed(client)
        policy = policy_for(client, users[-1])
        await client.commit(lambda d, _: d.update(policy=policy))
        await client.commit(lambda d, _: d["messages"].append(runtime.new_message("user", "We can meet Friday.", "text", ordinal=3)))
        assert policy_invalid_reason(client.state["document"], policy) is None
        await client.inject_policy()
        assert client.injected_attempt["policy"]["id"] == policy["id"]
        await settle(client)
    asyncio.run(flow())


def test_dispatch_cooldown_ignores_acknowledgments(connection):
    client, _, _ = connection
    async def flow():
        users = await seed(client)
        candidate = policy_for(client, users[-1])
        candidate["eligible_until_turn"] = 20
        document = deepcopy(client.state["document"])
        document["controller"] = {"last_automatic_turn": 1}
        for text in ("Yes", "Okay", "Thanks"):
            document["messages"].append(runtime.new_message("user", text, "text", ordinal=len(document["messages"])))
        assert policy_invalid_reason(document, candidate) == "cooldown"
        document["messages"].append(runtime.new_message("user", "We should meet next Friday.", "text", ordinal=6))
        assert policy_invalid_reason(document, candidate) is None
    asyncio.run(flow())


def test_hint_generation_does_not_stop_audio_and_only_display_ack_counts(connection, monkeypatch):
    client, browser, _ = connection
    async def flow():
        await seed(client)
        started, release = asyncio.Event(), asyncio.Event()
        async def help_content(*args, **kwargs):
            started.set()
            await release.wait()
            return {"status": "ready", "direction": "Greet your colleague", "meaning": "A friendly greeting",
                    "pattern": "It is good to see ...", "example": "It is good to see you again.",
                    "substitution": "Name the person.", "analysis_trace": {"raw_content": "fixture"}}
        monkeypatch.setattr(speaking_help, "generate_help", help_content)
        rid = str(uuid4())
        await client.client_event({"type": "hint", "request_id": rid, "level": "example"})
        await started.wait()
        assert not client.state["document"].get("controller", {}).get("exposures")
        assert not client.state["document"].get("hint_exposure")
        client.microphone = True
        await asyncio.wait_for(client.gemini_event(response()), timeout=1)
        assert any(e["type"] == "audio.delta" for e in browser.sent)
        await client.hint_shown({"hint_id": rid, "version": 1, "level": "usage"})
        await client.hint_shown({"hint_id": rid, "version": 1, "level": "usage"})
        await asyncio.gather(*list(client.exposure_tasks))
        assert len(client.state["document"]["controller"]["exposures"]) == 1
        release.set()
        await settle(client)
        assert client.workspace()["help"]["example"] == "It is good to see you again."
        await client.hint_shown({"hint_id": rid, "version": 2, "level": "example"})
        await settle(client)
        assert len(client.state["document"]["controller"]["exposures"]) == 2
        events = speaking_diagnostics.read_events(client.owner, client.session_id)["events"]
        assert len([e for e in events if e["kind"] == "hint.shown"]) == 2
        assert client.state["document"]["controller"]["automatic_attempts"] == {}
    asyncio.run(flow())


def test_slow_diagnostic_database_does_not_delay_audio(connection, monkeypatch):
    client, browser, _ = connection
    entered, release = threading.Event(), threading.Event()
    def slow_write(*args):
        entered.set()
        release.wait(timeout=3)
        return True
    monkeypatch.setattr(speaking_diagnostics, "append_event", slow_write)
    async def flow():
        client.microphone = True
        client.diagnostic("test.event", {})
        try:
            await asyncio.to_thread(entered.wait, 1)
            await asyncio.wait_for(client.gemini_event(response()), timeout=1)
            assert any(e["type"] == "audio.delta" for e in browser.sent)
            assert not client.diagnostic_writer.done()
        finally:
            release.set()
            await settle(client)
    asyncio.run(flow())


def test_help_from_replaced_connection_cannot_publish(connection, monkeypatch):
    from app.schemas.speaking_runtime import RealtimeStart
    client, _, _ = connection
    async def flow():
        started, release = asyncio.Event(), asyncio.Event()
        async def delayed(*args, **kwargs):
            started.set()
            await release.wait()
            return {"status": "ready", "example": "late help"}
        monkeypatch.setattr(speaking_help, "generate_help", delayed)
        client.request_help({"request_id": str(uuid4()), "level": "example"})
        await started.wait()
        state_ops.create_ticket(client.owner, client.session_id, RealtimeStart(client_connection_id=uuid4(), takeover=True))
        release.set()
        await settle(client)
        saved = state_ops.read_state(client.owner, client.session_id)
        assert (saved["document"].get("help") or {}).get("example") != "late help"
    asyncio.run(flow())


def test_dispatch_database_fence_does_not_hold_audio_lock(connection, monkeypatch):
    client, browser, _ = connection
    async def flow():
        users = await seed(client)
        await client.commit(lambda d, _: d.update(policy=policy_for(client, users[-1])))
        entered, release = asyncio.Event(), asyncio.Event()
        async def slow_fence():
            entered.set()
            await release.wait()
        monkeypatch.setattr(client, "fence", slow_fence)
        client.schedule_coaching()
        await entered.wait()
        client.microphone = True
        # Mirrors the provider loop: slow background fencing must not own this lock.
        async def audio():
            async with client.operation_lock:
                await client.upstream({"type": "input_audio_buffer.append",
                                      "audio": base64.b64encode(b"\x00" * 4800).decode()})
        await asyncio.wait_for(audio(), 1)
        assert client.provider.sent[-1].get("realtimeInput")
        release.set()
        await settle(client)
    asyncio.run(flow())


def test_uncertain_control_send_is_not_retried_or_relabelled(connection, monkeypatch):
    client, _, _ = connection
    async def flow():
        users = await seed(client)
        await client.commit(lambda d, _: d.update(policy=policy_for(client, users[-1])))
        sent = []
        async def uncertain(payload):
            sent.append(payload)
            raise TimeoutError
        monkeypatch.setattr(client, "raw_send", uncertain)
        with pytest.raises(TimeoutError):
            await client.inject_policy()
        attempt = deepcopy(client.injected_attempt)
        await client.inject_policy()
        assert len(sent) == 1 and attempt["send_status"] == "uncertain"
        await client.ensure_response()
        assert client.responses[client.active_response]["teaching_attempt"]["id"] == attempt["id"]
        await settle(client)
    asyncio.run(flow())


def test_display_ack_receipt_is_captured_before_slow_background_commit(connection, monkeypatch):
    client, _, _ = connection
    async def flow():
        await seed(client)
        rid = str(uuid4())
        card = client.help_base(rid, str(client.session.items[0].id), "usage", "requested")
        client.help_cards[(rid, 1)] = card
        entered, release = asyncio.Event(), asyncio.Event()
        original = client.commit
        async def slow_commit(*args, **kwargs):
            entered.set()
            await release.wait()
            await original(*args, **kwargs)
        monkeypatch.setattr(client, "commit", slow_commit)
        await asyncio.wait_for(client.client_event({"type": "hint.shown", "hint_id": rid, "version": 1, "level": "usage"}), 1)
        await entered.wait()
        assert client.pending_exposures
        received = next(iter(client.pending_exposures.values()))["visible_at"]
        client.microphone = True
        await asyncio.wait_for(client.client_event({"type": "audio.append", "audio": "AAA="}), 1)
        release.set()
        await settle(client)
        assert client.state["document"]["controller"]["exposures"][0]["visible_at"] == received
    asyncio.run(flow())


def test_persisted_hint_can_ack_after_reconnect_and_only_full_audio_exposes_target(connection):
    client, _, _ = connection
    async def flow():
        await seed(client)
        rid = str(uuid4())
        card = client.help_base(rid, str(client.session.items[0].id), "example", "requested")
        card.update(status="ready", example="It is good to see you.")
        await client.commit(lambda d, _: d.update(help=card))
        assert not client.help_cards  # Restored snapshot, no in-memory request.
        await client.hint_shown({"hint_id": rid, "version": 1, "level": "example"})
        await settle(client)
        assert client.state["document"]["controller"]["exposures"][0]["scope"] == "session"
        client.microphone = True
        await client.gemini_event(response("It is good to see you."))
        await client.gemini_event({"serverContent": {"turnComplete": True}})
        item_id = client.last_audio_item
        client.audio_items[item_id]["played_ms"] = 50
        client.playback_logged(item_id)
        await settle(client)
        before = len(client.state["document"]["controller"]["exposures"])
        await client.client_event({"type": "playback", "item_id": item_id, "played_ms": 100})
        await settle(client)
        assert len(client.state["document"]["controller"]["exposures"]) == before + 1
        assert client.state["document"]["controller"]["exposures"][-1]["kind"] == "assistant_audio"
    asyncio.run(flow())


def test_final_failed_diagnostic_writes_gap_and_close_summary(connection, monkeypatch):
    from fastapi import HTTPException
    client, _, _ = connection
    written, failed = [], []
    def write(owner, session_id, event):
        if event["kind"] == "test.invalid":
            failed.append(event)
            raise HTTPException(422, "invalid")
        written.append(event)
        return True
    monkeypatch.setattr(speaking_diagnostics, "append_event", write)
    async def flow():
        client.diagnostic("test.invalid", {})
        await client.diagnostic_writer
        await client.close_coaching()
        from app.services.speaking_coaching_runtime import drain_diagnostics
        await drain_diagnostics()
        assert len(failed) == 1  # Permanent validation failures are never retried.
        assert any(e["kind"] == "diagnostics.gap" for e in written)
        assert any(e["kind"] == "diagnostics.closed" for e in written)
        closed = next(e for e in written if e["kind"] == "diagnostics.closed")
        assert closed["payload"]["status"] == "incomplete"
        assert closed["payload"]["missing_events"] == 1
    asyncio.run(flow())


def test_diagnostic_arriving_during_gap_flush_is_drained(connection, monkeypatch):
    client, _, _ = connection
    async def flow():
        entered, release = asyncio.Event(), asyncio.Event()
        written = []
        async def append(event):
            if event["kind"] == "diagnostics.gap":
                entered.set()
                await release.wait()
            written.append(event["kind"])
        monkeypatch.setattr(client, "_append_diagnostic", append)
        client.diagnostic_gaps = client.total_diagnostic_gaps = 1
        client.diagnostic("test.before", {})
        await entered.wait()
        client.diagnostic("test.during", {})
        release.set()
        await client.diagnostic_writer
        assert written == ["test.before", "diagnostics.gap", "test.during"]
        assert client.diagnostic_queue.empty()
    asyncio.run(flow())
