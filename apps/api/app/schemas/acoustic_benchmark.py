"""Offline acoustic evidence contracts, independent of the live practice API.

Times are relative to each clip. Word indices address exact transcript.text.split()
tokens; neither token positions nor rule candidates constitute acoustic evidence.
"""

import hashlib
from typing import Annotated, Literal, Self, get_args
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


Identifier = Annotated[str, Field(min_length=1, max_length=240, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")]
Text = Annotated[str, Field(min_length=1, max_length=12000, pattern=r"\S")]
Sha256 = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
NonNegative = Annotated[float, Field(ge=0, allow_inf_nan=False)]
Phenomenon = Literal[
    "vowel_length", "linking_gap", "pause", "f0", "flap_t", "weak_form",
    "h_drop", "final_voicing", "elision", "assimilation", "glottal_stop", "drop_d",
]
PHENOMENA = get_args(Phenomenon)
MeasurementName = Literal[
    "duration_ms", "pause_duration_ms", "boundary_gap_ms", "closure_duration_ms",
    "f0_hz", "f0_semitones", "voicing_ratio", "f1_hz", "f2_hz", "intensity_db",
]
MeasurementUnit = Literal["ms", "Hz", "semitones", "ratio", "dB"]
MEASUREMENT_UNITS: dict[str, str] = {
    "duration_ms": "ms", "pause_duration_ms": "ms", "boundary_gap_ms": "ms",
    "closure_duration_ms": "ms", "f0_hz": "Hz", "f0_semitones": "semitones",
    "voicing_ratio": "ratio", "f1_hz": "Hz", "f2_hz": "Hz", "intensity_db": "dB",
}


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)


class Interval(Contract):
    start_seconds: NonNegative
    end_seconds: NonNegative

    @model_validator(mode="after")
    def ordered(self) -> Self:
        if self.end_seconds <= self.start_seconds:
            raise ValueError("interval end_seconds must exceed start_seconds")
        return self


class Measurement(Contract):
    name: MeasurementName
    value: float
    unit: MeasurementUnit
    interval: Interval | None = None

    @model_validator(mode="after")
    def valid_quantity(self) -> Self:
        if self.unit != MEASUREMENT_UNITS[self.name]:
            raise ValueError("measurement unit does not match name")
        if self.unit in {"ms", "Hz", "ratio"} and self.value < 0:
            raise ValueError("duration, frequency and ratio must be nonnegative")
        if self.unit == "Hz" and self.value == 0:
            raise ValueError("frequency must be positive; omit unmeasurable pitch")
        if self.unit == "ratio" and self.value > 1:
            raise ValueError("voicing_ratio must be between zero and one")
        return self


class AudioAsset(Contract):
    path: Text
    sha256: Sha256
    sample_rate_hz: int = Field(gt=0, le=384000, strict=True)
    channels: int = Field(gt=0, le=32, strict=True)
    frame_count: int = Field(gt=0, strict=True)

    @field_validator("path")
    @classmethod
    def relative_path(cls, value: str) -> str:
        if (
            value.startswith("/") or "\\" in value or ":" in value
            or any(part in {"", ".", ".."} for part in value.split("/"))
            or any(ord(character) < 32 for character in value)
        ):
            raise ValueError("audio path must be a safe relative POSIX path")
        return value

    @property
    def duration_seconds(self) -> float:
        return self.frame_count / self.sample_rate_hz


class Transcript(Contract):
    text: Text
    sha256: Sha256
    provenance: Literal["provided", "human_verified", "asr"]
    language: Literal["en"] = "en"

    @model_validator(mode="after")
    def text_identity(self) -> Self:
        if hashlib.sha256(self.text.encode("utf-8")).hexdigest() != self.sha256:
            raise ValueError("transcript sha256 must match exact UTF-8 text")
        return self


class Source(Contract):
    corpus: Text
    record_id: Identifier
    url: Text
    license: Text
    license_url: Text
    attribution: Text
    usage: Literal["benchmark_only"] = "benchmark_only"
    training_allowed: bool = False

    @field_validator("url", "license_url")
    @classmethod
    def public_source_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username or parsed.password or any(c.isspace() for c in value)
        ):
            raise ValueError("source and license URLs must be public http(s) locators")
        return value


class RuleCandidate(Contract):
    rule_version: Identifier
    description: Text


