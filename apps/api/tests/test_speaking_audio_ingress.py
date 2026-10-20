"""Real client-reader ordering with blocked provider state and playback storage."""
import asyncio
import base64
from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi import WebSocketDisconnect

from app.services import speaking_runtime as runtime
from app.services.speaking_coaching_runtime import drain_diagnostics
from test_speaking_gemini_runtime import connection  # noqa: F401
from test_speaking_runtime import FakeSocket


PCM = base64.b64encode(b"\x01\x00" * 2400).decode()


async def eventually(predicate):
    async with asyncio.timeout(1):
        while not predicate():
            await asyncio.sleep(0)


async def stop_reader(client, reader):
    client.ws.input.put_nowait(None)
    with pytest.raises(WebSocketDisconnect):
        await reader
    if client.exposure_tasks:
        await asyncio.gather(*list(client.exposure_tasks))
    if client.diagnostic_writer:
        await client.diagnostic_writer


async def seed_audio(client):
    response_id, item_id = "completed-response", "completed-audio"
    message = runtime.new_message("assistant", "What matters most to you?", "voice",
                                  response_id=response_id, provider_item_id=item_id)
    await client.commit(lambda d, _: d.update(messages=[message], playback_pending=[response_id]))
    client.responses[response_id] = {"id": response_id, "persisted": True, "text": message["text"]}
    client.audio_items[item_id] = {"response_id": response_id, "played_ms": 0, "generated_ms": 100}
    return message, response_id, item_id


def test_mixed_presentation_receipts_and_pcm_bypass_slow_state_lock_and_storage(connection, monkeypatch):
    client, _, _ = connection

    async def flow():
        client.ws = FakeSocket()
        client.microphone = True
        message, response_id, item_id = await seed_audio(client)
        hint_id = str(uuid4())
        card = client.help_base(hint_id, str(client.session.items[0].id), "direction", "requested")
        card["status"] = "ready"
        client.help_cards[(hint_id, 1)] = card
        release = asyncio.Event()
        commits = []
        original = client.commit

        async def slow_commit(operation, publish=True):
            commits.append(operation)
            await release.wait()
            await original(operation, publish)

        monkeypatch.setattr(client, "commit", slow_commit)
        await client.operation_lock.acquire()
        reader = asyncio.create_task(client.client_loop())
        try:
            for event in [
                {"type": "playback", "item_id": item_id, "played_ms": 100},
                {"type": "message.shown", "message_id": message["id"], "revision": 1},
                {"type": "audio.append", "audio": PCM},
                {"type": "hint.shown", "hint_id": hint_id, "version": 1, "level": "direction"},
                {"type": "playback", "item_id": item_id, "played_ms": 100},
                {"type": "audio.append", "audio": PCM},
                {"type": "ping"},
            ]:
                client.ws.input.put_nowait(event)
            await eventually(lambda: any(e["type"] == "pong" for e in client.ws.sent))
            assert not [e for e in client.ws.sent if e["type"] == "error"], client.ws.sent
            await eventually(lambda: len(commits) >= 2)
            assert len(client.provider.sent) == 2
            assert all(event["realtimeInput"]["audio"]["mimeType"] == "audio/pcm;rate=16000"
                       for event in client.provider.sent)
            assert len(commits) == 2  # One deduplicated playback write, one hint exposure.
            assert client.state["document"]["playback_pending"] == [response_id]
            assert client.audio_items[item_id]["played_ms"] == 100
            assert client.operation_lock.locked() and client.exposure_tasks
        finally:
            client.operation_lock.release()
            release.set()
            await stop_reader(client, reader)
        assert client.state["document"]["playback_pending"] == []
        assert not client.playback_confirmations

    asyncio.run(flow())


def test_muted_pcm_is_ignored_even_while_provider_state_is_locked(connection):
    client, _, _ = connection

    async def flow():
        client.ws = FakeSocket()
        await client.operation_lock.acquire()
        reader = asyncio.create_task(client.client_loop())
        try:
            client.ws.input.put_nowait({"type": "audio.append", "audio": PCM})
            client.ws.input.put_nowait({"type": "ping"})
            await eventually(lambda: any(e["type"] == "pong" for e in client.ws.sent))
            assert not client.provider.sent
        finally:
            client.operation_lock.release()
            await stop_reader(client, reader)

    asyncio.run(flow())


