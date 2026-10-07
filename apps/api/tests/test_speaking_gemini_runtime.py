"""Recorded Gemini wire shapes, with no external provider or model requests."""
import asyncio
import base64
from contextlib import asynccontextmanager
from copy import deepcopy
from datetime import datetime, timezone
import json
from uuid import uuid4

import pytest

from app.config import Settings
from app.integrations.speaking_runtime_repository import InlineRuntimeStore
from app.schemas.speaking import SpeakingSession, SpeakingSessionItem
from app.schemas.speaking_runtime import RealtimeStart
from app.services import speaking_gemini_runtime as gemini
from app.services import speaking_runtime as runtime, speaking_runtime_state as state_ops, store


class Browser:
    def __init__(self):
        self.sent = []

    async def send_json(self, event):
        self.sent.append(deepcopy(event))


class Provider:
    def __init__(self):
        self.sent = []

    async def send(self, payload):
        self.sent.append(json.loads(payload))

    async def recv(self):
        return json.dumps({"setupComplete": {}})


@pytest.fixture
def connection(monkeypatch):
    settings = Settings.model_construct(speaking_realtime_provider="gemini", gemini_api_key="fixture-key",
                                        deepseek_api_key=None, clerk_authorized_parties="https://libitu.fixture")
    monkeypatch.setattr(runtime, "get_settings", lambda: settings)
    monkeypatch.setattr(state_ops, "get_settings", lambda: settings)

    @asynccontextmanager
    async def forbidden(*args):
        raise AssertionError("No real provider in a Gemini runtime test")
        yield

    monkeypatch.setattr(gemini, "open_gemini", forbidden)
    adapter = InlineRuntimeStore()
    monkeypatch.setattr(state_ops, "get_runtime_store", lambda: adapter)
    session = SpeakingSession(id=uuid4(), user_id="gemini-fixture-owner", client_id=uuid4(),
                              scenario_type="everyday", goal="Agree when to meet", difficulty="guided",
                              feedback_level="light", logic_template=None, created_at=datetime.now(timezone.utc),
                              items=[SpeakingSessionItem(id=uuid4(), corpus_item_id=None, ordinal=0,
                                                         kind="chunk", text="good to see")])
    sid = str(session.id)
    store.speaking_sessions[sid] = session
    ticket = state_ops.create_ticket(session.user_id, sid, RealtimeStart(client_connection_id=uuid4()))
    state_ops.consume_ticket(sid, str(ticket.runtime_id), ticket.ticket)
    browser = Browser()
    result = gemini.GeminiSpeakingConnection(browser, session.user_id, sid, str(ticket.runtime_id))
    result.session = session
    result.state = state_ops.read_state(session.user_id, sid)
    result.provider = Provider()
    analyzed = []
    result.schedule_analysis = lambda message: analyzed.append(deepcopy(message))
    yield result, browser, analyzed
    store.speaking_sessions.pop(sid, None)


def activity(kind, *, sdk=False):
    return {"voiceActivity": {"voiceActivityType" if sdk else "type": kind, "audioOffset": "1.000s"}}


def transcribed(text, **extra):
    return {"serverContent": {"inputTranscription": {"text": text, **extra}}}


def response(text="Hello there."):
    return {"serverContent": {
        "modelTurn": {"parts": [{"inlineData": {"mimeType": "audio/pcm;rate=24000",
                                                  "data": base64.b64encode(b"\x00" * 4800).decode()}}]},
        "outputTranscription": {"text": text},
    }}


def history(connection, role):
    return [message for message in connection.state["document"]["messages"] if message["role"] == role]


