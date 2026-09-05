from datetime import UTC, datetime
from uuid import NAMESPACE_URL, uuid5

from app.config import get_settings
from app.integrations import processing_queue
from app.integrations.supabase_repository import get_supabase_repository
from app.schemas.job import JobCreateRequest, ProcessingJob, ProcessingStage, ProcessingStatus
from app.services import store
from app.services.blueprint_service import create_blueprint


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
        if existing.status == ProcessingStatus.failed:
            existing = _resume_job(existing)
            _save_queued_job(existing)
        if existing.status != ProcessingStatus.ready:
            processing_queue.enqueue(existing.id)
        return existing

    repository = get_supabase_repository()
    persisted = repository.find_job(payload.content_id, analysis_version) if repository is not None else None
    if persisted is not None:
        if persisted.status == ProcessingStatus.ready:
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
