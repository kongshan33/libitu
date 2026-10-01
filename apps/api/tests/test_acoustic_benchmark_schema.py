"""Protect evidence boundaries before any detector can emit product feedback."""

from copy import deepcopy
import hashlib

import pytest
from pydantic import ValidationError

from app.schemas.acoustic_benchmark import (
    Annotation,
    BenchmarkManifest,
    Gate,
    Measurement,
    Observation,
    ResultFile,
    SampleResult,
)


def sample_data() -> dict:
    text = "Read it again."
    return {
        "sample_id": "sample-001",
        "speaker_id": "speaker-001",
        "source_group_id": "chapter-001",
        "split": "dev",
        "role": "reference",
        "audio": {
            "path": "audio/sample-001.wav", "sha256": "a" * 64,
            "sample_rate_hz": 16000, "channels": 1, "frame_count": 32000,
        },
        "transcript": {
            "text": text, "sha256": hashlib.sha256(text.encode()).hexdigest(),
            "provenance": "provided",
        },
        "source": {
            "corpus": "test-corpus", "record_id": "record-001",
            "url": "https://example.org/corpus/record-001", "license": "CC0-1.0",
            "license_url": "https://creativecommons.org/publicdomain/zero/1.0/",
            "attribution": "Schema fixture; no human speech supplied.",
        },
        "targets": [{
            "target_id": "target-001", "phenomenon": "linking_gap",
            "word_start": 0, "word_end": 2,
            "rule_candidate": {"rule_version": "candidate-v1", "description": "May link."},
        }],
    }


def manifest_data() -> dict:
    return {"dataset_id": "seed", "dataset_version": "v1", "samples": [sample_data()]}


def measurement_data() -> dict:
    return {"name": "boundary_gap_ms", "value": 80.0, "unit": "ms"}


def observation_data() -> dict:
    return {
        "target_id": "target-001", "phenomenon": "linking_gap", "status": "measured",
        "measurements": [measurement_data()],
    }


def result_data() -> dict:
    sample = sample_data()
    return {
        "sample_id": sample["sample_id"], "audio_sha256": sample["audio"]["sha256"],
        "transcript_sha256": sample["transcript"]["sha256"], "role": "reference",
        "quality": {"status": "passed", "reasons": []},
        "content": {"status": "passed", "reasons": []},
        "alignment": {"status": "passed", "reasons": []},
        "observations": [observation_data()],
    }


def result_file_data() -> dict:
    return {
        "dataset_id": "seed", "dataset_version": "v1", "run_id": "run-001",
        "versions": {"pipeline": "offline-v1"}, "results": [result_data()],
    }


def test_pending_manifest_round_trip_keeps_rule_candidates_separate():
    manifest = BenchmarkManifest.model_validate(manifest_data())
    sample = manifest.samples[0]
    assert sample.audio.duration_seconds == 2
    assert sample.targets[0].annotation.status == "pending"
    assert sample.targets[0].annotation.label is None
    assert sample.source.training_allowed is False
    assert "duration_seconds" not in sample.audio.model_dump()
    assert BenchmarkManifest.model_validate_json(manifest.model_dump_json()) == manifest
    assert BenchmarkManifest(dataset_id="empty", dataset_version="v1", samples=[]).samples == []


def test_reviewed_label_cannot_skip_human_target_localization():
    data = manifest_data()
    target = data["samples"][0]["targets"][0]
    target.pop("word_start")
    target.pop("word_end")
    target["annotation"] = {
        "status": "adjudicated", "label": "present", "annotator_ids": ["reviewer-a", "reviewer-b"],
    }
    with pytest.raises(ValidationError, match="requires a word span"):
        BenchmarkManifest.model_validate(data)
    target["interval"] = {"start_seconds": 0.4, "end_seconds": 0.7}
    assert BenchmarkManifest.model_validate(data).samples[0].targets[0].annotation.label == "present"


