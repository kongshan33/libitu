"""Durable, leased Stage 5 jobs; the inline adapter is an explicit test fixture."""

import hashlib
import json
import re
import time
from copy import deepcopy
from datetime import datetime, timezone
from typing import Protocol
from uuid import UUID, uuid4

import httpx
from fastapi import HTTPException

from app.config import get_settings
from app.integrations.speaking_runtime_repository import _document, _identity, _inline_runtime_store, _json_value
from app.integrations.supabase_repository import SupabaseRepository, get_supabase_repository
from app.schemas.speaking_feedback import ANALYSIS_VERSION, RUBRIC_VERSION
from app.services import store

LEASE_SECONDS = 120
MAX_ATTEMPTS = 3
MAX_SOURCE_BYTES = 2 * 1024 * 1024
_NON_RETRYABLE = {"input_limit", "worker_version_mismatch"}
_STATUSES = {"queued", "processing", "ready", "partial", "insufficient_data", "failed"}
_TERMINAL = _STATUSES - {"queued", "processing"}
_MESSAGE_FIELDS = {"id", "ordinal", "role", "text", "input_source", "status", "revision",
                   "provider_item_id", "response_id", "client_turn_id", "created_at", "started_at", "finalized_at"}
_EVIDENCE_FIELDS = {"id", "session_item_id", "message_id", "transcript_revision", "start", "end",
                    "quote", "match_type", "appropriateness", "prompted", "assistance", "reason"}
_EXPOSURE_FIELDS = {"id", "target_item_id", "source_message_id", "source_revision", "after_turn",
                    "kind", "level", "visible_at", "overlap", "response_id", "scope", "certainty"}
_ATTEMPT_FIELDS = {"id", "response_id", "sent_at", "bound_at", "send_status", "presented", "presented_at"}
_TARGET_STATE_FIELDS = {"skipped", "reason", "skipped_at", "restored_at", "version"}


class FeedbackStore(Protocol):
    def enqueue(self, owner: str, session_id: str, retry: bool = False) -> dict | None: ...
    def read(self, owner: str, session_id: str) -> dict | None: ...
    def claim(self, job_id: str | None = None) -> dict | None: ...
    def complete(self, job_id: str, lease_token: str, status: str, result: dict | None,
                 error_code: str | None = None) -> bool: ...
    def pending_sessions(self, limit: int = 10) -> list[dict]: ...


def _invalid() -> HTTPException:
    return HTTPException(422, "Invalid speaking feedback state.")


def _unavailable() -> HTTPException:
    return HTTPException(503, "Speaking feedback persistence is unavailable. Please retry.")


def _uuid(value: str) -> str:
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise _invalid() from None


def _payload(value: dict, source: bool = False) -> dict:
    try:
        if not source:
            return _document(value)
        if not isinstance(value, dict):
            raise ValueError
        _json_value(value)
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode("utf-8")) > MAX_SOURCE_BYTES:
            raise ValueError
        return json.loads(encoded)
    except (HTTPException, ValueError, TypeError, UnicodeError, RecursionError):
        raise _invalid() from None


def _result(status: str, result: dict | None, error_code: str | None) -> dict | None:
    if (not isinstance(status, str) or status not in _TERMINAL
            or (error_code is not None and (not isinstance(error_code, str)
                or re.fullmatch(r"[a-z][a-z0-9_]{0,63}", error_code) is None))
            or (result is None and status != "failed")):
        raise _invalid()
    return _payload(result) if result is not None else None


def _limit(value: int) -> int:
    if type(value) is not int or not 1 <= value <= 100:
        raise _invalid()
    return value


def _job(value: object) -> dict | None:
    if value is None:
        return None
    try:
        if (not isinstance(value, dict) or value.get("status") not in _STATUSES
                or type(value.get("attempts")) is not int or not 0 <= value["attempts"] <= MAX_ATTEMPTS
                or not isinstance(value.get("user_id"), str) or not value["user_id"]
                or not isinstance(value.get("rubric_version"), str) or not 1 <= len(value["rubric_version"]) <= 80
                or not isinstance(value.get("analysis_version"), str) or not 1 <= len(value["analysis_version"]) <= 80
                or not isinstance(value.get("input_hash"), str)
                or re.fullmatch(r"[a-f0-9]{64}", value["input_hash"]) is None):
            raise ValueError
        _uuid(value["id"])
        _uuid(value["session_id"])
        source = _payload(value["source"], source=True)
        if (not isinstance(source.get("session"), dict) or not isinstance(source.get("messages"), list)
                or not isinstance(source.get("evidence"), list)
                or not isinstance(source.get("controller", {}).get("exposures"), list)):
            raise ValueError
        if value.get("result") is not None:
            _payload(value["result"])
        for key in ("created_at", "updated_at"):
            datetime.fromisoformat(value[key].replace("Z", "+00:00"))
        if value.get("lease_token") is not None:
            _uuid(value["lease_token"])
        return deepcopy(value)
    except (KeyError, ValueError, TypeError, AttributeError, HTTPException):
        raise _unavailable() from None