class Annotation(Contract):
    status: Literal["pending", "single_review", "adjudicated", "synthetic"] = "pending"
    label: Literal["present", "absent", "uncertain", "not_applicable"] | None = None
    measurements: list[Measurement] = Field(default_factory=list)
    annotator_ids: list[Identifier] = Field(default_factory=list)
    notes: str = Field(default="", max_length=12000)

    @model_validator(mode="after")
    def review_evidence(self) -> Self:
        if len(set(self.annotator_ids)) != len(self.annotator_ids):
            raise ValueError("annotator_ids must identify distinct reviewers")
        if len({m.name for m in self.measurements}) != len(self.measurements):
            raise ValueError("measurement names must be unique within each annotation")
        if self.status == "pending":
            if self.label is not None or self.measurements or self.annotator_ids:
                raise ValueError("pending annotation cannot contain reviewed evidence")
        else:
            if self.label is None and not self.measurements:
                raise ValueError("reviewed or synthetic annotation needs a label or measurement")
            required = {"single_review": 1, "adjudicated": 2, "synthetic": 0}[self.status]
            if len(self.annotator_ids) < required:
                raise ValueError(f"{self.status} needs at least {required} annotators")
            if self.status == "synthetic" and self.annotator_ids:
                raise ValueError("synthetic annotations cannot impersonate human review")
        return self


class Target(Contract):
    target_id: Identifier
    phenomenon: Phenomenon
    word_start: int | None = Field(default=None, ge=0, strict=True)
    word_end: int | None = Field(default=None, gt=0, strict=True)
    interval: Interval | None = None
    rule_candidate: RuleCandidate | None = None
    annotation: Annotation = Field(default_factory=Annotation)

    @model_validator(mode="after")
    def token_span(self) -> Self:
        if (self.word_start is None) != (self.word_end is None):
            raise ValueError("word_start and word_end must both be supplied or omitted")
        if self.word_start is not None and self.word_end <= self.word_start:
            raise ValueError("word_end must exceed word_start (half-open indices)")
        if (
            self.annotation.status != "pending"
            and self.annotation.label not in {"uncertain", "not_applicable"}
            and self.word_start is None and self.interval is None
            and not any(m.interval for m in self.annotation.measurements)
        ):
            raise ValueError("reviewed evidence requires a word span or clip-relative interval")
        return self


class BenchmarkSample(Contract):
    sample_id: Identifier
    speaker_id: Identifier
    source_group_id: Identifier
    split: Literal["train", "dev", "test"]
    role: Literal["reference", "learner"]
    reference_sample_id: Identifier | None = None
    audio: AudioAsset
    transcript: Transcript
    source: Source
    conditions: list[Identifier] = Field(default_factory=list)
    target_accent: Text | None = None
    targets: list[Target] = Field(default_factory=list)

    @model_validator(mode="after")
    def target_bounds(self) -> Self:
        if len(set(self.conditions)) != len(self.conditions):
            raise ValueError("conditions must be unique to avoid duplicated evaluation slices")
        if self.reference_sample_id == self.sample_id:
            raise ValueError("sample cannot reference itself")
        if self.role == "reference" and self.reference_sample_id is not None:
            raise ValueError("only learner samples may link a reference sample")
        if len({target.target_id for target in self.targets}) != len(self.targets):
            raise ValueError("target_id must be unique within each sample")
        token_count = len(self.transcript.text.split())
        for target in self.targets:
            if target.word_end is not None and target.word_end > token_count:
                raise ValueError("target word span exceeds transcript tokens")
            intervals = [target.interval, *(m.interval for m in target.annotation.measurements)]
            if any(i is not None and i.end_seconds > self.audio.duration_seconds for i in intervals):
                raise ValueError("target or annotation interval exceeds clip duration")
        return self


class BenchmarkManifest(Contract):
    schema_version: Literal["acoustic-benchmark.v1"] = "acoustic-benchmark.v1"
    dataset_id: Identifier
    dataset_version: Identifier
    dataset_kind: Literal["human_speech", "synthetic_smoke"] = "human_speech"
    samples: list[BenchmarkSample]

    @model_validator(mode="after")
    def sample_identity(self) -> Self:
        if len({sample.sample_id for sample in self.samples}) != len(self.samples):
            raise ValueError("sample_id must be unique")
        for sample in self.samples:
            for target in sample.targets:
                status = target.annotation.status
                if status == "synthetic" and self.dataset_kind != "synthetic_smoke":
                    raise ValueError("synthetic annotations require a synthetic_smoke dataset")
                if self.dataset_kind == "synthetic_smoke" and status not in {"pending", "synthetic"}:
                    raise ValueError("synthetic_smoke datasets cannot contain human gold labels")
        return self


