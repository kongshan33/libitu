from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime
import json
from threading import Event, Thread
from time import perf_counter, sleep

import httpx

from app.config import get_settings
from app.integrations import processing_queue
from app.integrations.deepseek import AnalysisProviderError, analyze_transcript
from app.integrations.youtube_transcript import TranscriptUnavailableError, fetch_youtube_caption_track
from app.integrations.supabase_repository import get_supabase_repository
from app.schemas.analysis import (
    AnalysisTranscriptPreviewLine,
    BlueprintAnalysis,
    BlueprintAnalysisPreview,
)
from app.schemas.content import ContentKind, ContentResolveResponse
from app.schemas.captions import CaptionTrack
from app.schemas.job import ProcessingJob, ProcessingStage, ProcessingStatus
from app.services.blueprint_service import (
    create_blueprint_from_analysis,
)
from app.services.caption_source import caption_fingerprint
from app.services.transcript_formatter import (
    ParsedTranscriptLine,
    format_transcript,
    serialize_transcript,
    caption_track_to_text,
)


Analyzer = Callable[
    [ContentResolveResponse, str, Callable[[BlueprintAnalysisPreview], None] | None],
    BlueprintAnalysis,
]
TranscriptFetcher = Callable[[str, str | None], str | CaptionTrack]
TranscriptFormatter = Callable[
    [str, str | None, Callable[[list[ParsedTranscriptLine]], None] | None],
    list[ParsedTranscriptLine],
]


class JobSuperseded(Exception):
    """A newer durable generation or terminal state owns this job."""