@pytest.mark.parametrize("sdk", [False, True])
def test_actual_vad_end_and_normal_response_finalize_one_user_without_finished(connection, sdk):
    client, browser, analyzed = connection

    async def flow():
        client.microphone = True
        await client.gemini_event(activity("ACTIVITY_START", sdk=sdk))
        await client.gemini_event(transcribed("Hello, good to see you."))
        assert not analyzed and all(message["status"] != "final" for message in history(client, "user"))
        await client.gemini_event(activity("ACTIVITY_END", sdk=sdk))
        assert not analyzed
        await client.gemini_event(response())
        await client.gemini_event({"serverContent": {"generationComplete": True}})
        await client.gemini_event({"serverContent": {"turnComplete": True}})

    asyncio.run(flow())
    users = history(client, "user")
    assert len(users) == 1 and users[0]["status"] == "final"
    assert users[0]["text"] == "Hello, good to see you."
    assert len(analyzed) == 1 and analyzed[0]["id"] == users[0]["id"]
    assert client.state["turn_count"] == 1
    assert history(client, "assistant")[0]["text"] == "Hello there."
    assert any(event["type"] == "audio.delta" for event in browser.sent)
    assert any(event["type"] == "transcript.delta" and event["role"] == "assistant" for event in browser.sent)


def test_text_mode_shows_transcription_while_discarding_native_audio(connection):
    client, browser, analyzed = connection

    async def flow():
        await client.submit_text({"type": "text.submit", "client_turn_id": str(uuid4()), "text": "Hello."})
        await client.gemini_event(response("Good to see you."))
        await client.gemini_event({"serverContent": {"generationComplete": True}})
        await client.gemini_event({"serverContent": {"turnComplete": True}})

    asyncio.run(flow())
    assert len(analyzed) == 1
    assert not any(event["type"] == "audio.delta" for event in browser.sent)
    assert history(client, "assistant")[0]["text"] == "Good to see you."
    assert history(client, "assistant")[0]["input_source"] == "text"
    requests = [event["clientContent"] for event in client.provider.sent if "clientContent" in event]
    assert requests[-1] == {"turns": [{"role": "user", "parts": [{"text": "Hello."}]}], "turnComplete": True}


def test_old_interrupted_ai_completion_does_not_finalize_new_learner_speech(connection):
    client, browser, analyzed = connection

    async def flow():
        client.microphone = True
        await client.gemini_event(response("An unfinished explanation"))
        await client.gemini_event(activity("ACTIVITY_START"))
        await client.gemini_event(transcribed("I need "))
        await client.gemini_event({"serverContent": {"interrupted": True}})
        await client.gemini_event({"serverContent": {"turnComplete": True}})
        assert not analyzed and history(client, "user")[0]["status"] == "unavailable"
        await client.gemini_event(transcribed("more time."))
        await client.gemini_event(activity("ACTIVITY_END"))
        await client.gemini_event(response("How much more time?"))
        await client.gemini_event({"serverContent": {"turnComplete": True}})

    asyncio.run(flow())
    assert [message["status"] for message in history(client, "assistant")] == ["interrupted", "final"]
    assert len(analyzed) == 1 and analyzed[0]["text"] == "I need more time."
    assert any(event["type"] == "audio.clear" for event in browser.sent)


def test_even_after_new_vad_end_old_interrupted_response_cannot_finalize_new_input(connection):
    client, _, analyzed = connection

    async def flow():
        await client.gemini_event(response("Previous response"))
        await client.gemini_event(activity("ACTIVITY_START"))
        await client.gemini_event(transcribed("Wait, I have another idea."))
        await client.gemini_event(activity("ACTIVITY_END"))
        await client.gemini_event({"serverContent": {"interrupted": True}})
        await client.gemini_event({"serverContent": {"turnComplete": True}})
        assert not analyzed
        await client.gemini_event(response("What is your idea?"))
        await client.gemini_event({"serverContent": {"turnComplete": True}})

    asyncio.run(flow())
    assert len(analyzed) == 1 and analyzed[0]["text"] == "Wait, I have another idea."


