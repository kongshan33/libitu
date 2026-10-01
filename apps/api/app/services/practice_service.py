from datetime import datetime, timezone
from hashlib import sha256
import json
from uuid import NAMESPACE_URL, uuid5

from fastapi import HTTPException

from app.integrations.practice_repository import PracticeRepository
from app.schemas.practice import AttemptCreate, PracticeAttempt
from app.services.blueprint_service import find_blueprint_sentence, get_blueprint


def owned(repo: PracticeRepository, owner: str, attempt: str, *, include_deleted: bool = False) -> dict:
    row = repo.get(owner, attempt)
    if row is None or (row.get("deleted_at") and not include_deleted):
        raise HTTPException(404, "Practice attempt not found")
    return row


def create_attempt(repo: PracticeRepository, owner: str, payload: AttemptCreate) -> PracticeAttempt:
    attempt_id = str(uuid5(NAMESPACE_URL, json.dumps(["shadow-v1", owner, str(payload.client_id)])))
    digest = sha256(payload.model_dump_json().encode()).hexdigest()
    existing = repo.get(owner, attempt_id)
    if existing is None:
        content_id = str(payload.content_id)
        if not repo.source_available(owner, content_id):
            raise HTTPException(404, "Practice source not found")
        blueprint = get_blueprint(content_id)
        sentence = find_blueprint_sentence(blueprint, payload.sentence_id) if blueprint else None
        if sentence is None or sentence.start_ms is None or sentence.end_ms is None:
            raise HTTPException(409, "This sentence is no longer available. Return to Stage 1 and select it again.")
        retention = payload.recording
        existing = repo.create({
            "id": attempt_id, "user_id": owner, "content_id": content_id,
            "sentence_id": sentence.id, "sentence_text": "".join(part if isinstance(part, str) else part.text for part in sentence.parts),
            "start_ms": sentence.start_ms, "end_ms": sentence.end_ms,
            "reference_version": f"{blueprint.analysis_version}:{sentence.segmentation_version}",
            "duration_ms": payload.duration_ms, "playback_rate": payload.playback_rate,
            "text_visible": payload.text_visible, "request_hash": digest,
            "recording_state": "pending" if retention else "none",
            "recording_sha256": retention.sha256 if retention else None,
            "recording_bytes": retention.size if retention else None,
            "recording_mime": retention.mime_type if retention else None,
            "recording_consent_at": datetime.now(timezone.utc).isoformat() if retention else None,
            "consent_version": retention.consent_version if retention else None,
        })
    if not existing or existing.get("deleted_at"):
        raise HTTPException(409, "This attempt has been deleted")
    if existing["request_hash"] != digest:
        raise HTTPException(409, "This attempt ID was already used for a different recording")
    return PracticeAttempt.model_validate(existing)


def upload_recording(repo: PracticeRepository, owner: str, attempt: str, data: bytes, mime: str) -> PracticeAttempt:
    row = owned(repo, owner, attempt)
    if row["recording_state"] not in ("pending", "ready"):
        raise HTTPException(409, "Recording retention is not enabled for this attempt")
    if mime != row["recording_mime"] or len(data) != row["recording_bytes"] or sha256(data).hexdigest() != row["recording_sha256"]:
        raise HTTPException(422, "Recording does not match this attempt")
    signatures = {"audio/webm": data.startswith(b"\x1a\x45\xdf\xa3"),
                  "audio/ogg": data.startswith(b"OggS"), "audio/mp4": data[4:8] == b"ftyp"}
    if not signatures.get(mime):
        raise HTTPException(415, "Unsupported recording container")
    if row["recording_state"] == "pending":
        repo.upload(row, data)
        repo.update(owner, attempt, {"recording_state": "ready"}, pending_only=True)
    current = owned(repo, owner, attempt, include_deleted=True)
    if current.get("deleted_at") or current["recording_state"] == "deleted":
        # Deletion wins over an upload that was already in flight on another worker.
        repo.remove_audio(row)
        raise HTTPException(409, "Recording was deleted")
    return PracticeAttempt.model_validate(current)


def delete_recording(repo: PracticeRepository, owner: str, attempt: str, *, entire_attempt: bool = False) -> None:
    row = owned(repo, owner, attempt, include_deleted=True)
    changes = {"recording_state": "deleted"}
    if entire_attempt:
        changes.update({"deleted_at": row.get("deleted_at") or datetime.now(timezone.utc).isoformat(), "sentence_text": ""})
    repo.update(owner, attempt, changes)
    # A failed removal returns 503. The tombstone permits safe retry and blocks replay/re-upload.
    repo.remove_audio(row)
