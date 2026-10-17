from datetime import datetime, timedelta, timezone
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import NAMESPACE_URL, uuid5
import json
import wave

from fastapi import HTTPException

from app.config import get_settings
from app.integrations.reference_repository import ReferenceRepository
from app.schemas.reference import MAX_SEGMENT_MS, PrepareReference, PrepareCapture, ReferenceView, SentenceSnapshot
from app.services.acoustics import sources
from app.services.acoustics.audio import AudioFailure, RATE, normalize
from app.services.acoustics.reference_prosody import reference_identity, reference_version
from app.services.blueprint_service import get_blueprint, personalize_blueprint


def snapshot(repo: ReferenceRepository, owner: str, content: str, segment_id: str) -> dict:
    if not repo.source_available(owner, content):
        raise HTTPException(404, "Reference source not found")
    blueprint = get_blueprint(content)
    # The public blueprint route derives current sentence identities and segment
    # ranges from recovered captions. References must snapshot that same view.
    if blueprint is not None:
        blueprint = personalize_blueprint(blueprint, learner_level=None)
    segment = next((s for s in blueprint.segments if s.id == segment_id), None) if blueprint else None
    if segment is None or segment.start_ms is None or segment.end_ms is None:
        raise HTTPException(409, "Return to Stage 1 and select a current timed segment.")
    if segment.end_ms - segment.start_ms > MAX_SEGMENT_MS:
        raise HTTPException(422, "Reference preparation supports segments up to ten minutes.")
    first, last = segment.transcript_start_index, segment.transcript_end_index
    if first is None or last is None or not (0 <= first < last <= len(blueprint.transcript)):
        raise HTTPException(409, "Shared sentence boundaries are unavailable.")
    sentences = []
    for line in blueprint.transcript[first:last]:
        if (not line.id or line.start_ms is None or line.end_ms is None
                or line.start_ms < segment.start_ms or line.end_ms > segment.end_ms):
            raise HTTPException(409, "Sentence timing changed. Select the segment again.")
        sentences.append(SentenceSnapshot(id=line.id, text="".join(p if isinstance(p, str) else p.text for p in line.parts),
                                          start_ms=line.start_ms, end_ms=line.end_ms,
                                          word_timings=line.word_timings or []).model_dump())
    if len({s['id'] for s in sentences}) != len(sentences):
        raise HTTPException(409, "Shared sentence identity is ambiguous.")
    return {"start_ms": segment.start_ms, "end_ms": segment.end_ms, "sentences": sentences,
            "reference_version": f"{blueprint.analysis_version}:{blueprint.segmentation_version}:{blueprint.caption_fingerprint}"}


def owned(repo: ReferenceRepository, owner: str, reference: str, *, allow_deleted: bool = False) -> dict:
    row = repo.get(owner, reference)
    if row is None:
        raise HTTPException(404, "Reference not found")
    if allow_deleted:
        return row
    if row['state'] == 'deleted' or datetime.fromisoformat(row['expires_at']) <= datetime.now(timezone.utc):
        raise HTTPException(410, "This reference has expired or been deleted.")
    if not repo.source_available(owner, row['content_id']) or not sources.row_available(row):
        raise HTTPException(403, "This reference source is no longer available.")
    return row


