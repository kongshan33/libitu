"""Operator-owned grants; knowing a YouTube URL grants no media capabilities."""
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Literal
from uuid import UUID
import json

from pydantic import Field, model_validator

from app.config import get_settings
from app.schemas.reference import StrictModel


class SourceGrant(StrictModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,100}$")
    content_id: UUID
    owners: list[str] = Field(min_length=1, max_length=100)
    rights_reference: str = Field(min_length=1, max_length=1000)
    expires_at: datetime
    mode: Literal["file", "upload"] = "file"
    # Full file timeline origin; only selected segment is normalized and retained.
    origin_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    path: str | None = None
    size: int = Field(gt=0, le=512 * 1024 * 1024)

    @model_validator(mode="after")
    def check(self):
        if self.end_ms <= self.origin_ms or self.expires_at.tzinfo is None:
            raise ValueError("Source requires ordered bounds and an explicit expiry timezone")
        if self.mode == "file" and (not self.path or not Path(self.path).is_absolute()):
            raise ValueError("File sources require an operator-managed absolute path")
        if self.mode == "upload" and (self.path is not None or self.size > 32 * 1024 * 1024):
            raise ValueError("Upload grants are bounded and have no local path")
        return self

    @property
    def fingerprint(self) -> str:
        return sha256(self.model_dump_json().encode()).hexdigest()


def grants() -> list[SourceGrant]:
    path = get_settings().acoustic_sources_path
    if not path:
        return []
    data = json.loads(Path(path).read_text())
    result = [SourceGrant.model_validate(value) for value in data]
    if len({item.id for item in result}) != len(result):
        raise ValueError("Duplicate source grant ID")
    return result


def eligible(grant: SourceGrant, owner: str, content: str, start: int, end: int) -> bool:
    return (owner in grant.owners and str(grant.content_id) == content
            and grant.expires_at > datetime.now(timezone.utc)
            and grant.origin_ms <= start < end <= grant.end_ms
            and (grant.mode != "upload" or (start == grant.origin_ms and end == grant.end_ms)))


def resolve(owner: str, content: str, start: int, end: int) -> SourceGrant | None:
    return next((g for g in grants() if eligible(g, owner, content, start, end)), None)


def resolve_row(row: dict) -> SourceGrant | None:
    return next((g for g in grants() if g.id == row["source_id"]
                 and g.fingerprint == row["source_fingerprint"]
                 and eligible(g, row["user_id"], row["content_id"], row["start_ms"], row["end_ms"])), None)


def is_browser_capture(row: dict) -> bool:
    snapshot = row.get('snapshot', {})
    return (row.get('input_mode') == 'upload' and snapshot.get('source_kind') == 'browser_capture'
            and snapshot.get('consent_version') == 'reference-analysis-v1')


def row_available(row: dict) -> bool:
    return is_browser_capture(row) or resolve_row(row) is not None