def test_no_vad_end_no_final_credit_even_when_model_turn_completes(connection):
    client, _, analyzed = connection

    async def flow():
        await client.gemini_event(activity("ACTIVITY_START"))
        await client.gemini_event(transcribed("A fragment without its boundary"))
        await client.gemini_event(response())
        await client.gemini_event({"serverContent": {"turnComplete": True}})

    asyncio.run(flow())
    assert not analyzed and client.state["turn_count"] == 0


def test_explicit_finished_is_supported_independently_of_model_completion(connection):
    client, _, analyzed = connection

    async def flow():
        await client.gemini_event(transcribed("This version has a final marker.", finished=True))

    asyncio.run(flow())
    assert len(analyzed) == 1 and history(client, "user")[0]["status"] == "final"


def test_ambiguous_overlapping_vad_inputs_do_not_become_learning_evidence(connection):
    client, _, analyzed = connection

    async def flow():
        await client.gemini_event(activity("ACTIVITY_START"))
        await client.gemini_event(transcribed("The first unfinished thought"))
        await client.gemini_event(activity("ACTIVITY_END"))
        # There is no provider utterance ID, so a late fragment could belong to either input.
        await client.gemini_event(activity("ACTIVITY_START"))
        await client.gemini_event(transcribed("A second thought"))
        await client.gemini_event(activity("ACTIVITY_END"))
        await client.gemini_event(response())
        await client.gemini_event({"serverContent": {"turnComplete": True}})

    asyncio.run(flow())
    assert not analyzed and client.state["turn_count"] == 0
    assert [message["status"] for message in history(client, "user")] == ["unavailable", "unavailable"]


def test_late_asr_fragment_revises_same_user_and_does_not_add_a_turn(connection):
    client, _, analyzed = connection

    async def flow():
        await client.gemini_event(activity("ACTIVITY_START"))
        await client.gemini_event(transcribed("Good to see"))
        await client.gemini_event(activity("ACTIVITY_END"))
        await client.gemini_event(response())
        await client.gemini_event({"serverContent": {"turnComplete": True}})
        await client.gemini_event(transcribed(" you."))

    asyncio.run(flow())
    users = history(client, "user")
    assert len(users) == 1 and users[0]["text"] == "Good to see you."
    assert users[0]["revision"] == 2 and client.state["turn_count"] == 1
    assert [message["revision"] for message in analyzed] == [1, 2]
    assert analyzed[0]["id"] == analyzed[1]["id"]


def test_late_asr_revision_immediately_withdraws_old_evidence_before_new_analysis(connection):
    client, _, analyzed = connection

    async def flow():
        await client.gemini_event(activity("ACTIVITY_START"))
        await client.gemini_event(transcribed("Good to see"))
        await client.gemini_event(activity("ACTIVITY_END"))
        await client.gemini_event(response())
        await client.gemini_event({"serverContent": {"turnComplete": True}})
        message = history(client, "user")[0]
        item_id = str(client.session.items[0].id)
        def analyzed_old(document, _):
            document["evidence"] = [{"id": str(uuid4()), "session_item_id": item_id,
                                     "message_id": message["id"], "transcript_revision": 1,
                                     "start": 0, "end": 11, "quote": "Good to see", "match_type": "exact",
                                     "appropriateness": "uncertain", "prompted": False, "reason": "Lexical occurrence."}]
            document["learning"] = [{"session_item_id": item_id, "observed_uses": 1,
                                     "independent_uses": 1, "prompted_uses": 0, "last_message_id": message["id"]}]
            document["policy"] = {"id": "old-policy", "source_message_id": message["id"], "source_revision": 1,
                                  "learning_version": 1, "target_item_id": item_id, "action": "implicit_elicitation",
                                  "status": "pending", "response_id": None, "instruction": "Old revision policy."}
        await client.commit(analyzed_old)
        await client.gemini_event(transcribed(" you."))

    asyncio.run(flow())
    assert len(analyzed) == 2
    assert client.state["document"]["evidence"] == []
    assert client.state["document"]["learning"][0]["observed_uses"] == 0
    assert client.state["document"]["policy"]["status"] == "expired"
