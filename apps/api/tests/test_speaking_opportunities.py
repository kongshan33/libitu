"""Planned opportunities remain distinct from instructions, delivery and learner use."""
import asyncio
import base64
from copy import deepcopy
import threading
from uuid import uuid4

import pytest

from app.schemas.speaking_plan import SpeakingMissionPlan
from app.schemas.speaking_runtime import RealtimeStart
from app.services import speaking_help, speaking_teaching as teaching
from app.services import speaking_runtime as runtime, speaking_runtime_state as state_ops
from app.services.speaking_coaching_runtime import policy_invalid_reason
from app.services.speaking_opportunities import opportunity_view, planned_targets, set_target_skipped
from test_speaking_coaching_runtime import policy_for, seed, settle
from test_speaking_gemini_runtime import connection, response  # noqa: F401
from test_speaking_teaching import analyze, mission, model, no_paid_analysis, utterance  # noqa: F401


def add_plan(session, roles=None):
    roles = roles or ["primary"] * len(session.items)
    session.mission_plan = SpeakingMissionPlan(
        plan_id=uuid4(), candidate_id=uuid4(), scenario_type=session.scenario_type,
        title="Revised deadline", setting="Discuss the deadline with a colleague.",
        goal="Agree on a revised deadline", user_role="Project lead", ai_role="Colleague",
        register="professional", targets=[
            {"session_item_id": item.id, "corpus_item_id": item.corpus_item_id or uuid4(),
             "role": role, "communicative_function": "Balance the competing needs",
             "fit": "high", "fit_reason": "The deadline requires a trade-off.",
             "trigger_question": "How should we balance the deadline and testing needs?",
             "skip_when": "The learner changes topic or closes the conversation."}
            for item, role in zip(session.items, roles)
        ])
    return session


def turns():
    return [utterance(text, ordinal=index) for index, text in enumerate([
        "We need to agree on a deadline.", "Testing requires another week.", "We can change the deadline."])]


def test_plan_without_model_recommendation_schedules_relevant_primary_only_from_third_turn(monkeypatch):
    session = add_plan(mission(("chunk", "to be fair"), ("chunk", "as a result")), ["opportunity", "primary"])
    model(monkeypatch)
    users = turns()
    for index in range(2):
        assert analyze(session, users[index], users[:index + 1])["policy"]["action"] == "continue_naturally"
    result = analyze(session, users[-1], users)
    assert result["policy"]["action"] == "implicit_elicitation"
    assert result["policy"]["target_item_id"] == str(session.items[1].id)
    assert result["analysis_trace"]["recommendation_source"] == "planned_context_fallback"
    assert "as a result" not in result["policy"]["instruction"]
    assert "How should we balance" in result["policy"]["instruction"]


@pytest.mark.parametrize("text", ["Goodbye, that is all.", "Let's change the topic to dinner.", "I like strawberry ice cream."])
def test_plan_fallback_requires_current_context_and_never_forces_closing_or_changed_topic(monkeypatch, text):
    session = add_plan(mission(("chunk", "to be fair")))
    model(monkeypatch)
    users = [*turns()[:2], utterance(text, ordinal=2)]
    result = analyze(session, users[-1], users)
    assert result["policy"]["action"] != "implicit_elicitation"


def test_model_context_veto_and_fallback_attempt_limit_are_preserved(monkeypatch):
    session = add_plan(mission(("chunk", "to be fair")))
    target = str(session.items[0].id)
    users = turns()
    model(monkeypatch, recommendation={
        "target_item_id": target, "intent": "Balance needs", "opportunity": "Which need comes first?",
        "context_sufficient": False, "closing": False})
    assert analyze(session, users[-1], users)["policy"]["action"] != "implicit_elicitation"
    model(monkeypatch)
    result = analyze(session, users[-1], users, {"controller": {"automatic_attempts": {target: 1}}})
    assert result["policy"]["action"] != "implicit_elicitation"


def test_skip_and_restore_preserve_audit_and_fence_pre_skip_analysis(monkeypatch):
    session = add_plan(mission(("chunk", "to be fair")))
    model(monkeypatch)
    users = turns()
    previous = {"messages": users}
    result = analyze(session, users[-1], users, previous)
    target = str(session.items[0].id)
    current = deepcopy(previous)
    set_target_skipped(current, target, "Not suitable here", "2026-10-20T01:00:00+00:00")
    set_target_skipped(current, target, "Not suitable here", "2026-10-20T01:01:00+00:00")
    assert current["target_states"][target]["version"] == 1
    assert policy_invalid_reason(current, result["policy"]) == "target_skipped"
    current.update(teaching.reconcile_analysis_result(session, current, result, previous))
    assert current["policy"]["status"] == "expired"
    set_target_skipped(current, target, None, "2026-10-20T01:02:00+00:00")
    assert policy_invalid_reason(current, result["policy"]) == "target_state_changed"
    assert [row["action"] for row in current["target_states"][target]["history"]] == ["skip", "restore"]
    assert opportunity_view(session, current)[0]["status"] == "planned"