@pytest.mark.parametrize("mutation", [
    lambda sample: sample["audio"].update(path="../outside.wav"),
    lambda sample: sample["audio"].update(path="audio/../../outside.wav"),
    lambda sample: sample["audio"].update(path="/absolute.wav"),
    lambda sample: sample["audio"].update(path="C:/absolute.wav"),
    lambda sample: sample["audio"].update(path="audio\\clip.wav"),
    lambda sample: sample["audio"].update(path="audio/./clip.wav"),
    lambda sample: sample["audio"].update(sha256="not-a-hash"),
    lambda sample: sample["audio"].update(frame_count=0),
    lambda sample: sample["audio"].update(sample_rate_hz=True),
    lambda sample: sample["transcript"].update(sha256="b" * 64),
    lambda sample: sample["transcript"].update(text="Changed words"),
    lambda sample: sample.update(speaker_id=""),
    lambda sample: sample.update(source_group_id=" "),
    lambda sample: sample["source"].update(license=""),
    lambda sample: sample["source"].update(url="file:///private/audio.wav"),
    lambda sample: sample["source"].update(url="https://name:secret@example.org/audio"),
    lambda sample: sample["targets"][0].update(word_end=4),
    lambda sample: sample["targets"][0].update(word_start=2, word_end=2),
    lambda sample: sample["targets"][0].update(word_end=None),
    lambda sample: sample["targets"][0].update(interval={"start_seconds": 1, "end_seconds": 2.001}),
    lambda sample: sample["targets"][0].update(interval={"start_seconds": -1, "end_seconds": 1}),
    lambda sample: sample["targets"][0].update(interval={"start_seconds": 1, "end_seconds": float("inf")}),
    lambda sample: sample.update(reference_sample_id="sample-001"),
    lambda sample: sample.update(score=95),
])
def test_manifest_rejects_unreproducible_or_unsafe_input(mutation):
    data = manifest_data()
    mutation(data["samples"][0])
    with pytest.raises(ValidationError):
        BenchmarkManifest.model_validate(data)


def test_annotation_windows_must_fit_audio():
    data = manifest_data()
    data["samples"][0]["targets"][0]["annotation"] = {
        "status": "single_review", "annotator_ids": ["reviewer-1"],
        "measurements": [{**measurement_data(), "interval": {"start_seconds": 0, "end_seconds": 3}}],
    }
    with pytest.raises(ValidationError, match="clip duration"):
        BenchmarkManifest.model_validate(data)


@pytest.mark.parametrize("annotation", [
    {"label": "present"},
    {"measurements": [measurement_data()]},
    {"annotator_ids": ["reviewer-1"]},
    {"status": "single_review", "label": "present"},
    {"status": "single_review", "annotator_ids": ["reviewer-1"]},
    {"status": "adjudicated", "label": "present", "annotator_ids": ["reviewer-1"]},
    {"status": "adjudicated", "label": "present", "annotator_ids": ["reviewer-1", "reviewer-1"]},
    {"status": "synthetic", "label": "present", "annotator_ids": ["reviewer-1"]},
    {"status": "single_review", "annotator_ids": ["reviewer-1"], "measurements": [measurement_data()] * 2},
])
def test_unreviewed_or_duplicate_labels_cannot_become_gold(annotation):
    with pytest.raises(ValidationError):
        Annotation.model_validate(annotation)


def test_numeric_gold_does_not_require_a_presence_label():
    annotation = Annotation(
        status="adjudicated", annotator_ids=["reviewer-1", "reviewer-2"],
        measurements=[Measurement(**measurement_data())],
    )
    assert annotation.label is None


def test_synthetic_gold_cannot_be_mixed_with_human_evaluation():
    data = manifest_data()
    target = data["samples"][0]["targets"][0]
    target["annotation"] = {"status": "synthetic", "measurements": [measurement_data()]}
    with pytest.raises(ValidationError, match="synthetic_smoke"):
        BenchmarkManifest.model_validate(data)
    data["dataset_kind"] = "synthetic_smoke"
    BenchmarkManifest.model_validate(data)
    target["annotation"] = {
        "status": "adjudicated", "label": "present", "annotator_ids": ["reviewer-1", "reviewer-2"],
    }
    with pytest.raises(ValidationError, match="human gold"):
        BenchmarkManifest.model_validate(data)


