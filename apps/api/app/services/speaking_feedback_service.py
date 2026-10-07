"""Owner-scoped report requests and the deliberately small public projection."""

from fastapi import HTTPException
from pydantic import ValidationError

from app.integrations.speaking_feedback_repository import get_feedback_store
from app.schemas.speaking_feedback import SpeakingFeedback
from app.services.speaking_runtime_state import require_session


def public_feedback(job: dict) -> SpeakingFeedback:
    # Never spread a private job into a response. Source/controller and leases stay server-side.
    retryable = job["status"] in ("failed", "partial") and job["attempts"] < 3
    if job.get("error_code") in ("worker_version_mismatch", "input_limit"):
        retryable = False
    try:
        source = job["source"]
        return SpeakingFeedback(
            id=job["id"], session_id=job["session_id"], status=job["status"],
            input_hash=job["input_hash"], rubric_version=job["rubric_version"],
            analysis_version=job["analysis_version"], attempts=job["attempts"],
            retryable=retryable, error_code=job.get("error_code"),
            created_at=job["created_at"], updated_at=job["updated_at"],
            session=source["session"], messages=source.get("messages", []), result=job.get("result"),
        )
    except (ValidationError, KeyError, TypeError):
        raise HTTPException(503, "This report is temporarily unavailable. Please retry.") from None


def request_feedback(owner: str, session_id: str, retry: bool = False) -> SpeakingFeedback:
    session = require_session(owner, session_id)
    if session.status != "completed":
        raise HTTPException(409, "End this mission before requesting its report.")
    job = get_feedback_store().enqueue(owner, session_id, retry=retry)
    if job is None:
        raise HTTPException(404, "Speaking mission not found.")
    return public_feedback(job)


def read_feedback(owner: str, session_id: str) -> SpeakingFeedback:
    session = require_session(owner, session_id)
    if session.status != "completed":
        raise HTTPException(409, "End this mission before requesting its report.")
    job = get_feedback_store().read(owner, session_id)
    if job is None:
        raise HTTPException(404, "The report has not been requested yet.")
    return public_feedback(job)
