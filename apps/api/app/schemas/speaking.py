from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator


LogicTemplateId = Literal[
    "persuasive_pitch", "technical_troubleshoot", "stakeholder_alignment",
    "status_update", "disagreement", "onboarding",
]
ScenarioType = Literal["workplace", "everyday"]
SpeakingDifficulty = Literal["guided", "standard", "challenging"]
FeedbackLevel = Literal["light", "balanced", "detailed"]


class LogicTemplate(BaseModel):
    id: LogicTemplateId
    title: str
    description: str
    steps: list[str]


class SpeakingOptions(BaseModel):
    logic_templates: list[LogicTemplate]
    max_structures: int = 3
    max_expressions: int = 5
    min_items: int = 1


class SpeakingSessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_id: UUID
    scenario_type: ScenarioType
    goal: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    difficulty: SpeakingDifficulty = "standard"
    feedback_level: FeedbackLevel = "balanced"
    logic_template_id: LogicTemplateId | None = None
    corpus_item_ids: list[UUID] = Field(min_length=1, max_length=8)

    @field_validator("corpus_item_ids")
    @classmethod
    def reject_duplicate_items(cls, value: list[UUID]) -> list[UUID]:
        if len(set(value)) != len(value):
            raise ValueError("Select each corpus item only once.")
        return value


class SpeakingSessionItem(BaseModel):
    id: UUID
    corpus_item_id: UUID | None
    ordinal: int = Field(ge=0)
    kind: Literal["chunk", "idiom", "structure"]
    text: str
    meaning: str | None = None
    tags: list[str] = Field(default_factory=list)
    slots: dict[str, str] = Field(default_factory=dict)
    source_title: str | None = None


class SpeakingSession(BaseModel):
    id: UUID
    user_id: str
    client_id: UUID
    scenario_type: ScenarioType
    goal: str
    difficulty: SpeakingDifficulty
    feedback_level: FeedbackLevel
    logic_template: LogicTemplate | None
    status: Literal["draft", "active", "completed", "abandoned"] = "draft"
    created_at: datetime
    turn_count: int = 0
    items: list[SpeakingSessionItem]


class SpeakingTurnCreate(BaseModel):
    user_message: str = Field(min_length=1)


class SpeakingTurnResponse(BaseModel):
    session_id: str
    ai_message: str
    feedback: str
    stage_advance: bool = False
