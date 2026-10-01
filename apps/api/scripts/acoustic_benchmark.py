"""Validate, inspect and evaluate offline acoustic benchmark files.

Run from apps/api with .venv/bin/python -m scripts.acoustic_benchmark --help.
Commands never download audio, invoke models, or contact the application API.
"""

from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import sys

from pydantic import ValidationError

from app.schemas.acoustic_benchmark import BenchmarkManifest, ResultFile, SampleResult, Observation
from app.services.acoustic_benchmark import evaluate, validate_manifest


def _write(path: Path, value: dict, *, replace: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w" if replace else "x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False, allow_nan=False)
        stream.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    schema = commands.add_parser("schemas", help="Export the authoritative Pydantic JSON Schemas")
    schema.add_argument("--output-dir", type=Path, required=True)
    schema.add_argument("--replace", action="store_true", help="Explicitly regenerate existing schemas")
    for name in ("validate", "evaluate", "new-run"):
        command = commands.add_parser(name)
        command.add_argument("manifest", type=Path)
        if name in ("validate", "evaluate"):
            command.add_argument("--audio-root", type=Path, required=name == "evaluate")
            command.add_argument("--output", type=Path, help="Write a new JSON report without overwriting")
        if name == "evaluate":
            command.add_argument("--results", type=Path, required=True)
            command.add_argument("--split", choices=("train", "dev", "test"), default="test")
            command.add_argument("--allow-synthetic", action="store_true")
        if name == "new-run":
            command.add_argument("--run-id", required=True)
            command.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "schemas":
            for name, model in (("manifest", BenchmarkManifest), ("results", ResultFile)):
                _write(args.output_dir / f"{name}.schema.json", model.model_json_schema(), replace=args.replace)
            print(json.dumps({"exported": ["manifest.schema.json", "results.schema.json"]}))
            return 0
        manifest = BenchmarkManifest.model_validate_json(args.manifest.read_text(encoding="utf-8"))
        if args.command == "new-run":
            validate_manifest(manifest)
            run = ResultFile(
                dataset_id=manifest.dataset_id,
                dataset_version=manifest.dataset_version,
                run_id=args.run_id,
                versions={"pipeline": "not-run-v1"},
                results=[SampleResult(
                    sample_id=sample.sample_id,
                    audio_sha256=sample.audio.sha256,
                    transcript_sha256=sample.transcript.sha256,
                    role=sample.role,
                    observations=[Observation(
                        target_id=target.target_id,
                        phenomenon=target.phenomenon,
                        status="not_evaluated",
                        reasons=["detector_not_run"],
                    ) for target in sample.targets],
                ) for sample in manifest.samples],
            )
            _write(args.output, run.model_dump(mode="json"))
            print(json.dumps({"created": str(args.output), "status": "not_evaluated", "model_invoked": False}))
            return 0
        report = validate_manifest(manifest, args.audio_root)
        if args.command == "evaluate":
            run = ResultFile.model_validate_json(args.results.read_text(encoding="utf-8"))
            report = evaluate(manifest, run, split=args.split, allow_synthetic=args.allow_synthetic)
            report["audio_files_checked"] = len(manifest.samples)
        # Pin the complete evaluated annotation revision, not only user-maintained
        # dataset_version. The hash includes labels and source/target metadata.
        report["manifest_sha256"] = sha256(manifest.model_dump_json().encode("utf-8")).hexdigest()
        if args.output:
            _write(args.output, report)
        print(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False))
        return 0
    except (OSError, ValueError, ValidationError) as exc:
        # Do not print Pydantic's input_value: it can contain private transcripts.
        if isinstance(exc, ValidationError):
            errors = [{"field": list(error["loc"]), "message": error["msg"]} for error in exc.errors(include_input=False)]
        else:
            errors = [{"message": str(exc)}]
        print(json.dumps({"status": "invalid", "errors": errors}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
