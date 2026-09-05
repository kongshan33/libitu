from enum import StrEnum

from pydantic import BaseModel, Field, HttpUrl


class ContentKind(StrEnum):
    youtube = "youtube"
    article = "article"
    pasted_text = "pasted_text"


class ContentResolveRequest(BaseModel):
    kind: ContentKind
    source_url: HttpUrl | None = None
    pasted_text: str | None = Field(default=None, min_length=1)
    transcript_text: str | None = Field(default=None, min_length=1)
    language: str | None = None
    title: str | None = None


class ContentResolveResponse(BaseModel):
    content_id: str
    kind: ContentKind
    normalized_key: str
    source_url: str | None = None
    has_transcript: bool = False
    language: str | None = None
    title: str | None = None
