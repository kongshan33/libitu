"""Bounded local decoding; no network protocols or arbitrary ffmpeg arguments."""
from hashlib import sha256
from pathlib import Path
import subprocess
import wave

from app.schemas.reference import MAX_SEGMENT_MS

RATE = 16000


class AudioFailure(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize(source: Path, target: Path, start_ms: int, duration_ms: int) -> None:
    if start_ms < 0 or not 0 < duration_ms <= MAX_SEGMENT_MS:
        raise AudioFailure("invalid_audio_range")
    try:
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file,pipe",
                        "-i", str(source), "-ss", str(start_ms / 1000), "-t", str(duration_ms / 1000),
                        "-vn", "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s16le", str(target)],
                       check=True, capture_output=True, timeout=90)
        with wave.open(str(target)) as audio:
            duration = audio.getnframes() / audio.getframerate()
            if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != RATE:
                raise AudioFailure("invalid_normalized_audio")
        if abs(duration - duration_ms / 1000) > 0.05:
            raise AudioFailure("audio_duration_mismatch")
    except FileNotFoundError as error:
        raise AudioFailure("ffmpeg_unavailable") from error
    except (subprocess.SubprocessError, wave.Error, EOFError) as error:
        raise AudioFailure("audio_decode_failed") from error


def crop(source: Path, target: Path, start_sec: float, end_sec: float) -> float:
    """Return actual crop origin. Padding is never implicitly added."""
    with wave.open(str(source)) as audio:
        first = max(0, round(start_sec * RATE))
        last = min(audio.getnframes(), round(end_sec * RATE))
        if last <= first:
            raise AudioFailure("empty_sentence_audio")
        audio.setpos(first)
        frames = audio.readframes(last - first)
    with wave.open(str(target), "wb") as output:
        output.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        output.writeframes(frames)
    return first / RATE
