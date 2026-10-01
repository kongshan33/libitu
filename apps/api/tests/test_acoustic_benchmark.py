"""Offline integrity/metric regression tests, not real-speech quality validation.

Every PCM file below is an artificial constant signal in a temporary directory.
The adjudicated/present/absent records are simulated contracts for hand-calculated
metric examples, not human-reviewed speech or material eligible for a benchmark.
No public corpus, model, network request, or application API is used.
"""

from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
import wave

import pytest

from app.schemas.acoustic_benchmark import BenchmarkManifest, ResultFile
from app.services.acoustic_benchmark import evaluate, validate_manifest, validate_results


API_ROOT = Path(__file__).resolve().parents[1]


def test_committed_json_schemas_match_authoritative_contracts():
    directory = API_ROOT / "benchmarks/acoustics/v1/schemas"
    for name, model in (("manifest", BenchmarkManifest), ("results", ResultFile)):
        assert json.loads((directory / f"{name}.schema.json").read_text()) == model.model_json_schema()


def test_public_seed_conversion_keeps_source_identity_without_invented_labels():
    from scripts.prepare_acoustic_seed import build_seed

    manifest = build_seed()
    committed = BenchmarkManifest.model_validate_json(
        (API_ROOT / "benchmarks/acoustics/v1/public_seed/manifest.json").read_text()
    )
    assert manifest == committed
    assert len(manifest.samples) == 16
    assert {s.split for s in manifest.samples} == {"dev"}
    assert {s.role for s in manifest.samples} == {"reference", "learner"}
    assert all(s.reference_sample_id is None and not s.source.training_allowed for s in manifest.samples)
    assert all(s.transcript.provenance == "provided" for s in manifest.samples)
    targets = [t for s in manifest.samples for t in s.targets]
    assert len(targets) == 64
    assert all(t.annotation.status == "pending" and t.annotation.label is None for t in targets)
    assert all(t.interval is None and t.rule_candidate is None for t in targets)


def digest(data: bytes) -> str:
    return sha256(data).hexdigest()


def reviewed(label: str | None = "present", *, values: list[dict] | None = None) -> dict:
    return {
        "status": "adjudicated",
        "label": label,
        "measurements": values or [],
        "annotator_ids": ["simulated-reviewer-1", "simulated-reviewer-2"],
        "notes": "Invented metric-unit-test record; not human-reviewed speech.",
    }


def duration(value: float) -> dict:
    return {"name": "pause_duration_ms", "value": value, "unit": "ms"}


def fixture_manifest(
    directory: Path,
    annotations: list[dict] | None = None,
    *,
    split: str = "test",
    kind: str = "human_speech",
) -> BenchmarkManifest:
    directory.mkdir(parents=True, exist_ok=True)
    samples = []
    for index, annotation in enumerate(annotations if annotations is not None else [{}]):
        filename = f"signal-{index}.wav"
        path = directory / filename
        with wave.open(str(path), "wb") as wav:
            wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            # Distinct payloads prevent accidental hash-group leakage in tests
            # intended to isolate a different grouping constraint.
            wav.writeframes((index + 1).to_bytes(2, "little", signed=True) * 16000)
        text = "A short synthetic fixture."
        samples.append({
            "sample_id": f"sample-{index}",
            "speaker_id": f"speaker-{index}",
            "source_group_id": f"session-{index}",
            "split": split,
            "role": "learner",
            "audio": {
                "path": filename,
                "sha256": digest(path.read_bytes()),
                "sample_rate_hz": 16000,
                "channels": 1,
                "frame_count": 16000,
            },
            "transcript": {"text": text, "sha256": digest(text.encode()), "provenance": "provided"},
            "source": {
                "corpus": "invented-unit-fixtures",
                "record_id": f"record-{index}",
                "url": f"https://example.invalid/fixture-{index}",
                "license": "Invented fixture; not a licensed speech source",
                "license_url": "https://example.invalid/fixture-license",
                "attribution": "Libitu test generator, artificial PCM",
            },
            "conditions": ["test-artificial-pcm"],
            "targets": [{
                "target_id": "target-0", "phenomenon": "pause", "annotation": annotation,
                "interval": {"start_seconds": 0.0, "end_seconds": 1.0},
            }],
        })
    return BenchmarkManifest.model_validate({
        "dataset_id": "metric-unit-fixture",
        "dataset_version": "v1",
        "dataset_kind": kind,
        "samples": samples,
    })


def observation(status: str, value: float = 100.0, *, confidence: float | None = None) -> dict:
    result = {"target_id": "target-0", "phenomenon": "pause", "status": status}
    if status in {"detected", "not_detected", "measured"}:
        result["measurements"] = [duration(value)]
    else:
        result["reasons"] = ["simulated-abstention"]
    if confidence is not None:
        result["confidence"] = confidence
    return result


