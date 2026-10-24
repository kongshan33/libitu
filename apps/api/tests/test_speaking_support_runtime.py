"""Support changes and real presentation receipts preserve truthful attribution."""
import asyncio
from copy import deepcopy
from uuid import uuid4

import pytest

from app.integrations.speaking_realtime import session_configuration
from app.services import speaking_help, speaking_runtime as runtime
from app.services.speaking_support_runtime import change_support, support_workspace
from test_speaking_coaching_runtime import policy_for, seed, settle
from test_speaking_gemini_runtime import connection, response  # noqa: F401


def test_support_changes_are_versioned_and_do_not_erase_exposures(connection):
    client, browser, _ = connection
    client.session.support_level = "model_frame"

    async def flow():
        users = await seed(client)
        policy = policy_for(client, users[-1])
        policy.update(support_level="model_frame", support_version=0)
        card = client.help_base(str(uuid4()), str(client.session.items[0].id), "usage", "requested")
        await client.commit(lambda d, _: d.update(
            policy=policy, help=card, hint="old hint",
            controller={"exposures": [{"id": "already-shown"}]}), False)
        assert client.workspace()["support"] == {"level": "model_frame", "version": 0}
        await client.client_event({"type": "support.set", "level": "no_hint",
                                   "expected_version": 0, "request_id": str(uuid4())})
        document = client.state["document"]
        assert document["support"] == {"level": "no_hint", "version": 1}
        assert document["support_history"][0]["level"] == "no_hint"
        assert document["policy"]["expiry_reason"] == "support_changed"
        assert document["help"] is None and document["hint"] is None
        assert document["controller"]["exposures"] == [{"id": "already-shown"}]
        await client.client_event({"type": "support.set", "level": "label_only",
                                   "expected_version": 0, "request_id": str(uuid4())})
        assert any(row.get("code") == "support_changed" for row in browser.sent)
        assert client.state["document"]["support"]["level"] == "no_hint"
        await client.client_event({"type": "support.set", "level": "no_hint",
                                   "expected_version": 1, "request_id": str(uuid4())})
        assert len(client.state["document"]["support_history"]) == 1
        await settle(client)
    asyncio.run(flow())


@pytest.mark.parametrize("busy", ["response", "control", "playback", "learner"])
def test_support_waits_until_an_already_started_reply_finishes(connection, busy):
    client, browser, _ = connection
    client.session.support_level = "model_frame"

    async def flow():
        if busy == "response":
            client.response_requested = True
        elif busy == "control":
            client.injected_attempt = {"id": "already-sent"}
        elif busy == "playback":
            client.state["document"]["playback_pending"] = ["response"]
            await client.commit(lambda d, _: d.update(playback_pending=["response"]), False)
        else:
            client.user_speaking = True
        await client.client_event({"type": "support.set", "level": "no_hint",
                                   "expected_version": 0, "request_id": str(uuid4())})
        assert any(row.get("code") == "support_busy" for row in browser.sent)
        assert client.workspace()["support"] == {"level": "model_frame", "version": 0}
    asyncio.run(flow())


def test_late_requested_help_cannot_restore_a_card_after_support_changes(connection, monkeypatch):
    client, _, _ = connection
    client.session.support_level = "model_frame"

    async def flow():
        started, release = asyncio.Event(), asyncio.Event()
        async def delayed(*args, **kwargs):
            started.set()
            await release.wait()
            return {"status": "ready", "direction": "A previous hint", "pattern": "old [hint]"}
        monkeypatch.setattr(speaking_help, "generate_help", delayed)
        request_id = str(uuid4())
        client.help_request_id = request_id
        task = asyncio.create_task(client.build_help(request_id, str(client.session.items[0].id), "usage"))
        await started.wait()
        await client.commit(lambda d, _: change_support(client.session, d, "no_hint", 0, "now"))
        release.set()
        await task
        assert client.state["document"]["help"] is None
        await settle(client)
    asyncio.run(flow())


