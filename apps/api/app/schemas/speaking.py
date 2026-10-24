from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

from app.schemas.speaking_plan import PracticeVariation, ScenarioChange, SpeakingMissionPlan


LogicTemplateId = Literal[
    "persuasive_pitch", "technical_troubleshoot", "stakeholder_alignment",
    "status_update", "disagreement", "onboarding",
]
ScenarioType = Literal["workplace", "everyday"]
SpeakingDifficulty = Literal["guided", "standard", "challenging"]
FeedbackLevel = Literal["light", "balanced", "detailed"]
SupportLevel = Literal["model_frame", "model_label", "label_only", "no_hint"]
EVIDENCE_CONTRACT_VERSION = "speaking-evidence-v3"


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
    plan_id: UUID | None = None
    candidate_id: UUID | None = None
    support_level: SupportLevel | None = None

    @model_validator(mode="after")
    def require_plan_pair(self) -> "SpeakingSessionCreate":
        if (self.plan_id is None) != (self.candidate_id is None):
            raise ValueError("Choose both a saved plan and its scenario.")
        return self

    @field_validator("corpus_item_ids")
    @classmethod
    def reject_duplicate_items(cls, value: list[UUID]) -> list[UUID]:
        if len(set(value)) != len(value):
            raise ValueError("Select each corpus item only once.")
        return value


class SpeakingSessionItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    id: UUID
    corpus_item_id: UUID | None
    source_corpus_item_id: UUID | None = None
    ordinal: int = Field(ge=0)
    kind: Literal["chunk", "idiom", "structure"]
    text: str
    meaning: str | None = None
    tags: list[str] = Field(default_factory=list)
    slots: dict[str, str] = Field(default_factory=dict)
    source_title: str | None = None
    usage_note: str | None = None
    usage_register: Literal["casual", "neutral", "professional", "formal"] | None = Field(
        default=None, validation_alias="register", serialization_alias="register",
    )
    scenario_tags: list[str] = Field(default_factory=list)
    pattern_family: str | None = None


class SpeakingPractice(BaseModel):
    model_config = ConfigDict(extra="forbid")

    parent_session_id: UUID | None
    root_session_id: UUID
    variation: PracticeVariation
    changes: list[ScenarioChange] = Field(default_factory=list, max_length=4)


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
    mission_plan: SpeakingMissionPlan | None = None
    support_level: SupportLevel | None = None
    evidence_contract_version: Literal["speaking-evidence-v3"] | None = None
    practice: SpeakingPractice | None = None


class SpeakingTurnCreate(BaseModel):
    user_message: str = Field(min_length=1)


class SpeakingTurnResponse(BaseModel):
    session_id: str
    ai_message: str
    feedback: str
    stage_advance: bool = False
