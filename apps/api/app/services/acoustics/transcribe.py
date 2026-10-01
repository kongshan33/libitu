"""Isolated, bounded ASR process. Expected text is deliberately not an input."""
import argparse
from functools import lru_cache
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys

from app.services.acoustics.audio import AudioFailure, file_hash


def model_fingerprint(path: Path) -> str:
    names = ("config.json", "model.bin", "tokenizer.json", "vocabulary.json" if (path / "vocabulary.json").is_file() else "vocabulary.txt")
    if not all((path / name).is_file() for name in names):
        raise AudioFailure("asr_model_unavailable")
    return sha256(json.dumps({name: file_hash(path / name) for name in names}, sort_keys=True).encode()).hexdigest()


@lru_cache(maxsize=2)
def verify_model(path: str, digest: str) -> None:
    if model_fingerprint(Path(path)) != digest:
        raise AudioFailure("asr_model_integrity_failed")


def transcribe(audio: Path, settings) -> dict:
    if not settings.practice_asr_model_path or not settings.practice_asr_model_sha256:
        raise AudioFailure("asr_model_unavailable")
    verify_model(settings.practice_asr_model_path, settings.practice_asr_model_sha256)
    try:
        result = subprocess.run([sys.executable, "-m", "app.services.acoustics.transcribe", "--audio", str(audio),
            "--model", settings.practice_asr_model_path], capture_output=True, check=True, timeout=180)
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired as error:
        raise AudioFailure("asr_timeout") from error
    except (subprocess.CalledProcessError, ValueError) as error:
        raise AudioFailure("asr_failed") from error


def main():
    from importlib.metadata import version
    from faster_whisper import WhisperModel
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    if version("faster-whisper") != "1.2.1":
        raise SystemExit("ASR runtime version mismatch")
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=2, local_files_only=True)
    segments, _ = model.transcribe(args.audio, language="en", beam_size=5, temperature=0,
        condition_on_previous_text=False, initial_prompt=None, vad_filter=False)
    rows = list(segments)
    print(json.dumps({"text": " ".join(s.text.strip() for s in rows),
        "reliable": bool(rows) and all(s.avg_logprob >= -1.0 and s.no_speech_prob < .6 and s.compression_ratio < 2.4 for s in rows)}))


if __name__ == "__main__":
    main()
