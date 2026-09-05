from pydantic import BaseModel, ConfigDict, Field

from app.schemas.analysis import LearnerLevel


class LogicNode(BaseModel):
    id: str
    title: str
    subtitle: str
    time: str | None = None


class BlueprintSegment(BaseModel):
    id: str
    title: str
    summary: str
    timestamp_ms: int | None = None


class HighlightedTranscriptPart(BaseModel):
    text: str
    tag: str
    kind: str


class TranscriptLine(BaseModel):
    id: str | None = None
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
