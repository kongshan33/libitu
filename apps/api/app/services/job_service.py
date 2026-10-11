from datetime import UTC, datetime
import logging
from threading import RLock
from uuid import NAMESPACE_URL, uuid5

from fastapi import HTTPException

from app.config import get_settings
from app.integrations import processing_queue
from app.integrations.supabase_repository import get_supabase_repository
from app.schemas.job import JobCreateRequest, ProcessingJob, ProcessingStage, ProcessingStatus
from app.services import store
from app.services.blueprint_service import create_blueprint
from app.services.transcript_formatter import caption_track_matches_text

logger = logging.getLogger(__name__)
# Inline storage is process-local. Configured storage uses atomic repository/Redis CAS.
_inline_lock = RLock()


def create_or_resume_job(payload: JobCreateRequest) -> ProcessingJob:
    version = get_settings().analysis_version
    if get_settings().queue_is_configured:
        try:
            return _enqueue_job(payload, version)
        except HTTPException:
            raise
        except Exception as error:
            raise HTTPException(503, "Processing is temporarily unavailable. Retry the same request.") from error
    with _inline_lock:
        existing = next((job for job in store.jobs.values()
                         if job.content_id == payload.content_id and job.analysis_version == version), None)
        if existing:
            if not _retry_allowed(payload, existing, legacy_retry=False):
                return existing
            current = _resume_job(existing)
        else:
            if payload.retry_failed is True:
                raise HTTPException(409, "The processing attempt no longer exists. Reload its state.")
            if payload.retry_failed is False and payload.content_id not in store.contents:
                raise HTTPException(404, "Content must be resolved before creating a processing job.")
            current = ProcessingJob(id=_job_id(payload.content_id, version), content_id=payload.content_id,
                                    analysis_version=version, status=ProcessingStatus.pending, attempt_count=1)
        store.jobs[current.id] = current
        content = store.contents.get(payload.content_id)
        transcript = store.content_transcripts.get(payload.content_id)
        if content is None or not transcript:
            result = current.model_copy(update={"status": ProcessingStatus.failed, "processing_stage": ProcessingStage.failed,
                "error_code": "content_not_found" if content is None else "transcript_unavailable",
                "error_message": "Content must be resolved before creating a processing job." if content is None else
                    "No transcript was captured. Open the YouTube transcript panel in the extension and try again.",
                "completed_at": datetime.now(UTC)})
        else:
            try:
                blueprint = create_blueprint(content, transcript)
                result = current.model_copy(update={"status": ProcessingStatus.ready, "processing_stage": ProcessingStage.completed,
                    "blueprint_id": blueprint.id, "completed_at": datetime.now(UTC)})
            except Exception:
                result = current.model_copy(update={"status": ProcessingStatus.failed, "processing_stage": ProcessingStage.failed,
                    "error_code": "processing_failed", "error_message": "Blueprint processing failed unexpectedly.",
                    "completed_at": datetime.now(UTC)})
        store.jobs[result.id] = result
        return result


def _retry_allowed(payload: JobCreateRequest, job: ProcessingJob, *, legacy_retry: bool) -> bool:
    if payload.retry_failed is None:
        return legacy_retry and job.status == ProcessingStatus.failed
    if payload.retry_failed is False:
        return False
    expected = payload.expected_attempt_count
    if expected > job.attempt_count:
        raise HTTPException(409, "The retry count is ahead of the current attempt. Reload its state.")
    return expected == job.attempt_count and job.status == ProcessingStatus.failed


def get_job(job_id: str) -> ProcessingJob | None:
    if not get_settings().queue_is_configured:
        return store.jobs.get(job_id)
    repository = get_supabase_repository()
    cached = processing_queue.get_job(job_id)
    if repository is None:
        return cached
    durable = repository.get_job(job_id)
    # Preview lives only in Redis. Accept it only for the same durable generation/state.
    if durable and cached and (cached.content_id, cached.analysis_version, cached.attempt_count, cached.status) == (
        durable.content_id, durable.analysis_version, durable.attempt_count, durable.status):
        return cached
    return durable


def _enqueue_job(payload: JobCreateRequest, version: str) -> ProcessingJob:
    repository = get_supabase_repository()
    backend = repository or processing_queue
    existing = backend.find_job(payload.content_id, version)
    if existing and (existing.content_id != payload.content_id or existing.analysis_version != version):
        raise HTTPException(409, "The processing identity changed. Reload its state.")
    if existing is None:
        if payload.retry_failed is True:
            raise HTTPException(409, "The processing attempt no longer exists. Reload its state.")
        content = repository.get_content(payload.content_id) if repository else processing_queue.get_content(payload.content_id)
        if content is None:
            if payload.retry_failed is None:
                # Legacy callers receive their original failed-job response;
                # do not insert a dangling foreign key into durable storage.
                return ProcessingJob(id=_job_id(payload.content_id, version), content_id=payload.content_id,
                    analysis_version=version, status=ProcessingStatus.failed, processing_stage=ProcessingStage.failed,
                    error_code="content_not_found", error_message="Content must be resolved before creating a processing job.")
            raise HTTPException(404, "Content must be resolved before creating a processing job.")
        existing = backend.create_job_once(ProcessingJob(id=_job_id(payload.content_id, version),
            content_id=payload.content_id, analysis_version=version, status=ProcessingStatus.pending, attempt_count=1))
    elif _retry_allowed(payload, existing, legacy_retry=True) or (
        payload.retry_failed is None and existing.status == ProcessingStatus.ready
        and _caption_source_changed(payload.content_id, version)
    ):
        updated = backend.compare_and_swap_job(existing, _resume_job(existing))
        existing = updated or backend.find_job(payload.content_id, version)
        if existing is None:
            raise HTTPException(409, "The processing attempt changed. Reload its state.")
    # Publish only to the cache. Never upsert an old read back over a durable CAS.
    processing_queue.save_job(existing)
    if existing.status in (ProcessingStatus.pending, ProcessingStatus.processing):
        processing_queue.enqueue(existing.id)
    return existing


def _caption_source_changed(content_id: str, analysis_version: str) -> bool:
    """A timing-only upgrade is free; different spoken words need fresh analysis."""
    try:
        queued = processing_queue.get_content(content_id)
        if queued is None or queued.caption_track is None:
            return False
        blueprint = processing_queue.get_blueprint(content_id, analysis_version)
        if blueprint is None:
            repository = get_supabase_repository()
            blueprint = repository.get_blueprint(content_id, analysis_version) if repository is not None else None
    except Exception as error:
        # A failed optional probe is not evidence of changed spoken text. Keep
        # the ready job; primary job/blueprint reads still report their errors.
        logger.warning("Optional caption source comparison failed: %s", type(error).__name__)
        return False
    if blueprint is None:
        return True
    text = "\n".join(
        "".join(part if isinstance(part, str) else part.text for part in line.parts)
        for line in blueprint.transcript
    )
    return not caption_track_matches_text(queued.caption_track, text, queued.content.language)


def _job_id(content_id: str, analysis_version: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"processing-job:{content_id}:{analysis_version}"))


def _resume_job(job: ProcessingJob) -> ProcessingJob:
    return job.model_copy(
        update={
            "status": ProcessingStatus.pending,
            "attempt_count": job.attempt_count + 1,
            "processing_stage": ProcessingStage.queued,
            "blueprint_id": None,
            "error_code": None,
            "error_message": None,
            "analysis_preview": None,
            "queued_at": datetime.now(UTC),
            "started_at": None,
            "completed_at": None,
            "stage_timings_ms": {},
        }
    )
