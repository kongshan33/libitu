from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.blueprint import CorpusItem as CorpusSnapshot


class CorpusSourceLocator(BaseModel):
    client_key: str | None = Field(default=None, max_length=1600)
    source_url: str | None = Field(default=None, max_length=2000)
    source_title: str | None = Field(default=None, max_length=500)
    snapshot: CorpusSnapshot | None = None


class CorpusSelectionAnalysisRequest(BaseModel):
    content_id: str | None = None
    selected_text: str = Field(min_length=1, max_length=800)
    current_sentence: str = Field(min_length=1, max_length=2000)
    context_before: str | None = Field(default=None, max_length=2000)
    context_after: str | None = Field(default=None, max_length=2000)
    timestamp: str | None = Field(default=None, max_length=24)


class CorpusSelectionFields(BaseModel):
    kind: str = Field(pattern="^(chunk|idiom|structure)$")
    tags: list[str] = Field(default_factory=list)
    level: str = Field(pattern="^(A1|A2|B1|B2|C1|C2)$")
    usage_register: str = Field(alias="register", pattern="^(casual|neutral|professional|formal)$")


class CorpusSelectionPronunciation(BaseModel):
    ipa: str
    connected_speech: str
    audio_text: str


class CorpusSelectionExample(BaseModel):
    english: str
    chinese: str
    typical: bool = False


class CorpusSelectionExplanation(BaseModel):
    pronunciation: CorpusSelectionPronunciation
    meaning: str
    pragmatic_function: str
    similar_expressions: list[str] = Field(default_factory=list)
    examples: list[CorpusSelectionExample] = Field(default_factory=list)
    usage_chips: list[str] = Field(default_factory=list)


class CorpusReusablePattern(BaseModel):
    template: str
    slots: dict[str, str] = Field(default_factory=dict)
    rationale: str


class CorpusSelectionTranslation(BaseModel):
    label: str
    text: str
    recommended: bool = False


class CorpusSelectionSyntaxAnalysis(BaseModel):
    sentence_type: str
    main_clause: str
    structure_breakdown: list[str] = Field(default_factory=list)
    logic_relations: list[str] = Field(default_factory=list)
    information_hierarchy: list[str] = Field(default_factory=list)
    style_features: list[str] = Field(default_factory=list)
    usage_scenarios: list[str] = Field(default_factory=list)
    grammar_points: list[str] = Field(default_factory=list)
    wording_notes: list[str] = Field(default_factory=list)
    reusable_patterns: list[CorpusReusablePattern] = Field(default_factory=list)
    translations: list[CorpusSelectionTranslation] = Field(default_factory=list)
    translation_notes: list[str] = Field(default_factory=list)
    background_context: str | None = None
    evidence: list[str] = Field(default_factory=list)


class CorpusSelectionAnalysis(BaseModel):
    analysis_source: Literal["ai", "fallback"]
    provider_notice: str | None = None
    selection_type: str = Field(pattern="^(phrase|sentence)$")
    completeness: str = Field(pattern="^(complete|needs_expansion|structure_candidate)$")
    selected_text: str
    recommended_text: str
    recommendation_reason: str
    fields: CorpusSelectionFields
    note_placeholder: str
    explanation: CorpusSelectionExplanation
    syntax_analysis: CorpusSelectionSyntaxAnalysis


class CorpusItemAnalysisDetail(BaseModel):
    context: CorpusSelectionAnalysisRequest
    analysis: CorpusSelectionAnalysis


class CorpusItemCreate(BaseModel):
    content_id: str | None = None
    kind: str = Field(pattern="^(chunk|idiom|structure)$")
    text: str = Field(min_length=1, max_length=2000)
    meaning: str | None = None
    usage_context: str | None = None
    tags: list[str] = Field(default_factory=list)
    slots: dict[str, str] = Field(default_factory=dict)
    source_locator: CorpusSourceLocator = Field(default_factory=CorpusSourceLocator)
    analysis_detail: CorpusItemAnalysisDetail | None = None


class CorpusItem(CorpusItemCreate):
    id: str
    user_id: str
    created_at: datetime | None = None
    updated_at: datetime | None = None


class CorpusItemUpdate(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=2000)
    meaning: str | None = None
    usage_context: str | None = None
    tags: list[str] | None = None
    slots: dict[str, str] | None = None
    analysis_detail: CorpusItemAnalysisDetail | None = None

    @field_validator("text", "tags", "slots", mode="before")
    @classmethod
    def required_when_provided(cls, value):
        if value is None or (isinstance(value, str) and not value.strip()):
            raise ValueError("This field cannot be blank or null")
        return value