def test_microphone_control_stays_locked_and_later_audio_cannot_overtake_it(connection):
    client, _, _ = connection

    async def flow():
        client.ws = FakeSocket()
        client.microphone = client.conversation_started = True
        await client.operation_lock.acquire()
        reader = asyncio.create_task(client.client_loop())
        client.ws.input.put_nowait({"type": "microphone", "enabled": False})
        client.ws.input.put_nowait({"type": "audio.append", "audio": PCM})
        client.ws.input.put_nowait({"type": "ping"})
        await eventually(lambda: client.ws.input.qsize() == 2)
        assert client.microphone and not client.provider.sent
        assert not any(e["type"] == "pong" for e in client.ws.sent)
        client.operation_lock.release()
        await eventually(lambda: any(e["type"] == "pong" for e in client.ws.sent))
        assert not client.microphone
        assert client.provider.sent == [{"realtimeInput": {"audioStreamEnd": True}}]
        await stop_reader(client, reader)

    asyncio.run(flow())


def test_unlocked_pcm_keeps_validation_rate_limit_and_serialized_provider_send(connection):
    client, _, _ = connection

    async def flow():
        client.ws = FakeSocket()
        client.microphone = True
        client.audio_budget = 4800
        client.audio_refilled_at = client.started
        consume = client.consume_audio_budget
        client.consume_audio_budget = lambda size, _current: consume(size, client.started)
        diagnostics = []
        client.diagnostic = lambda kind, payload, **_: diagnostics.append((kind, deepcopy(payload)))
        await client.provider_lock.acquire()
        reader = asyncio.create_task(client.client_loop())
        client.ws.input.put_nowait({"type": "audio.append", "audio": "not valid base64"})
        client.ws.input.put_nowait({"type": "audio.append", "audio": PCM})
        await eventually(lambda: bool(client.ws.sent))
        await eventually(lambda: client.ws.input.empty())
        assert client.ws.sent[0]["code"] == "invalid_input"
        assert not client.provider.sent
        client.provider_lock.release()
        await eventually(lambda: len(client.provider.sent) == 1)
        client.ws.input.put_nowait({"type": "audio.append", "audio": PCM})
        with pytest.raises(runtime.ProviderFailure) as error:
            await reader
        assert error.value.code == "audio_rate"
        assert len(client.provider.sent) == 1
        assert diagnostics == [("input.audio_rate_exceeded", {
            "frame_bytes": 4800, "remaining_budget_bytes": round(client.audio_budget),
            "burst_limit_bytes": runtime.AUDIO_BURST_BYTES,
            "refill_bytes_per_second": runtime.AUDIO_REFILL_BYTES_PER_SECOND})]

    asyncio.run(flow())


def test_playback_failure_keeps_pending_state_and_duplicate_ack_can_retry(connection, monkeypatch):
    client, _, _ = connection

    async def flow():
        _, response_id, item_id = await seed_audio(client)
        diagnostics = []
        client.diagnostic = lambda kind, payload, **_: diagnostics.append((kind, payload))
        original = client.commit

        async def failed(*args, **kwargs):
            raise RuntimeError("storage unavailable")

        monkeypatch.setattr(client, "commit", failed)
        await client.client_event({"type": "playback", "item_id": item_id, "played_ms": 100})
        await asyncio.gather(*list(client.exposure_tasks))
        assert client.state["document"]["playback_pending"] == [response_id]
        assert not client.playback_confirmations
        assert ("response.playback_uncommitted", {
            "response_id": response_id, "reason": "connection_fenced_or_storage"}) in diagnostics
        monkeypatch.setattr(client, "commit", original)
        await client.client_event({"type": "playback", "item_id": item_id, "played_ms": 100})
        await asyncio.gather(*list(client.exposure_tasks))
        assert client.state["document"]["playback_pending"] == []

    asyncio.run(flow())


