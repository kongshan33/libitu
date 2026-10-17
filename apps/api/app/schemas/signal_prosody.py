"""Descriptive server acoustic previews; never pronunciation grades."""
from typing import Literal
from pydantic import Field
from app.schemas.acoustic_base import StrictModel

SIGNAL_VERSION = "server-prominence-v1"
BoundarySource = Literal["subtitle_word", "asr_word", "mfa"]


class WordBoundary(StrictModel):
    text: str
    start_sec: float = Field(ge=0)
    end_sec: float = Field(gt=0)
    source_index: int | None = Field(default=None, ge=0)


class ProminenceWord(WordBoundary):
    value: float | None = None
    sensitivity_range: list[float] = Field(default_factory=list, max_length=2)
    uncertain: bool = True
    reasons: list[str] = Field(default_factory=list)


class SignalProsody(StrictModel):
    version: Literal["server-prominence-v1"] = SIGNAL_VERSION
    feature_version: Literal["server-praat-energy-10ms-v1"] = "server-praat-energy-10ms-v1"
    aggregation_version: Literal["positive-cwt-p90-perturb50ms-v1"] = "positive-cwt-p90-perturb50ms-v1"
    boundary_source: BoundarySource
    duration_evaluated: bool = False
    duration_sec: float = Field(gt=0)
    # Display curves are 50ms samples of the full 10ms computation. The complete
    # raw F0/energy evidence remains in the private acoustic checkpoint.
    time_basis: Literal["sentence_seconds"] = "sentence_seconds"
    time_step_sec: Literal[0.05] = 0.05
    pitch_st: list[float | None] = Field(default_factory=list, max_length=12001)
    prominence: list[float | None] = Field(default_factory=list, max_length=12001)
    words: list[ProminenceWord] = Field(default_factory=list, max_length=1024)
    reasons: list[str] = Field(default_factory=list)
    experimental: Literal[True] = True


class SignalPair(StrictModel):
    learner: SignalProsody
    reference: SignalProsody | None = None
