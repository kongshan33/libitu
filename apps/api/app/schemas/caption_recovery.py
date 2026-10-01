"""A timing-only upgrade never creates or restarts a processing job."""

from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.schemas.blueprint import Blueprint
from app.schemas.captions import CaptionTrack


class CaptionTimingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    caption_track: CaptionTrack


class CaptionTimingResponse(BaseModel):
    status: Literal["updated", "unchanged"]
    blueprint: Blueprint
