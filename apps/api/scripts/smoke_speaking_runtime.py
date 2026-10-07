"""Opt-in paid Stage 4 smoke with synthetic owned records and guaranteed cleanup.

Run from apps/api: uv run python -m scripts.smoke_speaking_runtime --live
No real account, microphone, or existing corpus is touched; no credentials print.
"""
import argparse
import asyncio
import json
import base64
import subprocess
import tempfile
from pathlib import Path
from uuid import uuid4

from app.config import get_settings
from app.schemas.corpus import CorpusItemCreate
from app.schemas.speaking import SpeakingSessionCreate
from app.schemas.speaking_runtime import RealtimeStart
from app.services import corpus_service, speaking_runtime_state, speaking_service
from app.services.speaking_gemini_runtime import GeminiSpeakingConnection


class SyntheticBrowser:
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.events = asyncio.Queue()

    async def send_json(self, event):
        await self.events.put(event)

    async def receive_text(self):
        return json.dumps(await self.incoming.get())

    async def close(self):
        pass


async def exercise(owner, session_id, voice_pcm: bytes | None = None):
    ticket = await asyncio.to_thread(speaking_runtime_state.create_ticket, owner, session_id,
                                     RealtimeStart(client_connection_id=uuid4()))
    await asyncio.to_thread(speaking_runtime_state.consume_ticket, session_id, str(ticket.runtime_id), ticket.ticket)
    browser = SyntheticBrowser()
    connection = GeminiSpeakingConnection(browser, owner, session_id, str(ticket.runtime_id))
    running = asyncio.create_task(connection.run())
    client_id = str(uuid4())
    sent = False
    playback = {}
    audio_bytes = 0
    stream_task = None
    async def stream_voice():
        await browser.incoming.put({"type": "microphone", "enabled": True})
        samples = bytes(48000) + voice_pcm + bytes(96000)
        for offset in range(0, len(samples), 4800):
            await browser.incoming.put({"type": "audio.append", "audio": base64.b64encode(samples[offset:offset + 4800]).decode()})
            await asyncio.sleep(0.1)
    try:
        async with asyncio.timeout(70):
            while True:
                event = await browser.events.get()
                if event["type"] == "error":
                    raise RuntimeError(f'{event["code"]}: {event["message"]}')
                if event["type"] == "audio.delta":
                    count = len(base64.b64decode(event["audio"]))
                    audio_bytes += count
                    playback[event["item_id"]] = playback.get(event["item_id"], 0) + count / 48
                    await browser.incoming.put({"type": "playback", "item_id": event["item_id"],
                                                "played_ms": playback[event["item_id"]]})
                if event["type"] == "snapshot":
                    workspace = event["workspace"]
                    messages = workspace["messages"]
                    if not sent and any(m["role"] == "assistant" and m["status"] == "final" for m in messages):
                        if voice_pcm is not None:
                            stream_task = asyncio.create_task(stream_voice())
                        else:
                            await browser.incoming.put({"type": "text.submit", "client_turn_id": client_id,
                                                        "text": "One trade-off is that this database scales well, but querying is harder."})
                        await browser.incoming.put({"type": "ping"})
                        sent = True
                    if (sent and sum(m["role"] == "assistant" and m["status"] == "final" for m in messages) >= 2
                            and workspace["analysis_status"] in ("ready", "unavailable")):
                        assert workspace["session"]["turn_count"] == 1
                        if voice_pcm is None:
                            assert sum(m["client_turn_id"] == client_id for m in messages) == 1
                        else:
                            assert audio_bytes > 0
                        assert workspace["evidence"], "Expected grounded target occurrence"
                        break
        saved = await asyncio.to_thread(speaking_runtime_state.public_workspace, owner, session_id)
        completed = await asyncio.to_thread(speaking_runtime_state.end_session, owner, session_id)
        assert completed.session.status == "completed"
        assert len(saved.messages) == len(completed.messages)
        return {"provider": "gemini", "model": get_settings().gemini_live_model,
                "messages": len(saved.messages), "user_turns": saved.session.turn_count,
                "evidence": len(saved.evidence), "analysis": saved.analysis_status,
                "voice_input": voice_pcm is not None, "output_audio_bytes": audio_bytes,
                "ended_and_recovered": True}
    finally:
        if stream_task:
            stream_task.cancel()
            await asyncio.gather(stream_task, return_exceptions=True)
        connection.stop.set()
        try:
            await asyncio.wait_for(running, 8)
        except asyncio.TimeoutError:
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="Explicitly enable bounded paid provider calls")
    parser.add_argument("--voice", action="store_true", help="Use a local macOS synthetic voice and ffmpeg PCM conversion")
    args = parser.parse_args()
    if not args.live:
        parser.error("This smoke calls real providers; pass --live explicitly.")
    owner = "libitu-stage4-smoke-" + uuid4().hex
    item = session = None
    try:
        item = corpus_service.create_corpus_item(owner, CorpusItemCreate(
            kind="chunk", text="One trade-off is", meaning="Introduce a compromise",
            source_locator={"source_title": "Synthetic Stage 4 smoke"},
        ))
        session = speaking_service.create_speaking_session(owner, SpeakingSessionCreate(
            client_id=uuid4(), scenario_type="workplace", goal="Discuss a database choice with a colleague",
            corpus_item_ids=[item.id],
        ))
        voice_pcm = None
        if args.voice:
            with tempfile.TemporaryDirectory(prefix="libitu-voice-smoke-") as directory:
                source, pcm = Path(directory) / "voice.aiff", Path(directory) / "voice.pcm"
                subprocess.run(["say", "-v", "Samantha", "-o", str(source),
                                "One trade-off is that this database scales well, but querying is harder."], check=True)
                subprocess.run(["ffmpeg", "-v", "error", "-i", str(source), "-ar", "24000", "-ac", "1",
                                "-f", "s16le", str(pcm)], check=True)
                voice_pcm = pcm.read_bytes()
        print(json.dumps(asyncio.run(exercise(owner, str(session.id), voice_pcm))))
    finally:
        if session:
            speaking_runtime_state.delete_session(owner, str(session.id))
        if item:
            corpus_service.delete_corpus_item(owner, str(item.id))


if __name__ == "__main__":
    main()