def test_skip_survives_new_analysis_and_explicit_help_selection(monkeypatch):
    session = add_plan(mission(("chunk", "to be fair"), ("chunk", "as a result")))
    target = str(session.items[0].id)
    previous = {}
    set_target_skipped(previous, target, "Not suitable here", "2026-10-20T01:00:00+00:00")
    model(monkeypatch)
    users = turns()
    result = analyze(session, users[-1], users, previous)
    assert result["policy"]["target_item_id"] == str(session.items[1].id)
    assert teaching.hint_target(session, previous) == str(session.items[1].id)


@pytest.mark.parametrize("status", ["pending", "applied"])
@pytest.mark.parametrize("budget_exhausted", [False, True])
def test_default_requested_help_ignores_skipped_policy_and_automatic_budget(
        connection, monkeypatch, status, budget_exhausted):
    client, _, _ = connection
    client.session.items.append(client.session.items[0].model_copy(update={"id": uuid4(), "ordinal": 1, "text": "as a result"}))
    add_plan(client.session)
    skipped, available = (str(item.id) for item in client.session.items)
    selected = []
    async def build(request_id, target, level):
        selected.append((target, level))
    monkeypatch.setattr(client, "build_help", build)
    async def flow():
        document = client.state["document"]
        set_target_skipped(document, skipped, "Not applicable", state_ops.iso_now())
        # An applied policy keeps its audit target; an old pending policy can
        # also be present in a snapshot until the next reconciliation.
        document["policy"] = {"status": status, "target_item_id": skipped}
        if budget_exhausted:
            document["controller"] = {"automatic_attempts": {skipped: teaching.MAX_PROMPTS_PER_ITEM,
                                                            available: teaching.MAX_PROMPTS_PER_ITEM}}
            assert teaching.hint_target(client.session, document) is None
        client.request_help({"request_id": str(uuid4()), "level": "usage"})
        await settle(client)
        assert selected == [(available, "usage")]
    asyncio.run(flow())


def test_requested_help_rejects_explicitly_skipped_but_allows_available_after_automatic_budget(connection, monkeypatch):
    client, _, _ = connection
    client.session.items.append(client.session.items[0].model_copy(update={"id": uuid4(), "ordinal": 1, "text": "as a result"}))
    add_plan(client.session)
    skipped, available = (str(item.id) for item in client.session.items)
    selected = []
    async def build(request_id, target, level):
        selected.append((target, level))
    monkeypatch.setattr(client, "build_help", build)
    async def flow():
        document = client.state["document"]
        set_target_skipped(document, skipped, "Not applicable", state_ops.iso_now())
        document["controller"] = {"automatic_attempts": {available: teaching.MAX_PROMPTS_PER_ITEM}}
        with pytest.raises(ValueError):
            client.request_help({"request_id": str(uuid4()), "target_item_id": skipped, "level": "example"})
        assert not client.help_requests
        client.request_help({"request_id": str(uuid4()), "target_item_id": available, "level": "example"})
        await settle(client)
        assert selected == [(available, "example")]
        set_target_skipped(document, available, "Also not applicable", state_ops.iso_now())
        with pytest.raises(ValueError):
            client.request_help({"request_id": str(uuid4()), "level": "usage"})
        assert len(client.help_requests) == 1
    asyncio.run(flow())


def test_opportunity_requires_reflection_and_presentation_on_same_attempt_and_survives_source_deletion():
    session = add_plan(mission(("chunk", "to be fair")))
    target = str(session.items[0].id)
    session.items[0].corpus_item_id = None
    assert target in planned_targets(session)
    document = {"teaching_attempts": [
        {"id": "a", "policy": {"target_item_id": target}, "send_status": "sent",
         "response_id": "r1", "assessment": {"outcome": "reflected"}, "presented": False},
        {"id": "b", "policy": {"target_item_id": target}, "send_status": "sent",
         "response_id": "r2", "assessment": {"outcome": "not_reflected"}, "presented": True},
    ]}
    row = opportunity_view(session, document)[0]
    assert row["status"] == "planned" and row["reflected"] and row["presented"]
    document["teaching_attempts"][0]["presented"] = True
    assert opportunity_view(session, document)[0]["status"] == "offered"
    document["evidence"] = [{"session_item_id": target, "appropriateness": "uncertain"}]
    assert opportunity_view(session, document)[0]["status"] == "offered"
    document["evidence"][0]["appropriateness"] = "appropriate"
    assert opportunity_view(session, document)[0]["status"] == "used"
    set_target_skipped(document, target, "Skip", "2026-10-20T01:00:00+00:00")
    assert opportunity_view(session, document)[0]["status"] == "skipped"
    assert opportunity_view(session, document)[0]["sent"] is True


