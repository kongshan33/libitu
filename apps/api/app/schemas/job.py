from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.analysis import BlueprintAnalysisPreview


class ProcessingStatus(StrEnum):
    pending = "pending"
    processing = "processing"
    ready = "ready"
    failed = "failed"


class ProcessingStage(StrEnum):
    queued = "queued"
    loading_content = "loading_content"
    fetching_transcript = "fetching_transcript"
    formatting_transcript = "formatting_transcript"
    analyzing = "analyzing"
    building_blueprint = "building_blueprint"
    persisting = "persisting"
    completed = "completed"
    failed = "failed"


class JobCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content_id: str


class ProcessingJob(BaseModel):
    id: str
    content_id: str
    status: ProcessingStatus
    analysis_version: str
    processing_stage: ProcessingStage = ProcessingStage.queued
    attempt_count: int = 0
    blueprint_id: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    analysis_preview: BlueprintAnalysisPreview | None = None
    queued_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    started_at: datetime | None = None
    completed_at: datetime | None = None
    stage_timings_ms: dict[str, int] = Field(default_factory=dict)