def fixture_run(manifest: BenchmarkManifest, predictions: dict[int, dict]) -> ResultFile:
    return ResultFile.model_validate({
        "dataset_id": manifest.dataset_id,
        "dataset_version": manifest.dataset_version,
        "run_id": "unit-run",
        "versions": {"pipeline": "simulated-unit-v1"},
        "calibration_id": "simulated-not-a-calibration" if any(
            p.get("confidence") is not None for p in predictions.values()
        ) else None,
        "results": [{
            "sample_id": manifest.samples[index].sample_id,
            "audio_sha256": manifest.samples[index].audio.sha256,
            "transcript_sha256": manifest.samples[index].transcript.sha256,
            "role": manifest.samples[index].role,
            "quality": {"status": "passed", "reasons": []},
            "content": {"status": "passed", "reasons": []},
            "alignment": {"status": "passed", "reasons": []},
            "observations": [prediction],
        } for index, prediction in predictions.items()],
    })


def cli(*args: str | Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "scripts.acoustic_benchmark", *map(str, args)],
        cwd=API_ROOT, capture_output=True, text=True, check=False, timeout=20,
    )


def save_model(path: Path, model) -> Path:
    path.write_text(model.model_dump_json(), encoding="utf-8")
    return path


def test_real_file_integrity_is_distinct_from_metadata_only_inventory(tmp_path):
    manifest = fixture_manifest(tmp_path)
    assert validate_manifest(manifest)["readiness"] == "metadata_only"
    report = validate_manifest(manifest, tmp_path)
    assert report["audio_files_checked"] == 1
    assert report["duration_seconds"] == 1.0
    assert report["readiness"] == "needs_annotation"
    assert report["release_ready"] is False


@pytest.mark.parametrize("defect", ["missing", "hash", "metadata", "truncated"])
def test_actual_wav_defects_cannot_pass_metadata_validation(tmp_path, defect):
    manifest = fixture_manifest(tmp_path)
    data = manifest.model_dump()
    path = tmp_path / data["samples"][0]["audio"]["path"]
    if defect == "missing":
        path.unlink()
    elif defect == "hash":
        path.write_bytes(path.read_bytes() + b"changed")
    elif defect == "metadata":
        data["samples"][0]["audio"]["sample_rate_hz"] = 8000
    else:
        path.write_bytes(path.read_bytes()[:-10])
        # Pin the damaged file to bypass the hash gate and test PCM truncation.
        data["samples"][0]["audio"]["sha256"] = digest(path.read_bytes())
    with pytest.raises(ValueError, match={
        "missing": "missing", "hash": "SHA-256", "metadata": "metadata", "truncated": "truncated"
    }[defect]):
        validate_manifest(BenchmarkManifest.model_validate(data), tmp_path)


def test_symlink_cannot_resolve_audio_outside_allowed_root(tmp_path):
    audio_root = tmp_path / "audio"
    manifest = fixture_manifest(audio_root)
    path = audio_root / manifest.samples[0].audio.path
    outside = tmp_path / "outside.wav"
    path.rename(outside)
    path.symlink_to(outside)
    with pytest.raises(ValueError, match="escapes audio root"):
        validate_manifest(manifest, audio_root)


@pytest.mark.parametrize("group", ["speaker", "source_group", "audio_hash", "source_record"])
def test_reencoded_or_relabelled_identity_cannot_leak_across_splits(tmp_path, group):
    data = fixture_manifest(tmp_path, [{}, {}]).model_dump()
    first, second = data["samples"]
    second["split"] = "dev"
    if group in {"speaker", "source_group"}:
        field = f"{group}_id"
        second[field] = first[field]
    elif group == "audio_hash":
        second["audio"]["sha256"] = first["audio"]["sha256"]
    else:
        second["source"]["record_id"] = first["source"]["record_id"]
    with pytest.raises(ValueError, match="split leakage"):
        validate_manifest(BenchmarkManifest.model_validate(data))


def test_record_ids_are_namespaced_by_corpus(tmp_path):
    data = fixture_manifest(tmp_path, [{}, {}]).model_dump()
    first, second = data["samples"]
    second["split"] = "dev"
    second["source"]["record_id"] = first["source"]["record_id"]
    second["source"]["corpus"] = "different-fixture-corpus"
    assert validate_manifest(BenchmarkManifest.model_validate(data))["sample_count"] == 2


