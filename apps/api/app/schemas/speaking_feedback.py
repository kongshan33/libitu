"""Versioned Stage 5 public report. Provider output is validated separately."""

from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from app.schemas.speaking import SpeakingSession, SupportLevel
from app.schemas.speaking_runtime import SpeakingMessage

RUBRIC_VERSION = "speaking-rubric-v2"
ANALYSIS_VERSION = "speaking-feedback-v3"
SUPPORTED_REPORT_VERSIONS = {
    (RUBRIC_VERSION, ANALYSIS_VERSION),
    ("speaking-rubric-v2", "speaking-feedback-v2"),
    ("speaking-rubric-v1", "speaking-feedback-v1"),
}
FeedbackStatus = Literal["queued", "processing", "ready", "partial", "insufficient_data", "failed"]
DimensionId = Literal["task_fit", "transfer", "scenario_fit", "naturalness"]


class FeedbackReference(BaseModel):
    message_id: str
    transcript_revision: int = Field(ge=1)
    quote: str
    start: int = Field(ge=0)
    end: int = Field(ge=0)


class FeedbackCriterion(BaseModel):
    id: str
    label: str
    rating: int | None = Field(default=None, ge=0, le=4)
    reason: str
    evidence: list[FeedbackReference] = Field(default_factory=list)


class FeedbackDimension(BaseModel):
    id: DimensionId
    score: int | None = Field(default=None, ge=0, le=100)
    basis: Literal["ai_assessment", "coverage"]
    summary: str
    criteria: list[FeedbackCriterion] = Field(default_factory=list)


class FeedbackItem(BaseModel):
    session_item_id: str
    kind: Literal["chunk", "idiom", "structure"]
    text: str
    status: Literal["appropriate", "inappropriate", "uncertain", "not_observed"]
    independent_uses: int = Field(default=0, ge=0)
    prompted_uses: int = Field(default=0, ge=0)
    uncertain_assistance_uses: int = Field(default=0, ge=0)
    role: Literal["primary", "opportunity"] | None = None
    opportunity_status: Literal["planned", "offered", "used", "skipped"] | None = None
    excluded_reason: str | None = None
    reason: str
    evidence: list[FeedbackReference] = Field(default_factory=list)
    qualifying_independent_evidence: list[FeedbackReference] = Field(default_factory=list, max_length=40)


class FeedbackRefactor(BaseModel):
    id: str
    original: FeedbackReference
    suggested: str
    reason: str
    save_text: str | None = None
    save_kind: Literal["chunk", "idiom", "structure"] = "chunk"
    save_meaning: str | None = None


class FeedbackMissedOpportunity(BaseModel):
    id: str
    session_item_id: str
    opportunity_attempt_id: str
    opportunity_response_id: str
    original: FeedbackReference
    suggested: str = Field(min_length=1, max_length=600)
    reason: str = Field(min_length=1, max_length=400)
    basis: Literal["ai_suggestion"] = "ai_suggestion"


class FeedbackLogicStage(BaseModel):
    label: str
    status: Literal["observed", "not_observed", "uncertain"]
    reason: str
    evidence: list[FeedbackReference] = Field(default_factory=list)


class FeedbackStatistics(BaseModel):
    user_turns: int = 0
    assessed_turns: int = 0
    excluded_turns: int = 0
    word_count: int = 0
    average_words: float = 0
    selected_expressions: int = 0
    used_expressions: int = 0
    selected_structures: int = 0
    used_structures: int = 0
    primary_targets: int = 0
    offered_primary_targets: int = 0
    assessed_primary_targets: int = 0
    used_primary_targets: int = 0
    skipped_targets: int = 0
    opportunity_targets: int = 0
    used_opportunity_targets: int = 0


class FeedbackResult(BaseModel):
    dimensions: list[FeedbackDimension]
    item_results: list[FeedbackItem]
    statistics: FeedbackStatistics
    refactors: list[FeedbackRefactor] = Field(default_factory=list, max_length=3)
    missed_opportunities: list[FeedbackMissedOpportunity] = Field(default_factory=list, max_length=3)
    missed_opportunities_status: Literal["not_requested", "not_applicable", "ready", "unavailable"] = "not_requested"
    logic_stages: list[FeedbackLogicStage] = Field(default_factory=list)
    notices: list[str] = Field(default_factory=list)


class SpeakingFeedback(BaseModel):
    id: str
    session_id: str
    status: FeedbackStatus
    input_hash: str
    rubric_version: str = RUBRIC_VERSION
    analysis_version: str = ANALYSIS_VERSION
    attempts: int = 0
    retryable: bool = False
    error_code: str | None = None
    created_at: str
    updated_at: str
    session: SpeakingSession
    effective_support_level: SupportLevel | None = None
    messages: list[SpeakingMessage]
    result: FeedbackResult | None = None


class FeedbackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    retry: bool = False
