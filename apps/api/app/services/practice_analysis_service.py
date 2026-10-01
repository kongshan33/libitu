from datetime import datetime, timezone
from hashlib import sha256

from fastapi import HTTPException
from app.config import get_settings
from app.integrations.practice_analysis_repository import PracticeAnalysisRepository
from app.integrations.reference_repository import get_reference_repository
from app.schemas.practice_analysis import ANALYSIS_VERSION, AnalysisCreate, AnalysisView
from app.services.acoustics import engine, sources


def attempt_owned(repo: PracticeAnalysisRepository, owner: str, attempt: str) -> dict:
    row = repo.get_attempt(owner, attempt)
    if not row or row.get("deleted_at"):
        raise HTTPException(404, "Practice attempt not found")
    return row


def owned(repo: PracticeAnalysisRepository, owner: str, attempt: str) -> dict:
    attempt_owned(repo, owner, attempt)
    row = repo.get(owner, attempt)
    if not row:
        raise HTTPException(404, "This take has no server analysis")
    return row


def reference_for(attempt: dict, reference_id: str | None) -> dict | None:
    if not reference_id:
        return None
    repo = get_reference_repository()
    row = repo.get(attempt["user_id"], reference_id) if repo else None
    if not row or row["state"] == "deleted" or row["content_id"] != str(attempt["content_id"]) \
        or not repo.source_available(attempt["user_id"], row["content_id"]) \
        or datetime.fromisoformat(row["expires_at"]) <= datetime.now(timezone.utc) or not sources.row_available(row):
        return None
    sentence = next((s for s in row["snapshot"]["sentences"] if s["id"] == attempt["sentence_id"]), None)
    if not sentence or any(sentence[key] != attempt[target] for key, target in (
        ("text", "sentence_text"), ("start_ms", "start_ms"), ("end_ms", "end_ms"))):
        return None
    return row


def view(repo: PracticeAnalysisRepository, owner: str, row: dict) -> AnalysisView:
    attempt = attempt_owned(repo, owner, row["id"])
    result = row.get("result")
    reference = reference_for(attempt, row.get('reference_id')) if row['state'] == 'queued' else None
    waiting = reference and reference['state'] in ('awaiting_upload', 'queued', 'processing')
    if result and row.get("reference_id") and reference_for(attempt, row["reference_id"]) is None:
        result = {**result, "reference": None, "assessment": None, "comparison": "unavailable", "reason": "reference_unavailable"}
    return AnalysisView(id=row["id"], sentence_id=attempt["sentence_id"], state=row["state"],
        analysis_version=row["analysis_version"], result=result, error_code='reference_pending' if waiting else row.get("error_code"), created_at=row["created_at"],
        retryable=row["state"] in ("failed", "cancelled") and not row.get("input_cleaned_at")
        and datetime.fromisoformat(row["input_expires_at"]) > datetime.now(timezone.utc))


def create(repo: PracticeAnalysisRepository, owner: str, attempt_id: str, payload: AnalysisCreate) -> AnalysisView:
    attempt = attempt_owned(repo, owner, attempt_id)
    digest = sha256(payload.model_dump_json().encode()).hexdigest()
    row = repo.get(owner, attempt_id)
    if not row:
        settings = get_settings()
        if not settings.practice_asr_model_path or not settings.practice_asr_model_sha256:
            raise HTTPException(503, "Server speech analysis is not configured yet. Keep this page open and retry later.")
        # A reference may expire while the browser uploads a take. Preserve learner
        # analysis without binding unavailable, changed or another account's audio.
        reference_id = str(payload.reference_id) if payload.reference_id else None
        if reference_id and reference_for(attempt, reference_id) is None:
            reference_id = None
        row = repo.create({"id": attempt_id, "user_id": owner,
            "reference_id": reference_id, "request_hash": digest,
            "input_sha256": payload.sha256, "input_bytes": payload.size, "input_mime": payload.mime_type,
            "consent_version": payload.consent_version, "analysis_version": ANALYSIS_VERSION, "state": "awaiting_upload",
            "snapshot": {"text": attempt["sentence_text"], "sentence_id": attempt["sentence_id"],
                "engine": engine.engine_identity(settings), "asr_sha256": settings.practice_asr_model_sha256}})
    if row["request_hash"] != digest or row["state"] == "deleted":
        raise HTTPException(409, "This analysis was already registered or deleted. Record a new take.")
    return view(repo, owner, row)


def upload(repo: PracticeAnalysisRepository, owner: str, attempt_id: str, data: bytes, mime: str) -> AnalysisView:
    row = owned(repo, owner, attempt_id)
    if row["state"] == "deleted" or row.get("input_cleaned_at") or datetime.fromisoformat(row["input_expires_at"]) <= datetime.now(timezone.utc):
        raise HTTPException(409, "Analysis input is no longer accepted. Record a new take.")
    if len(data) != row["input_bytes"] or sha256(data).hexdigest() != row["input_sha256"] or mime != row["input_mime"]:
        raise HTTPException(422, "Analysis audio does not match this take")
    signatures = {"audio/webm": data.startswith(b"\x1a\x45\xdf\xa3"), "audio/ogg": data.startswith(b"OggS"), "audio/mp4": data[4:8] == b"ftyp"}
    if not signatures.get(mime):
        raise HTTPException(415, "Unsupported recording container")
    if row["state"] == "awaiting_upload":
        repo.upload(row, data)
        repo.control(owner, attempt_id, "upload")
    current = repo.get(owner, attempt_id)
    attempt = repo.get_attempt(owner, attempt_id)
    if not current or current["state"] == "deleted" or not attempt or attempt.get("deleted_at") or current.get("input_cleaned_at"):
        repo.remove_audio(row)
        raise HTTPException(409, "Analysis was deleted or finished")
    return view(repo, owner, current)
