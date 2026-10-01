"""Bounded source-caption metadata, not an acoustic-alignment contract."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


MAX_CAPTION_CHARACTERS = 240_000
MAX_CAPTION_MILLISECONDS = 604_800_000


class CaptionSegment(BaseModel):
    model_config = ConfigDict(extra="ignore")

    utf8: str = Field(max_length=MAX_CAPTION_CHARACTERS)
    # Invalid offsets remain inspectable source data; the formatter rejects them
    # as word evidence rather than dropping their text or inventing a time.
    tOffsetMs: int | None = Field(default=None, strict=True, ge=-MAX_CAPTION_MILLISECONDS, le=MAX_CAPTION_MILLISECONDS)


class CaptionEvent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    tStartMs: int = Field(strict=True, ge=0, le=MAX_CAPTION_MILLISECONDS)
    dDurationMs: int | None = Field(default=None, strict=True, ge=0, le=MAX_CAPTION_MILLISECONDS)
    segs: list[CaptionSegment] = Field(default_factory=list, max_length=12_000)
    aAppend: Literal[0, 1] | None = None
    wWinId: int | None = Field(default=None, strict=True, ge=0)


class CaptionTrack(BaseModel):
    model_config = ConfigDict(extra="ignore")

    version: Literal["youtube-json3-v1", "youtube-snippets-v1"] = "youtube-json3-v1"
    video_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    language: str | None = Field(default=None, max_length=35)
    kind: Literal["asr", "manual", "unknown"] = "unknown"
    events: list[CaptionEvent] = Field(max_length=10_000)

    @model_validator(mode="after")
    def validate_payload_size(self) -> "CaptionTrack":
        segments = [segment for event in self.events for segment in event.segs]
        if len(segments) > 50_000 or sum(len(segment.utf8) for segment in segments) > MAX_CAPTION_CHARACTERS:
            raise ValueError("Caption track exceeds the bounded source-text size.")
        if len(self.model_dump_json(exclude_none=True).encode("utf-8")) > 2 * 1024 * 1024:
            raise ValueError("Caption track exceeds the bounded metadata size.")
        return self


class CaptionWordTiming(BaseModel):
    """One normalized source token with a caption-derived start and optional estimated end."""

    source_token_index: int = Field(ge=0)
    text: str = Field(min_length=1, pattern=r"^\S+$")
    start_ms: int = Field(ge=0)
    end_ms: int | None = Field(default=None, ge=0)
    start_source: Literal["caption_offset"] = "caption_offset"
    end_source: Literal["next_word_estimate", "event_end_estimate"] | None = None
    source_event_index: int = Field(ge=0)
    source_seg_index: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_estimated_end(self) -> "CaptionWordTiming":
        if (self.end_ms is None) != (self.end_source is None):
            raise ValueError("Word end and its estimation source must be supplied together.")
        if self.end_ms is not None and self.end_ms <= self.start_ms:
            raise ValueError("Word end estimate must be after its caption start.")
        return self