@pytest.mark.parametrize("measurement", [
    {"name": "boundary_gap_ms", "value": 1, "unit": "Hz"},
    {"name": "duration_ms", "value": -1, "unit": "ms"},
    {"name": "f0_hz", "value": 0, "unit": "Hz"},
    {"name": "voicing_ratio", "value": 1.2, "unit": "ratio"},
    {"name": "f0_semitones", "value": float("nan"), "unit": "semitones"},
    {"name": "intensity_db", "value": float("inf"), "unit": "dB"},
])
def test_measurements_require_finite_quantities_with_matching_units(measurement):
    with pytest.raises(ValidationError):
        Measurement.model_validate(measurement)


@pytest.mark.parametrize("status", ["measured", "uncertain", "not_evaluated", "not_supported", "rejected"])
def test_confidence_is_not_a_replacement_for_evidence(status):
    data = observation_data()
    data.update(status=status, confidence=0.8, reasons=["test"])
    with pytest.raises(ValidationError, match="calibrated confidence"):
        Observation.model_validate(data)


def test_confidence_requires_calibration_and_results_have_no_pronunciation_score():
    data = result_file_data()
    data["results"][0]["observations"][0].update(status="not_detected", confidence=0.8)
    with pytest.raises(ValidationError, match="calibration_id"):
        ResultFile.model_validate(data)
    data["calibration_id"] = "held-out-calibration-v1"
    result = ResultFile.model_validate(data)
    assert result.results[0].observations[0].confidence == 0.8
    data["results"][0]["score"] = 95
    with pytest.raises(ValidationError, match="Extra inputs"):
        ResultFile.model_validate(data)


@pytest.mark.parametrize("gate", ["quality", "content", "alignment"])
def test_localized_decisions_require_independently_passed_gates(gate):
    data = result_data()
    data[gate] = {"status": "failed", "reasons": ["insufficient_evidence"]}
    with pytest.raises(ValidationError, match="require"):
        SampleResult.model_validate(data)


@pytest.mark.parametrize("phenomenon,name,unit", [("pause", "pause_duration_ms", "ms"), ("f0", "f0_hz", "Hz")])
def test_unaligned_pause_and_pitch_measurements_are_allowed_but_not_detection(phenomenon, name, unit):
    data = result_data()
    data.pop("content")
    data.pop("alignment")
    observation = data["observations"][0]
    observation.update(phenomenon=phenomenon, measurements=[{"name": name, "value": 100, "unit": unit}])
    assert SampleResult.model_validate(data).alignment.status == "not_checked"
    observation["status"] = "detected"
    with pytest.raises(ValidationError, match="content and alignment"):
        SampleResult.model_validate(data)


@pytest.mark.parametrize("status", ["not_evaluated", "not_supported", "rejected", "uncertain"])
def test_abstention_needs_an_explanation(status):
    with pytest.raises(ValidationError, match="require reasons"):
        Observation(target_id="target-001", phenomenon="flap_t", status=status)


def test_unevaluated_results_cannot_smuggle_measurements():
    data = observation_data()
    data.update(status="not_evaluated", reasons=["not_run"])
    with pytest.raises(ValidationError, match="unevaluated"):
        Observation.model_validate(data)
    data.update(status="measured", measurements=[])
    with pytest.raises(ValidationError, match="require acoustic"):
        Observation.model_validate(data)