def test_confirmed_scene_reaches_voice_partner_without_target_wording():
    from app.integrations.speaking_realtime import role_instructions
    session = add_plan(mission(("chunk", "to be fair")))
    instructions = role_instructions(session, include_language_targets=False)
    assert '"learner_role": "Project lead"' in instructions
    assert '"your_role": "Colleague"' in instructions
    assert '"setting": "Discuss the deadline with a colleague."' in instructions
    assert "to be fair" not in instructions
    assert "trigger_question" not in instructions


def test_replaced_runtime_cannot_skip_another_connections_target(connection):
    client, _, _ = connection
    add_plan(client.session)
    async def flow():
        state_ops.create_ticket(client.owner, client.session_id,
                                RealtimeStart(client_connection_id=uuid4(), takeover=True))
        with pytest.raises(runtime.RuntimeStopped):
            await client.client_event({"type": "target.skip", "target_item_id": str(client.session.items[0].id),
                                       "reason": "Not suitable here"})
        assert not state_ops.read_state(client.owner, client.session_id)["document"].get("target_states")
    asyncio.run(flow())


def test_runtime_skip_after_send_retains_immutable_attempt_and_blocks_late_help(connection, monkeypatch):
    client, _, _ = connection
    add_plan(client.session)
    async def assess(*args):
        return {"outcome": "reflected", "reason": "Contextual invitation", "exact_quote": "Which deadline works?"}
    monkeypatch.setattr(speaking_help, "assess_policy_response", assess)
    async def flow():
        users = await seed(client)
        policy = policy_for(client, users[-1])
        target = policy["target_item_id"]
        await client.commit(lambda document, _: document.update(policy=policy))
        await client.inject_policy()
        await settle(client)
        assert client.workspace()["opportunities"][0]["sent"] is True
        await client.client_event({"type": "target.skip", "target_item_id": target, "reason": "Not suitable here"})
        await client.gemini_event(response("Which deadline works?"))
        await client.gemini_event({"serverContent": {"turnComplete": True}})
        await settle(client)
        row = client.workspace()["opportunities"][0]
        assert row["status"] == "skipped" and row["sent"] and row["bound"] and row["reflected"]
        assert not row["presented"]
        assert client.workspace()["help"] is None
        assert client.state["document"]["teaching_attempts"][0]["validity_at_bind"] == "target_skipped"
        await client.client_event({"type": "target.restore", "target_item_id": target})
        assert client.workspace()["opportunities"][0]["status"] == "planned"
        await settle(client)
    asyncio.run(flow())


def test_runtime_reflected_opportunity_is_offered_only_after_actual_text_ack(connection, monkeypatch):
    client, _, _ = connection
    add_plan(client.session)
    async def assess(*args):
        return {"outcome": "reflected", "reason": "Contextual invitation", "exact_quote": "Which deadline works?"}
    monkeypatch.setattr(speaking_help, "assess_policy_response", assess)
    async def flow():
        users = await seed(client)
        await client.commit(lambda document, _: document.update(policy=policy_for(client, users[-1])))
        await client.inject_policy()
        await client.gemini_event(response("Which deadline works?"))
        await client.gemini_event({"serverContent": {"turnComplete": True}})
        await settle(client)
        assert client.workspace()["opportunities"][0]["status"] == "planned"
        message = client.state["document"]["messages"][-1]
        await client.client_event({"type": "message.shown", "message_id": message["id"], "revision": message["revision"]})
        await settle(client)
        row = client.workspace()["opportunities"][0]
        assert row["status"] == "offered"
        assert row["sent"] and row["bound"] and row["reflected"] and row["presented"]
    asyncio.run(flow())


