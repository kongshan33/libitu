from app.schemas.analysis import (
    AnalysisCorpusItem,
    AnalysisLogicNode,
    BlueprintAnalysis,
)
from app.schemas.content import ContentKind, ContentResolveResponse
from app.schemas.job import ProcessingJob, ProcessingStatus
from app.workers import blueprint_worker
from app.integrations.deepseek import AnalysisProviderError
from app.services.transcript_formatter import ParsedTranscriptLine


def test_worker_fetches_missing_transcript_and_saves_ai_blueprint(monkeypatch) -> None:
    content = ContentResolveResponse(
        content_id="7e4219cb-d8b0-5dd4-a561-0f23faacf477",
        kind=ContentKind.youtube,
        normalized_key="youtube:video-worker-test",
        source_url="https://www.youtube.com/watch?v=video-worker-test",
        title="Worker test video",
        language="en",
    )
    job = ProcessingJob(
        id="db52e189-ad0e-4c62-af48-a8178bbd66cc",
        content_id=content.content_id,
        status=ProcessingStatus.pending,
        analysis_version="mvp-v6",
    )
    jobs = {job.id: job}
    saved_jobs = []
    saved_blueprints = []
    saved_transcripts = []

    monkeypatch.setattr(blueprint_worker.processing_queue, "get_job", jobs.get)
    monkeypatch.setattr(blueprint_worker.processing_queue, "acquire_lock", lambda _job_id: True)
    monkeypatch.setattr(blueprint_worker.processing_queue, "release_lock", lambda _job_id: None)
    monkeypatch.setattr(
        blueprint_worker.processing_queue,
        "get_content",
        lambda _content_id: blueprint_worker.processing_queue.QueuedContent(content, None),
    )
    monkeypatch.setattr(
        blueprint_worker.processing_queue,
        "save_content",
        lambda _content, transcript: saved_transcripts.append(transcript),
    )

    def save_job(next_job: ProcessingJob) -> None:
        saved_jobs.append(next_job)
        jobs[next_job.id] = next_job

    monkeypatch.setattr(blueprint_worker.processing_queue, "save_job", save_job)
    monkeypatch.setattr(blueprint_worker.processing_queue, "save_blueprint", saved_blueprints.append)

    def fake_fetch(video_id: str, language: str | None) -> str:
        assert video_id == "video-worker-test"
        assert language == "en"
        return "0:03\tTo be fair, queue processing is useful."

    def fake_analyze(
        _content: ContentResolveResponse,
        transcript: str,
        _on_progress,
    ) -> BlueprintAnalysis:
        assert transcript == "0:03\tTo be fair, queue processing is useful."
        return BlueprintAnalysis(
            summary="The speaker explains why queued processing is useful.",
            chapters=["Queue processing"],
            logic_flow=[
                AnalysisLogicNode(
                    title="Main claim",
                    subtitle="Queued processing keeps API requests short.",
                    timestamp="0:03",
                )
            ],
            corpus_items=[
                AnalysisCorpusItem(
                    kind="chunk",
                    text="To be fair",
                    source_text="To be fair",
                    meaning="concedes a point before a claim",
                    usage_note="Use before presenting a different view.",
                    tags=["acknowledging", "softening"],
                    pattern_family=None,
                    timestamp="0:03",
                    level="B1",
                    register="professional",
                    scenario_tags=["workplace", "disagreement"],
                    phonology_note=None,
                    naturalness_score=4,
                    transferability_score=4,
                    learning_value_score=3,
                ),
                AnalysisCorpusItem(
                    kind="structure",
                    text="[process] is useful",
                    source_text="queue processing is useful",
                    meaning="frames an architectural benefit",
                    usage_note="Use to describe why a process matters.",
                    tags=["framing"],
                    pattern_family="framed-explanation",
                    timestamp="0:03",
                    level="B1",
                    register="professional",
                    scenario_tags=["workplace", "explanation"],
                    phonology_note=None,
                    naturalness_score=3,
                    transferability_score=4,
                    learning_value_score=4,
                ),
            ],
            key_points=["Processing runs outside the API request."],
            scenario_suggestions=["Explain an architecture choice"],
        )

    def fake_format(transcript: str, language: str | None, on_progress):
        assert language == "en"
        lines = [ParsedTranscriptLine(time="0:03", text="To be fair, queue processing is useful.")]
        on_progress(lines)
        return lines

    blueprint_worker.process_job(
        job.id,
        analyzer=fake_analyze,
        transcript_fetcher=fake_fetch,
        transcript_formatter=fake_format,
    )

    assert saved_transcripts == ["0:03\tTo be fair, queue processing is useful."]
    transcript_previews = [
        saved_job.analysis_preview.transcript_lines
        for saved_job in saved_jobs
        if saved_job.analysis_preview is not None
    ]
    assert transcript_previews[0][0].model_dump() == {
        "time": "0:03",
        "text": "To be fair, queue processing is useful.",
    }
    assert len(saved_blueprints) == 1
    assert saved_blueprints[0].title == "Worker test video"
    assert saved_blueprints[0].transcript[0].time == "0:03"
    highlighted_parts = [part for part in saved_blueprints[0].transcript[0].parts if not isinstance(part, str)]
    assert [part.kind for part in highlighted_parts] == ["chunk", "structure"]
    assert jobs[job.id].status == ProcessingStatus.ready
    assert jobs[job.id].processing_stage.value == "completed"
    assert jobs[job.id].attempt_count == 1
    assert jobs[job.id].blueprint_id == saved_blueprints[0].id
    assert jobs[job.id].started_at is not None
    assert jobs[job.id].completed_at is not None
    assert set(jobs[job.id].stage_timings_ms) >= {
        "loading_content",
        "fetching_transcript",
        "formatting_transcript",
        "analyzing",
        "building_blueprint",
        "persisting",
        "total",
    }