def prepare_capture(repo: ReferenceRepository, owner: str, payload: PrepareCapture) -> ReferenceView:
    content = str(payload.content_id)
    data = snapshot(repo, owner, content, payload.segment_id)
    sentence = next((s for s in data['sentences'] if s['id'] == payload.sentence_id), None)
    if not sentence or sentence['start_ms'] != payload.start_ms or sentence['end_ms'] != payload.end_ms:
        raise HTTPException(409, 'The captured range no longer matches this sentence.')
    if payload.end_ms - payload.start_ms > 60_000:
        raise HTTPException(422, 'Capture analysis supports sentences up to 60 seconds.')
    settings = get_settings()
    identity = reference_identity(settings)
    data = {**data, 'sentences': [sentence], 'start_ms': payload.start_ms, 'end_ms': payload.end_ms,
            'source_kind': 'browser_capture', 'capture_id': payload.capture_id,
            'consent_version': payload.consent_version, 'input_bytes': payload.size,
            **identity}
    fingerprint = sha256(json.dumps([owner, content, data, payload.sha256], sort_keys=True).encode()).hexdigest()
    identifier = str(uuid5(NAMESPACE_URL, f'browser-reference:{fingerprint}'))
    # Identical retries reuse the live generation. Explicit preparation after
    # deletion/expiry gets a new identity without reviving historical references.
    for _ in range(32):
        existing = repo.get(owner, identifier)
        if existing is None or (existing['state'] != 'deleted'
                and datetime.fromisoformat(existing['expires_at']) > datetime.now(timezone.utc)):
            break
        identifier = str(uuid5(NAMESPACE_URL, f'browser-reference:{fingerprint}:after:{identifier}'))
    else:
        raise HTTPException(409, 'Capture this sentence again to prepare a new reference.')
    if repo.get(owner, identifier) is None:
        repo.create({'id': identifier, 'user_id': owner, 'content_id': content, 'segment_id': payload.segment_id,
            'source_id': 'browser_capture', 'source_fingerprint': fingerprint, 'input_mode': 'upload',
            'input_sha256': payload.sha256, 'analysis_version': reference_version(settings),
            'snapshot': data, 'start_ms': payload.start_ms, 'end_ms': payload.end_ms, 'state': 'awaiting_upload',
            'expires_at': (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()})
    return ReferenceView.model_validate(owned(repo, owner, identifier))


def latest_capture(repo: ReferenceRepository, owner: str, content: str, segment: str, sentence_id: str) -> ReferenceView | None:
    data = snapshot(repo, owner, content, segment)
    sentence = next((s for s in data['sentences'] if s['id'] == sentence_id), None)
    if not sentence:
        raise HTTPException(404, 'Sentence not found')
    settings = get_settings()
    identity, version = reference_identity(settings), reference_version(settings)
    for row in repo.recent_captures(owner, content, segment):
        if sources.is_browser_capture(row) and row['analysis_version'] == version \
                and all(row['snapshot'].get(key) == value for key, value in identity.items()) \
                and row['snapshot'].get('reference_version') == data['reference_version'] \
                and row['snapshot'].get('sentences') == [sentence]:
            return ReferenceView.model_validate(owned(repo, owner, row['id']))
    return None


def prepare(repo: ReferenceRepository, owner: str, payload: PrepareReference) -> ReferenceView:
    content = str(payload.content_id)
    data = snapshot(repo, owner, content, payload.segment_id)
    grant = sources.resolve(owner, content, data['start_ms'], data['end_ms'])
    if grant is None:
        raise HTTPException(409, "A permitted file reference is not available for this segment.")
    settings = get_settings()
    data = {**data, **reference_identity(settings)}
    identity = json.dumps([owner, grant.fingerprint, data], sort_keys=True)
    identifier = str(uuid5(NAMESPACE_URL, identity))
    existing = repo.get(owner, identifier)
    if existing is None:
        expiry = min(grant.expires_at, datetime.now(timezone.utc) + timedelta(days=30))
        existing = repo.create({"id": identifier, "user_id": owner, "content_id": content, "segment_id": payload.segment_id,
            "source_id": grant.id, "source_fingerprint": grant.fingerprint, "input_mode": grant.mode,
            "input_sha256": grant.sha256, "analysis_version": reference_version(settings),
            "snapshot": data, "start_ms": data['start_ms'], "end_ms": data['end_ms'],
            "state": "queued" if grant.mode == "file" else "awaiting_upload", "expires_at": expiry.isoformat()})
    if existing['state'] == 'deleted' or datetime.fromisoformat(existing['expires_at']) <= datetime.now(timezone.utc):
        raise HTTPException(410, "This reference was deleted or expired. A renewed source grant is required.")
    return ReferenceView.model_validate(existing)


def upload(repo: ReferenceRepository, owner: str, identifier: str, data: bytes) -> ReferenceView:
    row = owned(repo, owner, identifier)
    grant = sources.resolve_row(row)
    browser = sources.is_browser_capture(row)
    if row['input_mode'] != 'upload' or (not browser and grant is None):
        raise HTTPException(409, "This source does not accept browser uploads.")
    if len(data) != (row['snapshot']['input_bytes'] if browser else grant.size) or sha256(data).hexdigest() != row['input_sha256']:
        raise HTTPException(422, "Audio does not match the registered reference source.")
    if row['audio_ready']:
        return ReferenceView.model_validate(row)
    if row['state'] != 'awaiting_upload':
        raise HTTPException(409, "Reference upload is no longer active.")
    if browser:
        try:
            with wave.open(BytesIO(data)) as uploaded:
                actual_ms = uploaded.getnframes() / uploaded.getframerate() * 1000
            if abs(actual_ms - (row['end_ms'] - row['start_ms'])) > 100:
                raise HTTPException(422, 'The captured audio duration does not match the sentence.')
        except (wave.Error, EOFError) as error:
            raise HTTPException(415, 'Captured references must be WAV audio.') from error
    with TemporaryDirectory(prefix='libitu-reference-upload-') as directory:
        source, target = Path(directory) / 'input', Path(directory) / 'reference.wav'
        source.write_bytes(data)
        try:
            normalize(source, target, 0, row['end_ms'] - row['start_ms'])
        except AudioFailure as error:
            raise HTTPException(422, error.code) from error
        normalized = target.read_bytes()
        repo.upload(row, normalized)
        current = repo.control(owner, identifier, 'upload', sha256(normalized).hexdigest())
    if current is None or current['state'] == 'deleted':
        repo.remove_audio(row)
        raise HTTPException(410, "Reference was deleted during upload.")
    if not current['audio_ready']:
        # Cancel/expiry won the race; bytes are not acknowledged as ready.
        raise HTTPException(409, "Reference upload was interrupted. Retry preparation.")
    return ReferenceView.model_validate(current)


def sentence_audio(repo: ReferenceRepository, row: dict, sentence_id: str | None) -> bytes:
    if not row['audio_ready']:
        raise HTTPException(409, "Reference audio is still being prepared.")
    sentence = next((s for s in row['snapshot']['sentences'] if s['id'] == sentence_id), None)
    if sentence_id is not None and sentence is None:
        raise HTTPException(404, "Sentence not found in this reference version.")
    raw = repo.read_audio(row)
    if sha256(raw).hexdigest() != row['audio_sha256']:
        raise HTTPException(503, "Reference audio integrity check failed.")
    if sentence_id is None:
        return raw
    with wave.open(BytesIO(raw)) as audio:
        start = round((sentence['start_ms'] - row['start_ms']) * RATE / 1000)
        end = round((sentence['end_ms'] - row['start_ms']) * RATE / 1000)
        audio.setpos(start)
        frames = audio.readframes(end - start)
    output = BytesIO()
    with wave.open(output, 'wb') as audio:
        audio.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
        audio.writeframes(frames)
    return output.getvalue()
