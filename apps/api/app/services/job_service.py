from datetime import UTC, datetime
import logging
from uuid import NAMESPACE_URL, uuid5

from app.config import get_settings
from app.integrations import processing_queue
from app.integrations.supabase_repository import get_supabase_repository
from app.schemas.job import JobCreateRequest, ProcessingJob, ProcessingStage, ProcessingStatus
from app.services import store
from app.services.blueprint_service import create_blueprint
from app.services.transcript_formatter import caption_track_matches_text


logger = logging.getLogger(__name__)


def create_or_resume_job(payload: JobCreateRequest) -> ProcessingJob:
    analysis_version = get_settings().analysis_version
    if get_settings().queue_is_configured:
        return _enqueue_job(payload, analysis_version)

    for job in store.jobs.values():
        if job.content_id == payload.content_id and job.analysis_version == analysis_version:
            return job

    content = store.contents.get(payload.content_id)
    transcript = store.content_transcripts.get(payload.content_id)
    if content is None:
        job = ProcessingJob(
            id=_job_id(payload.content_id, analysis_version),
            content_id=payload.content_id,
            status=ProcessingStatus.failed,
            analysis_version=analysis_version,
            error_message="Content must be resolved before creating a processing job.",
        )
        store.jobs[job.id] = job
        return job

    if not transcript:
        job = ProcessingJob(
            id=_job_id(payload.content_id, analysis_version),
            content_id=payload.content_id,
            status=ProcessingStatus.failed,
            analysis_version=analysis_version,
            error_message="No transcript was captured. Open the YouTube transcript panel in the extension and try again.",
        )
        store.jobs[job.id] = job
        return job

    blueprint = create_blueprint(content, transcript)
    job = ProcessingJob(
        id=_job_id(payload.content_id, analysis_version),
        content_id=payload.content_id,
        status=ProcessingStatus.ready,
        analysis_version=analysis_version,
        blueprint_id=blueprint.id,
    )
    store.jobs[job.id] = job
    return job


def get_job(job_id: str) -> ProcessingJob | None:
    if get_settings().queue_is_configured:
        queued_job = processing_queue.get_job(job_id)
        if queued_job is not None:
            return queued_job
        repository = get_supabase_repository()
        return repository.get_job(job_id) if repository is not None else None
    return store.jobs.get(job_id)


def _enqueue_job(payload: JobCreateRequest, analysis_version: str) -> ProcessingJob:
    existing = processing_queue.find_job(payload.content_id, analysis_version)
    if existing is not None:
        if existing.status == ProcessingStatus.failed or (
            existing.status == ProcessingStatus.ready
            and _caption_source_changed(payload.content_id, analysis_version)
        ):
            existing = _resume_job(existing)
            _save_queued_job(existing)
        if existing.status != ProcessingStatus.ready:
            processing_queue.enqueue(existing.id)
        return existing

    repository = get_supabase_repository()
    persisted = repository.find_job(payload.content_id, analysis_version) if repository is not None else None
    if persisted is not None:
        if persisted.status == ProcessingStatus.ready and not _caption_source_changed(payload.content_id, analysis_version):
            processing_queue.save_job(persisted)
            return persisted
        resumed = _resume_job(persisted)
        _save_queued_job(resumed)
        processing_queue.enqueue(resumed.id)
        return resumed

    if processing_queue.get_content(payload.content_id) is None:
        job = ProcessingJob(
            id=_job_id(payload.content_id, analysis_version),
            content_id=payload.content_id,
            status=ProcessingStatus.failed,
            analysis_version=analysis_version,
            error_code="content_not_found",
            error_message="Content must be resolved before creating a processing job.",
        )
        _save_queued_job(job)
        return job

    job = ProcessingJob(
        id=_job_id(payload.content_id, analysis_version),
        content_id=payload.content_id,
        status=ProcessingStatus.pending,
        analysis_version=analysis_version,
    )
    _save_queued_job(job)
    processing_queue.enqueue(job.id)
    return job


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


def _save_queued_job(job: ProcessingJob) -> None:
    processing_queue.save_job(job)
    repository = get_supabase_repository()
    if repository is not None:
        repository.save_job(job)


def _job_id(content_id: str, analysis_version: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"processing-job:{content_id}:{analysis_version}"))


def _resume_job(job: ProcessingJob) -> ProcessingJob:
    return job.model_copy(
        update={
            "status": ProcessingStatus.pending,
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
