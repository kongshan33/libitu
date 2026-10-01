from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.analysis import LearnerLevel
from app.schemas.sentence import SentenceMetadata


class LogicNode(BaseModel):
    id: str
    title: str
    subtitle: str
    time: str | None = None


class BlueprintSegment(BaseModel):
    id: str
    sequence: int | None = Field(default=None, ge=1)
    title: str
    summary: str
    logic_node_id: str | None = None
    timestamp_ms: int | None = Field(default=None, ge=0)
    start_ms: int | None = Field(default=None, ge=0)
    end_ms: int | None = Field(default=None, ge=0)
    duration_ms: int | None = Field(default=None, ge=0)
    transcript_start_index: int | None = Field(default=None, ge=0)
    transcript_end_index: int | None = Field(default=None, ge=0)
    source_text: str | None = None
    quote: str | None = None
    word_count: int | None = Field(default=None, ge=0)
    phonology_tags: list[str] = Field(default_factory=list, max_length=12)
    difficulty: Literal["easy", "medium", "dense"] | None = None
    recommended: bool = False

    @model_validator(mode="after")
    def validate_ranges(self) -> "BlueprintSegment":
        if (self.start_ms is None) != (self.end_ms is None):
            raise ValueError("Segment start_ms and end_ms must be provided together.")
        if self.start_ms is not None and self.end_ms is not None:
            if self.end_ms <= self.start_ms:
                raise ValueError("Segment end_ms must be greater than start_ms.")
            if self.duration_ms is not None and self.duration_ms != self.end_ms - self.start_ms:
                raise ValueError("Segment duration_ms must match end_ms - start_ms.")

        if (self.transcript_start_index is None) != (self.transcript_end_index is None):
            raise ValueError(
                "Segment transcript_start_index and transcript_end_index must be provided together."
            )
        if (
            self.transcript_start_index is not None
            and self.transcript_end_index is not None
            and self.transcript_end_index <= self.transcript_start_index
        ):
            raise ValueError("Segment transcript_end_index must be greater than transcript_start_index.")
        return self


class HighlightedTranscriptPart(BaseModel):
    text: str
    tag: str
    kind: str


class TranscriptLine(SentenceMetadata):
    time: str
    parts: list[str | HighlightedTranscriptPart]


class CorpusItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    id: str
    kind: str
    text: str
    tags: list[str]
    meta: str
    saved: bool = False
    meaning: str | None = None
    usage_note: str | None = None
    source_text: str | None = None
    pattern_family: str | None = None
    level: LearnerLevel | None = None
    usage_register: str | None = Field(
        default=None,
        validation_alias="register",
        serialization_alias="register",
    )
    scenario_tags: list[str] = []
    phonology_note: str | None = None
    naturalness_score: int | None = Field(default=None, ge=1, le=5)
    transferability_score: int | None = Field(default=None, ge=1, le=5)
    learning_value_score: int | None = Field(default=None, ge=1, le=5)


class Blueprint(BaseModel):
    id: str
    content_id: str
    analysis_version: str = "mvp-v1"
    segmentation_version: str | None = None
    # Source-timing revision, independent of paid semantic analysis_version.
    caption_fingerprint: str | None = None
    title: str
    source_url: str | None = None
    summary: str
    logic_flow: list[LogicNode]
    chapters: list[str] = []
    transcript: list[TranscriptLine] = []
    corpus_items: list[CorpusItem] = []
    key_points: list[str]
    scenario_suggestions: list[str]
    segments: list[BlueprintSegment] = []