def test_visible_target_ack_records_session_usage_once_without_assuming_snapshot_was_seen(connection):
    client, _, _ = connection
    add_plan(client.session)
    async def flow():
        await seed(client)
        target = str(client.session.items[0].id)
        assert not client.state["document"].get("controller", {}).get("exposures")
        client.workspace()
        assert not client.state["document"].get("controller", {}).get("exposures")
        client.user_speaking = True
        await client.client_event({"type": "target.shown", "target_item_id": target})
        await settle(client)
        exposure = client.state["document"]["controller"]["exposures"][0]
        assert exposure["kind"] == "visual_target"
        assert exposure["level"] == "usage" and exposure["scope"] == "session"
        assert exposure["overlap"] is True and exposure["after_turn"] == 3
        assert exposure["visible_at"]
        client.target_acks.clear()  # A resumed runtime can safely acknowledge the same card.
        await client.client_event({"type": "target.shown", "target_item_id": target})
        await settle(client)
        assert len(client.state["document"]["controller"]["exposures"]) == 1
        # A later utterance remains assisted beyond the legacy two-turn window.
        users = [*client.state["document"]["messages"],
                 *[runtime.new_message("user", "A later response", "text", ordinal=index,
                                       started_at=state_ops.future(1), finalized_at=state_ops.future(2))
                   for index in range(3, 7)]]
        assert teaching._assistance(target, users[-1], users, client.state["document"]["controller"], {}) == "usage"
    asyncio.run(flow())


def test_target_ack_persistence_never_holds_audio_input(connection, monkeypatch):
    client, _, _ = connection
    add_plan(client.session)
    async def flow():
        entered, release = asyncio.Event(), asyncio.Event()
        real_commit = client.commit
        async def slow_commit(*args, **kwargs):
            entered.set()
            await release.wait()
            return await real_commit(*args, **kwargs)
        monkeypatch.setattr(client, "commit", slow_commit)
        client.microphone = True
        await client.client_event({"type": "target.shown", "target_item_id": str(client.session.items[0].id)})
        await entered.wait()
        try:
            await asyncio.wait_for(client.client_event({
                "type": "audio.append", "audio": base64.b64encode(b"\x00" * 4800).decode()}), timeout=1)
            assert client.provider.sent  # Input made it upstream while presentation storage waited.
        finally:
            release.set()
            await settle(client)
    asyncio.run(flow())


def test_skipping_during_help_generation_discards_late_card_even_after_restore(connection, monkeypatch):
    client, _, _ = connection
    add_plan(client.session)
    async def flow():
        entered, release = asyncio.Event(), asyncio.Event()
        async def generate(*args, **kwargs):
            entered.set()
            await release.wait()
            return {"status": "ready", "direction": "A late direction", "analysis_trace": {}}
        monkeypatch.setattr(speaking_help, "generate_help", generate)
        target = str(client.session.items[0].id)
        await client.client_event({"type": "hint", "target_item_id": target, "request_id": str(uuid4()), "level": "usage"})
        await entered.wait()
        await client.client_event({"type": "target.skip", "target_item_id": target, "reason": "Not suitable here"})
        await client.client_event({"type": "target.restore", "target_item_id": target})
        release.set()
        await settle(client)
        assert client.workspace()["help"] is None
    asyncio.run(flow())


def test_end_atomically_freezes_received_facts_when_background_cas_is_delayed(connection, monkeypatch):
    from app.integrations.speaking_feedback_repository import InlineFeedbackStore
    from app.services import speaking_lifecycle, store

    client, _, _ = connection
    add_plan(client.session)
    store.speaking_sessions[client.session_id].mission_plan = client.session.mission_plan
    monkeypatch.setitem(runtime._connections, client.runtime_id, client)
    monkeypatch.setattr(runtime, "END_RECEIPT_DRAIN_SECONDS", 0.01)
    feedback = InlineFeedbackStore(state_ops.get_runtime_store())
    monkeypatch.setattr(speaking_lifecycle, "request_feedback", feedback.enqueue)

    async def flow():
        await seed(client)
        target = str(client.session.items[0].id)
        assistant = runtime.new_message("assistant", "Which deadline works?", "text", ordinal=3, response_id="offered")
        attempt = {"id": "attempt", "response_id": "offered", "send_status": "sent",
                   "policy": {"target_item_id": target, "action": "implicit_elicitation"},
                   "assessment": {"outcome": "reflected"}}
        def seed_response(document, _):
            document["messages"].append(assistant)
            document["teaching_attempts"] = [attempt]
        await client.commit(seed_response)
        entered, release = threading.Barrier(3), threading.Event()
        adapter = state_ops.get_runtime_store()
        real_cas = adapter.compare_and_swap
        def delayed_cas(owner, session_id, version, document, status, count):
            if status == "active":
                entered.wait(timeout=3)
                assert release.wait(timeout=3)
            return real_cas(owner, session_id, version, document, status, count)
        monkeypatch.setattr(adapter, "compare_and_swap", delayed_cas)
        await client.client_event({"type": "target.shown", "target_item_id": target})
        await client.client_event({"type": "message.shown", "message_id": assistant["id"], "revision": 1})
        await asyncio.to_thread(entered.wait, 3)
        try:
            ended = await speaking_lifecycle.end_speaking_session(client.owner, client.session_id)
            assert ended.session.status == "completed"
            assert ended.opportunities[0].status == "offered"
            frozen = feedback.read(client.owner, client.session_id)["source"]
            exposure = frozen["controller"]["exposures"][0]
            assert exposure["kind"] == "visual_target" and exposure["after_turn"] == 3
            assert exposure["scope"] == "session" and exposure["visible_at"]
            assert frozen["teaching_attempts"][0]["presented"] is True
            version = state_ops.read_state(client.owner, client.session_id)["version"]
        finally:
            release.set()
            await settle(client)
        # The delayed old-generation writes cannot modify completed/frozen data.
        assert state_ops.read_state(client.owner, client.session_id)["version"] == version
        assert feedback.read(client.owner, client.session_id)["source"] == frozen
    asyncio.run(flow())


