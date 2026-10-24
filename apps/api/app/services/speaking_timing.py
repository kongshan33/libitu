"""Bounded, content-free timings for the Mission preparation HTTP path."""

import json
import logging
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from threading import Lock
from time import perf_counter
from typing import Iterator, Literal
from uuid import uuid4


PreparationOperation = Literal["plan", "practice_plan", "create", "workspace"]
PreparationPhase = Literal[
    "input_read", "model_generation", "model_repair", "validation", "save_plan",
    "create", "workspace_session_read", "workspace_runtime_read",
]
_PHASES = frozenset({
    "input_read", "model_generation", "model_repair", "validation", "save_plan",
    "create", "workspace_session_read", "workspace_runtime_read",
})
_OPERATIONS = frozenset({"plan", "practice_plan", "create", "workspace"})
_LOGGER = logging.getLogger(__name__)


@dataclass
class PreparationTiming:
    operation: PreparationOperation
    request_id: str = field(default_factory=lambda: uuid4().hex)
    started_at: float = field(default_factory=lambda: perf_counter())
    durations_ms: dict[str, float] = field(default_factory=dict)
    _lock: Lock = field(default_factory=Lock, repr=False)
    _finished: bool = False

    def add(self, phase: PreparationPhase, elapsed_ms: float) -> None:
        if phase not in _PHASES:
            raise ValueError("Unknown preparation timing phase")
        with self._lock:
            if not self._finished:
                self.durations_ms[phase] = self.durations_ms.get(phase, 0.0) + max(0.0, elapsed_ms)

    def finish(self, status_code: int) -> dict[str, str]:
        """Finish once, logging only fixed labels, generated IDs and numbers."""
        with self._lock:
            if not self._finished:
                self.durations_ms["total"] = max(0.0, (perf_counter() - self.started_at) * 1000)
                self._finished = True
                _LOGGER.info("speaking_preparation_timing %s", json.dumps({
                    "request_id": self.request_id,
                    "operation": self.operation,
                    "status_code": status_code,
                    "outcome": "success" if status_code < 400 else "failed",
                    "durations_ms": {name: round(value, 2) for name, value in self.durations_ms.items()},
                }, separators=(",", ":")))
            return {
                "X-Request-ID": self.request_id,
                "Server-Timing": ", ".join(
                    f"{name};dur={elapsed:.2f}" for name, elapsed in self.durations_ms.items()
                ),
            }


_CURRENT: ContextVar[PreparationTiming | None] = ContextVar("speaking_preparation_timing", default=None)


def current_request_id() -> str | None:
    timing = _CURRENT.get()
    return timing.request_id if timing else None


@contextmanager
def request_timing(operation: PreparationOperation) -> Iterator[PreparationTiming]:
    """Context propagates to FastAPI worker threads, without shared request state."""
    if operation not in _OPERATIONS:
        raise ValueError("Unknown preparation operation")
    timing = PreparationTiming(operation)
    token = _CURRENT.set(timing)
    try:
        yield timing
    finally:
        _CURRENT.reset(token)


@contextmanager
def measure_phase(phase: PreparationPhase) -> Iterator[None]:
    if phase not in _PHASES:
        raise ValueError("Unknown preparation timing phase")
    timing = _CURRENT.get()
    started_at = perf_counter()
    try:
        yield
    finally:
        if timing:
            timing.add(phase, (perf_counter() - started_at) * 1000)