def test_legacy_assessment_cannot_restore_automatic_help_after_support_cas(connection, monkeypatch):
    client, _, _ = connection
    assert client.session.support_level is None

    async def assess(*args):
        return {"outcome": "reflected", "reason": "fixture", "exact_quote": "When should we meet?"}
    monkeypatch.setattr(speaking_help, "assess_policy_response", assess)

    async def flow():
        users = await seed(client)
        message = runtime.new_message("assistant", "When should we meet?", "text",
                                      ordinal=3, response_id="legacy-response")
        attempt = {"id": "legacy-attempt", "response_id": message["response_id"],
                   "policy": policy_for(client, users[-1])}
        await client.commit(lambda d, _: d.update(
            messages=[*users, message], teaching_attempts=[attempt]), False)
        commit = client.commit
        switched = False

        async def race(mutation, *args, **kwargs):
            nonlocal switched
            if mutation.__name__ == "show":
                switched = True
                await commit(lambda d, _: change_support(client.session, d, "no_hint", 0, "now"), False)
            return await commit(mutation, *args, **kwargs)
        monkeypatch.setattr(client, "commit", race)
        await client.assess_response({"id": message["response_id"], "text": message["text"],
                                     "teaching_attempt": attempt}, "final")
        assert switched
        assert client.workspace()["support"] == {"level": "no_hint", "version": 1}
        assert client.state["document"].get("help") is None
        await settle(client)
    asyncio.run(flow())


@pytest.mark.parametrize("complete", [True, False])
def test_model_audio_receipts_distinguish_possible_and_confirmed_example(connection, monkeypatch, complete):
    client, _, _ = connection
    client.session.support_level = "model_frame"

    async def assess(*args):
        return {"outcome": "reflected", "reason": "fixture",
                "exact_quote": "Who would you like to meet?",
                "model_quote": "Good to see you at our planning meeting.",
                "transfer_question_quote": "Who would you like to meet?"}
    monkeypatch.setattr(speaking_help, "assess_policy_response", assess)

    async def flow():
        users = await seed(client)
        policy = policy_for(client, users[-1])
        policy.update(action="model_then_transfer", support_level="model_frame", support_version=0)
        await client.commit(lambda d, _: d.update(policy=policy), False)
        await client.inject_policy()
        client.microphone = True
        await client.gemini_event(response("Good to see you at our planning meeting. Who would you like to meet?"))
        item_id = next(iter(client.audio_items))
        audio = client.audio_items[item_id]
        await client.client_event({"type": "playback", "item_id": item_id, "played_ms": 20})
        await settle(client)
        exposures = client.state["document"]["controller"]["exposures"]
        assert len(exposures) == 1 and exposures[0]["certainty"] == "possible"
        assert not client.state["document"]["teaching_attempts"][0].get("presented")
        if complete:
            await client.gemini_event({"serverContent": {"turnComplete": True}})
            await client.client_event({"type": "playback", "item_id": item_id, "played_ms": audio["generated_ms"]})
        else:
            await client.gemini_event({"serverContent": {"interrupted": True}})
        await settle(client)
        document = client.state["document"]
        confirmed = [row for row in document["controller"]["exposures"] if not row.get("certainty")]
        assert bool(confirmed) is complete
        if complete:
            assert confirmed[0]["level"] == "example"
            attempt = document["teaching_attempts"][0]
            assert attempt["presented"] and attempt["assessment"]["model_quote"]
            assert document.get("help") is None
            assert client.workspace()["demonstrations"][0]["quote"] == "Good to see"
        else:
            assert not document["teaching_attempts"][0].get("presented")
            assert client.workspace()["demonstrations"] == []
    asyncio.run(flow())


def test_demonstration_spans_require_exact_final_presented_evidence(connection):
    client, _, _ = connection
    client.session.support_level = "model_label"
    target = str(client.session.items[0].id)
    text = "🙂 Good to see you here. Who will you meet next?"
    message = runtime.new_message("assistant", text, "text", response_id="response")
    attempt = {"response_id": "response", "presented": True,
               "policy": {"action": "model_then_transfer", "target_item_id": target},
               "assessment": {"outcome": "reflected", "model_quote": "Good to see you here.",
                              "transfer_question_quote": "Who will you meet next?"}}
    document = {"messages": [message], "teaching_attempts": [attempt]}
    span = support_workspace(client.session, document)["demonstrations"][0]
    assert (span["start"], span["end"], span["quote"]) == (3, 14, "Good to see")
    for mutate in (
        lambda d: d["teaching_attempts"][0].update(presented=False),
        lambda d: d["messages"][0].update(status="interrupted"),
        lambda d: d["teaching_attempts"][0]["assessment"].update(model_quote="not in this response"),
        lambda d: d.update(support={"level": "no_hint", "version": 1}),
    ):
        changed = deepcopy(document)
        mutate(changed)
        assert support_workspace(client.session, changed)["demonstrations"] == []


