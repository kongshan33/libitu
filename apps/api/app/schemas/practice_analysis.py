from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field
from app.schemas.acoustic_base import StrictModel

ANALYSIS_VERSION = "practice-comparison-v2"


class AnalysisCreate(StrictModel):
    consent_version: Literal["practice-analysis-v1"]
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    size: int = Field(gt=0, le=8 * 1024 * 1024)
    mime_type: Literal["audio/webm", "audio/ogg", "audio/mp4"]
    reference_id: UUID | None = None


class ContentCheck(StrictModel):
    status: Literal["matched", "mismatch", "uncertain", "unavailable"]
    transcript: str = ""
    reason: str | None = None


class AlignedPhone(StrictModel):
    label: str
    duration_ms: float = Field(gt=0)


class WordProsody(StrictModel):
    text: str
    start_sec: float
    end_sec: float
    duration_ms: float
    pause_after_ms: float | None = None
    pitch_st: float | None = None
    pitch_curve_st: list[float | None] = Field(default_factory=list)
    # Dictionary-constrained alignment labels, not an independent phone transcript.
    phones: list[AlignedPhone] = Field(default_factory=list)
    # Zero means VAD supports continuous speech across this boundary; null is unknown.
    boundary_pause_ms: float | None = Field(default=None, ge=0)


class VoiceProsody(StrictModel):
    content: ContentCheck
    alignment_status: str
    quality_issues: list[str] = Field(default_factory=list)
    words: list[WordProsody] = Field(default_factory=list)


class SimilarityScore(StrictModel):
    value: float | None = Field(default=None, ge=0, le=100)
    compared: int = Field(default=0, ge=0)
    eligible: int = Field(default=0, ge=0)
    reason: str | None = None
    experimental: Literal[True] = True


class SoundMeasurementPair(StrictModel):
    word_index: int = Field(ge=0)
    end_index: int = Field(gt=0)
    reference: float
    learner: float
    unit: Literal["ms"] = "ms"
    similarity: float = Field(ge=0, le=100)


class SoundCheck(StrictModel):
    kind: str
    status: Literal["measured", "insufficient_evidence", "unsupported", "no_targets"]
    score: SimilarityScore = Field(default_factory=SimilarityScore)
    pairs: list[SoundMeasurementPair] = Field(default_factory=list)
    # Measurement agreement must never be presented as a realized phonological process.
    realization: Literal["not_evaluated"] = "not_evaluated"
    note: str


class LayerAssessment(StrictModel):
    version: Literal["reference-similarity-v1"] = "reference-similarity-v1"
    sound: list[SoundCheck] = Field(default_factory=list)
    rhythm: SimilarityScore = Field(default_factory=SimilarityScore)
    melody: SimilarityScore = Field(default_factory=SimilarityScore)


class ProsodyResult(StrictModel):
    version: str = ANALYSIS_VERSION
    learner: VoiceProsody
    reference: VoiceProsody | None = None
    comparison: Literal["available", "unavailable"] = "unavailable"
    reason: str | None = None
    assessment: LayerAssessment | None = None
    # All word times are relative to each voice's sentence audio, not video time.
    time_basis: Literal["sentence_seconds"] = "sentence_seconds"


class AnalysisView(StrictModel):
    id: UUID
    sentence_id: str
    state: Literal["awaiting_upload", "queued", "processing", "completed", "needs_review", "failed", "cancelled", "deleted"]
    analysis_version: str
    result: ProsodyResult | None = None
    error_code: str | None = None
    retryable: bool = False
    created_at: datetime
