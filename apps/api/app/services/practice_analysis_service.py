from datetime import datetime, timezone
from hashlib import sha256
from typing import Literal

from fastapi import HTTPException
from app.config import get_settings
from app.integrations.practice_analysis_repository import PracticeAnalysisRepository
from app.integrations.practice_repository import PracticeRepository
from app.integrations.reference_repository import get_reference_repository
from app.schemas.practice_analysis import GATED_ANALYSIS_VERSION, AnalysisCreate, AnalysisView, LayerAvailability, WordCheck
from app.schemas.practice import RecognitionFeedback
from app.services.acoustics.word_check import analysis_scope
from app.services.acoustics import engine, sources
from app.schemas.signal_prosody import SignalPair, SignalProsody, SIGNAL_VERSION


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


def read(repo: PracticeAnalysisRepository, owner: str, attempt: str) -> AnalysisView | None:
    snapshot = repo.read_snapshot(owner, attempt)
    if not snapshot:
        raise HTTPException(404, "Practice attempt not found")
    row = snapshot["analysis"]
    if row is None:
        return None
    # The RPC checks owner, parent deletion and source visibility in one MVCC
    # snapshot. Operator grants remain live local configuration, never cached.
    reference = valid_reference(snapshot["attempt"], snapshot["reference"])
    return format_view(snapshot["attempt"], row, reference)


def control(repo: PracticeAnalysisRepository, owner: str, attempt: str, action: Literal["retry", "cancel"]) -> AnalysisView:
    row = owned(repo, owner, attempt)
    if action == "retry" and not view(repo, owner, row).retryable:
        raise HTTPException(409, "This analysis cannot be retried. Record a new take.")
    current = repo.control(owner, attempt, action)
    if current is None:
        raise HTTPException(404, "This take has no server analysis")
    return view(repo, owner, current)


def delete(repo: PracticeAnalysisRepository, owner: str, attempt: str) -> None:
    row = owned(repo, owner, attempt)
    # Persist the tombstone/fence before touching the audio. Repeated deletion or
    # the existing cleanup worker can finish an interrupted object removal.
    if repo.control(owner, attempt, "delete") is None:
        raise HTTPException(404, "This take has no server analysis")
    repo.remove_audio(row)


def reference_for(attempt: dict, reference_id: str | None) -> dict | None:
    if not reference_id:
        return None
    repo = get_reference_repository()
    row = repo.get(attempt["user_id"], reference_id) if repo else None
    if row and row["state"] != "deleted" and row["content_id"] == str(attempt["content_id"]) \
            and repo.source_available(attempt["user_id"], row["content_id"]):
        return valid_reference(attempt, row)
    return None


def valid_reference(attempt: dict, row: dict | None) -> dict | None:
    """Validate a source-visible, owner-scoped Reference without database reads."""
    if not row or row["state"] == "deleted" or row["content_id"] != str(attempt["content_id"]) \
        or datetime.fromisoformat(row["expires_at"]) <= datetime.now(timezone.utc) or not sources.row_available(row):
        return None
    sentence = next((s for s in row["snapshot"]["sentences"] if s["id"] == attempt["sentence_id"]), None)
    if not sentence or any(sentence[key] != attempt[target] for key, target in (
        ("text", "sentence_text"), ("start_ms", "start_ms"), ("end_ms", "end_ms"))):
        return None
    return row


def view(repo: PracticeAnalysisRepository, owner: str, row: dict) -> AnalysisView:
    attempt = attempt_owned(repo, owner, row["id"])
    needs_reference = row["state"] == "queued" or row.get("result") or row.get("coarse_checkpoint")
    reference = reference_for(attempt, row.get("reference_id")) if needs_reference else None
    return format_view(attempt, row, reference)


