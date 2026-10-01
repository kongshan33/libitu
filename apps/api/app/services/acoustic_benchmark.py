"""Offline benchmark integrity and target-level evaluation; no audio inference.

Missing predictions remain in coverage denominators. Only adjudicated human
annotations (or explicitly requested synthetic fixtures) are used as truth.
This module never derives a phenomenon label from a transcript or a rule.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from hashlib import sha256
from pathlib import Path
from statistics import mean
import wave

from app.schemas.acoustic_benchmark import BenchmarkManifest, ResultFile, PHENOMENA


MAX_WAV_BYTES = 64 * 1024 * 1024


def file_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 6) if denominator else None


def validate_manifest(
    manifest: BenchmarkManifest, audio_root: Path | None = None
) -> dict[str, object]:
    """Validate identity, partition isolation, pairs, and optionally actual WAVs."""
    samples = {sample.sample_id: sample for sample in manifest.samples}
    groups: dict[tuple[str, str], str] = {}
    checked = 0
    for sample in manifest.samples:
        for kind, identifier in (
            ("speaker", sample.speaker_id),
            ("source_group", sample.source_group_id),
            ("audio_sha256", sample.audio.sha256),
            ("source_record", f"{sample.source.corpus}\0{sample.source.record_id}"),
        ):
            key = (kind, identifier)
            previous = groups.setdefault(key, sample.split)
            if previous != sample.split:
                raise ValueError(f"split leakage: {kind} {identifier} spans {previous}/{sample.split}")
        if sample.reference_sample_id:
            reference = samples.get(sample.reference_sample_id)
            if reference is None or reference.role != "reference" or sample.role != "learner":
                raise ValueError(f"{sample.sample_id}: reference must identify a reference sample")
            if reference.split != sample.split:
                raise ValueError(f"{sample.sample_id}: paired reference crosses dataset splits")
            # Deliberate omissions, repetitions and wrong-content attempts still
            # belong to the same reference task. Each actual transcript has its
            # own hash; content gates decide whether comparison is meaningful.
        if audio_root is None:
            continue
        root = audio_root.resolve()
        path = (root / sample.audio.path).resolve()
        if not path.is_relative_to(root):
            raise ValueError(f"{sample.sample_id}: audio path escapes audio root")
        if not path.is_file():
            raise ValueError(f"{sample.sample_id}: audio file is missing")
        if path.stat().st_size > MAX_WAV_BYTES:
            raise ValueError(f"{sample.sample_id}: audio exceeds 64 MiB per-file limit")
        if file_sha256(path) != sample.audio.sha256:
            raise ValueError(f"{sample.sample_id}: audio SHA-256 mismatch")
        try:
            with wave.open(str(path), "rb") as audio:
                actual = (audio.getframerate(), audio.getnchannels(), audio.getnframes())
                expected = (sample.audio.sample_rate_hz, sample.audio.channels, sample.audio.frame_count)
                if actual != expected or audio.getcomptype() != "NONE":
                    raise ValueError(f"{sample.sample_id}: WAV metadata mismatch or unsupported encoding")
                frame_bytes = audio.getnchannels() * audio.getsampwidth()
                available = 0
                while chunk := audio.readframes(65536):
                    available += len(chunk)
                if available != sample.audio.frame_count * frame_bytes:
                    raise ValueError(f"{sample.sample_id}: truncated WAV payload")
        except (wave.Error, EOFError) as exc:
            raise ValueError(f"{sample.sample_id}: invalid PCM WAV") from exc
        checked += 1
    return inventory(manifest, checked)


def inventory(manifest: BenchmarkManifest, audio_files_checked: int = 0) -> dict[str, object]:
    annotations: Counter[str] = Counter()
    phenomena = {name: Counter() for name in PHENOMENA}
    for sample in manifest.samples:
        for target in sample.targets:
            annotations[target.annotation.status] += 1
            phenomena[target.phenomenon][target.annotation.status] += 1
    targets = sum(annotations.values())
    reviewed = annotations["adjudicated"]
    if manifest.dataset_kind == "synthetic_smoke":
        readiness = "synthetic_only"
    elif not manifest.samples:
        readiness = "empty"
    elif audio_files_checked != len(manifest.samples):
        readiness = "metadata_only"
    elif reviewed == 0 or reviewed != targets:
        readiness = "needs_annotation"
    else:
        readiness = "annotated_pilot"
    return {
        "schema_version": "acoustic-inventory.v1",
        "dataset_id": manifest.dataset_id,
        "dataset_version": manifest.dataset_version,
        "dataset_kind": manifest.dataset_kind,
        "sample_count": len(manifest.samples),
        "speaker_count": len({s.speaker_id for s in manifest.samples}),
        "source_group_count": len({s.source_group_id for s in manifest.samples}),
        "duration_seconds": round(sum(s.audio.duration_seconds for s in manifest.samples), 3),
        "audio_files_checked": audio_files_checked,
        "by_split": dict(sorted(Counter(s.split for s in manifest.samples).items())),
        "by_role": dict(sorted(Counter(s.role for s in manifest.samples).items())),
        "by_condition": dict(sorted(Counter(c for s in manifest.samples for c in s.conditions).items())),
        "annotation_counts": dict(sorted(annotations.items())),
        "phenomena": {name: dict(sorted(counts.items())) for name, counts in phenomena.items()},
        "readiness": readiness,
        "release_ready": False,
        "limitations": [
            "Inventory and schema validation do not establish acoustic accuracy.",
            "Public source transcripts/ratings are not Libitu phenomenon annotations.",
            "A separate speaker-disjoint, sufficiently sized evaluation is required for release.",
        ],
    }


def validate_results(manifest: BenchmarkManifest, run: ResultFile) -> None:
    """Bind output to the exact dataset, audio, transcript, role and targets."""
    if (manifest.dataset_id, manifest.dataset_version) != (run.dataset_id, run.dataset_version):
        raise ValueError("result dataset identity/version mismatch")
    samples = {sample.sample_id: sample for sample in manifest.samples}
    for result in run.results:
        sample = samples.get(result.sample_id)
        if sample is None:
            raise ValueError(f"unknown result sample: {result.sample_id}")
        if (result.audio_sha256, result.transcript_sha256, result.role) != (
            sample.audio.sha256, sample.transcript.sha256, sample.role
        ):
            raise ValueError(f"{result.sample_id}: result audio/transcript/role identity mismatch")
        targets = {target.target_id: target for target in sample.targets}
        for observation in result.observations:
            target = targets.get(observation.target_id)
            if target is None or target.phenomenon != observation.phenomenon:
                raise ValueError(f"{result.sample_id}: unknown target or phenomenon mismatch")
            if (
                observation.status in {"measured", "detected", "not_detected"}
                and target.word_start is None and target.interval is None
                and not any(m.interval for m in observation.measurements)
            ):
                raise ValueError(f"{result.sample_id}: conclusion requires a localized target or measurement")
            for measurement in observation.measurements:
                if measurement.interval and measurement.interval.end_seconds > sample.audio.duration_seconds:
                    raise ValueError(f"{result.sample_id}: measurement interval exceeds audio")


def _summarize_targets(rows: list[tuple], truth_status: str) -> dict[str, object]:
    status_counts: Counter[str] = Counter()
    annotation_counts: Counter[str] = Counter()
    label_counts: Counter[str] = Counter()
    binary = Counter({"tp": 0, "fp": 0, "tn": 0, "fn": 0})
    labeled = decisive = positives = abstained_positive = 0
    brier_errors: list[float] = []
    measurements: dict[str, dict] = defaultdict(lambda: {"eligible": 0, "errors": [], "signed": []})
    eligible_annotations = 0
    for target, observation in rows:
        status = observation.status if observation else "missing"
        status_counts[status] += 1
        annotation = target.annotation
        annotation_counts[annotation.status] += 1
        label_counts[annotation.label or "unlabeled"] += 1
        if annotation.status != truth_status or annotation.label in ("uncertain", "not_applicable"):
            continue
        eligible_annotations += 1
        if annotation.label in ("present", "absent"):
            labeled += 1
            positive = annotation.label == "present"
            positives += int(positive)
            if status in ("detected", "not_detected"):
                decisive += 1
                detected = status == "detected"
                binary["tp" if positive and detected else "fn" if positive else "fp" if detected else "tn"] += 1
                if observation.confidence is not None:
                    probability = observation.confidence if detected else 1 - observation.confidence
                    brier_errors.append((probability - int(positive)) ** 2)
            elif positive:
                abstained_positive += 1
        predicted = {
            m.name: m for m in observation.measurements
        } if observation and status in ("measured", "detected", "not_detected") else {}
        for truth in annotation.measurements:
            key = f"{truth.name}:{truth.unit}"
            metric = measurements[key]
            metric["eligible"] += 1
            actual = predicted.get(truth.name)
            if actual is not None and actual.unit == truth.unit:
                error = actual.value - truth.value
                metric["errors"].append(abs(error))
                metric["signed"].append(error)
    tp, fp, fn = binary["tp"], binary["fp"], binary["fn"]
    return {
        "target_count": len(rows),
        "status_counts": dict(sorted(status_counts.items())),
        "annotation_status_counts": dict(sorted(annotation_counts.items())),
        "annotation_label_counts": dict(sorted(label_counts.items())),
        "eligible_annotations": eligible_annotations,
        "binary": {
            "eligible": labeled,
            "decided": decisive,
            "abstained_or_missing": labeled - decisive,
            "coverage": _ratio(decisive, labeled),
            **binary,
            "precision_on_decided": _ratio(tp, tp + fp),
            "recall_on_decided": _ratio(tp, tp + fn),
            # This end-to-end recall makes abstaining on all difficult positive
            # examples visible instead of making selective recall look perfect.
            "recall_all_eligible_positives": _ratio(tp, positives),
            "positive_abstentions_or_missing": abstained_positive,
            "f1_on_decided": _ratio(2 * tp, 2 * tp + fp + fn),
            "confidence_sample_count": len(brier_errors),
            "brier_on_confident_decisions": round(mean(brier_errors), 6) if brier_errors else None,
        },
        "measurements": {
            key: {
                "eligible": values["eligible"],
                "measured": len(values["errors"]),
                "coverage": _ratio(len(values["errors"]), values["eligible"]),
                "mae": round(mean(values["errors"]), 6) if values["errors"] else None,
                "bias": round(mean(values["signed"]), 6) if values["signed"] else None,
            }
            for key, values in sorted(measurements.items())
        },
    }


def evaluate(
    manifest: BenchmarkManifest,
    run: ResultFile,
    *,
    split: str = "test",
    allow_synthetic: bool = False,
) -> dict[str, object]:
    validate_manifest(manifest)
    validate_results(manifest, run)
    if split not in ("train", "dev", "test"):
        raise ValueError("split must be train, dev or test")
    synthetic = manifest.dataset_kind == "synthetic_smoke"
    if synthetic and not allow_synthetic:
        raise ValueError("synthetic fixtures require --allow-synthetic; they are not speech evaluation")
    truth_status = "synthetic" if synthetic else "adjudicated"
    predictions = {(r.sample_id, o.target_id): o for r in run.results for o in r.observations}
    rows: dict[str, list] = {name: [] for name in PHENOMENA}
    slices: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))
    for sample in manifest.samples:
        if sample.split != split:
            continue
        for target in sample.targets:
            row = (target, predictions.get((sample.sample_id, target.target_id)))
            rows[target.phenomenon].append(row)
            for group in [f"role:{sample.role}", f"speaker:{sample.speaker_id}", *[f"condition:{c}" for c in sample.conditions]]:
                slices[group][target.phenomenon].append(row)
    per_phenomenon = {name: _summarize_targets(items, truth_status) for name, items in rows.items()}
    eligible = sum(item["eligible_annotations"] for item in per_phenomenon.values())
    return {
        "schema_version": "acoustic-evaluation.v1",
        "dataset_id": manifest.dataset_id,
        "dataset_version": manifest.dataset_version,
        "run_id": run.run_id,
        "versions": run.versions,
        "calibration_id": run.calibration_id,
        "split": split,
        "mode": "synthetic_smoke" if synthetic else "heldout_pilot" if split == "test" else "exploratory",
        "status": "no_eligible_annotations" if eligible == 0 else "pilot_metrics_only",
        "release_ready": False,
        "phenomena": per_phenomenon,
        "slices": {
            group: {name: _summarize_targets(items, truth_status) for name, items in sorted(groups.items())}
            for group, groups in sorted(slices.items())
        },
        "limitations": [
            "Target-level evaluation only; event discovery, framewise F0/DTW and pronunciation scores are not implemented.",
            "Pending/single-review/uncertain/not-applicable labels never count as negative examples.",
            "Missing predictions count as missing coverage, not true negatives.",
            "Metrics lack release-size validation and confidence intervals; a calibration ID is provenance, not proof of calibration.",
        ],
    }