def test_presented_structure_with_natural_prefix_records_example_assistance(connection):
    client, _, _ = connection
    target = client.session.items[0]
    target.kind, target.text = "structure", "the more [action], the more [result]"
    client.session.support_level = "model_frame"

    async def flow():
        message = runtime.new_message("assistant", "I agree, the more you plan, the more you learn.", "text",
                                      response_id="modeled")
        await client.commit(lambda d, _: d.update(messages=[message], teaching_attempts=[{
            "id": "attempt", "response_id": "modeled",
            "policy": {"action": "model_then_transfer", "target_item_id": str(target.id)},
        }]), False)
        client.message_shown({"message_id": message["id"], "revision": 1})
        await settle(client)
        exposures = client.state["document"]["controller"]["exposures"]
        assert len(exposures) == 1 and exposures[0]["level"] == "example"
    asyncio.run(flow())


@pytest.mark.parametrize("text,exposed", [
    ("I am convinced the pilot is useful. Which option would you choose?", True),
    ("I believe the pilot is useful. Which option would you choose?", False),
    ("I am almost convinced the pilot is useful. Which option would you choose?", False),
])
def test_text_only_model_variant_counts_assistance_without_visible_target_labels(connection, text, exposed):
    from app.services.speaking_teaching import _assistance

    client, _, _ = connection
    target = client.session.items[0]
    target.kind, target.text = "chunk", "I'm convinced"
    client.session.support_level = "model_label"

    async def flow():
        message = runtime.new_message("assistant", text, "text", response_id="text-model")
        await client.commit(lambda d, _: d.update(messages=[message], teaching_attempts=[{
            "id": "attempt", "response_id": "text-model",
            "policy": {"action": "model_then_transfer", "target_item_id": str(target.id)},
            "assessment": {"outcome": "unknown"},
        }]), False)
        assert not client.audio_items and not client.target_acks
        client.message_shown({"message_id": message["id"], "revision": 1})
        await settle(client)
        document = client.state["document"]
        controller = document.get("controller", {"exposures": []})
        exposures = controller["exposures"]
        assert len(exposures) == int(exposed)
        if exposed:
            assert exposures[0]["kind"] == "assistant_text"
            assert exposures[0]["level"] == "example"
        learner = runtime.new_message("user", "I am convinced we should launch.", "text", ordinal=1)
        assert _assistance(str(target.id), learner, [learner], controller, {}) == (
            "example" if exposed else "independent")
        # Exposure cannot turn an unverified model effect into a highlighted demonstration.
        assert client.workspace()["demonstrations"] == []
    asyncio.run(flow())


def test_explicit_support_on_legacy_session_records_visible_owned_target(connection):
    client, _, _ = connection
    assert client.session.mission_plan is None
    client.session.support_level = "label_only"

    async def flow():
        target = str(client.session.items[0].id)
        client.target_shown({"target_item_id": target})
        await settle(client)
        exposures = client.state["document"]["controller"]["exposures"]
        assert len(exposures) == 1
        assert exposures[0]["target_item_id"] == target and exposures[0]["level"] == "usage"
        with pytest.raises(ValueError):
            client.target_shown({"target_item_id": str(uuid4())})
    asyncio.run(flow())


def test_provider_setup_does_not_receive_the_target_list(connection):
    client, _, _ = connection
    client.session.support_level = "no_hint"
    settings = session_configuration(client.settings, client.session)
    assert "language_targets" not in settings["session"]["instructions"]
    assert client.session.items[0].text not in settings["session"]["instructions"]
    asyncio.run(client.configure())
    instructions = client.provider.sent[0]["setup"]["systemInstruction"]["parts"]
    assert "model_then_transfer" in str(instructions)
    assert "implicit_elicitation" in str(instructions)
    assert client.session.items[0].text not in str(instructions)
