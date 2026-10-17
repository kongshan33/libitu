"""Resident, isolated ASR with bounded requests; expected text is never an input."""
import argparse
import atexit
from contextlib import redirect_stdout
import os
import selectors
from threading import Lock
from time import monotonic
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


class ResidentASR:
    """One serialized model process per worker, restarted after timeout or failure."""

    def __init__(self):
        self.lock = Lock()
        self.process = None
        self.identity = None
        self.timeout = 180

    def _stop(self):
        process, self.process = self.process, None
        self.identity = None
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdin.close()
            process.stdout.close()

    def close(self):
        with self.lock:
            self._stop()

    def _read(self):
        deadline, data = monotonic() + self.timeout, bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise AudioFailure("asr_timeout")
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk or len(data) + len(chunk) > 1024 * 1024:
                    raise AudioFailure("asr_failed")
                data.extend(chunk)
                if b"\n" in data:
                    return json.loads(data)

    def _start(self, settings):
        identity = (settings.practice_asr_model_path, settings.practice_asr_model_sha256)
        if not all(identity):
            raise AudioFailure("asr_model_unavailable")
        verify_model(*identity)
        if self.process is not None and (self.identity != identity or self.process.poll() is not None):
            self._stop()
        if self.process is None:
            self.process = subprocess.Popen(
                [sys.executable, "-m", "app.services.acoustics.transcribe", "--serve", "--model", identity[0]],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
            self.identity = identity
            if self._read() != {"ready": True}:
                raise AudioFailure("asr_failed")

    def request(self, settings, audio=None):
        with self.lock:
            try:
                self._start(settings)
                if audio is None:
                    return None
                self.process.stdin.write((json.dumps({"audio": str(audio)}) + "\n").encode())
                self.process.stdin.flush()
                result = self._read()
                if not isinstance(result, dict) or not isinstance(result.get("text"), str) \
                        or type(result.get("reliable")) is not bool:
                    raise AudioFailure("asr_failed")
                return result
            except AudioFailure:
                self._stop()
                raise
            except (OSError, ValueError) as error:
                self._stop()
                raise AudioFailure("asr_failed") from error


_resident = ResidentASR()
atexit.register(_resident.close)


def warm_up(settings):
    _resident.request(settings)


def close_resident():
    _resident.close()


def transcribe(audio: Path, settings) -> dict:
    return _resident.request(settings, audio)


def recognize(model, audio):
    segments, _ = model.transcribe(audio, language="en", beam_size=5, temperature=0,
        condition_on_previous_text=False, initial_prompt=None, vad_filter=False, word_timestamps=True)
    rows = list(segments)
    return {"text": " ".join(s.text.strip() for s in rows),
        "words": [{"text": w.word, "start_sec": w.start, "end_sec": w.end}
                  for s in rows for w in (getattr(s, "words", None) or [])],
        "reliable": bool(rows) and all(s.avg_logprob >= -1.0 and s.no_speech_prob < .6 and s.compression_ratio < 2.4 for s in rows)}


def main():
    from importlib.metadata import version
    from faster_whisper import WhisperModel
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--audio")
    mode.add_argument("--serve", action="store_true")
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    if version("faster-whisper") != "1.2.1":
        raise SystemExit("ASR runtime version mismatch")
    with redirect_stdout(sys.stderr):
        model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=2, local_files_only=True)
    if not args.serve:
        with redirect_stdout(sys.stderr):
            result = recognize(model, args.audio)
        print(json.dumps(result))
        return
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with redirect_stdout(sys.stderr):
                result = recognize(model, request["audio"])
            print(json.dumps(result), flush=True)
        except Exception:
            # Do not put audio paths, transcripts or runtime exception details on the wire.
            print(json.dumps({"error": "asr_failed"}), flush=True)
            return


if __name__ == "__main__":
    main()