class SupabaseFeedbackStore:
    def __init__(self, database: SupabaseRepository) -> None:
        self.database = database

    def _rpc(self, name: str, payload: dict):
        try:
            return self.database._request("POST", f"/rpc/{name}", json=payload).json()
        except httpx.HTTPStatusError as exc:
            try:
                response = exc.response.json()
                code = response.get("code") if isinstance(response, dict) else None
            except ValueError:
                code = None
            if code == "PT409":
                raise HTTPException(409, "End this session before requesting feedback.") from None
            if code == "PT422":
                raise _invalid() from None
            raise _unavailable() from None
        except (httpx.RequestError, ValueError, TypeError):
            raise _unavailable() from None

    def enqueue(self, owner: str, session_id: str, retry: bool = False) -> dict | None:
        session_id = _identity(owner, session_id)
        if type(retry) is not bool:
            raise _invalid()
        return _job(self._rpc("enqueue_speaking_feedback", {
            "p_user_id": owner, "p_session_id": session_id, "p_retry": retry,
        }))

    def read(self, owner: str, session_id: str) -> dict | None:
        session_id = _identity(owner, session_id)
        return _job(self._rpc("read_speaking_feedback", {
            "p_user_id": owner, "p_session_id": session_id,
        }))

    def claim(self, job_id: str | None = None) -> dict | None:
        return _job(self._rpc("claim_speaking_feedback", {"p_job_id": _uuid(job_id) if job_id else None}))

    def complete(self, job_id: str, lease_token: str, status: str, result: dict | None,
                 error_code: str | None = None) -> bool:
        result = _result(status, result, error_code)
        response = self._rpc("complete_speaking_feedback", {
            "p_job_id": _uuid(job_id), "p_lease_token": _uuid(lease_token),
            "p_status": status, "p_result": result, "p_error_code": error_code,
        })
        if type(response) is not bool:
            raise _unavailable()
        return response

    def pending_sessions(self, limit: int = 10) -> list[dict]:
        result = self._rpc("pending_speaking_feedback_sessions", {"p_limit": _limit(limit)})
        if not isinstance(result, list) or len(result) > limit:
            raise _unavailable()
        try:
            return [{"user_id": row["user_id"], "session_id": _identity(row["user_id"], row["session_id"])}
                    for row in result]
        except (HTTPException, TypeError, KeyError):
            raise _unavailable() from None


def _freeze(session, document: dict) -> dict:
    def select(row, fields):
        return {key: row[key] for key in fields if key in row}

    def rows(key, fields, source=document):
        value = source.get(key, [])
        if not isinstance(value, list):
            raise _invalid()
        return [select(row, fields) for row in value if isinstance(row, dict)]

    attempts = []
    for row in document.get("teaching_attempts", []):
        if isinstance(row, dict):
            attempts.append({
                **select(row, _ATTEMPT_FIELDS),
                "policy": select(row.get("policy") or {}, {"target_item_id", "action", "support_level", "support_version"}),
                "assessment": select(row.get("assessment") or {}, {
                    "outcome", "reason", "exact_quote", "model_quote", "transfer_question_quote",
                }),
            })
    target_states = {
        target: {**select(state, _TARGET_STATE_FIELDS),
                 "history": [select(event, {"action", "at", "reason"}) for event in state.get("history", [])
                             if isinstance(event, dict)]}
        for target, state in (document.get("target_states") or {}).items() if isinstance(state, dict)
    }

    support = {}
    if isinstance(document.get("support"), dict):
        support["support"] = select(document["support"], {"level", "version"})
    if isinstance(document.get("support_history"), list):
        support["support_history"] = rows("support_history", {"level", "version", "at"})
    return _payload({"session": session.model_dump(mode="json"),
                     "messages": rows("messages", _MESSAGE_FIELDS),
                     "evidence": rows("evidence", _EVIDENCE_FIELDS),
                     "controller": {"exposures": rows("exposures", _EXPOSURE_FIELDS,
                                                      document.get("controller") or {})},
                     "teaching_attempts": attempts, "target_states": target_states, **support}, source=True)


