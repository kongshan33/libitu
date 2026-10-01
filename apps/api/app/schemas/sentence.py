"""Shared optional metadata for final transcript rows and streaming previews."""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas.captions import CaptionWordTiming


BoundarySource = Literal[
    "source_punctuation", "punctuation_model", "syntax_merge", "caption_pause", "unresolved"
]


class SentenceMetadata(BaseModel):
    id: str | None = None
    segmentation_version: str | None = None
    source_token_start: int | None = Field(default=None, ge=0)
    source_token_end: int | None = Field(default=None, ge=0)
    start_ms: int | None = Field(default=None, ge=0)
    end_ms: int | None = Field(default=None, ge=0)
    boundary_source: BoundarySource | None = None
    boundary_confidence: Literal["high", "medium", "low"] | None = None
    timing_source: Literal["caption_word_offsets", "caption_event_estimate", "caption_estimate"] | None = None
    word_timings: list[CaptionWordTiming] | None = None

    @model_validator(mode="after")
    def validate_sentence_metadata(self) -> "SentenceMetadata":
        if self.segmentation_version is not None:
            if not self.id or self.source_token_start is None or self.source_token_end is None:
                raise ValueError("Versioned sentences require identity and a source token range.")
            if self.source_token_end <= self.source_token_start:
                raise ValueError("Sentence source token range must be nonempty.")
        if (self.start_ms is None) != (self.end_ms is None):
            raise ValueError("Sentence timing endpoints must be supplied together.")
        if self.start_ms is not None and self.end_ms is not None and self.end_ms <= self.start_ms:
            raise ValueError("Sentence end_ms must exceed start_ms.")
        if self.word_timings:
            if self.timing_source != "caption_word_offsets":
                raise ValueError("Word timings require caption word-offset provenance.")
            if self.source_token_start is None or self.source_token_end is None:
                raise ValueError("Word timings require a normalized source token range.")
            previous_index = -1
            previous_start = -1
            previous_end = None
            for word in self.word_timings:
                if not self.source_token_start <= word.source_token_index < self.source_token_end:
                    raise ValueError("Word timing must refer to a token within its sentence.")
                if word.source_token_index <= previous_index or word.start_ms <= previous_start:
                    raise ValueError("Word timing indices and caption starts must increase strictly.")
                if previous_end is not None and word.start_ms < previous_end:
                    raise ValueError("Estimated word intervals cannot overlap.")
                if self.start_ms is not None and word.start_ms < self.start_ms:
                    raise ValueError("Word start cannot precede the sentence navigation interval.")
                if self.end_ms is not None and (word.start_ms >= self.end_ms or (word.end_ms or 0) > self.end_ms):
                    raise ValueError("Word timing cannot exceed the sentence navigation interval.")
                previous_index, previous_start = word.source_token_index, word.start_ms
                previous_end = word.end_ms
        return self
