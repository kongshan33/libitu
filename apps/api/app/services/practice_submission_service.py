"""One browser upload, atomic registration, and unchanged separate audio purposes."""
from datetime import datetime, timezone
from hashlib import sha256
from fastapi import HTTPException
from app.schemas.practice import PracticeAttempt
from app.schemas.practice_submission import PracticeSubmission
from app.services import practice_service, practice_analysis_service


def submit(repo, recordings, owner: str, payload: PracticeSubmission, data: bytes, mime: str) -> PracticeAttempt:
    metadata = payload.analysis
    if (len(data), sha256(data).hexdigest(), mime) != (metadata.size, metadata.sha256, metadata.mime_type):
        raise HTTPException(422, 'Analysis audio does not match this take')
    signatures = {'audio/webm': data.startswith(b'\x1a\x45\xdf\xa3'), 'audio/ogg': data.startswith(b'OggS'),
                  'audio/mp4': data[4:8] == b'ftyp'}
    if not signatures.get(mime):
        raise HTTPException(415, 'Unsupported recording container')
    if payload.attempt.recording and recordings is None:
        raise HTTPException(503, 'Recording storage is unavailable. Retry shortly.')
    identifier, digest = practice_service.attempt_identity(owner, payload.attempt)
    context = repo.submission_context(owner, identifier)
    if context:
        attempt = context['attempt']
        if attempt.get('deleted_at') or attempt['request_hash'] != digest:
            raise HTTPException(409, 'Take deleted or submission changed')
    else:
        attempt = practice_service.build_attempt(repo, owner, payload.attempt)
    analysis = (context or {}).get('analysis')
    analysis_digest = sha256(metadata.model_dump_json().encode()).hexdigest()
    if analysis:
        if analysis['state'] == 'deleted' or analysis['request_hash'] != analysis_digest:
            raise HTTPException(409, 'Analysis deleted or submission changed')
    else:
        analysis = practice_analysis_service.build_analysis(attempt, metadata)
    context = repo.register_submission(owner, attempt, analysis)
    row = context['analysis']
    uploaded = False
    if row['state'] == 'awaiting_upload':
        if row.get('input_cleaned_at') or datetime.fromisoformat(row['input_expires_at']) <= datetime.now(timezone.utc):
            raise HTTPException(409, 'Analysis input expired. Record a new take.')
        repo.upload(row, data)  # Durable cloud object remains required before queueing.
        uploaded = True
    try:
        current = repo.finalize_submission(owner, identifier)
    except HTTPException as error:
        if uploaded and error.status_code == 409:
            repo.remove_audio(row)
        raise
    if uploaded and current['analysis'].get('input_cleaned_at'):
        repo.remove_audio(row)  # A competing upload must not revive cleaned inputs.
    if payload.attempt.recording:
        # Analysis can start while independent retention saves. A retry after input
        # cleanup uploads only the retained recording, never the analysis again.
        return practice_service.upload_recording(recordings, owner, identifier, data, mime)
    return PracticeAttempt.model_validate(current['attempt'])
