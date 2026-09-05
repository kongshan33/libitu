from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


LearnerLevel = Literal["A1", "A2", "B1", "B2", "C1", "C2"]
CorpusKind = Literal["chunk", "idiom", "structure"]
CorpusRegister = Literal["casual", "neutral", "professional", "formal"]
PatternFamily = Literal[
    "contrast",
    "concession-pivot",
    "justified-claim",
    "framed-explanation",
    "hedged-position",
    "cleft",
    "pseudo-cleft",
    "one-that",
    "what-clause",
    "narrative-arc",
    "emphasis",
    "comparative-diminishment",
]


class AnalysisLogicNode(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    subtitle: str = Field(min_length=1, max_length=180)
    timestamp: str | None = None


class AnalysisTranscriptPreviewLine(BaseModel):
    time: str = Field(min_length=1, max_length=16)
    text: str = Field(min_length=1, max_length=1000)


class AnalysisCorpusItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    kind: CorpusKind
    text: str = Field(min_length=1, max_length=240)
    source_text: str = Field(min_length=1, max_length=240)
    meaning: str = Field(min_length=1, max_length=240)
    usage_note: str = Field(min_length=1, max_length=320)
    tags: list[str] = Field(default_factory=list, max_length=3)
    pattern_family: PatternFamily | None = None
    timestamp: str | None = None
    level: LearnerLevel
    usage_register: CorpusRegister = Field(
        validation_alias="register",
        serialization_alias="register",
    )
    scenario_tags: list[str] = Field(min_length=1, max_length=3)
    phonology_note: str | None = Field(default=None, max_length=320)
    naturalness_score: int = Field(ge=1, le=5)
    transferability_score: int = Field(ge=1, le=5)
    learning_value_score: int = Field(ge=1, le=5)

    @model_validator(mode="after")
    def validate_kind_contract(self) -> "AnalysisCorpusItem":
        if self.kind == "chunk" and self.text != self.source_text:
            raise ValueError("Chunk text must exactly match source_text.")
        if self.kind == "structure" and self.pattern_family is None:
            raise ValueError("Structure items require pattern_family.")
        if self.kind != "structure" and self.pattern_family is not None:
            raise ValueError("Only structure items may define pattern_family.")
        if self.level in {"A1", "C2"}:
            raise ValueError("Corpus candidates must be A2, B1, B2, or C1.")
        if self.level == "A2" and self.naturalness_score != 5:
            raise ValueError("A2 candidates require naturalness_score 5.")
        return self


class BlueprintAnalysisPreview(BaseModel):
    output_chars: int = Field(default=0, ge=0)
    summary: str | None = Field(default=None, max_length=1200)
    chapters: list[str] = Field(default_factory=list, max_length=12)
    logic_flow: list[AnalysisLogicNode] = Field(default_factory=list, max_length=6)
    corpus_items: list[AnalysisCorpusItem] = Field(default_factory=list, max_length=32)
    transcript_lines: list[AnalysisTranscriptPreviewLine] = Field(
        default_factory=list,
        max_length=2000,
    )


class BlueprintAnalysis(BaseModel):
    summary: str = Field(min_length=1, max_length=1200)
    chapters: list[str] = Field(min_length=1, max_length=12)
    logic_flow: list[AnalysisLogicNode] = Field(min_length=1, max_length=6)
    corpus_items: list[AnalysisCorpusItem] = Field(default_factory=list, max_length=32)
    key_points: list[str] = Field(min_length=1, max_length=8)
    scenario_suggestions: list[str] = Field(min_length=1, max_length=6)