def test_end_receipts_are_owner_scoped_and_cannot_cross_runtime_takeover(connection, monkeypatch):
    from fastapi import HTTPException

    client, _, _ = connection
    add_plan(client.session)
    monkeypatch.setitem(runtime._connections, client.runtime_id, client)
    async def flow():
        target = str(client.session.items[0].id)
        client.pending_exposures["received"] = {
            "id": "received", "target_item_id": target, "kind": "visual_target", "level": "usage",
            "scope": "session", "visible_at": state_ops.iso_now(), "source_message_id": None, "source_revision": 0}
        receipts = await runtime.capture_local_receipts(client.owner, client.session_id)
        assert receipts["runtime_id"] == client.runtime_id
        with pytest.raises(HTTPException) as error:
            await runtime.capture_local_receipts("another-owner", client.session_id)
        assert error.value.status_code == 404
        # Capture can happen just before another tab wins the durable generation.
        state_ops.create_ticket(client.owner, client.session_id, RealtimeStart(client_connection_id=uuid4(), takeover=True))
        assert await runtime.capture_local_receipts(client.owner, client.session_id) is None
        ended = state_ops.end_session(client.owner, client.session_id, receipts)
        assert ended.session.status == "completed"
        state = state_ops.read_state(client.owner, client.session_id)
        assert not state["document"].get("controller", {}).get("exposures")
        before = state["version"]
        state_ops.end_session(client.owner, client.session_id, receipts)
        assert not state_ops.read_state(client.owner, client.session_id)["document"].get("controller", {}).get("exposures")
        assert state_ops.read_state(client.owner, client.session_id)["version"] > before
    asyncio.run(flow())


def test_end_keeps_captured_receipt_when_ws_closes_during_authoritative_read(connection, monkeypatch):
    client, _, _ = connection
    add_plan(client.session)
    monkeypatch.setitem(runtime._connections, client.runtime_id, client)
    async def flow():
        client.pending_exposures["received"] = {
            "id": "received", "target_item_id": str(client.session.items[0].id),
            "kind": "visual_target", "level": "usage", "scope": "session",
            "visible_at": state_ops.iso_now(), "source_message_id": None, "source_revision": 0}
        entered, release = threading.Event(), threading.Event()
        real_read = state_ops.read_state
        def delayed_first_read(owner, session_id):
            if not entered.is_set():
                entered.set()
                assert release.wait(timeout=3)
            return real_read(owner, session_id)
        monkeypatch.setattr(state_ops, "read_state", delayed_first_read)
        capture = asyncio.create_task(runtime.capture_local_receipts(client.owner, client.session_id))
        assert await asyncio.to_thread(entered.wait, 3)
        try:
            # Natural shutdown can fence this connection and remove its registry
            # entry while the HTTP request is still waiting for the DB read.
            await asyncio.to_thread(state_ops.disconnect_runtime, client.owner, client.session_id, client.runtime_id)
            runtime._connections.pop(client.runtime_id)
        finally:
            release.set()
        receipts = await capture
        assert receipts["runtime_id"] == client.runtime_id
        state_ops.end_session(client.owner, client.session_id, receipts)
        saved = state_ops.read_state(client.owner, client.session_id)
        assert saved["document"]["controller"]["exposures"][0]["id"] == "received"
    asyncio.run(flow())
