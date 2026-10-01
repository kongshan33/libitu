"""Convert the locked public seed into the v1 manifest without creating labels.

Run after download_acoustic_seed.py. Existing output is never overwritten: use
a new path/version for subsequent reviews. This command does no network work.
"""

from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path

from app.schemas.acoustic_benchmark import BenchmarkManifest
from app.services.acoustic_benchmark import validate_manifest


ROOT = Path(__file__).resolve().parents[3]
SEED = ROOT / "apps/api/benchmarks/acoustics/v1/public_seed"
AUDIO_ROOT = ROOT / ".cache/acoustic-benchmark/public-seed"


def build_seed() -> BenchmarkManifest:
    records = json.loads((SEED / "source_records.json").read_text(encoding="utf-8"))["recordings"]
    licenses = {item["corpus"]: item for item in json.loads((SEED / "LICENSES.json").read_text(encoding="utf-8"))["licenses"]}
    samples = []
    for record in records:
        license_info = licenses[record["dataset"]]
        # These are annotation work items, not text-derived positive candidates.
        # Reviewers locate an actual target (or mark not_applicable) before review.
        targets = [{
            "target_id": f"{phenomenon}-review",
            "phenomenon": phenomenon,
            "annotation": {"notes": "Pending human target selection and independent annotation; no occurrence inferred."},
        } for phenomenon in ("pause", "f0", "vowel_length", "linking_gap")]
        samples.append({
            "sample_id": record["sample_id"],
            "speaker_id": record["speaker_id"],
            "source_group_id": record["source_group_id"],
            "split": "dev",
            "role": record["role"],
            "reference_sample_id": None,
            "audio": {
                "path": record["audio_relpath"],
                "sha256": record["sha256"],
                "sample_rate_hz": record["sample_rate_hz"],
                "channels": record["channels"],
                "frame_count": record["frame_count"],
            },
            "transcript": {
                "text": record["transcript"],
                "sha256": sha256(record["transcript"].encode("utf-8")).hexdigest(),
                "provenance": "provided",
                "language": "en",
            },
            "source": {
                "corpus": record["dataset"],
                "record_id": f"{record['original_speaker_id']}:{record['original_utterance_id']}",
                "url": record["audio_url"],
                "license": license_info["license_id"],
                "license_url": license_info["license_url"],
                "attribution": license_info["attribution"],
                "usage": "benchmark_only",
                "training_allowed": False,
            },
            "conditions": ["source_read_speech", "quality_unreviewed"],
            "target_accent": "en-US",
            "targets": targets,
        })
    return BenchmarkManifest.model_validate({
        "dataset_id": "libitu-public-acoustic-seed",
        "dataset_version": "seed-2026-09-13-v1",
        "dataset_kind": "human_speech",
        "samples": samples,
    })


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = build_seed()
    report = validate_manifest(manifest, AUDIO_ROOT)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        stream.write(manifest.model_dump_json(indent=2) + "\n")
    print(json.dumps({"output": str(args.output), "samples": report["sample_count"], "readiness": report["readiness"]}))


if __name__ == "__main__":
    main()
