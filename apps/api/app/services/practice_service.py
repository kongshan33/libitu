from datetime import datetime, timezone
from hashlib import sha256
import json
from uuid import NAMESPACE_URL, uuid5

from fastapi import HTTPException

from app.integrations.practice_repository import PracticeRepository
from app.schemas.practice import AttemptCreate, PracticeAttempt, PracticeProgress, TextSupport, WordMatchCounts
from app.services.acoustics.word_check import checked_tokens
from app.services.blueprint_service import find_blueprint_sentence, get_blueprint


def directory_progress(repo: PracticeRepository, owner: str, content: str) -> PracticeProgress:
    practiced = repo.practiced_sentences(owner, content)
    ids = set(practiced)
    best: dict[str, WordMatchCounts] = {}
    for row in repo.reliable_word_checks(owner, content):
        sentence = row["shadow_attempts"]["sentence_id"]
        matched, total = row.get("matched_count"), row.get("source_count")
        if sentence not in ids or type(matched) is not int or type(total) is not int or not 0 <= matched <= total or total <= 0:
            continue
        previous = best.get(sentence)
        if previous is None or matched * previous.source_count > previous.matched_count * total:
            best[sentence] = WordMatchCounts(matched_count=matched, source_count=total)
    return PracticeProgress(practiced_sentence_ids=practiced, best_word_matches=best)


def owned(repo: PracticeRepository, owner: str, attempt: str, *, include_deleted: bool = False) -> dict:
    row = repo.get(owner, attempt)
    if row is None or (row.get("deleted_at") and not include_deleted):
        raise HTTPException(404, "Practice attempt not found")
    return row


def attempt_identity(owner: str, payload: AttemptCreate) -> tuple[str, str]:
    identifier = str(uuid5(NAMESPACE_URL, json.dumps(["shadow-v1", owner, str(payload.client_id)])))
    digest = sha256(payload.model_dump_json(exclude={"text_support"} if payload.text_support is None else set()).encode()).hexdigest()
    return identifier, digest


def build_attempt(repo: PracticeRepository, owner: str, payload: AttemptCreate) -> dict:
    attempt_id, digest = attempt_identity(owner, payload)
    content_id = str(payload.content_id)
    if not repo.source_available(owner, content_id):
        raise HTTPException(404, "Practice source not found")
    blueprint = get_blueprint(content_id)
    sentence = find_blueprint_sentence(blueprint, payload.sentence_id) if blueprint else None
    if sentence is None or sentence.start_ms is None or sentence.end_ms is None:
        raise HTTPException(409, "This sentence is no longer available. Return to Stage 1 and select it again.")
    text = "".join(part if isinstance(part, str) else part.text for part in sentence.parts)
    # Trusted source bounds allow a full 2x Quick turn; preserve legacy 60s takes.
    if payload.duration_ms > max(61_000, 2 * (sentence.end_ms - sentence.start_ms) + 1_000):
        raise HTTPException(422, "Recording exceeds twice this sentence duration")
    support = payload.text_support
    if support is not None:
        validate_text_support(support, text)
    retention = payload.recording
    return {
        "id": attempt_id, "user_id": owner, "content_id": content_id,
        "sentence_id": sentence.id, "sentence_text": text,
        "start_ms": sentence.start_ms, "end_ms": sentence.end_ms,
        "reference_version": f"{blueprint.analysis_version}:{sentence.segmentation_version}",
        "duration_ms": payload.duration_ms, "playback_rate": payload.playback_rate,
        "text_visible": bool(support.visible_source_indices_at_start) if support is not None else payload.text_visible,
        "request_hash": digest,
        "text_support": support.model_dump(mode="json") if support is not None else None,
        "recording_state": "pending" if retention else "none",
        "recording_sha256": retention.sha256 if retention else None,
        "recording_bytes": retention.size if retention else None,
        "recording_mime": retention.mime_type if retention else None,
        "recording_consent_at": datetime.now(timezone.utc).isoformat() if retention else None,
        "consent_version": retention.consent_version if retention else None,
    }


def create_attempt(repo: PracticeRepository, owner: str, payload: AttemptCreate) -> PracticeAttempt:
    attempt_id, digest = attempt_identity(owner, payload)
    existing = repo.get(owner, attempt_id)
    if existing is None:
        existing = repo.create(build_attempt(repo, owner, payload))
    if not existing or existing.get("deleted_at"):
        raise HTTPException(409, "This attempt has been deleted")
    if existing["request_hash"] != digest:
        raise HTTPException(409, "This attempt ID was already used for a different recording")
    return PracticeAttempt.model_validate(existing)


def validate_text_support(support: TextSupport, text: str) -> None:
    count = len(checked_tokens(text))
    visible = set(support.visible_source_indices_at_start)
    revealed = set(support.revealed_source_indices)
    if any(index >= count for index in visible | revealed):
        raise HTTPException(422, "Text support position is outside this sentence")
    if support.mode == "hidden" and not visible.issubset(revealed):
        raise HTTPException(422, "Visible hidden-mode words must be included in revealed positions")
    if support.mode == "full" and visible != set(range(count)):
        raise HTTPException(422, "Full text must include every source position at recording start")


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
        changes.update({"deleted_at": row.get("deleted_at") or datetime.now(timezone.utc).isoformat(),
                        "sentence_text": "", "text_support": None, "recognition_feedback": None})
    repo.update(owner, attempt, changes)
    # A failed removal returns 503. The tombstone permits safe retry and blocks replay/re-upload.
    repo.remove_audio(row)