def process_job(
    job_id: str,
    analyzer: Analyzer = analyze_transcript,
    transcript_fetcher: TranscriptFetcher = fetch_youtube_caption_track,
    transcript_formatter: TranscriptFormatter = format_transcript,
) -> None:
    if not processing_queue.acquire_lock(job_id):
        return
    current_job = None
    total_started = perf_counter()
    analysis_started: float | None = None
    try:
        # Re-read after acquiring the worker lock. A duplicate queue entry must
        # not execute a terminal failure, nor use a pre-lock pending snapshot.
        repository = get_supabase_repository()
        job = repository.get_job(job_id) if repository else processing_queue.get_job(job_id)
        if job is None or job.status in (ProcessingStatus.ready, ProcessingStatus.failed):
            return
        current_job = job
        settings = get_settings()
        if job.analysis_version != settings.analysis_version:
            _fail(
                job,
                "analysis_version_obsolete",
                f"Analysis version {job.analysis_version} is no longer processed.",
            )
            return

        current_job = job.model_copy(
            update={
                "status": ProcessingStatus.processing,
                "processing_stage": ProcessingStage.loading_content,
                "attempt_count": max(1, job.attempt_count),
                "started_at": datetime.now(UTC),
                "completed_at": None,
                "stage_timings_ms": {},
            }
        )
        _save_job(current_job)
        _log_job_event(current_job, "job_started")

        load_started = perf_counter()
        queued_content = processing_queue.get_content(job.content_id)
        if queued_content is None:
            repository = get_supabase_repository()
            queued_content = repository.get_content(job.content_id) if repository is not None else None
        if queued_content is None:
            _fail(current_job, "content_not_found", "Content state expired before processing started.")
            return
        current_job = _record_timing(current_job, ProcessingStage.loading_content, load_started)

        caption_track = queued_content.caption_track
        transcript = queued_content.transcript_text
        if not transcript and caption_track is not None:
            transcript = caption_track_to_text(caption_track)
        if not transcript:
            current_job = _transition(current_job, ProcessingStage.fetching_transcript)
            transcript_started = perf_counter()
            content = queued_content.content
            if content.kind != ContentKind.youtube:
                _fail(current_job, "transcript_unavailable", "No source text is available for analysis.")
                return
            video_id = content.normalized_key.removeprefix("youtube:")
            fetched = transcript_fetcher(video_id, content.language)
            if isinstance(fetched, CaptionTrack):
                caption_track = fetched
                transcript = caption_track_to_text(fetched)
            else:
                transcript = fetched
            _save_content(content, transcript, caption_track)
            current_job = _record_timing(
                current_job,
                ProcessingStage.fetching_transcript,
                transcript_started,
            )

        current_job = _transition(current_job, ProcessingStage.formatting_transcript)
        formatting_started = perf_counter()
        last_transcript_preview_at: float | None = None

        def update_transcript_preview(lines: list[ParsedTranscriptLine]) -> None:
            nonlocal current_job, last_transcript_preview_at
            now = perf_counter()
            if last_transcript_preview_at is not None and now - last_transcript_preview_at < 0.4:
                return
            transcript_lines = [
                AnalysisTranscriptPreviewLine(time=line.time, text=line.text, **line.metadata())
                for line in lines
            ]
            current_job = current_job.model_copy(
                update={
                    "analysis_preview": BlueprintAnalysisPreview(
                        transcript_lines=transcript_lines
                    )
                }
            )
            processing_queue.save_job(current_job)
            last_transcript_preview_at = now

        if caption_track is not None:
            formatted_lines = transcript_formatter(
                transcript, queued_content.content.language, update_transcript_preview,
                caption_track=caption_track,
            )
        else:
            # Preserve the injected/plain formatter contract for legacy providers.
            formatted_lines = transcript_formatter(
                transcript, queued_content.content.language, update_transcript_preview,
            )
        formatted_transcript = serialize_transcript(formatted_lines)
        if not formatted_transcript:
            raise TranscriptUnavailableError(
                "No meaningful transcript remains after subtitle normalization."
            )
        current_job = _record_timing(
            current_job,
            ProcessingStage.formatting_transcript,
            formatting_started,
        )
        initial_transcript_lines = [
            AnalysisTranscriptPreviewLine(time=line.time, text=line.text, **line.metadata())
            for line in formatted_lines[: settings.transcript_preview_limit]
        ]
        if initial_transcript_lines and (
            current_job.analysis_preview is None
            or current_job.analysis_preview.transcript_lines != initial_transcript_lines
        ):
            last_transcript_preview_at = None
            update_transcript_preview(formatted_lines[: settings.transcript_preview_limit])

        current_job = _transition(current_job, ProcessingStage.analyzing, durable=True)
        analysis_started = perf_counter()

        def update_analysis_preview(preview: BlueprintAnalysisPreview) -> None:
            nonlocal current_job
            preview = preview.model_copy(
                update={"transcript_lines": initial_transcript_lines}
            )
            current_job = current_job.model_copy(update={"analysis_preview": preview})
            processing_queue.save_job(current_job)

        analysis = analyzer(
            queued_content.content,
            formatted_transcript,
            update_analysis_preview,
        )
        current_job = _record_timing(current_job, ProcessingStage.analyzing, analysis_started)
        analysis_started = None

        current_job = _transition(current_job, ProcessingStage.building_blueprint)
        build_started = perf_counter()
        blueprint = create_blueprint_from_analysis(
            queued_content.content,
            transcript,
            analysis,
            current_job.analysis_version,
            formatted_transcript,
            formatted_lines=formatted_lines,
        )
        if caption_track is not None:
            blueprint = blueprint.model_copy(update={"caption_fingerprint": caption_fingerprint(caption_track)})
        current_job = _record_timing(current_job, ProcessingStage.building_blueprint, build_started)

        current_job = _transition(current_job, ProcessingStage.persisting)
        persist_started = perf_counter()
        _save_blueprint(blueprint)
        current_job = _record_timing(current_job, ProcessingStage.persisting, persist_started)
        timings = {**current_job.stage_timings_ms, "total": _elapsed_ms(total_started)}
        current_job = current_job.model_copy(
            update={
                "status": ProcessingStatus.ready,
                "processing_stage": ProcessingStage.completed,
                "blueprint_id": blueprint.id,
                "error_code": None,
                "error_message": None,
                "analysis_preview": None,
                "completed_at": datetime.now(UTC),
                "stage_timings_ms": timings,
            }
        )
        _save_job(current_job)
        _log_job_event(current_job, "job_completed")
    except JobSuperseded:
        return
    except TranscriptUnavailableError as error:
        _fail(current_job, "transcript_unavailable", str(error), total_started)
    except AnalysisProviderError as error:
        if analysis_started is not None:
            current_job = _record_timing(current_job, ProcessingStage.analyzing, analysis_started)
        _log_job_event(
            current_job,
            "analysis_provider_error",
            error_code=error.code,
            diagnostic=error.diagnostic or type(error).__name__,
        )
        _fail(current_job, error.code, str(error), total_started)
    except Exception as error:
        if current_job is None:
            raise
        _log_job_event(current_job, "job_exception", exception_type=type(error).__name__)
        _fail(current_job, "processing_failed", "Blueprint processing failed unexpectedly.", total_started)
    finally:
        processing_queue.release_lock(job_id)


