from types import SimpleNamespace

from app.integrations import processing_queue
from app.schemas.blueprint import Blueprint
from app.schemas.job import JobCreateRequest, ProcessingJob, ProcessingStage, ProcessingStatus
from app.services import job_service


def test_pending_job_is_reenqueued(monkeypatch) -> None:
    existing = ProcessingJob(
        id="job-pending",
        content_id="content-pending",
        status=ProcessingStatus.pending,
        analysis_version="mvp-v2",
    )
    enqueued: list[str] = []
    monkeypatch.setattr(
        job_service,
        "get_settings",
        lambda: SimpleNamespace(analysis_version="mvp-v2", queue_is_configured=True),
    )
    monkeypatch.setattr(job_service.processing_queue, "find_job", lambda *_args: existing)
    monkeypatch.setattr(job_service.processing_queue, "enqueue", enqueued.append)
    monkeypatch.setattr(job_service.processing_queue, "save_job", lambda _job: None)

    result = job_service.create_or_resume_job(JobCreateRequest(content_id=existing.content_id))

    assert result == existing
    assert enqueued == [existing.id]


def test_failed_job_is_reset_before_reenqueue(monkeypatch) -> None:
    existing = ProcessingJob(
        id="job-failed",
        content_id="content-failed",
        status=ProcessingStatus.failed,
        processing_stage=ProcessingStage.failed,
        analysis_version="mvp-v2",
        attempt_count=1,
        error_code="analysis_provider_failed",
        error_message="Provider timeout.",
    )
    saved: list[ProcessingJob] = []
    enqueued: list[str] = []
    monkeypatch.setattr(
        job_service,
        "get_settings",
        lambda: SimpleNamespace(analysis_version="mvp-v2", queue_is_configured=True),
    )
    monkeypatch.setattr(job_service.processing_queue, "find_job", lambda *_args: existing)
    monkeypatch.setattr(job_service.processing_queue, "compare_and_swap_job", lambda _old, new: new)
    monkeypatch.setattr(job_service.processing_queue, "save_job", saved.append)
    monkeypatch.setattr(job_service.processing_queue, "enqueue", enqueued.append)

    result = job_service.create_or_resume_job(JobCreateRequest(content_id=existing.content_id))

    assert result.status == ProcessingStatus.pending
    assert result.processing_stage == ProcessingStage.queued
    assert result.error_code is None
    assert result.completed_at is None
    assert saved == [result]
    assert enqueued == [existing.id]


def test_blueprint_cache_keys_include_analysis_version(monkeypatch) -> None:
    stored: dict[str, dict] = {}
    monkeypatch.setattr(
        processing_queue,
        "_set_json",
        lambda key, payload: stored.__setitem__(key, payload),
    )
    monkeypatch.setattr(processing_queue, "_get_json", stored.get)
    blueprint = Blueprint(
        id="blueprint-v2",
        content_id="content-versioned",
        analysis_version="mvp-v2",
        title="Versioned blueprint",
        summary="A versioned result.",
        logic_flow=[],
        chapters=[],
        transcript=[],
        corpus_items=[],
        key_points=[],
        scenario_suggestions=[],
    )

    processing_queue.save_blueprint(blueprint)

    assert processing_queue.get_blueprint(blueprint.content_id, "mvp-v2") == blueprint
    assert processing_queue.get_blueprint(blueprint.content_id, "mvp-v3") is None
