"""Fixed-origin Gemini Live transport; credentials and setup remain server-only.

The wire is Gemini v1beta BidiGenerateContent, not the OpenAI event protocol.
Send the setup once and await setupComplete before sending other messages.
"""
from array import array
from contextlib import asynccontextmanager
import logging
import math
import ssl
import sys

import certifi
from websockets.asyncio.client import connect

from app.config import Settings
from app.integrations.speaking_realtime import role_instructions
from app.schemas.speaking import SpeakingSession


GEMINI_LIVE_URL = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)
# WebSocket DEBUG output contains handshake headers and audio. This dedicated
# logger cannot inherit an application's verbose root logger or disclose the key.
_TRANSPORT_LOGGER = logging.Logger("libitu.gemini.transport", level=logging.CRITICAL + 1)
_TRANSPORT_LOGGER.propagate = False
_TRANSPORT_LOGGER.addHandler(logging.NullHandler())


@asynccontextmanager
async def open_gemini(settings: Settings):
    if not settings.gemini_api_key:
        raise ValueError("Gemini Live is not configured.")
    async with connect(
        GEMINI_LIVE_URL,
        additional_headers={"x-goog-api-key": settings.gemini_api_key},
        ssl=ssl.create_default_context(cafile=certifi.where()),
        open_timeout=15, close_timeout=3, ping_interval=20, ping_timeout=20,
        max_size=2 * 1024 * 1024, max_queue=16, logger=_TRANSPORT_LOGGER,
    ) as socket:
        yield socket


def gemini_configuration(settings: Settings, session: SpeakingSession) -> dict:
    """Single initial setup. Native audio uses transcript events for text views."""
    model = settings.gemini_live_model.removeprefix("models/")
    return {"setup": {
        "model": f"models/{model}",
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "maxOutputTokens": settings.speaking_max_output_tokens,
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": settings.gemini_live_voice}}},
        },
        # The text analyzer owns selected wording. Priming the voice partner with the
        # answer itself encourages it to demonstrate rather than elicit it.
        "systemInstruction": {"parts": [{"text": role_instructions(session, include_language_targets=False)}]},
        # Defaults are verbatim; do not bias ASR with equipped language, which
        # would manufacture apparent transfer evidence from recognition errors.
        "inputAudioTranscription": {},
        "outputAudioTranscription": {},
        "realtimeInputConfig": {
            "automaticActivityDetection": {
                "disabled": False,
                "startOfSpeechSensitivity": "START_SENSITIVITY_LOW",
                "endOfSpeechSensitivity": "END_SENSITIVITY_LOW",
                # Require a longer speech onset before automatic barge-in so
                # brief background sounds are less likely to interrupt a reply.
                "prefixPaddingMs": 300,
                "silenceDurationMs": 1200,
            },
            "activityHandling": "START_OF_ACTIVITY_INTERRUPTS",
            "turnCoverage": "TURN_INCLUDES_ONLY_ACTIVITY",
        },
    }}


class Pcm24To16:
    """Bounded streaming PCM16LE mono 24 kHz → 16 kHz resampler.

    Gemini accepts rate=24000 and resamples itself, so this is optional. This
    implementation maintains phase across chunks and low-passes before reducing
    the rate. A 31-tap windowed-sinc FIR adds approximately 0.65 ms lookahead.
    Call flush only at the end of a stream, not between microphone frames.
    """

    _HALF = 15
    _CUTOFF = 0.30  # 7.2 kHz passband limit below the new 8 kHz Nyquist boundary.

    def __init__(self) -> None:
        self._weights = []
        for phase in (0.0, 0.5):
            coefficients = []
            for offset in range(-self._HALF, self._HALF + 1):
                distance = offset - phase
                sinc = (2 * self._CUTOFF if distance == 0 else
                        math.sin(2 * math.pi * self._CUTOFF * distance) / (math.pi * distance))
                window = 0.5 + 0.5 * math.cos(math.pi * distance / (self._HALF + 0.5))
                coefficients.append(sinc * window)
            total = sum(coefficients)
            self._weights.append([coefficient / total for coefficient in coefficients])
        self.reset()

    def reset(self) -> None:
        self._samples: list[int] = []
        self._base = 0
        self._total = 0
        self._position = 0  # Half-input-sample units; increments by 3 per output.
        self._partial_byte = b""
        self._finished = False

    def process(self, data: bytes) -> bytes:
        if self._finished:
            raise ValueError("Reset the resampler before starting another stream.")
        if not isinstance(data, bytes):
            raise TypeError("PCM input must be bytes.")
        if len(data) > 32768:
            raise ValueError("PCM frame exceeds the 32 KiB limit.")
        data = self._partial_byte + data
        even = len(data) - len(data) % 2
        self._partial_byte = data[even:]
        samples = array("h")
        samples.frombytes(data[:even])
        if sys.byteorder != "little":
            samples.byteswap()
        self._samples.extend(samples)
        self._total += len(samples)
        return self._render(final=False)

    def convert(self, data: bytes) -> bytes:
        return self.process(data)

    def flush(self) -> bytes:
        if self._partial_byte:
            raise ValueError("PCM stream ended within a 16-bit sample.")
        if self._finished:
            return b""
        self._finished = True
        return self._render(final=True)

    def _render(self, *, final: bool) -> bytes:
        output = array("h")
        while self._position < self._total * 2:
            center, phase = divmod(self._position, 2)
            if not final and center + self._HALF >= self._total:
                break
            value = 0.0
            for offset, weight in zip(range(-self._HALF, self._HALF + 1), self._weights[phase]):
                index = center + offset
                if 0 <= index < self._total:
                    value += self._samples[index - self._base] * weight
            output.append(max(-32768, min(32767, round(value))))
            self._position += 3
        keep_from = min(self._total, max(self._base, self._position // 2 - self._HALF))
        self._samples = self._samples[keep_from - self._base:]
        self._base = keep_from
        if sys.byteorder != "little":
            output.byteswap()
        return output.tobytes()