def run_worker() -> None:
    settings = get_settings()
    if settings.processing_mode != "queue":
        print("Libitu blueprint worker disabled because PROCESSING_MODE is not queue.", flush=True)
        return
    if not settings.queue_is_configured:
        raise RuntimeError("Configure Upstash before starting the blueprint worker.")
    if not settings.deepseek_is_configured:
        raise RuntimeError("DEEPSEEK_API_KEY is required by the blueprint worker.")

    print(f"Libitu blueprint worker listening on {settings.processing_queue_name}", flush=True)
    stop_event = Event()
    heartbeat = Thread(target=_heartbeat_loop, args=(stop_event,), daemon=True)
    heartbeat.start()
    # Load the CPU pipeline once before accepting work, outside page/SSE requests.
    from app.integrations.sentence_syntax import get_sentence_syntax

    get_sentence_syntax("en")
    executor = ThreadPoolExecutor(
        max_workers=max(1, settings.processing_worker_concurrency),
        thread_name_prefix="blueprint-job",
    )
    futures: set[Future[None]] = set()
    try:
        while True:
            futures = {future for future in futures if not future.done()}
            if len(futures) >= max(1, settings.processing_worker_concurrency):
                sleep(0.2)
                continue
            job_id = processing_queue.dequeue()
            if job_id is None:
                sleep(1.0)
                continue
            futures.add(executor.submit(process_job, job_id))
    finally:
        stop_event.set()
        heartbeat.join(timeout=settings.worker_heartbeat_interval_seconds + 1)
        executor.shutdown(wait=True, cancel_futures=True)


def _fail(
    job: ProcessingJob,
    code: str,
    message: str,
    total_started: float | None = None,
) -> None:
    timings = dict(job.stage_timings_ms)
    if total_started is not None:
        timings["total"] = _elapsed_ms(total_started)
    failed = job.model_copy(
        update={
            "status": ProcessingStatus.failed,
            "processing_stage": ProcessingStage.failed,
            "attempt_count": max(1, job.attempt_count),
            "blueprint_id": None,
            "error_code": code,
            "error_message": message,
            "completed_at": datetime.now(UTC),
            "stage_timings_ms": timings,
        }
    )
    _save_job(failed)
    _log_job_event(failed, "job_failed")


def _save_job(job) -> None:
    repository = get_supabase_repository()
    if repository is not None:
        previous = repository.get_job(job.id)
        if previous is None or previous.status not in (ProcessingStatus.pending, ProcessingStatus.processing) or (
            previous.attempt_count != job.attempt_count and not (previous.attempt_count == 0 and job.attempt_count == 1)
        ):
            raise JobSuperseded()
        if repository.compare_and_swap_job(previous, job) is None:
            raise JobSuperseded()
    processing_queue.save_job(job)


def _save_content(content: ContentResolveResponse, transcript: str, caption_track: CaptionTrack | None = None) -> None:
    if caption_track is None:
        processing_queue.save_content(content, transcript)
    else:
        processing_queue.save_content(content, transcript, caption_track)
    repository = get_supabase_repository()
    if repository is not None:
        try:
            if caption_track is None:
                repository.save_content(content, transcript)
            else:
                repository.save_content(content, transcript, caption_track)
        except httpx.HTTPError as error:
            print(f"Supabase content persistence failed: {type(error).__name__}", flush=True)


def _save_blueprint(blueprint) -> None:
    processing_queue.save_blueprint(blueprint)
    repository = get_supabase_repository()
    if repository is not None:
        try:
            repository.save_blueprint(blueprint, blueprint.analysis_version)
        except httpx.HTTPError as error:
            print(f"Supabase blueprint persistence failed: {type(error).__name__}", flush=True)


def _transition(
    job: ProcessingJob,
    stage: ProcessingStage,
    *,
    durable: bool = False,
) -> ProcessingJob:
    next_job = job.model_copy(update={"processing_stage": stage})
    if durable:
        _save_job(next_job)
    else:
        processing_queue.save_job(next_job)
    _log_job_event(next_job, "job_stage_changed")
    return next_job


def _record_timing(
    job: ProcessingJob,
    stage: ProcessingStage,
    started: float,
) -> ProcessingJob:
    timings = {**job.stage_timings_ms, stage.value: _elapsed_ms(started)}
    return job.model_copy(update={"stage_timings_ms": timings})


def _elapsed_ms(started: float) -> int:
    return max(0, round((perf_counter() - started) * 1000))


def _heartbeat_loop(stop_event: Event) -> None:
    settings = get_settings()
    while not stop_event.is_set():
        try:
            processing_queue.save_worker_heartbeat()
        except Exception as error:
            print(
                json.dumps(
                    {
                        "event": "worker_heartbeat_failed",
                        "exception_type": type(error).__name__,
                        "timestamp": datetime.now(UTC).isoformat(),
                    },
                    separators=(",", ":"),
                ),
                flush=True,
            )
        stop_event.wait(settings.worker_heartbeat_interval_seconds)


def _log_job_event(job: ProcessingJob, event: str, **fields: str) -> None:
    print(
        json.dumps(
            {
                "event": event,
                "job_id": job.id,
                "content_id": job.content_id,
                "analysis_version": job.analysis_version,
                "status": job.status.value,
                "processing_stage": job.processing_stage.value,
                "attempt_count": job.attempt_count,
                "stage_timings_ms": job.stage_timings_ms,
                "timestamp": datetime.now(UTC).isoformat(),
                **fields,
            },
            separators=(",", ":"),
        ),
        flush=True,
    )


if __name__ == "__main__":
    run_worker()