def test_playback_write_participates_in_existing_shutdown_drain(connection, monkeypatch):
    client, _, _ = connection

    async def flow():
        _, response_id, item_id = await seed_audio(client)
        entered, release = asyncio.Event(), asyncio.Event()
        original = client.commit

        async def slow(operation, publish=True):
            entered.set()
            await release.wait()
            await original(operation, publish)

        monkeypatch.setattr(client, "commit", slow)
        await client.client_event({"type": "playback", "item_id": item_id, "played_ms": 100})
        await entered.wait()
        closing = asyncio.create_task(client.close_coaching())
        await asyncio.sleep(0)
        assert not closing.done()
        assert client.state["document"]["playback_pending"] == [response_id]
        release.set()
        await closing
        await drain_diagnostics()
        assert not client.exposure_tasks and not client.playback_confirmations
        assert client.state["document"]["playback_pending"] == []

    asyncio.run(flow())


def test_playback_ack_during_final_save_is_reconciled_without_another_ack(connection, monkeypatch):
    client, _, _ = connection

    async def flow():
        response_id, item_id = "saving-response", "saving-audio"
        response = {"id": response_id, "item_id": item_id, "persisted": False, "audio": True, "text": "Your view?"}
        client.responses[response_id] = response
        client.audio_items[item_id] = {"response_id": response_id, "played_ms": 0, "generated_ms": 100}
        entered, release = asyncio.Event(), asyncio.Event()
        original = client.commit

        async def slow_publish(operation, publish=True):
            before = client.state
            await original(operation, publish)
            if publish:
                committed = client.state
                client.state = before  # Simulate the final save not yet returning its state.
                entered.set()
                await release.wait()
                client.state = committed

        monkeypatch.setattr(client, "commit", slow_publish)
        saving = asyncio.create_task(client.save_assistant(response, "final"))
        await entered.wait()
        await client.client_event({"type": "playback", "item_id": item_id, "played_ms": 100})
        release.set()
        await saving
        if client.exposure_tasks:
            await asyncio.gather(*list(client.exposure_tasks))
        assert client.state["document"]["playback_pending"] == []
        if client.diagnostic_writer:
            await client.diagnostic_writer

    asyncio.run(flow())


def test_shutdown_persists_received_full_ack_before_its_delayed_confirmation(connection, monkeypatch):
    client, _, _ = connection

    async def flow():
        message, response_id, item_id = await seed_audio(client)
        partial = runtime.new_message("assistant", "Unheard remainder.", "voice",
                                      response_id="partial-response", provider_item_id="partial-audio")
        unknown = runtime.new_message("assistant", "Unknown playback.", "voice", response_id="unknown-response")
        await client.commit(lambda d, _: d.update(
            messages=[message, partial, unknown],
            playback_pending=[response_id, "partial-response", "unknown-response"]))
        client.audio_items["partial-audio"] = {
            "response_id": "partial-response", "played_ms": 50, "generated_ms": 100}
        client.responses["partial-response"] = {"id": "partial-response", "persisted": True}
        entered, release = asyncio.Event(), asyncio.Event()
        original = client.commit

        async def slow_confirmation(operation, publish=True):
            if operation.__name__ == "delivered":
                entered.set()
                await release.wait()
            await original(operation, publish)

        monkeypatch.setattr(client, "commit", slow_confirmation)
        await client.client_event({"type": "playback", "item_id": item_id, "played_ms": 100})
        await entered.wait()
        await client.persist_interrupted()
        statuses = {m["response_id"]: m["status"] for m in client.state["document"]["messages"]}
        assert statuses == {response_id: "final", "partial-response": "interrupted", "unknown-response": "interrupted"}
        release.set()
        await asyncio.gather(*list(client.exposure_tasks))
        assert client.state["document"]["messages"][0]["status"] == "final"
        if client.diagnostic_writer:
            await client.diagnostic_writer

    asyncio.run(flow())