def format_view(attempt: dict, row: dict, reference: dict | None) -> AnalysisView:
    """Pure projection shared by status snapshots and mutation acknowledgments."""
    result = row.get("result")
    waiting = row["state"] == "queued" and reference and reference['state'] in ('awaiting_upload', 'queued', 'processing') \
        and (row['analysis_version'] != GATED_ANALYSIS_VERSION or row.get('phase') == 'waiting_reference')
    if result and row.get("reference_id") and reference is None:
        result = {**result, "reference": None, "assessment": None, "comparison": "unavailable", "reason": "reference_unavailable"}
    check = WordCheck.model_validate(row['word_check']) if row.get('word_check') else None
    scope = analysis_scope(check) if check else None
    coarse = None
    if scope == "all_layers" and row.get("coarse_checkpoint") and row['state'] != 'deleted':
        coarse = SignalPair(learner=SignalProsody.model_validate(row['coarse_checkpoint']))
        bound = reference
        if bound and bound.get('audio_ready') and bound.get('snapshot', {}).get('engine') == row['snapshot'].get('engine'):
            sentence = next((r for r in bound.get('results', []) if r['sentence_id'] == attempt['sentence_id']), None)
            candidate = sentence.get('coarse') if sentence else None
            if candidate and candidate.get('version') == coarse.learner.version \
                    and candidate.get('feature_version') == coarse.learner.feature_version \
                    and candidate.get('aggregation_version') == coarse.learner.aggregation_version:
                coarse.reference = SignalProsody.model_validate(candidate)
    return AnalysisView(id=row["id"], sentence_id=attempt["sentence_id"], state=row["state"],
        analysis_version=row["analysis_version"], result=result, error_code='reference_pending' if waiting else row.get("error_code"), created_at=row["created_at"],
        retryable=row["state"] in ("failed", "cancelled") and not row.get("input_cleaned_at")
        and datetime.fromisoformat(row["input_expires_at"]) > datetime.now(timezone.utc),
        phase=row.get('phase'), word_check=check, analysis_scope=scope,
        layers=layer_availability(row, result, check) if row['analysis_version'] == GATED_ANALYSIS_VERSION else None,
        recognition_feedback=attempt.get('recognition_feedback'), coarse=coarse)

def mark_recognition_error(repo: PracticeAnalysisRepository, owner: str, attempt_id: str) -> RecognitionFeedback:
    attempt = attempt_owned(repo, owner, attempt_id)
    if attempt.get('recognition_feedback'):
        return RecognitionFeedback.model_validate(attempt['recognition_feedback'])
    analysis = repo.get(owner, attempt_id)
    check = WordCheck.model_validate(analysis['word_check']) if analysis and analysis.get('word_check') else None
    if not check or analysis['state'] == 'deleted' or check.status != 'reliable' \
            or all(op.kind == 'matched' for op in check.operations):
        raise HTTPException(409, "Recognition feedback requires a reliable word check with differences")
    row = repo.mark_recognition_error(owner, attempt_id)
    if not row:
        attempt_owned(repo, owner, attempt_id)  # Distinguish a concurrent parent deletion.
        raise HTTPException(409, "The word check is no longer available")
    return RecognitionFeedback.model_validate(row['recognition_feedback'])


def layer_availability(row: dict, result: dict | None, check: WordCheck | None) -> dict[str, LayerAvailability]:
    scope = analysis_scope(check) if check else "none"
    output = {}
    for layer in ("sound", "rhythm", "melody"):
        if scope == "none" or scope == "sound_only" and layer != "sound":
            reason = "word_check_pending" if not check else check.reason if check.status != 'reliable' else "match_threshold_not_met"
            output[layer] = LayerAvailability(state="locked", reason=reason)
        elif layer != 'sound' and row.get('coarse_checkpoint') and row['state'] != 'deleted' \
                and (not result or (row.get('reference_id') and result.get('comparison') == 'unavailable')
                     or (result.get('learner') or {}).get('alignment_status') != 'aligned'
                     or row['state'] in ('queued', 'processing', 'failed', 'cancelled')):
            field = 'pitch_st' if layer == 'melody' else 'prominence'
            available = any(value is not None for value in row['coarse_checkpoint'].get(field, []))
            output[layer] = LayerAvailability(state='partial' if available else 'unavailable', reason='preliminary' if available else 'insufficient_evidence')
        elif row['state'] in ('awaiting_upload', 'queued', 'processing'):
            output[layer] = LayerAvailability(state="pending", reason="reference_pending" if row.get('phase') == 'waiting_reference' else None)
        elif not result or row['state'] in ('failed', 'cancelled', 'deleted'):
            output[layer] = LayerAvailability(state="unavailable", reason=row.get('error_code') or row['state'])
        else:
            assessment = result.get('assessment') or {}
            measured = (any(item.get('pairs') for item in assessment.get('sound', [])) if layer == 'sound'
                        else (assessment.get(layer) or {}).get('value') is not None)
            learner = result.get('learner') or {}
            words = [word for word in learner.get('words', []) if word.get('source_index') is not None]
            preview = (any(w.get('phones') for w in words) if layer == 'sound' else
                       len(words) >= 3 if layer == 'rhythm' else any(
                           p is not None for w in words for p in w.get('pitch_curve_st', [])))
            partial = check.matched_count != check.source_count or any(op.kind == 'inserted' for op in check.operations)
            state = ('partial' if partial else 'available') if measured else 'partial' if preview else 'unavailable'
            output[layer] = LayerAvailability(state=state, reason=None if measured else "learner_only" if preview and not row.get("reference_id") else result.get('reason') or "insufficient_evidence")
    return output