def test_worker_rejects_obsolete_analysis_without_calling_model(monkeypatch) -> None:
    job = ProcessingJob(
        id="9cfe6c6b-cbfd-4d8f-a903-44b27e4411fc",
        content_id="7e4219cb-d8b0-5dd4-a561-0f23faacf477",
        status=ProcessingStatus.pending,
        analysis_version="mvp-v1",
    )
    jobs = {job.id: job}
    monkeypatch.setattr(blueprint_worker.processing_queue, "get_job", jobs.get)
    monkeypatch.setattr(blueprint_worker.processing_queue, "acquire_lock", lambda _job_id: True)
    monkeypatch.setattr(blueprint_worker.processing_queue, "release_lock", lambda _job_id: None)
    monkeypatch.setattr(
        blueprint_worker.processing_queue,
        "save_job",
        lambda next_job: jobs.__setitem__(next_job.id, next_job),
    )

    def unexpected_analyzer(_content, _transcript, _on_progress):
        raise AssertionError("The model must not run for obsolete jobs.")

    blueprint_worker.process_job(job.id, analyzer=unexpected_analyzer)

    assert jobs[job.id].status == ProcessingStatus.failed
    assert jobs[job.id].error_code == "analysis_version_obsolete"
    assert jobs[job.id].completed_at is not None


def test_worker_persists_provider_error_code_and_analysis_timing(monkeypatch) -> None:
    content = ContentResolveResponse(
        content_id="content-provider-error",
        kind=ContentKind.youtube,
        normalized_key="youtube:provider-error",
        title="Provider error",
        transcript_text="0:01\tA transcript is already available.",
    )
    job = ProcessingJob(
        id="job-provider-error",
        content_id=content.content_id,
        status=ProcessingStatus.pending,
        analysis_version="mvp-v6",
    )
    jobs = {job.id: job}
    monkeypatch.setattr(blueprint_worker.processing_queue, "get_job", jobs.get)
    monkeypatch.setattr(blueprint_worker.processing_queue, "acquire_lock", lambda _job_id: True)
    monkeypatch.setattr(blueprint_worker.processing_queue, "release_lock", lambda _job_id: None)
    monkeypatch.setattr(
        blueprint_worker.processing_queue,
        "get_content",
        lambda _content_id: blueprint_worker.processing_queue.QueuedContent(
            content,
            "0:01\tA transcript is already available.",
        ),
    )
    monkeypatch.setattr(
        blueprint_worker.processing_queue,
        "save_job",
        lambda next_job: jobs.__setitem__(next_job.id, next_job),
    )

    def fail_analysis(_content, _transcript, _on_progress):
        raise AnalysisProviderError(
            "DeepSeek stopped before the blueprint JSON was complete. Please retry.",
            code="analysis_response_truncated",
            diagnostic="finish_reason=length",
        )

    blueprint_worker.process_job(job.id, analyzer=fail_analysis)

    failed = jobs[job.id]
    assert failed.status == ProcessingStatus.failed
    assert failed.error_code == "analysis_response_truncated"
    assert "analyzing" in failed.stage_timings_ms
    assert "total" in failed.stage_timings_ms
