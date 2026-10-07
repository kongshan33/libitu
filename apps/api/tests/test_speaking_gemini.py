from array import array
import asyncio
from datetime import datetime, timezone
import math
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.integrations import speaking_gemini as gemini
from app.schemas.speaking import SpeakingSession, SpeakingSessionItem


def settings(**changes):
    return SimpleNamespace(gemini_api_key="fixture-key", gemini_live_model="gemini-3.8-live",
                           gemini_live_voice="Kore", speaking_max_output_tokens=450, **changes)


def session():
    return SpeakingSession(id=uuid4(), user_id="test", client_id=uuid4(), scenario_type="workplace",
                           goal="Agree on a deadline", difficulty="guided", feedback_level="light",
                           logic_template=None, created_at=datetime.now(timezone.utc),
                           items=[SpeakingSessionItem(id=uuid4(), corpus_item_id=None, ordinal=0,
                                                       kind="chunk", text="to be fair")])


def test_setup_enables_native_audio_and_unbiased_transcription():
    config = gemini.gemini_configuration(settings(), session())
    assert set(config) == {"setup"}
    setup = config["setup"]
    assert setup["model"] == "models/gemini-3.8-live"
    assert setup["generationConfig"]["responseModalities"] == ["AUDIO"]
    assert setup["generationConfig"]["maxOutputTokens"] == 450
    assert setup["inputAudioTranscription"] == {} and setup["outputAudioTranscription"] == {}
    assert "thinkingConfig" not in setup["generationConfig"]
    assert setup["realtimeInputConfig"]["activityHandling"] == "START_OF_ACTIVITY_INTERRUPTS"
    assert not setup["realtimeInputConfig"]["automaticActivityDetection"]["disabled"]
    assert "Agree on a deadline" in setup["systemInstruction"]["parts"][0]["text"]


def test_transport_uses_fixed_origin_header_secret_and_no_debug_logging(monkeypatch):
    observed = {}

    class FakeConnection:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            observed["closed"] = True

    def connect(url, **options):
        observed.update(url=url, options=options)
        return FakeConnection()

    monkeypatch.setattr(gemini, "connect", connect)

    async def use():
        async with gemini.open_gemini(settings()) as socket:
            assert isinstance(socket, FakeConnection)

    asyncio.run(use())
    assert observed["url"] == gemini.GEMINI_LIVE_URL and "?" not in observed["url"]
    assert observed["options"]["additional_headers"] == {"x-goog-api-key": "fixture-key"}
    assert observed["options"]["logger"].propagate is False
    assert observed["options"]["logger"].level > 50
    assert observed["closed"] is True


def pcm(samples):
    return array("h", samples).tobytes()


def convert(data, chunks):
    resampler = gemini.Pcm24To16()
    result, start = [], 0
    for size in chunks:
        result.append(resampler.process(data[start:start + size]))
        start += size
    result.append(resampler.process(data[start:]))
    assert len(resampler._samples) <= 32
    result.append(resampler.flush())
    assert resampler.flush() == b""
    return b"".join(result)


def test_resampler_keeps_phase_across_odd_byte_and_small_frame_boundaries():
    original = pcm(round(12000 * math.sin(index * 0.22)) for index in range(7000))
    whole = convert(original, [])
    fragmented = convert(original, [1, 13, 2, 777, 99, 3000, 4096, 1])
    assert whole == fragmented
    assert len(whole) // 2 == math.ceil(7000 * 2 / 3)


def test_resampler_low_passes_above_new_nyquist_and_keeps_voice_band():
    amplitudes = []
    for frequency in (1000, 11000):
        source = pcm(round(10000 * math.sin(2 * math.pi * frequency * index / 24000)) for index in range(12000))
        samples = array("h")
        samples.frombytes(convert(source, [4096, 4096, 4096]))
        amplitudes.append(math.sqrt(sum(value * value for value in samples[40:-40]) / len(samples[40:-40])))
    assert amplitudes[0] > 6500
    assert amplitudes[1] < amplitudes[0] * 0.03


def test_resampler_rejects_truncated_samples_and_oversized_frames_and_supports_reset():
    resampler = gemini.Pcm24To16()
    with pytest.raises(ValueError, match="32 KiB"):
        resampler.process(b"\x00" * 32769)
    resampler.process(b"\x00")
    with pytest.raises(ValueError, match="16-bit"):
        resampler.flush()
    resampler.reset()
    assert resampler.process(b"\x00" * 480) + resampler.flush() == b"\x00" * 320
    with pytest.raises(ValueError, match="Reset"):
        resampler.process(b"\x00\x00")
