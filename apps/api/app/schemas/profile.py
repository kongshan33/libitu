"""Private learning activity and a bounded summary of saved mission feedback."""

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.speaking import ScenarioType, SpeakingDifficulty
from app.schemas.speaking_feedback import DimensionId, FeedbackStatus

ProfileRange = Literal["4w", "3m", "all"]
ProfileHistoryKind = Literal["all", "shadowing", "speaking"]
FeedbackUnavailableReason = Literal["legacy_report", "version_mismatch", "invalid_result"]


class ProfileFeedbackDimension(BaseModel):
    model_config = ConfigDict(strict=True)

    id: DimensionId
    score: int | None = Field(ge=0, le=100)
    basis: Literal["ai_assessment", "coverage"]
    summary: str = Field(max_length=20000)


class ProfileFeedbackSummary(BaseModel):
    id: UUID
    session_id: UUID
    status: Literal["ready", "partial"]
    rubric_version: str
    analysis_version: str
    goal: str
    scenario_type: ScenarioType
    difficulty: SpeakingDifficulty
    created_at: datetime
    updated_at: datetime
    practiced_at: datetime
    dimensions: list[ProfileFeedbackDimension]


class ProfileHistoryFeedback(BaseModel):
    id: UUID
    status: FeedbackStatus
    available: bool
    unavailable_reason: FeedbackUnavailableReason | None = None


class ProfileOverview(BaseModel):
    shadowing_attempts: int
    speaking_sessions: int
    corpus_total: int
    corpus_structures: int
    corpus_week_added: int | None
    shadowing_duration_ms: int
    current_streak_days: int
    active_days: int


class ActivityBucket(BaseModel):
    date: date
    shadowing_attempts: int = 0
    speaking_turns: int = 0
    corpus_added: int | None = 0


class ProfileActivity(BaseModel):
    bucket: Literal["day", "month"]
    start_date: date
    end_date: date
    items: list[ActivityBucket]


class ResumeSpeaking(BaseModel):
    session_id: UUID
    goal: str
    status: Literal["draft", "active"]
    turn_count: int
    updated_at: datetime


class LastPracticedSource(BaseModel):
    content_id: UUID
    source_url: str | None = None
    sentence_id: str
    sentence_text: str
    title: str | None = None
    start_ms: int
    practiced_at: datetime


class ProfileHistoryItem(BaseModel):
    id: UUID
    kind: Literal["shadowing", "speaking"]
    title: str
    occurred_at: datetime
    duration_ms: int | None = None
    turn_count: int | None = None
    status: Literal["recorded", "draft", "active", "completed", "abandoned"]
    content_id: UUID | None = None
    source_url: str | None = None
    sentence_id: str | None = None
    session_id: UUID | None = None
    feedback: ProfileHistoryFeedback | None = None


class ProfileHistoryPage(BaseModel):
    items: list[ProfileHistoryItem]
    next_offset: int | None = None


class LearningProfile(BaseModel):
    timezone: str
    range: ProfileRange
    generated_at: datetime
    overview: ProfileOverview
    activity: ProfileActivity
    resume_speaking: ResumeSpeaking | None = None
    last_practiced_source: LastPracticedSource | None = None
    recent_history: ProfileHistoryPage
    latest_feedback: ProfileFeedbackSummary | None = None
    latest_feedback_unavailable_reason: Literal["not_available", "legacy_report", "version_mismatch", "invalid_result"] | None = None
