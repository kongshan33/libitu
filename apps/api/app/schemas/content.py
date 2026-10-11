from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl, model_validator

from app.schemas.captions import CaptionTrack
from app.schemas.job import ProcessingStatus


class ContentKind(StrEnum):
    youtube = "youtube"
    article = "article"
    pasted_text = "pasted_text"


class ContentResolveRequest(BaseModel):
    kind: ContentKind
    source_url: HttpUrl | None = None
    pasted_text: str | None = Field(default=None, min_length=1)
    transcript_text: str | None = Field(default=None, min_length=1)
    caption_track: CaptionTrack | None = None
    language: str | None = None
    title: str | None = None

    @model_validator(mode="after")
    def validate_caption_source(self) -> "ContentResolveRequest":
        if self.caption_track is not None:
            from urllib.parse import parse_qs, urlparse

            source = urlparse(str(self.source_url or ""))
            host = (source.hostname or "").lower()
            video_id = source.path.strip("/") if host == "youtu.be" else (
                parse_qs(source.query).get("v", [None])[0]
                if host in {"youtube.com", "www.youtube.com", "m.youtube.com"} else None
            )
            if self.kind != ContentKind.youtube or video_id != self.caption_track.video_id:
                raise ValueError("Caption track must belong to the requested YouTube video.")
            if self.language and self.caption_track.language and (
                self.language.split("-")[0].lower() != self.caption_track.language.split("-")[0].lower()
            ):
                raise ValueError("Caption track must match the requested language.")
        return self


class ContentResolveResponse(BaseModel):
    content_id: str
    kind: ContentKind
    normalized_key: str
    source_url: str | None = None
    has_transcript: bool = False
    language: str | None = None
    title: str | None = None


class PublicContent(BaseModel):
    content_id: str
    kind: Literal["youtube"] = "youtube"
    source_url: str
    title: str | None = None
    language: str | None = None


class ContentJobSummary(BaseModel):
    id: str
    content_id: str
    analysis_version: str
    status: ProcessingStatus
    attempt_count: int


class ContentProcessing(BaseModel):
    analysis_version: str
    blueprint_available: bool
    job: ContentJobSummary | None = None


class ContentContext(BaseModel):
    content: PublicContent
    processing: ContentProcessing
