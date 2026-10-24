"""Read-only practice comparisons and explicit support recommendations."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.speaking import SupportLevel
from app.schemas.speaking_plan import PlanTargetSelection


class SupportRecommendationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    targets: list[PlanTargetSelection] = Field(min_length=1, max_length=5)
    current_level: SupportLevel | None = None

    @model_validator(mode="after")
    def valid_selection(self):
        ids = [target.corpus_item_id for target in self.targets]
        primary = sum(target.role == "primary" for target in self.targets)
        if len(set(ids)) != len(ids) or not 1 <= primary <= 3 or len(ids) - primary > 2:
            raise ValueError("Choose one to three primary and up to two opportunity targets.")
        return self


class PracticeEvidence(BaseModel):
    session_id: UUID
    report_id: UUID
    practiced_at: datetime


class SupportTargetHistory(BaseModel):
    corpus_item_id: UUID
    role: Literal["primary", "opportunity"]
    qualifying_missions: int
    practice_days: int
    scene_roots: int
    eligible: bool
    evidence: list[PracticeEvidence] = Field(default_factory=list, max_length=5)


class SupportRecommendation(BaseModel):
    status: Literal["suggest_reduce", "insufficient_history", "keep_current"]
    suggested_level: SupportLevel | None = None
    current_level: SupportLevel | None = None
    rule_version: Literal["support-history-v1"] = "support-history-v1"
    as_of: datetime
    history_truncated: bool = False
    targets: list[SupportTargetHistory]
    reason: str


class PracticeUseSummary(BaseModel):
    status: Literal["appropriate", "inappropriate", "uncertain", "not_observed"]
    opportunity_status: Literal["planned", "offered", "used", "skipped"] | None = None
    independent_uses: int = Field(ge=0)
    prompted_uses: int = Field(ge=0)
    uncertain_assistance_uses: int = Field(ge=0)
    excluded_reason: str | None = None


class PracticeComparisonItem(BaseModel):
    session_item_id: UUID
    parent_session_item_id: UUID
    text: str
    role: Literal["primary", "opportunity"]
    before: PracticeUseSummary | None = None
    after: PracticeUseSummary | None = None


class PracticeComparison(BaseModel):
    status: Literal["ready", "pending", "unavailable", "incompatible"]
    reason: str
    parent_session_id: UUID | None = None
    child_session_id: UUID
    parent_support_level: SupportLevel | None = None
    child_support_level: SupportLevel | None = None
    items: list[PracticeComparisonItem] = Field(default_factory=list)
