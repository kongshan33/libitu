"""Restore the 16 explicitly selected public WAV files, or verify the local cache.

Run from any directory with the API virtualenv. No archive extraction, annotation,
model inference, or network access occurs when all locked files already exist.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import wave

import httpx

ROOT = Path(__file__).resolve().parents[3]
LOCK = ROOT / "apps/api/benchmarks/acoustics/v1/public_seed/source_records.json"
CACHE = ROOT / ".cache/acoustic-benchmark/public-seed"
REVISION = "613968e3b0b789fc33936fb5eba1973176ba7d11"
MAX_FILE_BYTES = 2 * 1024 * 1024


def allowed_files() -> dict[str, str]:
    files = {}
    for speaker, start in (("bdl", 1), ("slt", 5)):
        for index in range(start, start + 4):
            name = f"arctic_a{index:04d}.wav"
            files[f"cmu_arctic/{speaker}/{name}"] = (
                "http://festvox.org/cmu_arctic/cmu_arctic/"
                f"cmu_us_{speaker}_arctic/wav/{name}"
            )
    for speaker, utterances in {
        "0036": ("000360013", "000360034", "000360036", "000360132"),
        "1027": ("010270117", "010270124", "010270131", "010270140"),
    }.items():
        for utterance in utterances:
            files[f"speechocean762/{speaker}/{utterance}.wav"] = (
                "https://raw.githubusercontent.com/jimbozhang/speechocean762/"
                f"{REVISION}/WAVE/SPEAKER{speaker}/{utterance}.WAV"
            )
    return files


def verify(data: bytes, record: dict) -> None:
    if len(data) != record["byte_size"] or len(data) > MAX_FILE_BYTES:
        raise ValueError(f"Size mismatch: {record['audio_relpath']}")
    if hashlib.sha256(data).hexdigest() != record["sha256"]:
        raise ValueError(f"Checksum mismatch: {record['audio_relpath']}")
    with wave.open(io.BytesIO(data), "rb") as wav:
        actual = (wav.getframerate(), wav.getnchannels(), wav.getsampwidth(), wav.getnframes())
        expected = tuple(record[k] for k in (
            "sample_rate_hz", "channels", "sample_width_bytes", "frame_count"
        ))
        if actual != expected or wav.getcomptype() != "NONE":
            raise ValueError(f"WAV metadata mismatch: {record['audio_relpath']}")
        if len(wav.readframes(wav.getnframes())) != actual[1] * actual[2] * actual[3]:
            raise ValueError(f"Truncated PCM: {record['audio_relpath']}")


def fetch(client: httpx.Client, url: str) -> bytes:
    for attempt in range(3):
        try:
            with client.stream("GET", url) as response:
                response.raise_for_status()
                data = bytearray()
                for chunk in response.iter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_FILE_BYTES:
                        raise ValueError("Remote file exceeds the 2 MiB limit")
                return bytes(data)
        except httpx.TransportError:
            if attempt == 2:
                raise
    raise RuntimeError("Unreachable retry state")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true", help="Fail on missing files; never download")
    args = parser.parse_args()
    lock = json.loads(LOCK.read_text())
    records = lock["recordings"]
    allowed = allowed_files()
    actual = {record["audio_relpath"]: record["audio_url"] for record in records}
    if len(records) != 16 or actual != allowed:
        raise ValueError("Source lock must contain exactly the 16 allowlisted URLs and paths")
    restored = 0
    with httpx.Client(timeout=15, follow_redirects=False) as client:
        for record in records:
            path = CACHE / record["audio_relpath"]
            if path.resolve().is_relative_to(CACHE.resolve()) is False:
                raise ValueError("Audio path escapes the cache")
            if path.exists():
                if path.stat().st_size > MAX_FILE_BYTES:
                    raise ValueError(f"Oversized existing file: {path}")
                verify(path.read_bytes(), record)
                continue
            if args.verify_only:
                raise FileNotFoundError(path)
            data = fetch(client, record["audio_url"])
            verify(data, record)
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
                temporary.write(data)
                temporary_path = Path(temporary.name)
            try:
                # Publish complete bytes without replacing any existing file.
                os.link(temporary_path, path)
            except FileExistsError:
                verify(path.read_bytes(), record)
            finally:
                temporary_path.unlink()
            restored += 1
    print(json.dumps({"verified": len(records), "restored": restored, "cache_root": str(CACHE)}))


if __name__ == "__main__":
    main()
