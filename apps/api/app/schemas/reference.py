"""Versioned measurements, not pronunciation assessments."""
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator
from app.schemas.acoustic_base import StrictModel
from app.schemas.practice_analysis import VoiceProsody

MAX_REFERENCE_BYTES = 32 * 1024 * 1024
MAX_SEGMENT_MS = 600_000
PIPELINE_VERSION = "reference-measurements-v1"


class PrepareReference(StrictModel):
    content_id: UUID
    segment_id: str = Field(min_length=1, max_length=200)


class PrepareCapture(PrepareReference):
    sentence_id: str = Field(min_length=1, max_length=200)
    capture_id: str = Field(min_length=1, max_length=200)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    size: int = Field(gt=0, le=MAX_REFERENCE_BYTES)
    consent_version: Literal['reference-analysis-v1']


class SentenceSnapshot(StrictModel):
    id: str
    text: str = Field(min_length=1, max_length=12000)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)

    @model_validator(mode="after")
    def ordered(self):
        if self.end_ms <= self.start_ms:
            raise ValueError("Empty sentence interval")
        return self


class Interval(StrictModel):
    start_sec: float = Field(ge=0)
    end_sec: float = Field(gt=0)
    label: str | None = None

    @model_validator(mode="after")
    def ordered(self):
        if self.end_sec <= self.start_sec:
            raise ValueError("Empty acoustic interval")
        return self


class Alignment(StrictModel):
    status: Literal["aligned", "unavailable", "failed"]
    reason: str | None = None
    phone_set: str = "model_dictionary_labels"
    words: list[Interval] = Field(default_factory=list)
    phones: list[Interval] = Field(default_factory=list)
    # Forced alignment is not transcript verification.
    content_gate: Literal["not_checked"] = "not_checked"


class Frame(StrictModel):
    time_sec: float = Field(ge=0)
    f0_hz: float | None = Field(default=None, gt=0)
    energy_dbfs: float


class Measurements(StrictModel):
    duration_sec: float = Field(gt=0)
    rms_dbfs: float
    clipping_fraction: float = Field(ge=0, le=1)
    f0_valid_fraction: float = Field(ge=0, le=1)
    frames: list[Frame]
    speech: list[Interval]
    pauses: list[Interval]
    quality_issues: list[str]
    # All intervals and frame times are relative to the selected segment.
    time_basis: Literal["segment_seconds"] = "segment_seconds"


class SentenceResult(StrictModel):
    sentence_id: str
    status: Literal["completed", "partial", "failed"]
    alignment: Alignment
    measurements: Measurements | None = None
    error_code: str | None = None
    # No detector probabilities, actual IPA, stress labels or pronunciation score.
    observations: list[dict] = Field(default_factory=list, max_length=0)
    prosody: VoiceProsody | None = None


class ReferenceView(BaseModel):
    id: UUID
    content_id: UUID
    segment_id: str
    state: Literal["awaiting_upload", "queued", "processing", "completed", "partially_completed", "failed", "cancelled", "deleted"]
    input_mode: Literal["file", "upload"]
    analysis_version: str
    start_ms: int
    end_ms: int
    audio_ready: bool
    results: list[SentenceResult]
    error_code: str | None = None
    created_at: datetime
    expires_at: datetime
    attempts: int
    source_kind: Literal['registered', 'browser_capture'] = 'registered'

    @model_validator(mode='before')
    @classmethod
    def provenance(cls, value):
        if isinstance(value, dict) and value.get('snapshot', {}).get('source_kind') == 'browser_capture':
            return {**value, 'source_kind': 'browser_capture'}
        return value


class ReferenceCapability(StrictModel):
    available: bool
    input_mode: Literal["file", "upload"] | None = None
    reason: str | None = None