def build_analysis(attempt: dict, payload: AnalysisCreate) -> dict:
    attempt_id, owner = attempt['id'], attempt['user_id']
    digest = sha256(payload.model_dump_json().encode()).hexdigest()
    settings = get_settings()
    if not settings.practice_asr_model_path or not settings.practice_asr_model_sha256:
        raise HTTPException(503, "Server speech analysis is not configured yet. Keep this page open and retry later.")
    # A reference may expire while the browser uploads a take. Preserve learner
    # analysis without binding unavailable, changed or another account's audio.
    reference_id = str(payload.reference_id) if payload.reference_id else None
    if reference_id and reference_for(attempt, reference_id) is None:
        reference_id = None
    return {"id": attempt_id, "user_id": owner,
        "reference_id": reference_id, "request_hash": digest,
        "input_sha256": payload.sha256, "input_bytes": payload.size, "input_mime": payload.mime_type,
        "consent_version": payload.consent_version, "analysis_version": GATED_ANALYSIS_VERSION, "state": "awaiting_upload",
        "phase": "awaiting_upload",
        "snapshot": {"text": attempt["sentence_text"], "sentence_id": attempt["sentence_id"],
            "progressive_version": SIGNAL_VERSION,
            "engine": engine.engine_identity(settings), "asr_sha256": settings.practice_asr_model_sha256}}


def create(repo: PracticeAnalysisRepository, owner: str, attempt_id: str, payload: AnalysisCreate) -> AnalysisView:
    attempt = attempt_owned(repo, owner, attempt_id)
    digest = sha256(payload.model_dump_json().encode()).hexdigest()
    row = repo.get(owner, attempt_id)
    if not row:
        row = repo.create(build_analysis(attempt, payload))
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


def upload_with_recording(repo: PracticeAnalysisRepository, recordings: PracticeRepository | None,
                          owner: str, attempt_id: str, data: bytes, mime: str) -> AnalysisView:
    """Receive bytes once; each purpose retains its own consent and deletion lifecycle."""
    from app.services import practice_service

    if recordings is None:
        raise HTTPException(503, "Recording storage is unavailable. Retry shortly.")
    row = owned(repo, owner, attempt_id)
    attempt = practice_service.owned(recordings, owner, attempt_id)
    if row['state'] == 'deleted' or attempt['recording_state'] not in ('pending', 'ready'):
        raise HTTPException(409, "Recording retention or analysis is no longer enabled")
    digest = sha256(data).hexdigest()
    if any((size != len(data) or hashed != digest or kind != mime) for size, hashed, kind in (
            (row['input_bytes'], row['input_sha256'], row['input_mime']),
            (attempt['recording_bytes'], attempt['recording_sha256'], attempt['recording_mime']))):
        raise HTTPException(422, "Audio does not match the registered analysis and recording")
    if row['state'] == 'awaiting_upload':
        # Queue analysis first. The worker can use the local handoff while retention saves.
        upload(repo, owner, attempt_id, data, mime)
    # If retention failed after analysis was queued/completed, retry only retention.
    # Never recreate cleaned analysis inputs or reset a finished analysis.
    practice_service.upload_recording(recordings, owner, attempt_id, data, mime)
    return view(repo, owner, owned(repo, owner, attempt_id))
