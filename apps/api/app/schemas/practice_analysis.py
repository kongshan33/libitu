from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator
from app.schemas.acoustic_base import StrictModel
from app.schemas.practice import RecognitionFeedback
from app.schemas.signal_prosody import WordBoundary, SignalProsody, SignalPair

ANALYSIS_VERSION = "practice-comparison-v2"
GATED_ANALYSIS_VERSION = "practice-gated-v3"
AnalysisScope = Literal["none", "sound_only", "all_layers"]
AnalysisPhase = Literal["awaiting_upload", "queued_word_check", "checking_words", "word_check_complete",
                        "waiting_reference", "analyzing_sound", "analyzing_all", "coarse_ready", "finished"]


class CheckedToken(StrictModel):
    normalized: str
    display: str
    start: int = Field(ge=0)
    end: int = Field(gt=0)

    @model_validator(mode="after")
    def valid_span(self):
        if self.end <= self.start:
            raise ValueError("Empty token span")
        return self


class WordEdit(StrictModel):
    kind: Literal["matched", "substituted", "omitted", "inserted"]
    source_index: int | None = Field(default=None, ge=0)
    recognized_index: int | None = Field(default=None, ge=0)
    source_boundary: int | None = Field(default=None, ge=0)


class WordCheck(StrictModel):
    version: Literal["word-match-v1"] = "word-match-v1"
    status: Literal["reliable", "uncertain", "unavailable"]
    reason: str | None = None
    transcript: str = ""
    source_tokens: list[CheckedToken] = Field(default_factory=list)
    recognized_tokens: list[CheckedToken] = Field(default_factory=list)
    operations: list[WordEdit] = Field(default_factory=list)
    matched_count: int = Field(default=0, ge=0)
    source_count: int = Field(default=0, ge=0)
    tier: Literal["below_60", "partial_60_85", "full_85_plus"] | None = None
    word_timings: list[WordBoundary] = Field(default_factory=list, max_length=1024)

    @model_validator(mode="after")
    def consistent_result(self):
        if self.source_count != len(self.source_tokens):
            raise ValueError("Source word count does not match tokens")
        if self.status != "reliable":
            if self.tier is not None or self.operations or self.matched_count:
                raise ValueError("Uncertain recognition cannot establish a match tier")
            return self
        if not self.source_count or not self.recognized_tokens:
            raise ValueError("Reliable checks require both token sequences")
        source_position, recognized_position, matches = 0, 0, 0
        for op in self.operations:
            if op.kind == "inserted":
                if op.source_index is not None or op.recognized_index != recognized_position or op.source_boundary != source_position:
                    raise ValueError("Invalid insertion position")
                recognized_position += 1
                continue
            if op.source_index != source_position or op.source_boundary is not None or source_position >= self.source_count:
                raise ValueError("Invalid source position")
            if op.kind == "omitted":
                if op.recognized_index is not None:
                    raise ValueError("Omitted word has no recognized position")
            else:
                if op.recognized_index != recognized_position or recognized_position >= len(self.recognized_tokens):
                    raise ValueError("Invalid recognized position")
                same = self.source_tokens[source_position].normalized == self.recognized_tokens[recognized_position].normalized
                if same != (op.kind == "matched"):
                    raise ValueError("Match operation disagrees with tokens")
                matches += same
                recognized_position += 1
            source_position += 1
        tier = ("below_60" if matches*100 < self.source_count*60 else
                "partial_60_85" if matches*100 < self.source_count*85 else "full_85_plus")
        if source_position != self.source_count or recognized_position != len(self.recognized_tokens) \
                or matches != self.matched_count or self.tier != tier:
            raise ValueError("Word check counts or tier disagree with operations")
        return self


class LayerAvailability(StrictModel):
    state: Literal["locked", "pending", "available", "partial", "unavailable"]
    reason: str | None = None


class AnalysisCreate(StrictModel):
    consent_version: Literal["practice-analysis-v1"]
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    size: int = Field(gt=0, le=8 * 1024 * 1024)
    mime_type: Literal["audio/webm", "audio/ogg", "audio/mp4"]
    reference_id: UUID | None = None


class ContentCheck(StrictModel):
    status: Literal["matched", "mismatch", "uncertain", "unavailable", "source_transcript"]
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
    source_index: int | None = Field(default=None, ge=0)
    recognized_index: int | None = Field(default=None, ge=0)


class VoiceProsody(StrictModel):
    content: ContentCheck
    alignment_status: str
    quality_issues: list[str] = Field(default_factory=list)
    words: list[WordProsody] = Field(default_factory=list)
    rhythm_signal: SignalProsody | None = None


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
    phase: AnalysisPhase | None = None
    word_check: WordCheck | None = None
    analysis_scope: AnalysisScope | None = None
    layers: dict[str, LayerAvailability] | None = None
    recognition_feedback: RecognitionFeedback | None = None
    coarse: SignalPair | None = None