class InlineFeedbackStore:
    """Same ownership, retry and lease semantics without a configured database."""

    def __init__(self, runtime_store=None, clock=time.time) -> None:
        self.runtime = runtime_store or _inline_runtime_store
        # Serialize source freezing and parent deletion with the runtime fixture.
        self._lock = self.runtime._lock
        self._jobs: dict[str, dict] = {}
        self._clock = clock

    def _now(self) -> str:
        return datetime.fromtimestamp(self._clock(), timezone.utc).isoformat()

    def _live(self, job: dict) -> bool:
        parent = store.speaking_sessions.get(job["session_id"])
        return parent is not None and parent.user_id == job["user_id"] and parent.status == "completed"

    def _prune(self) -> None:
        for key in [key for key, job in self._jobs.items() if not self._live(job)]:
            self._jobs.pop(key)

    def enqueue(self, owner: str, session_id: str, retry: bool = False) -> dict | None:
        session_id = _identity(owner, session_id)
        if type(retry) is not bool:
            raise _invalid()
        with self._lock:
            self._prune()
            session = store.speaking_sessions.get(session_id)
            if session is None or session.user_id != owner:
                return None
            if session.status != "completed":
                raise HTTPException(409, "End this session before requesting feedback.")
            existing = self._jobs.get(session_id)
            if existing is not None:
                if (retry and existing["status"] in {"failed", "partial"}
                        and existing["attempts"] < MAX_ATTEMPTS
                        and existing.get("error_code") not in _NON_RETRYABLE):
                    existing.update(status="queued", error_code=None, updated_at=self._now())
                return deepcopy(existing)
            state = self.runtime._read(owner, session_id)
            source = _freeze(session, state["document"] if state else {})
            encoded = json.dumps(source, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            job = {"id": str(uuid4()), "user_id": owner, "session_id": session_id, "status": "queued",
                   "source": source, "input_hash": hashlib.sha256(encoded.encode()).hexdigest(),
                   "rubric_version": RUBRIC_VERSION, "analysis_version": ANALYSIS_VERSION,
                   "attempts": 0, "created_at": self._now(), "updated_at": self._now(),
                   "lease_token": None, "lease_expires_at": None, "result": None, "error_code": None}
            self._jobs[session_id] = job
            return deepcopy(job)

    def read(self, owner: str, session_id: str) -> dict | None:
        session_id = _identity(owner, session_id)
        with self._lock:
            self._prune()
            job = self._jobs.get(session_id)
            return deepcopy(job) if job and job["user_id"] == owner else None

    def profile_summaries(self, owner: str) -> dict[str, dict]:
        """Project existing live reports without pruning, enqueueing or exposing source."""
        with self._lock:
            return {job["session_id"]: {
                **{key: deepcopy(job.get(key)) for key in (
                    "id", "session_id", "status", "rubric_version", "analysis_version",
                    "created_at", "updated_at")},
                "dimensions": deepcopy((job.get("result") or {}).get("dimensions")),
            } for job in self._jobs.values() if job["user_id"] == owner and self._live(job)}

    def claim(self, job_id: str | None = None) -> dict | None:
        job_id = _uuid(job_id) if job_id else None
        with self._lock:
            self._prune()
            for job in sorted(self._jobs.values(), key=lambda row: row["created_at"]):
                if job_id is not None and job["id"] != job_id:
                    continue
                expired = (job["status"] == "processing"
                           and datetime.fromisoformat(job["lease_expires_at"]).timestamp() <= self._clock())
                if job["status"] != "queued" and not expired:
                    continue
                if job["attempts"] >= MAX_ATTEMPTS:
                    job.update(status="failed", error_code="retry_limit_reached", lease_token=None,
                               lease_expires_at=None, updated_at=self._now())
                    continue
                job.update(status="processing", attempts=job["attempts"] + 1, lease_token=str(uuid4()),
                           lease_expires_at=datetime.fromtimestamp(self._clock() + LEASE_SECONDS,
                                                                   timezone.utc).isoformat(),
                           updated_at=self._now())
                return deepcopy(job)
            return None

    def complete(self, job_id: str, lease_token: str, status: str, result: dict | None,
                 error_code: str | None = None) -> bool:
        job_id, lease_token = _uuid(job_id), _uuid(lease_token)
        result = _result(status, result, error_code)
        with self._lock:
            self._prune()
            job = next((job for job in self._jobs.values() if job["id"] == job_id), None)
            if (job is None or job["status"] != "processing" or job["lease_token"] != lease_token
                    or datetime.fromisoformat(job["lease_expires_at"]).timestamp() <= self._clock()):
                return False
            job.update(status=status, result=result, error_code=error_code,
                       lease_token=None, lease_expires_at=None, updated_at=self._now())
            return True

    def pending_sessions(self, limit: int = 10) -> list[dict]:
        limit = _limit(limit)
        with self._lock:
            self._prune()
            return [{"user_id": session.user_id, "session_id": str(session.id)}
                    for session in sorted(store.speaking_sessions.values(), key=lambda row: row.created_at)
                    if session.status == "completed" and str(session.id) not in self._jobs
                    and str(session.id) in self.runtime._documents][:limit]


_inline_feedback_store = InlineFeedbackStore()


def get_feedback_store() -> FeedbackStore:
    try:
        database = get_supabase_repository()
    except (httpx.HTTPError, ValueError):
        raise _unavailable() from None
    if database is not None:
        return SupabaseFeedbackStore(database)
    settings = get_settings()
    if settings.supabase_server_is_configured or settings.processing_mode != "inline":
        raise _unavailable()
    return _inline_feedback_store
