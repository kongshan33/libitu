from pathlib import Path
import shutil
import wave

import pytest

from app.services.acoustics.audio import AudioFailure
from app.services.acoustics.practice_prosody import normalize_take


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg unavailable")
def test_long_quick_audio_is_not_silently_truncated(tmp_path: Path):
    source = tmp_path / "long.wav"
    with wave.open(str(source), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\0\0" * (16000 * 90))
    assert normalize_take(source, tmp_path / "quick.wav", 91) == 90
    with pytest.raises(AudioFailure, match="recording_duration_invalid"):
        normalize_take(source, tmp_path / "detailed.wav")
    with pytest.raises(AudioFailure, match="recording_duration_invalid"):
        normalize_take(source, tmp_path / "too-long.wav", 80)