@pytest.mark.parametrize("defect", ["unknown", "wrong_role", "other_split"])
def test_reference_pair_requires_known_reference_role_in_same_split(tmp_path, defect):
    data = fixture_manifest(tmp_path, [{}, {}]).model_dump()
    reference, learner = data["samples"]
    reference["role"] = "reference"
    learner["reference_sample_id"] = reference["sample_id"]
    if defect == "unknown":
        learner["reference_sample_id"] = "missing-reference"
    elif defect == "wrong_role":
        reference["role"] = "learner"
    else:
        reference["split"] = "dev"
    with pytest.raises(ValueError, match="reference"):
        validate_manifest(BenchmarkManifest.model_validate(data))


def test_learner_actual_transcript_mismatch_does_not_remove_difficult_pair(tmp_path):
    data = fixture_manifest(tmp_path, [{}, {}]).model_dump()
    reference, learner = data["samples"]
    reference["role"] = "reference"
    learner["reference_sample_id"] = reference["sample_id"]
    actual_text = "A fixture."
    learner["transcript"].update(text=actual_text, sha256=digest(actual_text.encode()))
    report = validate_manifest(BenchmarkManifest.model_validate(data), tmp_path)
    assert report["audio_files_checked"] == 2


def test_result_file_pins_dataset_identity_and_revision(tmp_path):
    manifest = fixture_manifest(tmp_path)
    original = fixture_run(manifest, {}).model_dump()
    for field in ("dataset_id", "dataset_version"):
        wrong = deepcopy(original)
        wrong[field] = "another-dataset-or-revision"
        with pytest.raises(ValueError, match="dataset identity"):
            validate_results(manifest, ResultFile.model_validate(wrong))


@pytest.mark.parametrize("field", ["audio", "transcript", "role", "sample", "target", "phenomenon"])
def test_result_cannot_attach_evidence_to_other_sample_or_target(tmp_path, field):
    manifest = fixture_manifest(tmp_path)
    wrong = fixture_run(manifest, {0: observation("measured")}).model_dump()
    result = wrong["results"][0]
    if field in {"audio", "transcript"}:
        result[f"{field}_sha256"] = "f" * 64
    elif field == "role":
        result["role"] = "reference"
    elif field == "sample":
        result["sample_id"] = "unknown-sample"
    elif field == "target":
        result["observations"][0]["target_id"] = "unknown-target"
    else:
        result["observations"][0]["phenomenon"] = "f0"
    with pytest.raises(ValueError, match="identity mismatch|unknown|phenomenon mismatch"):
        validate_results(manifest, ResultFile.model_validate(wrong))


def test_missing_and_unevaluated_predictions_stay_in_full_coverage_denominator(tmp_path):
    manifest = fixture_manifest(tmp_path, [
        reviewed("present"), reviewed("present"), reviewed("absent"),
        reviewed("absent"), reviewed("present"), reviewed("absent"),
    ])
    run = fixture_run(manifest, {
        0: observation("detected"), 2: observation("not_detected"),
        3: observation("detected"), 4: observation("not_detected"),
        5: observation("not_evaluated"),
    })
    report = evaluate(manifest, run)["phenomena"]["pause"]
    binary = report["binary"]
    assert report["target_count"] == 6
    assert report["status_counts"] == {"detected": 2, "not_detected": 2, "missing": 1, "not_evaluated": 1}
    assert {key: binary[key] for key in ("tp", "fp", "tn", "fn")} == {"tp": 1, "fp": 1, "tn": 1, "fn": 1}
    assert (binary["eligible"], binary["decided"], binary["abstained_or_missing"]) == (6, 4, 2)
    assert binary["coverage"] == pytest.approx(2 / 3, abs=1e-6)
    assert binary["recall_on_decided"] == 0.5
    assert binary["recall_all_eligible_positives"] == pytest.approx(1 / 3, abs=1e-6)
    assert binary["positive_abstentions_or_missing"] == 1
    assert binary["precision_on_decided"] == binary["f1_on_decided"] == 0.5


def test_continuous_metrics_use_signed_error_and_count_unmeasured_truth(tmp_path):
    manifest = fixture_manifest(tmp_path, [reviewed(None, values=[duration(value)]) for value in (100.0, 300.0, 200.0)])
    report = evaluate(manifest, fixture_run(manifest, {
        0: observation("measured", 130.0), 1: observation("measured", 280.0),
        2: observation("uncertain"),
    }))["phenomena"]["pause"]
    # Errors +30, -20, omitted: MAE=25; bias=+5; coverage=2/3.
    metric = report["measurements"]["pause_duration_ms:ms"]
    assert metric["eligible"] == 3 and metric["measured"] == 2
    assert metric["mae"] == 25.0 and metric["bias"] == 5.0
    assert metric["coverage"] == pytest.approx(2 / 3, abs=1e-6)
    assert report["binary"]["eligible"] == 0
    assert report["binary"]["precision_on_decided"] is None


