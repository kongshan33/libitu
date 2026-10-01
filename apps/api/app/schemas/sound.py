from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


SoundKind = Literal["linking", "weak_form", "flap", "assimilation", "elision"]


class SoundToken(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int = Field(ge=0, lt=300)
    text: str = Field(min_length=1, max_length=6000)
    # UTF-16 code units, matching JavaScript String.slice, with an exclusive end.
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    pronunciations: list[list[str]] = Field(max_length=4)
    ipa: list[str] = Field(max_length=4)
    status: Literal["known", "unknown", "ambiguous"]


class SoundCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=250)
    kind: SoundKind
    token_start: int = Field(ge=0, lt=300)
    token_end: int = Field(gt=0, le=300)
    source_text: str = Field(min_length=1, max_length=6000)
    phonemes_before: str
    phonemes_after: str
    explanation: str
    conditions: list[str] = Field(min_length=1, max_length=12)
    rule_id: str
    status: Literal["candidate"] = "candidate"


class SoundCoverage(BaseModel):
    known: int = Field(ge=0, le=300)
    total: int = Field(ge=0, le=300)


class SentenceSound(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal["sound-rules-v1"] = "sound-rules-v1"
    content_id: str
    sentence_id: str
    sentence_text: str = Field(max_length=6000)
    dialect: Literal["en-US"] = "en-US"
    provider: Literal["cmudict-rules"] = "cmudict-rules"
    lexicon_version: str
    tokens: list[SoundToken] = Field(max_length=300)
    candidates: list[SoundCandidate] = Field(max_length=80)
    coverage: SoundCoverage
    warnings: list[str] = Field(max_length=20)