def test_duplicate_ids_and_measurements_are_rejected():
    data = manifest_data()
    data["samples"].append(deepcopy(data["samples"][0]))
    with pytest.raises(ValidationError, match="sample_id must be unique"):
        BenchmarkManifest.model_validate(data)
    data = manifest_data()
    data["samples"][0]["targets"] *= 2
    with pytest.raises(ValidationError, match="target_id must be unique"):
        BenchmarkManifest.model_validate(data)
    data = result_file_data()
    data["results"] *= 2
    with pytest.raises(ValidationError, match="sample_id must be unique"):
        ResultFile.model_validate(data)
    result = result_data()
    result["observations"] *= 2
    with pytest.raises(ValidationError, match="target_id must be unique"):
        SampleResult.model_validate(result)
    observation = observation_data()
    observation["measurements"] *= 2
    with pytest.raises(ValidationError, match="measurement names"):
        Observation.model_validate(observation)


def test_missing_pipeline_and_unexplained_gate_are_rejected():
    data = result_file_data()
    data["versions"] = {"aligner": "v1"}
    with pytest.raises(ValidationError, match="pipeline"):
        ResultFile.model_validate(data)
    with pytest.raises(ValidationError, match="require reasons"):
        Gate(status="not_checked", reasons=[])


@pytest.mark.parametrize("value", [True, False, "80", "0.8"])
def test_measurement_values_never_coerce_boolean_or_text(value):
    with pytest.raises(ValidationError):
        Measurement(name="boundary_gap_ms", value=value, unit="ms")


@pytest.mark.parametrize("value", [True, False, "0.8", "1"])
def test_confidence_never_coerces_boolean_or_text(value):
    data = observation_data()
    data.update(status="detected", confidence=value)
    with pytest.raises(ValidationError):
        Observation.model_validate(data)


@pytest.mark.parametrize("value", [1, 0, "true", "false"])
def test_training_permission_requires_a_real_boolean(value):
    data = manifest_data()
    data["samples"][0]["source"]["training_allowed"] = value
    with pytest.raises(ValidationError):
        BenchmarkManifest.model_validate(data)


def test_strict_json_accepts_integral_measurement_and_real_permission_boolean():
    data = manifest_data()
    data["samples"][0]["source"]["training_allowed"] = False
    manifest = BenchmarkManifest.model_validate(data)
    assert BenchmarkManifest.model_validate_json(manifest.model_dump_json()) == manifest
    measurement = Measurement.model_validate_json(
        '{"name":"boundary_gap_ms","value":80,"unit":"ms",'
        '"interval":{"start_seconds":0,"end_seconds":1}}'
    )
    assert measurement.value == 80.0
    data = result_file_data()
    data["calibration_id"] = "calibration-v1"
    data["results"][0]["observations"][0].update(status="detected", confidence=1)
    run = ResultFile.model_validate(data)
    assert ResultFile.model_validate_json(run.model_dump_json()) == run


def test_duplicate_conditions_cannot_inflate_evaluation_slices():
    data = manifest_data()
    data["samples"][0]["conditions"] = ["clean", "clean"]
    with pytest.raises(ValidationError, match="conditions must be unique"):
        BenchmarkManifest.model_validate(data)


@pytest.mark.parametrize("phenomenon", ["pause", "f0"])
def test_unrelated_quantities_cannot_bypass_alignment_using_pause_or_f0(phenomenon):
    data = result_data()
    data.pop("content")
    data.pop("alignment")
    data["observations"][0].update(
        phenomenon=phenomenon, measurements=[{"name": "f1_hz", "value": 500, "unit": "Hz"}],
    )
    with pytest.raises(ValidationError, match="content and alignment"):
        SampleResult.model_validate(data)


@pytest.mark.parametrize("interval", [
    {"start_seconds": 0, "end_seconds": float("nan")},
    {"start_seconds": float("-inf"), "end_seconds": 1},
    {"start_seconds": 1, "end_seconds": 1},
    {"start_seconds": True, "end_seconds": 1},
    {"start_seconds": "0", "end_seconds": 1},
])
def test_measurement_intervals_require_real_finite_ordered_seconds(interval):
    with pytest.raises(ValidationError):
        Measurement(**measurement_data(), interval=interval)
