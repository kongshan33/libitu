from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_RECORDING_BYTES = 8 * 1024 * 1024
SourceIndex = Annotated[int, Field(ge=0, strict=True)]


class TextSupport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal["text-support-v1"] = "text-support-v1"
    mode: Literal["hidden", "keywords", "full"]
    visible_source_indices_at_start: list[SourceIndex] = Field(max_length=1024)
    revealed_source_indices: list[SourceIndex] = Field(default_factory=list, max_length=1024)

    @model_validator(mode="after")
    def unique_positions(self):
        for indices in (self.visible_source_indices_at_start, self.revealed_source_indices):
            if len(set(indices)) != len(indices):
                raise ValueError("Text support positions must be unique")
        return self


class RecognitionFeedbackCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["recognition_error"]


class RecognitionFeedback(BaseModel):
    kind: Literal["recognition_error"]
    created_at: datetime


class RecordingRetention(BaseModel):
    model_config = ConfigDict(extra="forbid")
    consent_version: Literal["recording-retention-v1"]
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size: int = Field(gt=0, le=MAX_RECORDING_BYTES)
    mime_type: Literal["audio/webm", "audio/ogg", "audio/mp4"]


class AttemptCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    client_id: UUID
    content_id: UUID
    sentence_id: str = Field(min_length=1, max_length=200)
    duration_ms: int = Field(gt=0, le=61000)
    playback_rate: float = Field(ge=0.25, le=2)
    text_visible: bool
    recording: RecordingRetention | None = None
    text_support: TextSupport | None = None


class PracticeAttempt(BaseModel):
    id: UUID
    content_id: UUID
    sentence_id: str
    sentence_text: str
    start_ms: int
    end_ms: int
    reference_version: str
    duration_ms: int
    playback_rate: float
    text_visible: bool
    recording_state: Literal["none", "pending", "ready", "deleted"]
    created_at: datetime
    # Recording metadata is not an assessment and never establishes pronunciation quality.
    evidence_source: Literal["browser_recording"] = "browser_recording"
    text_support: TextSupport | None = None
    recognition_feedback: RecognitionFeedback | None = None


class AttemptPage(BaseModel):
    items: list[PracticeAttempt]
    next_offset: int | None = None


class WordMatchCounts(BaseModel):
    matched_count: int = Field(ge=0)
    source_count: int = Field(gt=0)


class PracticeProgress(BaseModel):
    practiced_sentence_ids: list[str]
    best_word_matches: dict[str, WordMatchCounts] = Field(default_factory=dict)


SentenceId = Annotated[str, Field(min_length=1, max_length=200)]