def test_unreviewed_and_ambiguous_annotations_never_become_negative_gold(tmp_path):
    manifest = fixture_manifest(tmp_path, [
        {},
        {"status": "single_review", "label": "absent", "annotator_ids": ["simulated-one"]},
        reviewed("uncertain"),
        reviewed("not_applicable"),
    ])
    report = evaluate(manifest, fixture_run(manifest, {
        index: observation("not_detected") for index in range(4)
    }))
    assert report["status"] == "no_eligible_annotations"
    assert report["phenomena"]["pause"]["target_count"] == 4
    binary = report["phenomena"]["pause"]["binary"]
    assert binary["eligible"] == binary["tn"] == 0
    assert binary["coverage"] is None


def test_synthetic_fixture_requires_explicit_opt_in_and_marks_metric_mode(tmp_path):
    manifest = fixture_manifest(tmp_path, [{"status": "synthetic", "label": "present"}], kind="synthetic_smoke")
    run = fixture_run(manifest, {0: observation("detected")})
    with pytest.raises(ValueError, match="allow-synthetic"):
        evaluate(manifest, run)
    report = evaluate(manifest, run, allow_synthetic=True)
    assert report["mode"] == "synthetic_smoke"
    assert report["release_ready"] is False
    assert report["phenomena"]["pause"]["binary"]["tp"] == 1


def test_cli_default_test_split_does_not_silently_evaluate_dev(tmp_path):
    manifest = fixture_manifest(tmp_path / "audio", [reviewed()], split="dev")
    run = fixture_run(manifest, {0: observation("detected")})
    completed = cli("evaluate", save_model(tmp_path / "manifest.json", manifest),
                    "--results", save_model(tmp_path / "run.json", run), "--audio-root", tmp_path / "audio")
    assert completed.returncode == 0, completed.stderr
    report = json.loads(completed.stdout)
    assert report["split"] == "test"
    assert report["status"] == "no_eligible_annotations"
    assert report["phenomena"]["pause"]["target_count"] == 0
    assert report["audio_files_checked"] == 1
    assert evaluate(manifest, run, split="dev")["phenomena"]["pause"]["binary"]["tp"] == 1


def test_cli_new_run_is_explicitly_unevaluated_and_refuses_overwrite(tmp_path):
    manifest = fixture_manifest(tmp_path / "audio", [{}, {}])
    manifest_path = save_model(tmp_path / "manifest.json", manifest)
    output = tmp_path / "new-run.json"
    args = ("new-run", manifest_path, "--run-id", "new-offline-run", "--output", output)
    completed = cli(*args)
    assert completed.returncode == 0, completed.stderr
    original = output.read_bytes()
    run = ResultFile.model_validate_json(original)
    validate_results(manifest, run)
    assert len(run.results) == 2
    for result in run.results:
        assert result.quality.status == result.content.status == result.alignment.status == "not_checked"
        for item in result.observations:
            assert item.status == "not_evaluated" and item.confidence is None
            assert item.measurements == [] and item.reasons
    repeated = cli(*args)
    assert repeated.returncode == 2
    assert output.read_bytes() == original


def test_cli_exports_closed_json_contracts_without_replacing_previous_files(tmp_path):
    output = tmp_path / "contracts"
    completed = cli("schemas", "--output-dir", output)
    assert completed.returncode == 0, completed.stderr
    manifest_schema = json.loads((output / "manifest.schema.json").read_text())
    result_schema = json.loads((output / "results.schema.json").read_text())
    assert manifest_schema["additionalProperties"] is False
    assert {"dataset_id", "dataset_version", "samples"} <= set(manifest_schema["required"])
    assert "null" in {item.get("type") for item in result_schema["$defs"]["Observation"]["properties"]["confidence"]["anyOf"]}
    original = {path.name: path.read_bytes() for path in output.iterdir()}
    assert cli("schemas", "--output-dir", output).returncode == 2
    assert {path.name: path.read_bytes() for path in output.iterdir()} == original


def test_brier_uses_probability_of_presence_and_excludes_null_confidence(tmp_path):
    manifest = fixture_manifest(tmp_path, [reviewed("present"), reviewed("absent"), reviewed("present")])
    run = fixture_run(manifest, {
        0: observation("detected", confidence=0.8),
        1: observation("not_detected", confidence=0.6),
        2: observation("detected"),
    })
    binary = evaluate(manifest, run)["phenomena"]["pause"]["binary"]
    assert binary["confidence_sample_count"] == 2
    assert binary["brier_on_confident_decisions"] == pytest.approx(0.1)