class Gate(Contract):
    status: Literal["passed", "failed", "not_checked"] = "not_checked"
    reasons: list[Text] = Field(default_factory=lambda: ["not_run"])

    @model_validator(mode="after")
    def explain_missing_gate(self) -> Self:
        if self.status != "passed" and not self.reasons:
            raise ValueError("failed or unchecked gates require reasons")
        return self


class Observation(Contract):
    """Confidence is the calibrated probability this detector decision is true.

    For not_detected, P(present) = 1 - confidence. The v1 contract stores one
    scalar per measurement name and target, not unaligned frame sequences.
    """

    target_id: Identifier
    phenomenon: Phenomenon
    status: Literal[
        "measured", "detected", "not_detected", "uncertain", "not_evaluated",
        "not_supported", "rejected",
    ]
    measurements: list[Measurement] = Field(default_factory=list)
    confidence: float | None = Field(default=None, ge=0, le=1)
    reasons: list[Text] = Field(default_factory=list)

    @model_validator(mode="after")
    def observation_evidence(self) -> Self:
        if len({m.name for m in self.measurements}) != len(self.measurements):
            raise ValueError("measurement names must be unique within each observation")
        if self.confidence is not None and self.status not in {"detected", "not_detected"}:
            raise ValueError("only detector decisions may contain calibrated confidence")
        if self.status in {"measured", "detected", "not_detected"} and not self.measurements:
            raise ValueError("measurements or detector decisions require acoustic measurements")
        if self.status in {"not_evaluated", "not_supported", "rejected"} and self.measurements:
            raise ValueError("unevaluated observations cannot contain acoustic measurements")
        if self.status in {"uncertain", "not_evaluated", "not_supported", "rejected"} and not self.reasons:
            raise ValueError("non-conclusive observations require reasons")
        return self


class SampleResult(Contract):
    sample_id: Identifier
    audio_sha256: Sha256
    transcript_sha256: Sha256
    role: Literal["reference", "learner"]
    quality: Gate = Field(default_factory=Gate)
    content: Gate = Field(default_factory=Gate)
    alignment: Gate = Field(default_factory=Gate)
    observations: list[Observation] = Field(default_factory=list)

    @model_validator(mode="after")
    def independent_evidence_gates(self) -> Self:
        if len({o.target_id for o in self.observations}) != len(self.observations):
            raise ValueError("observation target_id must be unique within each sample")
        for observation in self.observations:
            if observation.status not in {"measured", "detected", "not_detected"}:
                continue
            if self.quality.status != "passed":
                raise ValueError("acoustic conclusions require a passed quality gate")
            unaligned_names = {
                "pause": {"pause_duration_ms", "duration_ms"},
                "f0": {"f0_hz", "f0_semitones"},
            }.get(observation.phenomenon, set())
            unaligned_measurement = (
                observation.status == "measured" and bool(unaligned_names)
                and all(m.name in unaligned_names for m in observation.measurements)
            )
            if not unaligned_measurement and (self.content.status != "passed" or self.alignment.status != "passed"):
                raise ValueError("localized conclusions require passed content and alignment gates")
        return self


class ResultFile(Contract):
    schema_version: Literal["acoustic-results.v1"] = "acoustic-results.v1"
    dataset_id: Identifier
    dataset_version: Identifier
    run_id: Identifier
    versions: dict[Identifier, Identifier]
    calibration_id: Identifier | None = None
    results: list[SampleResult]

    @model_validator(mode="after")
    def versioned_decisions(self) -> Self:
        if "pipeline" not in self.versions:
            raise ValueError("versions must include pipeline")
        if len({result.sample_id for result in self.results}) != len(self.results):
            raise ValueError("result sample_id must be unique")
        if self.calibration_id is None and any(
            observation.confidence is not None
            for result in self.results for observation in result.observations
        ):
            raise ValueError("confidence requires a recorded calibration_id")
        return self
