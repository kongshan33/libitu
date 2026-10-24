"""Server-owned scenario planning and the immutable plan carried by a Mission."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator


ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
ScenarioType = Literal["workplace", "everyday"]
ScenarioRegister = Literal["casual", "neutral", "professional", "formal"]
PracticeVariation = Literal["details", "role_swap"]


class PracticePlanCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    variation: PracticeVariation


class PracticeSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    parent_session_id: UUID
    root_session_id: UUID
    variation: PracticeVariation
    parent_snapshot_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class ScenarioChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field: Literal["setting", "goal", "user_role", "ai_role"]
    before: ShortText
    after: ShortText


class PlanTargetSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    corpus_item_id: UUID
    role: Literal["primary", "opportunity"]


class SpeakingPlanCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenario_type: ScenarioType
    brief: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] = ""
    # Existing callers compare scenes; one-button Start requests only one.
    candidate_count: Literal[1, 2] = 2
    targets: list[PlanTargetSelection] = Field(min_length=1, max_length=5)

    @model_validator(mode="after")
    def validate_targets(self) -> "SpeakingPlanCreate":
        primary = sum(target.role == "primary" for target in self.targets)
        if not 1 <= primary <= 3 or len(self.targets) - primary > 2:
            raise ValueError("Choose one to three primary targets and up to two opportunity targets.")
        if len({target.corpus_item_id for target in self.targets}) != len(self.targets):
            raise ValueError("Select each corpus item only once.")
        return self


class SpeakingPlanTarget(PlanTargetSelection):
    communicative_function: ShortText
    fit: Literal["high", "medium", "low", "unknown"]
    fit_reason: ShortText
    trigger_question: ShortText
    skip_when: ShortText
    # Old persisted plans remain readable; new generation validates a real frame.
    sentence_frame: ShortText | None = None
    # Derived from stored corpus metadata, never accepted as a model assertion.
    metadata_status: Literal["available", "partial", "unknown"] = "unknown"


class ScenarioProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)

    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    setting: ShortText
    goal: ShortText
    user_role: ShortText
    ai_role: ShortText
    usage_register: ScenarioRegister = Field(validation_alias="register", serialization_alias="register")
    targets: list[SpeakingPlanTarget] = Field(min_length=1, max_length=5)


class ScenarioProposals(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidates: list[ScenarioProposal] = Field(min_length=1, max_length=3)


class SpeakingScenarioCandidate(ScenarioProposal):
    id: UUID
    changes: list[ScenarioChange] = Field(default_factory=list, max_length=4)


class SpeakingPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    version: Literal[1] = 1
    scenario_type: ScenarioType
    brief: str
    created_at: datetime
    candidates: list[SpeakingScenarioCandidate] = Field(min_length=1, max_length=3)
    practice_source: PracticeSource | None = None


class SpeakingMissionTarget(SpeakingPlanTarget):
    session_item_id: UUID
    parent_session_item_id: UUID | None = None


class SpeakingMissionPlan(ScenarioProposal):
    plan_id: UUID
    candidate_id: UUID
    version: Literal[1] = 1
    scenario_type: ScenarioType
    targets: list[SpeakingMissionTarget] = Field(min_length=1, max_length=5)
    changes: list[ScenarioChange] = Field(default_factory=list, max_length=4)
